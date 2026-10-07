// convert_machine (w466, docs/portal-on-ffbox-host.md change 3): the portal's own host as a machine (BEAST) becomes a
// machine reached over ssh when the portal moves to the VM, and back for a rollback, keeping everything but how it is
// reached. And the deploy that follows, over ssh from a Linux portal to a Windows PC, run against fake ssh and scp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle, type SessionSink } from './sessions.ts';
import { MachineManager, convertMachineRecord } from './machines.ts';
import { deploy, type DeployOptions } from './machineDeploy.ts';
import { ROOT, type Config } from './config.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import type { Machine, PermissionMode, SessionInfo } from '../shared/types.ts';

const T = '2026-10-05T19:31:34.000Z';

/** BEAST's record as add_machine local made it (state.json on BEAST, 2026-10-05), with two of its sandboxes. */
const beast = (over: Partial<Machine> = {}): Machine => ({
  id: 'beast',
  local: true,
  host: 'localhost',
  purpose: 'unused',
  status: 'ready',
  online: true,
  repoPath: 'C:\\ffsb\\_base',
  home: 'C:\\Users\\rydin',
  portalUrl: 'http://127.0.0.1:8790',
  sessionIds: ['w1', 'w2'],
  createdAt: T,
  platform: 'win32',
  sandboxRoot: 'F:\\ffsb',
  maxSandboxes: 5,
  maxAgentsPerSandbox: 6,
  maxUnity: 2,
  maxSandboxAgents: 6,
  diskWarnGB: 80,
  diskCriticalGB: 40,
  librarySeed: 'F:/ffsb/_seed/Library',
  librarySeedCopy: 'clone',
  unityBelowNormal: true,
  protectedPaths: ['C:/Users/rydin/nevergames/FinalFactory', 'C:\\ff-sandboxes', 'C:\\ff-sandboxes\\data'],
  sandboxes: [
    { id: 'mp-r2', branch: 'local/w408-integration', base: 'origin/develop', path: 'F:\\ffsb\\mp-r2', purpose: 'w408', status: 'ready', createdAt: T, unity: { state: 'stopped' }, sessionIds: ['w1'] },
    { id: 'shader-blackhole', branch: 'w410-alt-view-icons', base: 'origin/develop', path: 'F:\\ffsb\\shader-blackhole', purpose: 'w424', status: 'ready', createdAt: T, unity: { state: 'stopped' }, sessionIds: ['w2'] },
  ],
  ...over,
});

const EXTRAS = { unityMcpServer: { command: 'C:/uv/uvx.exe', args: ['--offline', 'mcp-for-unity'] }, maxEventsFile: null, sandboxIdleStopMinutes: 120, cleanup: { everyMinutes: 0, softFreeGB: 0 } };

