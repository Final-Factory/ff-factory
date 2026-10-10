// A machine for tests (w510): a real Daemon in this process with a pool of real git worktrees, a stand-in Unity editor
// and fake probes, linked to a MachineManager over a real WebSocket. Agents there are the daemon's own AgentSessions, so
// the scripted fake SDK a test installs with setQueryForTesting (e2e/fakeAgent.ts) answers them as it answers host ones.
// Test-only: no production code imports it. Nothing here touches the real home folder: the daemon's folder, Unity slots,
// agents' temp folders and its clean-up settings are all inside the machine's own temp root, and its clean-up never runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Daemon, type Probes, type SessionFactory } from '../machine/daemon.ts';
import { SandboxPool, type PoolDeps, type SandboxEditor } from '../machine/sandboxes.ts';
import { mergeSandboxes, type MachineManager } from './machines.ts';
import { machineAttachment } from './attachments.ts';
import { copyTree, removeTree, run, type RunResult } from './proc.ts';
import { readGitStatus } from './gitStatus.ts';
import { bus } from './store.ts';
import type { GitStatus, Machine, MachineSandbox, SandboxPoolSettings } from '../shared/types.ts';
import type { TrimPolicy } from './cacheTrim.ts';

export const GB = 1024 ** 3;

/** Wait for `cond`, polling every `step` ms; throws naming `what` after `ms`. */
export async function until(what: string, cond: () => boolean, ms = 60_000, step = 25) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, step));
  }
}

export interface TestRepos {
  root: string;
  origin: string;
  /** The machine's main clone, on develop, with a warm Library it never commits. */
  main: string;
  /** Where its sandboxes go. */
  sbRoot: string;
  git: (dir: string, ...a: string[]) => string;
  cleanup: () => void;
}

const gitIn = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe', windowsHide: true }).toString().trim();

/** The first testRepos of this process, made with git; the others are copies of it (one git call instead of six). */
let template: string | undefined;
function repoTemplate(): string {
  if (template && fs.existsSync(template)) return template;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-msb-template-'));
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'FinalFactory');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin], { windowsHide: true });
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'pipe', windowsHide: true });
  gitIn(main, 'switch', '-q', '-c', 'develop');
  fs.writeFileSync(path.join(main, '.gitignore'), 'Library/\nLogs/\nTemp/\n');
  fs.writeFileSync(path.join(main, 'README.md'), 'game\n');
  gitIn(main, 'add', '.gitignore', 'README.md');
  gitIn(main, 'commit', '-q', '-m', 'base');
  gitIn(main, 'push', '-q', '-u', 'origin', 'develop');
  fs.mkdirSync(path.join(main, 'Library', 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(main, 'Library', 'Artifacts', 'warm.bin'), 'imported');
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return (template = root);
}

