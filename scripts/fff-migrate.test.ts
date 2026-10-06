// fffctl migrate (scripts/fff-migrate.ts, w499) end to end against a synthetic BEAST: a fake ssh runs BEAST's side here
// (its PowerShell scripts under pwsh, its tar as tar), the VM's portal and BEAST's portal are the real server, and a real
// machine daemon is moved from one to the other at the cut-over. Linux only, with pwsh (GitHub's ubuntu runners have it);
// the option parsing runs everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { DEFAULTS, Migration, parseArgs, type Options, type System } from './fff-migrate.ts';
import { ROOT } from '../server/config.ts';
import { claudeProjectFolder } from '../server/vmMigration.ts';
import { Store } from '../server/store.ts';
import { SessionManager } from '../server/sessions.ts';
import { MachineManager } from '../server/machines.ts';
import { Daemon, type DaemonConfig, type Probes } from '../machine/daemon.ts';
import type { Config } from '../server/config.ts';

test('fffctl migrate: options, defaults and refusals', () => {
  const o = parseArgs(['--dry-run-copy']);
  assert.equal(o.mode, 'dry-run-copy');
  assert.deepEqual({ ssh: o.ssh, beastSshHost: o.beastSshHost, beastRoot: o.beastRoot, root: o.root, user: o.user, port: o.port }, { ssh: 'rydin@beast', beastSshHost: 'rydin@beast', beastRoot: 'C:/ff-sandboxes', root: '/srv/fff', user: 'fff', port: 8790 });
  assert.equal(parseArgs(['--cut-over', '--ssh', 'ben@beast2']).beastSshHost, 'ben@beast2', 'follows --ssh');
  assert.equal(parseArgs(['--cut-over', '--ssh', 'ben@beast2', '--beast-ssh-host', 'beast']).beastSshHost, 'beast');
  assert.equal(parseArgs(['--rollback-dry-run', '--keep-stage']).keepStage, true);
  assert.equal(parseArgs(['--dry-run-copy', '--no-resume-check']).resumeCheck, false);
  assert.equal(parseArgs(['--key', '--user', '']).user, undefined);
  assert.throws(() => parseArgs([]), /fffctl migrate --key/);
  assert.throws(() => parseArgs(['--dry-run-copy', '--cut-over']), /one mode at a time/);
  assert.throws(() => parseArgs(['--cut-over', '--ssh']), /--ssh needs a value/);
  assert.throws(() => parseArgs(['--cut-over', '--ssh', 'beast']), /--ssh is user@host/);
  assert.throws(() => parseArgs(['--cut-over', '--drain-minutes', 'x']), /drainMinutes/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option --bogus/);
});

// ---------------------------------------------------------------- the synthetic BEAST and VM

const PWSH = (() => {
  if (process.platform === 'win32') return undefined;
  for (const p of [process.env.FAKE_PWSH, ...(process.env.PATH ?? '').split(':').map((d) => path.join(d, 'pwsh'))]) if (p && fs.existsSync(p)) return p;
  return undefined;
})();
const skip = !PWSH ? 'needs Linux with pwsh (the fake BEAST runs its PowerShell scripts)' : undefined;

const lanIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const gitInit = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
};

/** Every file under `dir` with its content's hash: BEAST's side must be the same after a dry run. */
function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const FAKE_TOKEN = 'sk-ant-oat01-FAKEFORTHEMIGRATIONTEST-' + 'x'.repeat(40);
const BEAST_TOKEN = 'not-a-real-host-token';