test('convert_machine (record): BEAST to ssh keeps its sandboxes, agents, limits and protected paths; back to local; the refusals', () => {
  const m = beast();
  const ssh = convertMachineRecord(m, 'ssh', { sshHost: 'beast', portalUrl: 'https://fff.example.ts.net/', port: 8790, extras: EXTRAS });
  assert.equal(ssh.local, undefined);
  assert.equal('local' in ssh, false, 'not even an undefined key: the record is a plain ssh machine');
  assert.deepEqual([ssh.host, ssh.portalUrl], ['beast', 'https://fff.example.ts.net']);
  // What a later ssh redeploy writes into its daemon.json: the Unity MCP server and the idle stop it had. Not "no Max file"
  // or "no clean-up of its own": the portal no longer reads its Max file or cleans its disk once it is elsewhere.
  assert.deepEqual(ssh.daemonExtras, { unityMcpServer: EXTRAS.unityMcpServer, sandboxIdleStopMinutes: 120 });
  for (const k of ['id', 'repoPath', 'home', 'sandboxRoot', 'maxSandboxes', 'maxAgentsPerSandbox', 'maxUnity', 'maxSandboxAgents', 'diskWarnGB', 'diskCriticalGB', 'librarySeed', 'librarySeedCopy', 'unityBelowNormal', 'protectedPaths', 'sandboxes', 'sessionIds', 'createdAt', 'platform'] as const) {
    assert.deepEqual(ssh[k], m[k], `${k} kept`);
  }
  assert.equal(m.local, true, 'the record given is not changed');
  assert.deepEqual(convertMachineRecord(m, 'ssh', { sshHost: 'beast', port: 8790, publicUrl: 'https://fff.example.ts.net' }).portalUrl, 'https://fff.example.ts.net', 'portal_url defaults to publicUrl');

  const back = convertMachineRecord(ssh, 'local', { port: 8790 });
  assert.deepEqual([back.local, back.host, back.portalUrl, back.daemonExtras], [true, 'localhost', 'http://127.0.0.1:8790', undefined]);
  assert.deepEqual({ ...back }, { ...m }, 'there and back: the record it was');

  assert.throws(() => convertMachineRecord(m, 'ssh', { port: 8790, portalUrl: 'https://x.ts.net' }), /ssh_host is required/);
  assert.throws(() => convertMachineRecord(m, 'ssh', { sshHost: 'beast', port: 8790 }), /portal_url is required/);
  assert.throws(() => convertMachineRecord(m, 'ssh', { sshHost: 'beast', port: 8790, portalUrl: 'http://127.0.0.1:8790' }), /loopback address/);
  assert.throws(() => convertMachineRecord(m, 'ssh', { sshHost: 'beast', port: 8790, portalUrl: 'https://x.ts.net/portal' }), /portal_url is required/);
  assert.throws(() => convertMachineRecord(ssh, 'ssh', { sshHost: 'beast', port: 8790, portalUrl: 'https://x.ts.net' }), /reached over ssh already/);
  assert.throws(() => convertMachineRecord(m, 'local', { port: 8790 }), /portal's own host already/);
});

class LongAgent implements SessionHandle {
  static all: LongAgent[] = [];
  info: SessionInfo;
  live = false;
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  private readonly sink: SessionSink;
  private readonly events: EventEmitter;
  constructor(info: SessionInfo, sink: SessionSink, _o: unknown, events: EventEmitter) {
    this.info = info;
    this.sink = sink;
    this.events = events;
    LongAgent.all.push(this);
  }
  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid = 'u') {
    this.live = true;
    this.sink.append(this.info.id, { kind: 'user', text, from, uuid });
    Object.assign(this.info, { status: 'running' });
    this.sink.putSession(this.info);
    return uuid;
  }
  async interrupt() {}
  async setMode(m: PermissionMode) {
    this.info.permissionMode = m;
  }
  stop() {
    if (!this.live) return;
    this.live = false;
    this.info.status = 'stopped';
    this.sink.putSession(this.info);
    this.events.emit('ended', this);
  }
  decide() {
    return false;
  }
}