/** A bare origin and the machine's main clone of it (on develop), with a warm Library the clone never commits. */
export function testRepos(prefix = 'ff-msb-', parent = os.tmpdir()): TestRepos {
  fs.mkdirSync(parent, { recursive: true });
  const from = repoTemplate();
  const root = fs.mkdtempSync(path.join(parent, prefix));
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'FinalFactory');
  fs.cpSync(path.join(from, 'origin.git'), origin, { recursive: true });
  fs.cpSync(path.join(from, 'FinalFactory'), main, { recursive: true });
  gitIn(main, 'remote', 'set-url', 'origin', origin);
  const sbRoot = path.join(root, 'ffsb');
  return { root, origin, main, sbRoot, git: gitIn, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

/**
 * Real git, copy and delete; a stand-in editor (no Unity), and free space the test sets. `close()` refuses new ones and
 * waits for those still running (w759): the daemon's pool reads a sandbox's git status on its tick, after a switch or a
 * save, and the daemon's own stop waits for none of it. That `git -C <worktree>` has the worktree as its current folder,
 * and Windows refuses to delete a folder a live process is in (EPERM "Permission denied", ERROR_ACCESS_DENIED), so a
 * machine's clean-up that ran while one was still going failed, in whichever test stopped a machine at that moment.
 */
export function fakePoolDeps(repoPath: string, o: { free?: () => number | undefined } = {}) {
  const running = new Set<string>();
  const inflight = new Set<Promise<unknown>>();
  let closed = false;
  /** Per worktree: what the git look finds besides git's own answer (an open PR: gh is not there in tests). */
  const gitExtra = new Map<string, Partial<GitStatus>>();
  const track = <T>(start: () => Promise<T>, whenClosed: () => Promise<T>): Promise<T> => {
    if (closed) return whenClosed();
    const p = start();
    inflight.add(p);
    p.then(
      () => inflight.delete(p),
      () => inflight.delete(p),
    );
    return p;
  };
  const stopped: RunResult = { code: 1, stdout: '', stderr: 'the test machine is stopping' };
  const d: PoolDeps = {
    git: (args, opts = {}) => track(() => run('git', ['-C', repoPath, ...args], { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }), async () => stopped),
    copyTree: (src, dst, signal) => track(() => copyTree(src, dst, { signal }), () => Promise.reject(new Error(stopped.stderr))),
    removeTree: (dir) => track(() => removeTree(dir), async () => stopped),
    freeBytes: async () => (o.free ? o.free() : 500 * GB),
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
        status: async () => (running.has(sb.path) ? 'running: pid 4242' : 'not running'),
        editors: () => (running.has(sb.path) ? [{ pid: 4242, ppid: 1, cmd: `Unity -projectPath ${sb.path}` }] : []),
      },
    }),
    bridgeUp: (p) => running.has(p),
    gitStatus: (dir) =>
      track(
        async () => {
          const g = await readGitStatus(dir);
          const extra = gitExtra.get(path.resolve(dir));
          return g && extra ? { ...g, ...extra } : g;
        },
        async () => undefined,
      ),
    now: () => Date.now(),
  };
  const close = async () => {
    closed = true;
    while (inflight.size) await Promise.allSettled([...inflight]);
  };
  return { d, running, close, gitExtra };
}