/** A real FF Factory server as a child process, as systemd (the VM) or the ffsb-server task (BEAST) would run it. */
class Portal {
  child?: ChildProcess;
  lines: { t: number; line: string }[] = [];
  exits: (number | null)[] = [];
  dry = false;
  readonly name: string;
  readonly cfgFile: string;
  readonly home: string;
  readonly port: number;
  constructor(name: string, cfgFile: string, home: string, port: number) {
    this.name = name;
    this.cfgFile = cfgFile;
    this.home = home;
    this.port = port;
  }
  async start() {
    if (this.child) return;
    const env: NodeJS.ProcessEnv = { ...process.env, FFSB_CONFIG: this.cfgFile, HOME: this.home, USERPROFILE: this.home, CLAUDE_CONFIG_DIR: path.join(this.home, '.claude') };
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'DISCORD_TOKEN', 'FFSB_DRY_RUN']) delete env[k];
    if (this.dry) env.FFSB_DRY_RUN = '1';
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const take = (d: Buffer) => {
      for (const line of String(d).split('\n')) if (line.trim()) this.lines.push({ t: Date.now(), line });
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    child.once('exit', (code) => {
      this.exits.push(code);
      if (this.child === child) this.child = undefined;
    });
  }
  async stop() {
    const c = this.child;
    if (!c) return;
    const gone = new Promise((r) => c.once('exit', r));
    c.kill('SIGTERM');
    await gone;
  }
  log(since = 0) {
    return this.lines.filter((l) => l.t >= since).map((l) => l.line).join('\n');
  }
  async healthy(ms = 60_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/api/health`);
        if (r.ok) return (await r.json()) as { ok: boolean; dryRun?: boolean; version?: string };
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${this.name} did not come up:\n${this.log().slice(-3000)}`);
  }
}

/** The VM's side of System, for a test: its portal as a child process, no Tailscale, scripted answers. */
class TestSystem implements System {
  lines: string[] = [];
  answers: string[] = [];
  /** How many more starts do nothing (a portal that does not come up). */
  deadStarts = 0;
  readonly portal: Portal;
  constructor(portal: Portal) {
    this.portal = portal;
  }
  async stopPortal() {
    await this.portal.stop();
  }
  async startPortal() {
    if (this.deadStarts > 0) {
      this.deadStarts--;
      return;
    }
    await this.portal.start();
  }
  async setDryRun(on: boolean) {
    this.portal.dry = on;
  }
  async logsSince(t: number) {
    return this.portal.log(t);
  }
  async funnelState() {
    return undefined;
  }
  async setFunnel() {}
  async backupsActive() {
    return false;
  }
  async setBackups() {}
  async tailnetIp() {
    return '100.64.0.10';
  }
  async ask() {
    return this.answers.shift() ?? '';
  }
  out(line: string) {
    this.lines.push(line);
  }
}

interface World {
  base: string;
  beastRoot: string;
  beastData: string;
  beastClaude: string;
  beastBase: string;
  vm: string;
  vmCfgFile: string;
  vmBase: string;
  opts: Options;
  sys: TestSystem;
  vmPortal: Portal;
  beastPortal: Portal;
  publicUrl: string;
  machineToken: string;
  fake: string;
}