const PROBES: Probes = {
  stats: async () => ({ hostname: 'beast', platform: 'win32', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: 2 ** 30, memFreeBytes: 2 ** 30 }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

const until = async (what: string, cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('convert_machine (live): BEAST becomes an ssh machine and back with its daemon connected and an agent mid-turn; same link, same token', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-convert-'));
  const cfg = { dataDir: tmp, port: 8790, limits: { maxSessions: 6, maxSandboxes: 5, maxUnity: 2 }, repo: { url: 'x', basePath: tmp }, worker: { effort: 'high' }, unity: { mcpServer: { command: 'C:/uv/uvx.exe', args: ['mcp-for-unity'] }, idleStopMinutes: 120 } } as unknown as Config;
  const store = new Store(tmp);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.allowLocalAnywhere = true;
  const deployed: DeployOptions[] = [];
  mm.deployer = async (o) => {
    deployed.push(o);
    throw new Error('no real deploy in a test');
  };
  mm.hooks = {
    // A standing agent in its own folder (a machine with sandboxes takes no worker in its main clone, w536).
    specFor: () => ({ cwd: path.join(tmp, 'agents', 'w'), settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: path.join(tmp, 'agents', 'w'), protectedPaths: [], gameRepos: [] } }),
    handlersFor: () => ({}),
  };
  const server = http.createServer();
  let upgrades = 0;
  server.on('upgrade', (req, socket, head) => {
    upgrades++;
    mm.upgrade(req, socket, head, '127.0.0.1');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Registered reached over ssh first: a local machine takes no agent in its main clone (its sandboxes' base), and the
  // test needs one mid-turn. It then goes to local and back to ssh, the agent running throughout.
  const reg = { ...beast({ repoPath: tmp, home: tmp, host: 'beast', portalUrl: url, sandboxes: [], sessionIds: [] }) } as Partial<Machine>;
  delete reg.local;
  delete reg.online;
  const { token } = mm.register(reg as Machine);
  const d = new Daemon({ portalUrl: url, id: 'beast', token, repoPath: tmp, appDir: tmp, claude: 'no-such-claude', maxSessions: 3, maxEventsFile: null }, (i, s, o, e) => new LongAgent(i, s, o, e), PROBES);
  t.after(async () => {
    d.shutdown();
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  LongAgent.all = [];
  d.start();
  await until('online', () => mm.isOnline('beast'));
  // Once its daemon has connected with it, the token register staged is the machine's only one (w568).
  const tokensBefore = fs.readFileSync(path.join(tmp, 'machine-tokens.json'), 'utf8');
  assert.match(tokensBefore, /"beast": "[0-9a-f]{64}"/);
  assert.doesNotMatch(tokensBefore, /next:beast/);
  const s = mm.createSession('beast', { kind: 'standing', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'a long turn');
  await until('mid-turn', () => s.info.status === 'running');
  const same = () => {
    assert.equal(mm.isOnline('beast'), true);
    assert.equal(upgrades, 1, 'the same link: no reconnect');
    assert.equal(fs.readFileSync(path.join(tmp, 'machine-tokens.json'), 'utf8'), tokensBefore, 'the same token');
    assert.deepEqual([LongAgent.all.length, LongAgent.all[0].live, s.info.status], [1, true, 'running'], 'the agent ran on');
    assert.deepEqual(store.machines.get('beast')!.sessionIds, [s.info.id]);
  };

  // A redeploy would stop the agent: refused before anything changes.
  assert.throws(() => mm.convertMachine('beast', 'local', { redeploy: true }), /1 agent\(s\) running; a redeploy would stop them/);
  assert.equal(store.machines.get('beast')!.local, undefined, 'unchanged');

  // To local (the portal's own computer holds its clone: the rollback onto BEAST).
  assert.match(mm.convertMachine('beast', 'local', {}), /beast is the portal's own host again \(no ssh\), portal_url http:\/\/127\.0\.0\.1:8790; 0 sandbox\(es\), 1 agent record\(s\), its token and limits kept\. Its daemon stays connected as it is, its agents running on/);
  assert.deepEqual([mm.local()?.id, store.machines.get('beast')!.host], ['beast', 'localhost']);
  await new Promise((r) => setTimeout(r, 300));
  same();

  // To ssh (the portal moves to the VM): the extras a local deploy took from the config are kept for its redeploys.
  const text = mm.convertMachine('beast', 'ssh', { sshHost: 'beast', portalUrl: 'https://fff.example.ts.net' });
  assert.match(text, /beast is reached over ssh as "beast", portal_url https:\/\/fff\.example\.ts\.net; 0 sandbox\(es\), 1 agent record\(s\), its token and limits kept\. Its daemon stays connected as it is/);
  const m = store.machines.get('beast')!;
  assert.deepEqual([m.local, m.host, m.portalUrl, m.daemonExtras], [undefined, 'beast', 'https://fff.example.ts.net', { unityMcpServer: { command: 'C:/uv/uvx.exe', args: ['mcp-for-unity'] }, sandboxIdleStopMinutes: 120 }]);
  assert.equal(mm.local(), undefined, 'no longer the portal’s own host');
  await new Promise((r) => setTimeout(r, 300));
  same();
  mm.convertMachine('beast', 'local', {});

  // Only one machine is the portal's own host, and only one whose clone is on this computer.
  mm.register({ id: 'lothdesktop', host: 'lothdesktop', purpose: 'unused', status: 'ready', repoPath: 'D:\\work\\FFFRepo', home: 'C:\\Users\\Loth', portalUrl: 'https://fff.example.ts.net' });
  assert.throws(() => mm.convertMachine('lothdesktop', 'local'), /beast is already the portal's own host as a machine/);
  mm.convertMachine('beast', 'ssh', { sshHost: 'beast', portalUrl: 'https://fff.example.ts.net' });
  assert.throws(() => mm.convertMachine('lothdesktop', 'local'), /D:\\work\\FFFRepo is not on this computer/);

  // With no agent running, a redeploy goes out the new way: over ssh, with the extras it kept.
  sessions.sessions.get(s.info.id)!.stop();
  await until('the agent stopped', () => mm.liveCount('beast') === 0);
  assert.match(mm.convertMachine('beast', 'local', { redeploy: true }), /Redeploying it here, without ssh/);
  await until('deployed', () => deployed.length === 1);
  assert.deepEqual([deployed[0].local, deployed[0].host], [true, 'localhost']);
  await until('the deploy is over', () => store.machines.get('beast')!.status !== 'deploying');
  assert.match(mm.convertMachine('beast', 'ssh', { sshHost: 'beast', portalUrl: 'https://fff.example.ts.net', redeploy: true }), /Redeploying it over ssh to beast/);
  await until('deployed again', () => deployed.length === 2);
  assert.deepEqual([deployed[1].local, deployed[1].host, deployed[1].portalUrl, deployed[1].extra], [undefined, 'beast', 'https://fff.example.ts.net', { unityMcpServer: { command: 'C:/uv/uvx.exe', args: ['mcp-for-unity'] }, sandboxIdleStopMinutes: 120 }]);
});

// ---- A Linux portal deploying a Windows PC over ssh (the VM deploying BEAST): the whole deploy, against an ssh and an scp
// that record what they are given and answer as BEAST would. POSIX only: the fakes are shell scripts. CI runs it on Linux.

test('deploy from Linux to a Windows PC: platform, probe, scp, npm ci and install over ssh, with the daemon.json it writes', { skip: process.platform === 'win32' && 'POSIX shell fakes' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-linux-to-win-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'log.txt');
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(scripts);
  // BEAST's own probe answers (2026-10-05), and "started=True" from the install.
  const probe = ['platform=win32', 'home=C:\\Users\\rydin', 'user=Beast\\rydin', 'sid=S-1-5-21-1111-2222-3333-1001', 'os=Microsoft Windows 11 Pro 10.0.26200.0', 'loggedOn=True', 'tar=True', 'node=C:\\nvm4w\\nodejs\\node.exe', 'nodev=23.7.0', 'claude=C:\\Users\\rydin\\.local\\bin\\claude.exe', 'git=C:\\Program Files\\Git\\cmd\\git.exe'].join('\n');
  fs.writeFileSync(path.join(dir, 'probe.txt'), probe + '\n');
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    `#!/bin/sh
printf 'SSH %s\\n' "$*" >> '${log}'
case "$*" in *' uname -s') echo 'MINGW64_NT-10.0-26200'; exit 0;; esac
n=$(ls '${scripts}' | wc -l | tr -d ' ')
cat > '${scripts}'/$n.ps1
if grep -q "Emit 'platform' 'win32'" '${scripts}'/$n.ps1; then cat '${path.join(dir, 'probe.txt')}'; exit 0; fi
if grep -q 'Register-ScheduledTask' '${scripts}'/$n.ps1; then echo started=True; exit 0; fi
echo ok
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'scp'), `#!/bin/sh\nprintf 'SCP %s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  t.after(() => (process.env.PATH = PATH));

  const steps: string[] = [];
  const r = await deploy({
    host: 'beast',
    id: 'beast',
    portalUrl: 'https://fff.example.ts.net',
    token: 'ffm_beast_secret',
    root: ROOT,
    repoPath: 'C:\\ffsb\\_base',
    repoSlug: 'Final-Factory/FinalFactory',
    dirs: { sandboxRoot: 'F:\\ffsb' },
    sandboxes: { root: 'F:\\ffsb', maxSandboxes: 5, maxAgentsPerSandbox: 6, maxUnity: 2, diskWarnGB: 80, diskCriticalGB: 40 },
    step: (s) => steps.push(s),
    extra: { unityMcpServer: { command: 'C:/uv/uvx.exe', args: ['mcp-for-unity'] }, sandboxIdleStopMinutes: 120 },
  });
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.deepEqual({ ...r }, { platform: 'win32', home: 'C:\\Users\\rydin', repoPath: 'C:\\ffsb\\_base', node: 'C:\\nvm4w\\nodejs\\node.exe', nodeVersion: '23.7.0', claude: 'C:\\Users\\rydin\\.local\\bin\\claude.exe', version: head, started: true });
  assert.deepEqual(steps, ['checking the OS', 'probing', 'copying code', 'npm ci', 'installing']);

  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.match(lines[0], /^SSH -o BatchMode=yes -o ConnectTimeout=15 beast uname -s$/, 'the OS first');
  const ps = lines.filter((l) => l.startsWith('SSH ') && !l.endsWith('uname -s'));
  assert.equal(ps.length, 4, 'probe, unpack, npm ci, install');
  for (const l of ps) assert.match(l, /^SSH -o BatchMode=yes -o ConnectTimeout=15 beast powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
  const scp = lines.find((l) => l.startsWith('SCP '))!;
  assert.match(scp, /^SCP -o BatchMode=yes -o ConnectTimeout=15 -q (\.ff-factory-upload-\d+\.tgz) beast:\1$/, 'the bundle by a bare name into its home');

  const sent = fs.readdirSync(scripts).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => fs.readFileSync(path.join(scripts, f), 'utf8'));
  assert.equal(sent.length, 4);
  for (const s of sent) assert.ok(s.trimEnd().endsWith('#FFEND'), 'each script with its end mark');
  assert.match(sent[0], /\$slug = ''/, 'the probe does not search for the clone it was given');
  assert.match(sent[1], /\.ff-factory-upload-\d+\.tgz/, 'the unpack names the bundle scp copied');
  assert.match(sent[2], /npm/);
  const blob = /Write-B64 'daemon\.json' '([A-Za-z0-9+/=]+)'/.exec(sent[3]);
  assert.ok(blob, 'the install writes daemon.json');
  const written = JSON.parse(Buffer.from(blob[1], 'base64').toString('utf8'));
  assert.deepEqual(
    [written.portalUrl, written.id, written.token, written.repoPath, written.sandboxes.root, written.unityMcpServer.command, written.sandboxIdleStopMinutes, 'maxEventsFile' in written, 'cleanup' in written],
    ['https://fff.example.ts.net', 'beast', 'ffm_beast_secret', 'C:\\ffsb\\_base', 'F:\\ffsb', 'C:/uv/uvx.exe', 120, false, false],
  );
  assert.match(sent[3], /Register-ScheduledTask -TaskName 'FFFactoryDaemon'/);
  for (const s of sent) assert.doesNotMatch(s, /[^\x00-\x7f]/, 'pure ASCII on the way in');
});
