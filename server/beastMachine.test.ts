// The portal's own host as a machine (docs/beast-machine.md): the pool adopting and releasing existing worktrees (the
// daemon's side of protocol 6), the account rules, the local deploy, the fleet view, the guard and the reaper.
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
import { MachineManager, RemoteSession, localMachineDefaults, mergeSandboxes, poolSettingsOf } from './machines.ts';
import { PROTOCOL_VERSION } from './machineProtocol.ts';
import { daemonConfig, type DeployOptions } from './machineDeploy.ts';
import { LOCAL, installScript, scriptCommand } from './machineDeployWin.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { SandboxPool, librarySource, samePath, totalAgentsRefusal, type PoolDeps, type SandboxEditor } from '../machine/sandboxes.ts';
import { accountSource, hostClaudeEnvFor, machineUsesLogin, usesHostClaudeEnv } from './secrets.ts';
import { sandboxGuard } from './guard.ts';
import { isProtected } from './reaper.ts';
import { fleetOf } from '../shared/fleet.ts';
import { copyTree, removeTree, run } from './proc.ts';
import { readGitStatus } from './gitStatus.ts';
import type { Config } from './config.ts';
import type { ImageInput, Machine, PermissionMode, Sandbox, SandboxPoolSettings, SessionInfo, SystemStats } from '../shared/types.ts';

// Daemons started here keep their Unity slots mailbox in a folder of their own, not the real one in the home folder.
process.env.FF_UNITY_SLOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-slots-'));

const GB = 1024 ** 3;
const T = '2026-09-29T10:00:00.000Z';