async function world(t: { after: (fn: () => unknown) => void }): Promise<World> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fff-migrate-'));
  const ip = lanIp()!;
  const [vmPort, beastPort] = [await freePort(), await freePort()];
  const publicUrl = `http://${ip}:${vmPort}`;

  // ---- BEAST: its app folder (config.json, data, scripts), its base clone, its Claude folder
  const beastRoot = path.join(base, 'beast', 'ff-sandboxes');
  const beastData = path.join(beastRoot, 'data');
  const beastBase = path.join(base, 'beast', 'ffsb', '_base');
  const beastClaude = path.join(base, 'beast', 'claude');
  gitInit(beastBase);
  fs.mkdirSync(path.join(beastData, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(beastRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(base, 'beast', 'sb'), { recursive: true });
  const beastCfg = {
    port: beastPort,
    host: '127.0.0.1',
    trustProxy: false,
    publicUrl: `http://127.0.0.1:${beastPort}`,
    ownerName: 'Ben',
    dataDir: beastData,
    sandboxRoot: path.join(base, 'beast', 'sb'),
    repo: { url: beastBase, basePath: beastBase, referenceRepo: beastBase },
    defaultBase: 'develop',
    unity: { editorPath: path.join(base, 'no-unity'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
    voice: { enabled: false, autoInstall: false, tts: false },
    hostGuard: { pollSeconds: 0 },
    orchestrator: { notifyOnWorkerEvents: false },
    claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: BEAST_TOKEN },
    machines: { keepAgentsOnRestart: true },
  };
  fs.writeFileSync(path.join(beastRoot, 'config.json'), JSON.stringify(beastCfg, null, 2));
  // BEAST's own machine, registered as the portal registers it (its token hashed in machine-tokens.json).
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const session = (id: string, kind: string, over: object = {}) => ({ id, kind, title: id, status: 'idle', permissionMode: 'bypassPermissions', createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, pendingPermissions: [], ...over });
  fs.writeFileSync(
    path.join(beastData, 'state.json'),
    JSON.stringify({ sandboxes: [], orchestratorId: 'disp', sessions: [session('disp', 'orchestrator', { orchestratorRole: 'dispatcher', title: 'Dispatcher', sdkSessionId: 'sdk-disp-1' }), session('w1', 'worker', { machineId: 'beast' })], settings: { heartbeatMinutes: null } }, null, 2),
  );
  const store = new Store(beastData);
  const mm = new MachineManager({ dataDir: beastData, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config, store, new SessionManager({ limits: { maxSessions: 6 } } as Config, store));
  const { token: machineToken } = mm.register({ id: 'beast', host: 'localhost', local: true, purpose: 'unused', status: 'ready', repoPath: beastBase, home: path.join(base, 'beast'), portalUrl: `http://127.0.0.1:${beastPort}`, maxSessions: 2 });
  store.flush();
  const item = (id: string, title: string) => ({ id, title, brief: title, priority: 'normal', keys: [], requestedBy: { userId: 'ben', displayName: 'Ben' }, requesters: [{ userId: 'ben', displayName: 'Ben' }], humanAsked: true, status: 'open', createdAt: at, updatedAt: at, sessionIds: [], overlaps: [] });
  fs.writeFileSync(path.join(beastData, 'work.json'), JSON.stringify({ seq: 2, items: [item('w1', 'one'), item('w2', 'two')] }));
  fs.writeFileSync(path.join(beastData, 'transcripts', 'disp.jsonl'), '{"seq":1,"kind":"system","text":"hi"}\n');
  fs.writeFileSync(path.join(beastData, 'transcripts', 'w1.jsonl'), '{"seq":1,"kind":"system","text":"hi"}\n');
  fs.writeFileSync(path.join(beastData, 'outside-watch.json'), JSON.stringify({ topic: 'ffsb-abcdefghijklmnop', mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.1.5' }));
  fs.mkdirSync(path.join(beastData, 'tools', 'whisper'), { recursive: true });
  fs.writeFileSync(path.join(beastData, 'tools', 'whisper', 'model.bin'), 'big and Windows-only');
  fs.writeFileSync(path.join(beastData, 'supervisor.pid'), '1234');
  fs.mkdirSync(path.join(beastData, 'orchestrator-memory', 'dispatcher'), { recursive: true });
  fs.writeFileSync(path.join(beastData, 'orchestrator-memory', 'dispatcher', 'MEMORY.md'), '- remembered\n');
  // Its stop: what scripts\stop-server.ps1 does, as far as a test can: ask the server to stop, wait for it to go.
  fs.writeFileSync(
    path.join(beastRoot, 'scripts', 'stop-server.ps1'),
    `[IO.File]::WriteAllText((Join-Path $PSScriptRoot '../data/restart.request'), '')
for ($i = 0; $i -lt 120; $i++) { try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:${beastPort}/api/health'; Start-Sleep -Milliseconds 500 } catch { break } }
'stopped'
`,
  );
  const histDir = path.join(beastClaude, 'projects', claudeProjectFolder(beastBase));
  fs.mkdirSync(path.join(histDir, 'sdk-disp-1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(histDir, 'sdk-disp-1.jsonl'), `{"type":"user","cwd":${JSON.stringify(beastBase)},"message":"the dispatcher's history"}\n`);
  fs.writeFileSync(path.join(histDir, 'sdk-disp-1', 'subagents', 'a.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(histDir, 'someone-else.jsonl'), 'not copied\n');

  // ---- the VM: its own config.json as the guest install and fffctl configure leave it, its own empty data
  const vm = path.join(base, 'vm');
  const vmBase = path.join(vm, 'base');
  gitInit(vmBase);
  for (const d of ['config', 'data', 'secrets', 'home/.ssh', 'sandboxes', 'agents']) fs.mkdirSync(path.join(vm, d), { recursive: true });
  fs.writeFileSync(path.join(vm, 'secrets', 'claude-oauth-token'), FAKE_TOKEN + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(vm, 'home', '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheMigrationTest fff-portal@fff\n');
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy', 'vm', 'guest', 'config.vm.example.json'), 'utf8'));
  const vmCfg = {
    ...template,
    port: vmPort,
    publicUrl,
    ownerName: 'Lothsahn',
    dataDir: path.join(vm, 'data'),
    sandboxRoot: path.join(vm, 'sandboxes'),
    standingRoot: path.join(vm, 'agents'),
    repo: { ...template.repo, basePath: vmBase },
    hostDiskPaths: [vm],
    review: { root: path.join(vm, 'review') },
    hostGuard: { ...template.hostGuard, pollSeconds: 0 },
    unity: { editorPath: path.join(base, 'no-unity'), watchdog: { stallMinutes: 0, runningPollSeconds: 0, autoDismiss: false } },
    orchestrator: { ...template.orchestrator, notifyOnWorkerEvents: false },
    claudeTokenFile: path.join(vm, 'secrets', 'claude-oauth-token'),
    claudeAccounts: { orchestrator: 'tokenfile', dispatcher: 'tokenfile' },
  };
  const vmCfgFile = path.join(vm, 'config', 'config.json');
  fs.writeFileSync(vmCfgFile, JSON.stringify(vmCfg, null, 2) + '\n');

  // ---- the fakes: ssh runs BEAST's side here; schtasks.exe and claude record what they were asked
  const fake = path.join(base, 'bin');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'fake.env'), `PWSH=${JSON.stringify(PWSH)}\nLOG=${JSON.stringify(path.join(base, 'ssh.log'))}\nTASKS=${JSON.stringify(path.join(base, 'schtasks.log'))}\nCLAUDE_LOG=${JSON.stringify(path.join(base, 'claude.log'))}\nDENY=${JSON.stringify(path.join(base, 'deny'))}\nTOKEN_FILE=${JSON.stringify(path.join(vm, 'secrets', 'claude-oauth-token'))}\n`);
  const script = (name: string, body: string) => fs.writeFileSync(path.join(fake, name), `#!/usr/bin/env bash\nset -euo pipefail\n. "$(dirname "$0")/fake.env"\n${body}`, { mode: 0o755 });
  script(
    'ssh',
    `dest=""
while [ $# -gt 0 ]; do
  case "$1" in -i|-o|-p|-l|-F|-E|-J) shift 2 ;; -*) shift ;; *) dest=$1; shift; break ;; esac
done
printf '%s %s\\n' "$dest" "\${1:-}" >>"$LOG"
if [ -e "$DENY" ]; then echo "$dest: Permission denied (publickey)." >&2; exit 255; fi
[ "$dest" = rydin@beast ] || { echo "ssh: Could not resolve hostname $dest" >&2; exit 255; }
if [ "\${1:-}" = powershell.exe ]; then
  shift; args=()
  while [ $# -gt 0 ]; do case "$1" in -ExecutionPolicy) shift 2 ;; *) args+=("$1"); shift ;; esac; done
  exec "$PWSH" "\${args[@]}"
fi
exec "$@"
`,
  );
  script('schtasks.exe', 'printf \'%s\\n\' "$*" >>"$TASKS"\necho "SUCCESS: (fake)"\n');
  script(
    'claude',
    `id=""; prev=""
for a in "$@"; do [ "$prev" = --resume ] && id=$a; prev=$a; done
folder=$(pwd | sed 's/[^a-zA-Z0-9]/-/g')
f="$HOME/.claude/projects/$folder/$id.jsonl"
case " $* " in *"$(cat "$TOKEN_FILE")"*) echo "token on the command line" >>"$CLAUDE_LOG"; exit 9 ;; esac
[ "\${CLAUDE_CODE_OAUTH_TOKEN:-}" = "$(cat "$TOKEN_FILE")" ] && echo "token from the environment" >>"$CLAUDE_LOG"
case " $* " in *" --fork-session "*) echo "forked" >>"$CLAUDE_LOG" ;; esac
if [ -f "$f" ]; then
  mkdir -p "$(dirname "$f")"; echo '{"type":"user"}' >"$(dirname "$f")/fork-1.jsonl"
  echo '{"type":"result","subtype":"success","is_error":false,"result":"resumed","session_id":"fork-1"}'
else
  echo "No conversation found with session ID: $id ($f)" >&2; exit 1
fi
`,
  );
  const PATH0 = process.env.PATH;
  process.env.PATH = `${fake}:${PATH0}`;
  const vmPortal = new Portal('the VM\'s portal', vmCfgFile, path.join(vm, 'home'), vmPort);
  const beastPortal = new Portal("BEAST's portal", path.join(beastRoot, 'config.json'), path.join(base, 'beast'), beastPort);
  const sys = new TestSystem(vmPortal);
  t.after(async () => {
    await vmPortal.stop();
    await beastPortal.stop();
    process.env.PATH = PATH0;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const opts: Options = { ...DEFAULTS, mode: 'dry-run-copy', ssh: 'rydin@beast', beastSshHost: 'rydin@beast', beastRoot, beastClaudeDir: beastClaude, root: vm, port: vmPort, user: undefined, claude: path.join(fake, 'claude'), tailscale: false, healthSeconds: 90, daemonSeconds: 60, drainMinutes: 1 };
  return { base, beastRoot, beastData, beastClaude, beastBase, vm, vmCfgFile, vmBase, opts, sys, vmPortal, beastPortal, publicUrl, machineToken, fake };
}

const migration = (w: World, mode: Options['mode'], over: Partial<Options> = {}) => new Migration({ ...w.opts, mode, ...over }, w.sys);

test('fffctl migrate --dry-run-copy, again, then --rollback-dry-run: a read-only pull from BEAST, the copy checked as a dry run, and back', { skip, timeout: 300_000 }, async (t) => {
  const w = await world(t);
  await w.vmPortal.start();
  await w.vmPortal.healthy();
  const vmCfgBefore = fs.readFileSync(w.vmCfgFile, 'utf8');
  const beastBefore = treeHash(path.join(w.base, 'beast'));

  // The key is not authorized yet: the exact line to add, and nothing done.
  fs.writeFileSync(path.join(w.base, 'deny'), '');
  const denied = migration(w, 'dry-run-copy');
  await assert.rejects(denied.dryRunCopy(), (e: Error) => {
    assert.match(e.message, /cannot reach BEAST as rydin@beast/);
    assert.match(e.message, /administrators_authorized_keys/);
    assert.ok(e.message.includes('from="100.64.0.10",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheMigrationTest fff-portal@fff'));
    return true;
  });
  assert.equal(fs.existsSync(path.join(w.vm, 'migrate', 'dry-run.json')), false);
  fs.rmSync(path.join(w.base, 'deny'));

  const m = migration(w, 'dry-run-copy');
  const code = await m.dryRunCopy();
  const report = m.report.join('\n');
  t.diagnostic(report);
  assert.equal(code, 0, report);
  for (const check of ['starts as a dry run', 'no data restored on load', "counts equal BEAST's copy", 'an orchestrator conversation resumes']) assert.match(report, new RegExp(`PASS  ${check.replace(/[()]/g, '\\$&')}`), check);
  assert.match(report, /copied BEAST's config\.json and data: \d+ files/);
  assert.match(report, /copied 1 conversation\(s\) to resume/);
  assert.match(report, /beast: from the portal's own host to a machine reached over ssh \(rydin@beast\)/);

  // Read-only on BEAST: every file there as it was.
  assert.deepEqual(treeHash(path.join(w.base, 'beast')), beastBefore);
  const sshLog = fs.readFileSync(path.join(w.base, 'ssh.log'), 'utf8');
  assert.ok(!fs.existsSync(path.join(w.base, 'schtasks.log')), 'no task touched');
  assert.match(sshLog, /^rydin@beast powershell\.exe$/m);
  assert.match(sshLog, /^rydin@beast tar$/m);

  // What runs here now.
  const h = await w.vmPortal.healthy();
  assert.equal(h.dryRun, true);
  const cfg = JSON.parse(fs.readFileSync(w.vmCfgFile, 'utf8'));
  assert.equal(cfg.publicUrl, w.publicUrl);
  assert.equal(cfg.hostSandboxes, false);
  assert.equal(cfg.ownerName, 'Ben');
  assert.equal(cfg.claudeEnv.CLAUDE_CODE_OAUTH_TOKEN, BEAST_TOKEN, 'copied (ignored by the dry run)');
  assert.deepEqual(cfg.claudeAccounts, { orchestrator: 'tokenfile', dispatcher: 'tokenfile' });
  assert.equal(cfg.dataDir, path.join(w.vm, 'data'));
  assert.equal((fs.statSync(w.vmCfgFile).mode & 0o777).toString(8), '600');
  const state = JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'state.json'), 'utf8'));
  const beast = state.machines.find((x: { id: string }) => x.id === 'beast');
  assert.deepEqual([beast.local, beast.host, beast.portalUrl], [undefined, 'rydin@beast', w.publicUrl]);
  assert.ok(fs.existsSync(path.join(w.vm, 'data', 'machine-tokens.json')));
  assert.ok(!fs.existsSync(path.join(w.vm, 'data', 'tools')), 'no Windows tools');
  assert.ok(!fs.existsSync(path.join(w.vm, 'data', 'supervisor.pid')));
  assert.equal(fs.readFileSync(path.join(w.vm, 'data', 'orchestrator-memory', 'dispatcher', 'MEMORY.md'), 'utf8'), '- remembered\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'outside-watch.json'), 'utf8')), { topic: 'ffsb-abcdefghijklmnop' }, "without BEAST's adapter");
  const moved = path.join(w.vm, 'home', '.claude', 'projects', claudeProjectFolder(w.vmBase));
  assert.equal(fs.readFileSync(path.join(moved, 'sdk-disp-1.jsonl'), 'utf8'), fs.readFileSync(path.join(w.beastClaude, 'projects', claudeProjectFolder(w.beastBase), 'sdk-disp-1.jsonl'), 'utf8'));
  assert.ok(fs.existsSync(path.join(moved, 'sdk-disp-1', 'subagents', 'a.jsonl')), 'its subagents too');
  assert.ok(!fs.existsSync(path.join(moved, 'someone-else.jsonl')), 'only the ones it resumes');
  assert.deepEqual(fs.readFileSync(path.join(w.base, 'claude.log'), 'utf8').trim().split('\n'), ['token from the environment', 'forked'], 'the token in its environment only, the copy forked, not written');
  assert.match(w.vmPortal.log(), /!!!!!!!! DRY RUN/);
  assert.doesNotMatch(w.vmPortal.log() + report, new RegExp(`${FAKE_TOKEN}|${BEAST_TOKEN}`), 'no token printed');

  // Again, after BEAST moved on: only what changed comes over.
  fs.appendFileSync(path.join(w.beastData, 'transcripts', 'w1.jsonl'), '{"seq":2,"kind":"system","text":"later"}\n');
  fs.rmSync(path.join(w.beastData, 'orchestrator-memory', 'dispatcher', 'MEMORY.md'));
  const again = migration(w, 'dry-run-copy');
  assert.equal(await again.dryRunCopy(), 0, again.report.join('\n'));
  const r2 = again.report.join('\n');
  assert.match(r2, /a dry run is in place already/);
  assert.match(r2, /this time 1 file\(s\), [\d.]+ MB over the wire, 1 removed/);
  assert.match(fs.readFileSync(path.join(w.vm, 'data', 'transcripts', 'w1.jsonl'), 'utf8'), /later/);
  assert.ok(!fs.existsSync(path.join(w.vm, 'data', 'orchestrator-memory', 'dispatcher', 'MEMORY.md')));

  // Back: this VM's own portal as it was, the copy and its secrets gone.
  const back = migration(w, 'rollback-dry-run');
  assert.equal(await back.rollbackDryRun(), 0, back.report.join('\n'));
  assert.equal(fs.readFileSync(w.vmCfgFile, 'utf8'), vmCfgBefore);
  const after = JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'state.json'), 'utf8'));
  assert.ok(!(after.machines ?? []).some((x: { id: string }) => x.id === 'beast'), "BEAST's records are gone");
  assert.ok(!fs.existsSync(path.join(w.vm, 'data', 'machine-tokens.json')));
  assert.ok(!fs.existsSync(path.join(moved, 'sdk-disp-1.jsonl')));
  assert.ok(!fs.existsSync(path.join(moved, 'fork-1.jsonl')), "the check's fork too");
  assert.ok(!fs.existsSync(path.join(w.vm, 'migrate', 'stage')), 'the pulled copy wiped');
  assert.ok(!fs.existsSync(path.join(w.vm, 'migrate', 'dry-run.json')));
  assert.equal((await w.vmPortal.healthy()).dryRun, undefined, 'a normal start again');
  assert.equal(await migration(w, 'rollback-dry-run').rollbackDryRun(), 0, 'twice: nothing to do');
});

const PROBES: Probes = {
  stats: async () => ({ hostname: 'beast', platform: 'linux', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: 2 ** 30, memFreeBytes: 2 ** 30 }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('fffctl migrate --cut-over: BEAST\'s portal drains, sends its daemon here and stops; the copy starts here for real and the daemon says hello', { skip: skip ?? (lanIp() ? undefined : 'no network address for the daemon to dial'), timeout: 300_000 }, async (t) => {
  const w = await world(t);
  await w.beastPortal.start();
  await w.beastPortal.healthy();
  await w.vmPortal.start();
  await w.vmPortal.healthy();
  // BEAST's own daemon, as on BEAST: dialling BEAST's portal at loopback.
  const daemonDir = path.join(w.base, 'daemon');
  fs.mkdirSync(daemonDir);
  const configFile = path.join(daemonDir, 'daemon.json');
  const dc: DaemonConfig = { portalUrl: `http://127.0.0.1:${w.beastPortal.port}`, id: 'beast', token: w.machineToken, repoPath: w.beastBase, appDir: daemonDir, claude: 'no-such-claude', maxSessions: 2, maxEventsFile: null };
  fs.writeFileSync(configFile, JSON.stringify(dc, null, 2));
  const daemon = new Daemon({ ...dc, configFile }, undefined, PROBES);
  t.after(() => daemon.shutdown());
  daemon.start();
  await until("the daemon at BEAST's portal", () => /machine beast connected/.test(w.beastPortal.log()));

  // A typed "no" first: nothing on BEAST changes.
  const beastBefore = treeHash(w.beastRoot + '/scripts');
  w.sys.answers = ['no'];
  const no = migration(w, 'cut-over');
  assert.equal(await no.cutOver(), 3);
  assert.match(no.report.join('\n'), /stopped: nothing on BEAST was touched/);
  assert.ok(!fs.existsSync(path.join(w.base, 'schtasks.log')));
  assert.ok(w.beastPortal.child, "BEAST's portal still runs");
  assert.deepEqual(treeHash(w.beastRoot + '/scripts'), beastBefore);

  w.sys.answers = ['CUT OVER'];
  const m = migration(w, 'cut-over');
  const code = await m.cutOver();
  const report = m.report.join('\n');
  t.diagnostic(report);
  assert.equal(code, 0, `${report}\n--- BEAST:\n${w.beastPortal.log().slice(-2000)}\n--- VM:\n${w.vmPortal.log().slice(-2000)}`);
  assert.match(report, /relocated: beast/);
  assert.match(report, /BEAST portal: stopped/);
  assert.match(report, /connected here: beast/);
  assert.match(report, /set FFBox's fff\.url to http/);
  assert.match(report, /sign in, add the phone app again/);
  assert.deepEqual(fs.readFileSync(path.join(w.base, 'schtasks.log'), 'utf8').trim().split('\n'), ['/Change /TN ffsb-server /DISABLE']);
  assert.ok(!w.beastPortal.child, "BEAST's portal stopped");
  assert.deepEqual(w.beastPortal.exits, [0], 'cleanly');
  assert.match(w.beastPortal.log(), /relocate to http:\/\/[\d.]+:\d+: 1 of 1 connected daemon\(s\) took it/);
  // The daemon follows: daemon.json says so, and it is connected here.
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).portalUrl, w.publicUrl);
  assert.match(w.vmPortal.log(), /machine beast connected/);
  const h = await w.vmPortal.healthy();
  assert.equal(h.dryRun, undefined, 'for real');
  const state = JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'state.json'), 'utf8'));
  const beast = state.machines.find((x: { id: string }) => x.id === 'beast');
  assert.equal(beast.host, 'rydin@beast');
  // What BEAST's portal wrote at its stop came over (its resume file); its data is otherwise as it was.
  assert.ok(fs.existsSync(path.join(w.vm, 'migrate')));
  assert.ok(fs.existsSync(path.join(w.vm, 'home', '.claude', 'projects', claudeProjectFolder(w.vmBase), 'sdk-disp-1.jsonl')));
  assert.doesNotMatch(report, new RegExp(`${FAKE_TOKEN}|${BEAST_TOKEN}`));
});

test('fffctl migrate --cut-over: a portal here that does not come up puts everything back, BEAST\'s task started again', { skip: skip ?? (lanIp() ? undefined : 'no network address'), timeout: 300_000 }, async (t) => {
  const w = await world(t);
  await w.beastPortal.start();
  await w.beastPortal.healthy();
  await w.vmPortal.start();
  await w.vmPortal.healthy();
  const vmCfgBefore = fs.readFileSync(w.vmCfgFile, 'utf8');
  w.sys.answers = ['CUT OVER'];
  // The start after the install does nothing: no portal answers here.
  const realStart = w.sys.startPortal.bind(w.sys);
  let starts = 0;
  w.sys.startPortal = async () => {
    starts++;
    if (starts === 1) return;
    await realStart();
  };
  const m = migration(w, 'cut-over', { healthSeconds: 5 });
  assert.equal(await m.cutOver(), 1);
  const report = m.report.join('\n');
  t.diagnostic(report);
  assert.match(report, /this portal is not healthy within 5 s: rolling back/);
  assert.match(report, /rolled back: this VM's portal has its own data again/);
  assert.deepEqual(fs.readFileSync(path.join(w.base, 'schtasks.log'), 'utf8').trim().split('\n'), ['/Change /TN ffsb-server /DISABLE', '/Change /TN ffsb-server /ENABLE', '/Run /TN ffsb-server']);
  assert.equal(fs.readFileSync(w.vmCfgFile, 'utf8'), vmCfgBefore, "this VM's own config back");
  assert.equal((await w.vmPortal.healthy()).ok, true, 'and its portal up');
  const state = JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'state.json'), 'utf8'));
  assert.ok(!(state.machines ?? []).some((x: { id: string }) => x.id === 'beast'));
});