/** A Windows PC with nothing on its own Claude login. */
export const FAKE_PROBES: Probes = {
  stats: async () => ({ hostname: 'pc', platform: 'win32', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: GB, memFreeBytes: GB }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

/** Clean-up never runs by itself on a test machine: it would plan over the real home and temp folders. */
const NO_CLEANUP = { everyMinutes: 0, softFreeGB: 0 };

export interface TestMachineOptions {
  /** Machine id (default "pc"). */
  id?: string;
  /** Sandboxes made before the daemon starts (ready, from origin/develop, on sandbox/<name> unless given), with their labels. */
  sandboxes?: (string | { name: string; branch?: string })[];
  /** The portal's address when it already serves /machine (the e2e server); else the machine gets a stand-in portal of its own. */
  portalUrl?: string;
  /** The pool's limits. */
  maxSandboxes?: number;
  maxAgentsPerSandbox?: number;
  maxUnity?: number;
  /** The daemon's agents (default: the real AgentSession, answered by whatever query the test installed). */
  makeSession?: SessionFactory;
  /** The daemon's trim of a released sandbox's Library caches (default off in tests, so no sandbox is ever briefly 'cleanup'). */
  cacheTrim?: Partial<TrimPolicy> | false;
  /** Free bytes on the sandbox volume (default 500 GB). */
  free?: () => number | undefined;
  /** Temp folder prefix, and the folder it is made in (default the system temp folder). */
  prefix?: string;
  parent?: string;
}

export interface TestMachine {
  id: string;
  repos: TestRepos;
  /** Sandbox paths whose stand-in editor runs. */
  running: Set<string>;
  /** Pool settings, as the portal's record gives them (sandboxRoot and the limits). */
  settings: SandboxPoolSettings;
  /** "<machine>/<sandbox>", as tools and the API name a machine sandbox. */
  ref(name: string): string;
  /** A sandbox's worktree. */
  path(name: string): string;
  /** What to put in a seeded state.json's machines before the portal boots: the sandboxes made so far, labelled, with these agents. */
  record(sessionsBySandbox?: Record<string, string[]>): Machine;
  /** Register on `mm` (keeping a seeded record's sandboxes and agents), start the daemon and wait for its sandboxes on the portal. */
  connect(mm: MachineManager): Promise<void>;
  /** The connected daemon. */
  daemon?: Daemon;
  /**
   * From now on the daemon's git look at sandbox `name` also finds `extra` (an open PR, which gh would find), and it looks
   * now: its report reaches the portal like any other. A test that wrote git into the portal's record instead lost it to
   * the daemon's next report, whenever that came (w759).
   */
  gitLook(name: string, extra: Partial<GitStatus>): Promise<void>;
  /** Shut the daemon down, close the stand-in portal and remove every folder. */
  stop(): Promise<void>;
}

/**
 * A machine with sandboxes made and ready, not yet connected: the e2e server seeds its record before the portal boots,
 * then connects it. Unit tests use startTestMachine.
 */
export async function createTestMachine(o: TestMachineOptions = {}): Promise<TestMachine> {
  const id = o.id ?? 'pc';
  const repos = testRepos(o.prefix, o.parent);
  const appDir = path.join(repos.root, 'app');
  const settings: SandboxPoolSettings = { root: repos.sbRoot, maxSandboxes: o.maxSandboxes ?? 8, maxAgentsPerSandbox: o.maxAgentsPerSandbox ?? 4, maxUnity: o.maxUnity ?? 1, diskWarnGB: 50, diskCriticalGB: 20 };
  const { d: poolDeps, running, close: closePoolDeps, gitExtra } = fakePoolDeps(repos.main, { free: o.free });
  const wanted = (o.sandboxes ?? []).map((s): { name: string; branch?: string } => (typeof s === 'string' ? { name: s } : s));
  // The daemon's own pool code makes them, into the state file the daemon reads when it starts.
  const pool = new SandboxPool({ repoPath: repos.main, stateFile: path.join(appDir, 'sandboxes.json'), settings, activity: () => ({ busy: false, lastActivityMs: 0 }), onChange: () => undefined, onEvent: () => undefined, idleStopMinutes: 0 }, poolDeps);
  for (const s of wanted) await pool.create({ id: s.name, branch: s.branch ?? `sandbox/${s.name}`, base: 'origin/develop', seedLibrary: false, startUnity: false });
  await until('the test machine sandboxes', () => {
    const bad = pool.list().find((s) => s.status === 'error');
    if (bad) throw new Error(`test sandbox ${bad.id} failed: ${bad.statusDetail}`);
    return pool.list().every((s) => s.status === 'ready');
  });

  let server: http.Server | undefined;
  let daemon: Daemon | undefined;
  let portal: MachineManager | undefined;
  const base = (portalUrl: string): Omit<Machine, 'online' | 'sessionIds' | 'createdAt'> => ({
    id,
    portalUrl,
    host: id,
    purpose: 'unused',
    status: 'ready',
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    repoPath: repos.main,
    home: repos.root,
    appDir,
    tempDir: path.join(repos.root, 'tmp'),
    sandboxRoot: settings.root,
    maxSandboxes: settings.maxSandboxes,
    maxAgentsPerSandbox: settings.maxAgentsPerSandbox,
    maxUnity: settings.maxUnity,
  });
  const m: TestMachine = {
    id,
    repos,
    running,
    settings,
    ref: (name) => `${id}/${name}`,
    path: (name) => path.join(repos.sbRoot, name),
    async gitLook(name, extra) {
      gitExtra.set(path.resolve(repos.sbRoot, name), extra);
      const p = (daemon as unknown as { pool: { lastGitAt: number; tick(): Promise<void> } } | undefined)?.pool;
      if (!p) throw new Error(`machine ${id} is not connected`);
      p.lastGitAt = 0;
      await p.tick();
    },
    record: (bySandbox = {}) => {
      const sandboxes: MachineSandbox[] = mergeSandboxes([], pool.list()).map((sb) => ({ ...sb, sessionIds: bySandbox[sb.id] ?? [] }));
      return { ...base(o.portalUrl ?? ''), online: false, createdAt: new Date(0).toISOString(), sessionIds: Object.values(bySandbox).flat(), sandboxes };
    },
    async connect(mm) {
      portal = mm;
      let url = o.portalUrl;
      if (!url) {
        // A stand-in portal: the /machine socket and the attachment downloads a daemon makes (as index.ts serves them).
        server = http.createServer((req, res) => {
          const file = req.method === 'GET' ? /^\/machine\/attachments\/(att_[a-z0-9]{12})$/.exec(req.url ?? '') : null;
          if (!file || !mm.attachments) return void res.writeHead(404).end();
          const r = machineAttachment(mm.attachments, mm.authenticate(req.headers.authorization), file[1]);
          if ('error' in r) return void res.writeHead(r.status).end(r.error);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(r.record.size) });
          fs.createReadStream(r.file).pipe(res);
        });
        server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
        await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      }
      // A record seeded before the portal booted keeps its sandboxes (their labels and agents) and its agents.
      const { online: _o, sessionIds: _s, createdAt: _c, ...prev } = mm.list().find((x) => x.id === id) ?? ({} as Partial<Machine>);
      const { token } = mm.register({ ...prev, ...base(url) });
      // Never the portal's clean-up settings for it either (a machine that is not local gets config machines.cleanup).
      const cleanupFor = mm.cleanupFor;
      mm.cleanupFor = (mid) => (mid === id || !cleanupFor ? NO_CLEANUP : cleanupFor(mid));
      // Never this computer's own Unity MCP entry from ~/.claude.json: a command nothing runs (the fake SDK starts no stdio server).
      const busBefore = new Set(bus.listeners('event'));
      daemon = new Daemon(
        { portalUrl: url, id, token, agentHosts: false, repoPath: repos.main, appDir, tempDir: path.join(repos.root, 'tmp'), unitySlotsDir: path.join(repos.root, 'slots'), claude: 'no-such-claude', maxEventsFile: null, sandboxes: settings, sandboxIdleStopMinutes: 0, sandboxCacheTrim: o.cacheTrim ?? false, cleanup: NO_CLEANUP, unityMcpServer: { command: 'no-such-unity-mcp', args: [] } },
        o.makeSession,
        FAKE_PROBES,
        poolDeps,
      );
      // In one process the daemon and the portal share the event bus: the daemon's agents' text deltas already reach the
      // portal's pages there, and the daemon forwarding them too would loop (the portal re-emits each on the same bus,
      // where the daemon hears it again). So its forwarder goes; every other message still crosses the WebSocket.
      for (const l of bus.listeners('event')) if (!busBefore.has(l)) bus.off('event', l);
      // No keep-awake process (caffeinate, or a PowerShell that waits for this process to exit): one started by a late
      // signal once the daemon is stopped would keep the test run alive.
      (daemon as unknown as { awake: () => void }).awake = () => undefined;
      m.daemon = daemon;
      daemon.start();
      const names = pool.list().map((s) => s.id);
      await until(`machine ${id} online with its sandboxes`, () => {
        const rec = mm.list().find((x) => x.id === id);
        return mm.isOnline(id) && !!rec?.info && names.every((n) => rec.sandboxes?.some((s) => s.id === n && s.status === 'ready'));
      });
    },
    async stop() {
      daemon?.shutdown();
      server?.close();
      // The last session and machine updates have landed once the portal has the link's close: they came before it.
      if (portal) await until(`machine ${id} offline`, () => !portal!.isOnline(id), 5000, 10).catch(() => undefined);
      // No git still running in a sandbox when its folder goes (fakePoolDeps).
      await closePoolDeps();
      repos.cleanup();
    },
  };
  return m;
}

/** A machine with these sandboxes, connected to `mm` and ready for agents. */
export async function startTestMachine(mm: MachineManager, o: TestMachineOptions = {}): Promise<TestMachine> {
  const m = await createTestMachine(o);
  try {
    await m.connect(mm);
  } catch (e) {
    await m.stop();
    throw e;
  }
  return m;
}