const until = async (what: string, cond: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A bare origin, the base clone, and two worktrees made the way this host's own pool made them (git worktree add). */
function hostRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-beast-'));
  const origin = path.join(root, 'origin.git');
  const base = path.join(root, '_base');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, base], { stdio: 'pipe' });
  git(base, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(base, '.gitignore'), 'Library/\nLogs/\nTemp/\n');
  fs.writeFileSync(path.join(base, 'README.md'), 'game\n');
  git(base, 'add', '.gitignore', 'README.md');
  git(base, 'commit', '-q', '-m', 'base');
  git(base, 'push', '-q', '-u', 'origin', 'develop');
  const sbRoot = path.join(root, 'ffsb');
  fs.mkdirSync(sbRoot);
  const worktree = (id: string, branch: string) => {
    git(base, 'worktree', 'add', '-q', '-b', branch, path.join(sbRoot, id), 'develop');
    fs.mkdirSync(path.join(sbRoot, id, 'Library'), { recursive: true });
    fs.writeFileSync(path.join(sbRoot, id, 'Library', 'warm.bin'), `library of ${id}`);
    fs.writeFileSync(path.join(sbRoot, id, 'work.txt'), `uncommitted work in ${id}`);
  };
  worktree('mp-r2', 'e2e-r2-matrix');
  worktree('slot-5', 'e2e-r2-chaos');
  return { root, origin, base, sbRoot, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

function poolDeps(repoPath: string, o: { copies?: { src: string; mode?: string }[]; lowered?: number[]; pids?: Map<string, number> } = {}) {
  const running = new Set<string>();
  const d: PoolDeps = {
    git: (args, opts = {}) => run('git', ['-C', repoPath, ...args], { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
    copyTree: async (src, dst, signal, mode) => {
      o.copies?.push({ src, mode });
      await copyTree(src, dst, { signal });
    },
    removeTree,
    freeBytes: async () => 500 * GB,
    procs: async () => [],
    editor: (sb, logFile): SandboxEditor => ({
      unity: {
        logFile,
        start: async () => {
          running.add(sb.path);
          return 'Started (fake).';
        },
        stop: async () => {
          running.delete(sb.path);
          return 'Stopped (fake).';
        },
        status: async () => (running.has(sb.path) ? 'running' : 'not running'),
        editors: () => {
          const pid = o.pids?.get(sb.path) ?? (running.has(sb.path) ? 4242 : undefined);
          return pid ? [{ pid, ppid: 1, cmd: `Unity -projectPath ${sb.path}` }] : [];
        },
      },
    }),
    bridgeUp: (p) => running.has(p) || !!o.pids?.has(p),
    gitStatus: readGitStatus,
    now: () => Date.now(),
    lowerPriority: (pid) => o.lowered?.push(pid),
  };
  return { d, running };
}

const SETTINGS = (root: string, over: Partial<SandboxPoolSettings> = {}): SandboxPoolSettings => ({ root, maxSandboxes: 5, maxAgentsPerSandbox: 6, maxUnity: 4, diskWarnGB: 50, diskCriticalGB: 20, ...over });

// ---------------------------------------------------------------- the pool: adopt and release (real git; CI runs Windows too)

test('beast machine: the pool adopts worktrees as they are and releases them without touching anything', async (t) => {
  const r = hostRepos();
  t.after(r.cleanup);
  const lowered: number[] = [];
  const pids = new Map([[path.join(r.sbRoot, 'mp-r2'), 777]]);
  const { d } = poolDeps(r.base, { lowered, pids });
  const stateFile = path.join(r.root, 'app', 'sandboxes.json');
  const make = () => new SandboxPool({ repoPath: r.base, stateFile, settings: SETTINGS(r.sbRoot, { maxSandboxes: 2, belowNormal: true }), activity: () => ({ busy: false, lastActivityMs: Date.now() }), onChange: () => undefined, onEvent: () => undefined }, d);
  const p = make();
  const dir = path.join(r.sbRoot, 'mp-r2');
  const text = await p.adopt({ id: 'mp-r2', path: dir, branch: 'stale-name', base: 'origin/develop', createdAt: T, logPath: path.join(dir, 'Logs', 'sandbox-editor.log') });
  assert.match(text, /Adopted sandbox mp-r2 .*branch e2e-r2-matrix/, 'the branch checked out now, not the one on the old record');
  const sb = p.list()[0];
  assert.deepEqual([sb.id, sb.status, sb.branch, sb.createdAt, sb.unity.logPath], ['mp-r2', 'ready', 'e2e-r2-matrix', T, path.join(dir, 'Logs', 'sandbox-editor.log')]);
  await until('the running editor found and lowered', () => p.list()[0].unity.pid === 777);
  assert.deepEqual(lowered, [777], 'an adopted editor gets below-normal priority once');
  await p.tick();
  assert.deepEqual(lowered, [777], 'not again for the same pid');
  assert.equal(fs.readFileSync(path.join(dir, 'work.txt'), 'utf8'), 'uncommitted work in mp-r2', 'uncommitted work untouched');
  assert.equal(fs.readFileSync(path.join(dir, 'Library', 'warm.bin'), 'utf8'), 'library of mp-r2', 'Library untouched');
  assert.deepEqual(make().list().map((s) => s.id), ['mp-r2'], 'kept in sandboxes.json across a daemon restart');

  await assert.rejects(p.adopt({ id: 'mp-r2', path: dir, branch: 'x', base: 'b', createdAt: T }), /already exists/);
  const stray = path.join(r.sbRoot, 'stray');
  fs.mkdirSync(stray);
  await assert.rejects(p.adopt({ id: 'stray', path: stray, branch: 'x', base: 'b', createdAt: T }), /not a git worktree/);
  await assert.rejects(p.adopt({ id: 'slot-5', path: path.join(r.root, 'slot-5'), branch: 'x', base: 'b', createdAt: T }), /directly in the sandbox root/);
  await assert.rejects(p.adopt({ id: 'wrong', path: path.join(r.sbRoot, 'slot-5'), branch: 'x', base: 'b', createdAt: T }), /not a folder named wrong/);
  // A worktree of another repository is not this machine's.
  const other = path.join(r.root, 'other');
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  execFileSync('git', ['-C', other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  execFileSync('git', ['-C', other, 'worktree', 'add', '-q', '-b', 'o', path.join(r.sbRoot, 'foreign')]);
  await assert.rejects(p.adopt({ id: 'foreign', path: path.join(r.sbRoot, 'foreign'), branch: 'o', base: 'b', createdAt: T }), /not of this machine's main clone/);
  await p.adopt({ id: 'slot-5', path: path.join(r.sbRoot, 'slot-5'), branch: 'e2e-r2-chaos', base: 'origin/develop', createdAt: T });
  await assert.rejects(p.adopt({ id: 'another', path: path.join(r.sbRoot, 'another'), branch: 'x', base: 'b', createdAt: T }), /max_sandboxes 2/);
  // A hard reset (BEAST's WHEA errors) can leave a freshly written file full of zero bytes: the pool falls back to the
  // version before, not to an empty pool that would make the portal forget the sandboxes' labels and agents (w424).
  assert.ok(fs.existsSync(`${stateFile}.1`), 'the previous version is kept beside it');
  fs.writeFileSync(stateFile, Buffer.alloc(512));
  const recovered = make().list().map((s) => s.id);
  assert.ok(recovered.includes('mp-r2'), `the sandboxes come back from the previous version: ${recovered.join(', ')}`);
  assert.ok(fs.readdirSync(path.dirname(stateFile)).some((f) => f.startsWith('sandboxes.json.damaged-')), 'the damaged file is kept aside');

  assert.match(p.release('mp-r2'), /Released sandbox mp-r2/);
  assert.deepEqual(p.list().map((s) => s.id), ['slot-5']);
  assert.equal(fs.existsSync(path.join(dir, 'Library', 'warm.bin')), true, 'released: folder and Library stay');
  assert.match(r.git(r.base, 'worktree', 'list'), /mp-r2/, 'still a worktree of the base clone');
  assert.throws(() => p.release('mp-r2'), /no sandbox "mp-r2"/);
});

test('beast machine: the Library seed comes first and is block-cloned; a protected folder name is refused; the total agent cap', async (t) => {
  const r = hostRepos();
  t.after(r.cleanup);
  const seed = path.join(r.root, '_seed', 'Library');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'seed.bin'), 'the warm seed');
  const copies: { src: string; mode?: string }[] = [];
  const { d } = poolDeps(r.base, { copies });
  const p = new SandboxPool(
    {
      repoPath: r.base,
      stateFile: path.join(r.root, 'app', 'sandboxes.json'),
      settings: SETTINGS(r.sbRoot, { librarySeed: seed, librarySeedCopy: 'clone', librarySeedGB: 1, protectedPaths: [path.join(r.root, 'FinalFactory')] }),
      activity: () => ({ busy: false, lastActivityMs: Date.now() }),
      onChange: () => undefined,
      onEvent: () => undefined,
    },
    d,
  );
  await p.create({ id: 'fresh', branch: 'sandbox/fresh', base: 'origin/develop', seedLibrary: true, startUnity: false });
  await until('ready', () => {
    const s = p.list().find((x) => x.id === 'fresh');
    if (s?.status === 'error') throw new Error(s.statusDetail);
    return s?.status === 'ready';
  });
  assert.deepEqual(copies, [{ src: seed, mode: 'clone' }], 'the seed, by block clone');
  assert.equal(fs.readFileSync(path.join(r.sbRoot, 'fresh', 'Library', 'seed.bin'), 'utf8'), 'the warm seed');
  await assert.rejects(p.create({ id: 'finalfactory', branch: 'sandbox/x', base: 'origin/develop', seedLibrary: false, startUnity: false }), /protected checkout/);

  assert.equal(librarySource(r.base, [], () => false, path.join(r.root, 'empty-seed')), undefined, 'an empty or missing seed is skipped');
  assert.equal(librarySource(r.base, [{ path: path.join(r.sbRoot, 'mp-r2'), status: 'ready', editorUp: false }], (dir) => fs.existsSync(path.join(dir, 'Library')), path.join(r.root, 'nope')), path.join(r.sbRoot, 'mp-r2', 'Library'));
  assert.equal(totalAgentsRefusal(5, { maxAgents: 6 }), undefined);
  assert.match(totalAgentsRefusal(6, { maxAgents: 6 })!, /already 6 agents running in this machine's sandboxes \(max_sandbox_agents 6\)/);
  assert.equal(totalAgentsRefusal(60, {}), undefined, 'no total set: none');
  assert.equal(samePath('C:\\ffsb\\_base\\.git', 'c:/ffsb/_base/.git/', 'win32'), true);
  assert.equal(samePath('/a/b', '/a/B', 'darwin'), false);
});

// ---------------------------------------------------------------- the record moves (pure)

const hostSb = (id: string, over: Partial<Sandbox> = {}): Sandbox => ({
  id,
  name: id,
  branch: `sandbox/${id}`,
  base: 'origin/develop',
  path: `F:\\ffsb\\${id}`,
  purpose: `work in ${id}`,
  status: 'ready',
  createdAt: T,
  unity: { state: 'running', pid: 41592, logPath: `F:\\ffsb\\${id}\\Logs\\sandbox-editor.log` },
  sessionIds: [`${id}-a`, `${id}-b`],
  git: { branch: 'e2e-r2-invariants-catchup', dirty: 0, untracked: 0, at: T },
  ...over,
});

const info = (id: string, where: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: id,
  status: 'stopped',
  permissionMode: 'bypassPermissions',
  createdAt: T,
  lastActivityAt: T,
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  sdkSessionId: `sdk-${id}`,
  account: 'host:login',
  ...where,
});

const beastMachine = (over: Partial<Machine> = {}): Machine => ({
  id: 'beast',
  local: true,
  host: 'localhost',
  purpose: 'unused',
  status: 'ready',
  online: true,
  repoPath: 'C:\\ffsb\\_base',
  home: 'C:\\Users\\rydin',
  portalUrl: 'http://127.0.0.1:8790',
  sessionIds: [],
  createdAt: T,
  platform: 'win32',
  sandboxRoot: 'F:\\ffsb',
  maxSandboxes: 5,
  ...over,
});

// ---------------------------------------------------------------- daemons in process

class FakeAgent implements SessionHandle {
  info: SessionInfo;
  live = false;
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  private readonly sink: SessionSink;
  private readonly events: EventEmitter;
  constructor(info: SessionInfo, sink: SessionSink, _o: unknown, events: EventEmitter) {
    this.info = info;
    this.sink = sink;
    this.events = events;
  }
  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid = 'u', _images: ImageInput[] = []) {
    this.live = true;
    this.sink.append(this.info.id, { kind: 'user', text, from, uuid });
    this.info.status = 'idle';
    this.sink.putSession(this.info);
    this.events.emit('turnEnd', this, `echo ${text}`);
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
    this.sink.putSession?.(this.info);
    this.events?.emit('ended', this);
  }
  decide() {
    return false;
  }
}

const PROBES: Probes = {
  stats: async () => ({ hostname: 'BEAST', platform: 'win32', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: GB, memFreeBytes: GB }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

test("beast machine: its agents follow machines.useHostClaudeEnv like any machine's (claudeAccounts.workers is retired, w755)", () => {
  const token = 'sk-ant-oat01-' + 'x'.repeat(40) + 'WXYZ';
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: 'C:\\claude-cfg' }, machines: { useHostClaudeEnv: { '*': true, lothdesktop: false } } };
  const beast = { id: 'beast', local: true };
  assert.equal(usesHostClaudeEnv(cfg, beast), true, 'no entry naming it: the "*" rule, local or not');
  assert.match(accountSource(cfg, beast), /host token …WXYZ/);
  // An entry naming it: the host's own stored login, with the rest of claudeEnv kept.
  const own = { ...cfg, machines: { useHostClaudeEnv: { beast: false } } };
  assert.equal(usesHostClaudeEnv(own, beast), false);
  assert.deepEqual(hostClaudeEnvFor(own, beast), { CLAUDE_CONFIG_DIR: 'C:\\claude-cfg' }, 'no credential, but the config dir stays (resumed sessions find their history)');
  assert.equal(machineUsesLogin(own, beast), true);
  assert.match(accountSource(own, beast), /login \(this host's stored Claude login/);
  assert.equal(usesHostClaudeEnv({ ...cfg, machines: { useHostClaudeEnv: { beast: true } } }, beast), true, 'an entry naming it wins');
  assert.equal(usesHostClaudeEnv(cfg, 'beast'), true, 'not known to be local: the "*" rule');
  assert.equal(usesHostClaudeEnv(cfg, 'lothdesktop'), false);
  assert.deepEqual(hostClaudeEnvFor(cfg, 'lothdesktop'), {}, 'a Mac or PC on its own login gets nothing');
});

test('beast machine: add_machine local takes its settings from the config, deploys without ssh, and is the only one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-local-'));
  let store: Store | undefined;
  t.after(() => {
    store?.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = {
    dataDir: dir,
    port: 8790,
    sandboxRoot: 'F:\\ffsb',
    repo: { url: 'https://github.com/o/g.git', basePath: 'C:\\ffsb\\_base' },
    limits: { minFreeRamGB: 10 },
    protectedPaths: ['C:\\Users\\rydin\\nevergames\\FinalFactory'],
    hostGuard: { warnFreeGB: 80, criticalFreeGB: 40 },
    unity: { mcpServer: { command: 'uvx.exe', args: ['mcp-for-unity'] }, idleStopMinutes: 120 },
  } as unknown as Config;
  const defaults = localMachineDefaults(cfg, 'C:\\ff-sandboxes');
  assert.deepEqual(
    { ...defaults },
    {
      host: 'localhost',
      portalUrl: 'http://127.0.0.1:8790',
      repoPath: 'C:\\ffsb\\_base',
      sandboxRoot: 'F:\\ffsb',
      diskWarnGB: 80,
      diskCriticalGB: 40,
      protectedPaths: ['C:\\Users\\rydin\\nevergames\\FinalFactory', 'C:\\ff-sandboxes', dir],
      unityBelowNormal: true,
    },
  );
  store = new Store(dir);
  const mm = new MachineManager(cfg, store, new SessionManager(cfg, store));
  mm.allowLocalAnywhere = true;
  mm.deployWaitMs = { settle: 1, poll: 1 };
  const seen: DeployOptions[] = [];
  mm.deployer = async (o) => {
    seen.push(o);
    return { platform: 'win32', home: 'C:\\Users\\rydin', repoPath: o.repoPath!, node: 'node.exe', nodeVersion: '24.0.0', version: 'abc1234', started: true };
  };
  // Its limits and Library seed are add_machine's (w510: the portal's own pool's limits went with it).
  const m = mm.deployMachine({ id: 'BEAST', local: true, maxUnity: 3, maxSandboxes: 5, maxAgentsPerSandbox: 6, maxSandboxAgents: 6, librarySeed: 'F:\\ffsb\\_seed\\Library', librarySeedCopy: 'clone' });
  assert.equal(m.local, true);
  assert.equal(m.name, 'BEAST');
  assert.equal(m.maxUnity, 3, 'what add_machine is given wins');
  assert.equal(m.maxSandboxes, 5);
  await until('deployed', () => seen.length === 1 && store!.machines.get('beast')!.status !== 'deploying');
  const o = seen[0];
  assert.equal(o.local, true);
  assert.equal(o.portalUrl, 'http://127.0.0.1:8790', "this server's loopback address: no Funnel round trip");
  assert.equal(o.repoPath, 'C:\\ffsb\\_base');
  assert.deepEqual(o.sandboxes, { root: 'F:\\ffsb', maxSandboxes: 5, maxAgentsPerSandbox: 6, maxUnity: 3, diskWarnGB: 80, diskCriticalGB: 40, maxAgents: 6, librarySeed: 'F:\\ffsb\\_seed\\Library', librarySeedCopy: 'clone', belowNormal: true, protectedPaths: localMachineDefaults(cfg).protectedPaths });
  assert.deepEqual(o.extra, { unityMcpServer: { command: 'uvx.exe', args: ['mcp-for-unity'] }, maxEventsFile: null, sandboxIdleStopMinutes: 120, cleanup: { everyMinutes: 0, softFreeGB: 0 } });
  assert.equal(mm.local()?.id, 'beast');
  // A redeploy (an outdated daemon) keeps the base clone as the main clone rather than re-probing for one.
  mm.deployMachine({ id: 'beast', force: true });
  await until('redeployed', () => seen.length === 2 && store!.machines.get('beast')!.status !== 'deploying');
  assert.equal(seen[1].repoPath, 'C:\\ffsb\\_base');
  assert.equal(seen[1].local, true);
  assert.throws(() => mm.deployMachine({ id: 'beast2', local: true }), /beast is already the portal's own host/);
  mm.register({ id: 'm5', host: 'm5', purpose: 'unused', status: 'ready', repoPath: '/r', home: '/h', portalUrl: 'https://p' });
  assert.throws(() => mm.deployMachine({ id: 'm5', local: true }), /a machine reached over ssh; remove it first/);
  await assert.rejects(mm.cleanupNow('beast'), /cleaned by this host's guard/);

  const json = JSON.parse(daemonConfig({ portalUrl: 'http://127.0.0.1:8790', id: 'beast', token: 't', repoPath: 'C:\\ffsb\\_base', extra: o.extra }));
  assert.deepEqual([json.maxEventsFile, json.unityMcpServer.command, json.sandboxIdleStopMinutes], [null, 'uvx.exe', 120]);
  assert.deepEqual(poolSettingsOf({ sandboxRoot: '/s' }), { root: '/s', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 20, diskCriticalGB: 10 }, 'a machine without the extras: as before');
});

test('beast machine: the local transport runs the same bootstrap without ssh; an existing task survives a non-elevated deploy', () => {
  const [cmd, args] = scriptCommand(LOCAL);
  assert.equal(cmd, 'powershell.exe');
  assert.ok(args.includes('-EncodedCommand'));
  const [sshCmd, sshArgs] = scriptCommand('lothdesktop');
  assert.equal(sshCmd, 'ssh');
  assert.deepEqual(sshArgs.slice(-args.length), args, 'the same bootstrap, over ssh');
  assert.equal(sshArgs[sshArgs.indexOf('lothdesktop') + 1], 'powershell.exe');
  const s = installScript({ sid: 'S-1-5-21-1-2-3-1001', home: 'C:\\Users\\rydin', config: '{}', node: 'C:\\nvm4w\\nodejs\\node.exe', flag: false });
  assert.match(s, /registered=kept/);
  assert.match(s, /Register it once from an administrator PowerShell: Register-ScheduledTask -TaskName FFFactoryDaemon -Xml \(Get-Content -Raw/);
});

test('beast machine: the host group lists its daemon\'s sandboxes as its own; the daemon has no group of its own', () => {
  const s = (id: string, over: Partial<SessionInfo>) => info(id, { status: 'running', ...over });
  const beast = beastMachine({ sandboxes: [{ id: 'mp-r2', branch: 'sandbox/mp-r2', base: 'origin/develop', path: 'F:\\ffsb\\mp-r2', purpose: 'unused', status: 'ready', createdAt: T, unity: { state: 'running', pid: 41592 }, sessionIds: ['w1'] }], sessionIds: ['w1'], maxUnity: 4 });
  const m5 = { ...beastMachine({ id: 'm5', local: undefined, sandboxRoot: undefined, sandboxes: [], platform: 'darwin' }) };
  const system = { hostname: 'BEAST', platform: 'win32' } as SystemStats;
  const fleet = fleetOf({ sessions: [s('w1', { machineId: 'beast', machineSandbox: 'mp-r2' })], machines: [beast, m5], system, machineStats: {} });
  assert.deepEqual(fleet.map((c) => c.key), ['host', 'm5']);
  const host = fleet[0];
  assert.equal(host.daemon?.id, 'beast');
  assert.deepEqual(host.sandboxes.map((x) => [x.key, x.machineId, x.agents.live.length]), [['beast/mp-r2', 'beast', 1]]);
  assert.deepEqual([host.sandboxLimit, host.editors, host.editorLimit, host.live, host.busy], [5, 1, 4, 1, 1]);
  const before = fleetOf({ sessions: [], machines: [m5], system, machineStats: {} });
  assert.deepEqual([before[0].daemon, before[0].sandboxes.length], [undefined, 0], 'no daemon: the portal alone, no sandboxes (w510)');
});

test('beast machine: no agent ends the daemon\'s task; the reaper never touches a daemon', async () => {
  const g = sandboxGuard({ sandboxId: 'mp-r2', sandboxPath: 'F:/ffsb/mp-r2', protectedPaths: ['C:/Users/rydin/nevergames/FinalFactory', 'C:/ff-sandboxes'] });
  const decide = async (command: string) => {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: 'F:/ffsb/mp-r2' };
    const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    return r.hookSpecificOutput?.permissionDecision ?? 'allow';
  };
  for (const c of ['schtasks /End /TN FFFactoryDaemon', 'Stop-ScheduledTask -TaskName FFFactoryDaemon', 'Get-ScheduledTask FFFactoryDaemon | Disable-ScheduledTask', 'ls C:/ff-sandboxes/data']) assert.equal(await decide(c), 'deny', c);
  assert.equal(await decide('git status'), 'allow');
  const daemonProc = { pid: 9, ppid: 1, name: 'node.exe', cmd: '"C:\\nvm4w\\nodejs\\node.exe" "C:\\Users\\rydin\\.ff-factory\\app\\machine\\daemon.ts" daemon.json', created: 0 };
  assert.equal(isProtected(daemonProc, 1), true);
  assert.equal(isProtected({ ...daemonProc, cmd: 'node shot.js' }, 1), false);
});

test('beast machine: a standing agent on it keeps the workers\' account; its daemon cleans nothing even before the first welcome', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'standing.ts'), 'utf8');
  assert.match(src, /machineRunEnv\(this\.cfg, m \?\? a\.machineId/, 'the machine record, so the local rule applies');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dclean-'));
  try {
    const d = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'beast', token: 't', repoPath: dir, appDir: dir, maxEventsFile: null, cleanup: { everyMinutes: 0, softFreeGB: 0 } }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES);
    assert.deepEqual((d as unknown as { cleanupSettings: unknown }).cleanupSettings, { everyMinutes: 0, softFreeGB: 0 });
    const other = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'm5', token: 't', repoPath: dir, appDir: path.join(dir, 'x'), maxEventsFile: null }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES);
    assert.deepEqual((other as unknown as { cleanupSettings: unknown }).cleanupSettings, { everyMinutes: 60, softFreeGB: 80 }, 'other machines: the defaults, as before');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w469: a daemon gives its agents the Unity slots mailbox, their holder and unity-slot first on their PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dslot-'));
  try {
    const slots = path.join(dir, 'slots');
    const d = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'lothdesktop', token: 't', repoPath: path.join(dir, 'FinalFactory'), appDir: dir, maxEventsFile: null, unitySlotsDir: slots }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES);
    assert.deepEqual(d.slotEnv({ sandbox: 'sb1', cwd: path.join(dir, 'ffsb', 'sb1') }), { FF_UNITY_SLOTS: slots, FF_UNITY_HOLDER: 'sandbox:sb1' }, 'before start wrote the commands: no PATH change');
    assert.equal(d.slotEnv({ cwd: path.join(dir, 'FinalFactory') }).FF_UNITY_HOLDER, undefined, 'no holder for the main clone (w536)');
    assert.equal(d.slotEnv({ cwd: path.join(dir, 'agents', 'nightly') }).FF_UNITY_HOLDER, undefined, 'a standing agent holds for itself');
    (d as unknown as { slotBin: string }).slotBin = path.join(slots, 'bin');
    const env = d.slotEnv({ sandbox: 'sb1', cwd: path.join(dir, 'ffsb', 'sb1') });
    // Windows keeps the variable as "Path": the same key, so the agent does not get two.
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH')!;
    assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH'), [key]);
    assert.equal(env[key].split(path.delimiter)[0], path.join(slots, 'bin'));
    assert.equal(d.slots.dir, slots);
    // Built without one (a test's daemon), its mailbox is its own, never the machine's real one.
    const plain = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'mx', token: 't', repoPath: path.join(dir, 'FinalFactory'), appDir: path.join(dir, 'mx'), maxEventsFile: null }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES);
    assert.equal(plain.slots.dir, path.join(dir, 'mx', 'unity-slots'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w536: a daemon manages nothing in its main clone: unity and switch there are refused, no git status, no slot place or holder, no Unity MCP outside a sandbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dmain-'));
  try {
    const d = new Daemon(
      { portalUrl: 'http://127.0.0.1:1', id: 'm5', token: 't', repoPath: path.join(dir, 'FinalFactory'), appDir: dir, maxEventsFile: null, unitySlotsDir: path.join(dir, 'slots'), unityMcpServer: { command: 'uvx', args: ['mcp-for-unity'] } },
      (i, s, o, e) => new FakeAgent(i, s, o, e),
      PROBES,
    );
    const inside = d as unknown as { send(m: unknown): void; onMessage(m: unknown): void; slots: { d: { places(): { holder: string }[] } } };
    const sent: { type: string; id?: string; ok?: boolean; text?: string; error?: string }[] = [];
    inside.send = (m) => sent.push(m as (typeof sent)[number]);
    inside.onMessage({ type: 'unity', id: 'u1', action: 'start' });
    inside.onMessage({ type: 'switch', id: 's1', branch: 'feature/x' });
    inside.onMessage({ type: 'status_now' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(sent, [
      { type: 'unity_result', id: 'u1', ok: false, text: "a machine's main clone takes no agents (w536): give a sandbox" },
      { type: 'switch_result', id: 's1', ok: false, error: "a machine's main clone takes no agents (w536): give a sandbox" },
    ], 'no git status either');
    assert.equal('unity' in d || 'unityWatch' in d, false, "no editor or watch of the main clone");
    assert.deepEqual(inside.slots.d.places().map((p) => p.holder), [], "no 'main' slot place");
    // A standing agent: no holder and no UnityMCP, but the slots mailbox like every agent.
    const standing = { cwd: path.join(dir, 'agents', 'nightly') };
    assert.deepEqual(d.slotEnv(standing), { FF_UNITY_SLOTS: path.join(dir, 'slots') });
    assert.equal(d.stdioMcpFor({ unityMcp: true }), undefined);
    assert.ok(d.stdioMcpFor({ unityMcp: true, sandbox: 'sb1' })?.UnityMCP, 'a sandbox agent still gets its bridge');
    d.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w536: a daemon refuses every agent in its main clone, and checks a standing agent against the agent cap the portal sends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-d0-'));
  try {
    type Inside = { startRefusal(s: unknown): string | undefined; onMessage(m: unknown): void; entries: Map<string, unknown> };
    const make = (id: string, extra: Record<string, unknown> = {}) =>
      new Daemon({ portalUrl: 'http://127.0.0.1:1', id, token: 't', repoPath: dir, appDir: path.join(dir, id), maxEventsFile: null, ...extra }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES) as unknown as Inside;
    // Without sandboxes (the m5), with them (LothDesktop), and with an old daemon.json max_agents of 3: the main clone is refused.
    const pool = { root: path.join(dir, 'ffsb'), maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 1, diskCriticalGB: 1 };
    for (const d of [make('m5'), make('lothdesktop', { sandboxes: pool }), make('old', { maxSessions: 3 })]) {
      assert.match(d.startRefusal({ cwd: dir })!, /this machine runs workers in sandboxes only/);
      assert.match(d.startRefusal({ cwd: dir.toUpperCase() })!, /runs workers in sandboxes only/, 'compared without case');
    }
    // A sandbox agent is judged by the sandbox rules (here: no such sandbox).
    assert.match(make('m3').startRefusal({ sandbox: 'sb1', cwd: path.join(dir, 'ffsb', 'sb1') })!, /no sandbox "sb1" on this machine/);
    // A standing agent in its own folder: the machine's agents mid-turn, in sandboxes and standing together, against the cap.
    const d = make('cap');
    d.onMessage({ type: 'welcome', machineId: 'cap', maxSessions: 2, sessions: [] });
    const standing = { cwd: path.join(dir, 'cap', 'agents', 'nightly-reader') };
    assert.equal(d.startRefusal(standing), undefined);
    const midTurn = (sandbox?: string) => ({ s: { info: { status: 'running' } }, spec: { cwd: dir, ...(sandbox ? { sandbox } : {}) }, seq: 0 });
    d.entries.set('a', midTurn('sb1'));
    d.entries.set('i', { s: { info: { status: 'idle' } }, spec: { cwd: dir, sandbox: 'sb1' }, seq: 0 });
    assert.equal(d.startRefusal(standing), undefined, 'an idle agent takes no slot');
    d.entries.set('b', midTurn());
    assert.match(d.startRefusal(standing)!, /already 2 agents mid-turn on this machine, in its sandboxes and standing agents together \(its agent cap 2\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
