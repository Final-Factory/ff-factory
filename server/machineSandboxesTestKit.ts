// The helpers of the machine sandbox tests (w5826): server/machineSandboxes*.test.ts, split out of one
// machineSandboxes.test.ts of 51 tests that took 199 s on a Windows runner, so node --test runs and shards them apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, midTurnRefusal, othersMidTurn, type SessionHandle, type SessionSink } from './sessions.ts';
import { Agents } from './agents.ts';
import { BlockerWatch } from './blockerWatch.ts';
import { Identity } from './identity.ts';
import { MachineManager, limitOptions, machineForPath, mergeSandboxes, parseSandboxRef, poolSettingsOf } from './machines.ts';
import { daemonConfig } from './machineDeploy.ts';
import { describeCleanupItems } from './cleanup.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { UnitySlots } from '../machine/unitySlots.ts';
import type { BenchTicket } from '../machine/benchQueue.ts';
import { EDITOR_TICKET_RETRY_MS, SandboxPool, type PoolOptions, deletable, idleSandboxEditors, lfsDedup, lfsDedupWords, librarySource, treeBytes, type PoolDeps, type SandboxEditor } from '../machine/sandboxes.ts';
import { DISK_CRITICAL_GB_DEFAULT, DISK_WARN_GB_DEFAULT } from '../shared/types.ts';
import { copyTree, removeTree, run } from './proc.ts';
import { readGitStatus } from './gitStatus.ts';
import { borrowsFrom, configText, finishConversion, gitPathForm, isSlotRepo, isWorktree, keptStashPrefix, worktreeRecordOf } from '../machine/slotRepo.ts';
import { testRepos } from './testMachine.ts';
import type { Config } from './config.ts';
import type { GitStatus, ImageInput, PermissionMode, SandboxPoolSettings, SessionInfo, WorkItem } from '../shared/types.ts';
import { pairRoom, warmText } from '../shared/capacity.ts';


// Daemons started here keep their Unity slots mailbox in a folder of their own, not the real one in the home folder.
process.env.FF_UNITY_SLOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-slots-'));

export const GB = 1024 ** 3;

export const until = async (what: string, cond: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A bare origin and the machine's main clone of it (on master), with a warm Library the clone never commits. */
export const repos = () => testRepos();

/** Real git, copy and delete; a stand-in editor (no Unity), and free space the test sets. */
export function deps(repoPath: string, o: { free?: () => number | undefined; copyBytes?: number; bridge?: (project: string, since: number | undefined, running: Set<string>) => boolean } = {}) {
  const running = new Set<string>();
  const d: PoolDeps = {
    git: (args, opts = {}) => run('git', ['-C', repoPath, ...args], { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
    copyTree: (src, dst, signal) => copyTree(src, dst, { signal }),
    ...(o.copyBytes !== undefined ? { libraryCopyBytes: async () => o.copyBytes } : {}),
    removeTree,
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
    bridgeUp: (p, since) => (o.bridge ? o.bridge(p, since, running) : running.has(p)),
    gitStatus: readGitStatus,
    now: () => Date.now() + clockSkew.ms,
  };
  return { d, running };
}

export const SETTINGS = (root: string, over: Partial<SandboxPoolSettings> = {}): SandboxPoolSettings => ({ root, maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 1, diskWarnGB: 50, diskCriticalGB: 20, ...over });

export function pool(r: ReturnType<typeof repos>, o: { free?: () => number | undefined; copyBytes?: number; settings?: Partial<SandboxPoolSettings>; activity?: (id: string) => { busy: boolean; lastActivityMs: number }; idle?: number; slots?: () => UnitySlots; liveAgents?: (id: string) => number; trim?: PoolOptions['trim']; trimmer?: PoolOptions['trimmer']; releaseSweep?: PoolOptions['releaseSweep']; log?: (l: string) => void; reseedIdleDays?: number; bootTicket?: PoolOptions['bootTicket']; warm?: string[]; bridge?: (project: string, since: number | undefined, running: Set<string>) => boolean; awaitConfigure?: boolean; storeLocked?: () => boolean } = {}) {
  const events: { text: string; checkpoint?: boolean }[] = [];
  /** The status of each sandbox at every change the portal would be sent, consecutive repeats dropped (w898: the cleanup state's order). */
  const statuses: string[] = [];
  const { d, running } = deps(r.main, o);
  const created: { p?: SandboxPool } = {};
  const p = new SandboxPool(
    {
      repoPath: r.main,
      stateFile: path.join(r.root, 'app', 'sandboxes.json'),
      settings: SETTINGS(r.sbRoot, o.settings),
      activity: o.activity ?? (() => ({ busy: false, lastActivityMs: Date.now() })),
      onChange: () => {
        const s = created.p?.list().map((x) => `${x.id}:${x.status}`).join(',') ?? '';
        if (s && statuses.at(-1) !== s) statuses.push(s);
      },
      onEvent: (e) => events.push(e),
      idleStopMinutes: o.idle,
      ...(o.liveAgents ? { liveAgents: o.liveAgents } : {}),
      ...(o.trim !== undefined ? { trim: o.trim } : {}),
      ...(o.trimmer ? { trimmer: o.trimmer } : {}),
      ...(o.releaseSweep ? { releaseSweep: o.releaseSweep } : {}),
      ...(o.log ? { log: o.log } : {}),
      ...(o.reseedIdleDays !== undefined ? { reseedIdleDays: o.reseedIdleDays } : {}),
      ...(o.warm ? { warm: o.warm } : {}),
      librarySeedGB: 1,
      ...(o.awaitConfigure ? { awaitConfigure: true } : {}),
      ...(o.storeLocked ? { storeLocked: o.storeLocked } : {}),
      ...(o.bootTicket ? { bootTicket: o.bootTicket } : {}),
      ...(o.slots ? { editorSlot: (id: string) => o.slots!().startRefusal(`sandbox:${id}`), slotsStatus: async () => (await o.slots!().tick(), o.slots!().describe()) } : {}),
    },
    d,
  );
  created.p = p;
  return { p, events, running, statuses };
}

export const ready = (p: SandboxPool, id: string) => until(`${id} ready`, () => {
  const s = p.list().find((x) => x.id === id);
  if (s?.status === 'error') throw new Error(`${id} failed: ${s.statusDetail}`);
  return s?.status === 'ready';
});

// ---------------------------------------------------------------- the pool, against real git (CI runs this on Windows too)

/** A bench ticket the test grants or fails by hand (machine/benchQueue.ts BenchTicket's wait/release). */
/** w1860: moves the pools' clock forward (a test that waits out EDITOR_TICKET_RETRY_MS); put back after each use. */
export const clockSkew = { ms: 0 };

export function fakeTicket() {
  const t = {
    kind: 'waiting' as 'waiting' | 'granted' | 'failed',
    line: 'shared ticket, place 2, waiting for t00000001 exclusive probe A round 2',
    released: 0,
    async wait(ms = Infinity, onLine?: (l: string) => void) {
      const until = Date.now() + ms;
      onLine?.(t.line);
      while (t.kind === 'waiting' && Date.now() < until && !t.released) await new Promise((r) => setTimeout(r, 20));
      return t.kind === 'granted' ? { kind: 'granted' as const, ticket: 't00000002', line: 'granted t00000002' } : t.kind === 'failed' ? { kind: 'failed' as const, line: 'gave up' } : { kind: 'waiting' as const, line: t.line };
    },
    state() {
      return t.kind === 'granted' ? { kind: 'granted' as const, ticket: 't00000002', line: 'granted t00000002' } : t.kind === 'failed' ? { kind: 'failed' as const, line: 'revoked t00000002 at x: its turn is over' } : { kind: 'waiting' as const, line: t.line };
    },
    release() {
      t.released++;
    },
  };
  return t;
}

// ---------------------------------------------------------------- portal <-> daemon, end to end

export class FakeAgent implements SessionHandle {
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
    this.sink.putSession(this.info);
    this.events.emit('ended', this);
  }
  decide() {
    return false;
  }
}

export const PROBES: Probes = {
  stats: async () => ({ hostname: 'pc', platform: 'win32', cpuModel: 'x', cpuCount: 1, loadPct: 0, memTotalBytes: GB, memFreeBytes: GB }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

/** A portal with a machine `pc` (a real daemon and git) holding two ready sandboxes, sb1 on feature/w1 and sb2 (w640, w890). */
export async function twoSandboxes(t: { after: (fn: () => void | Promise<void>) => void }) {
  const r = repos();
  const cfg = {
    dataDir: path.join(r.root, 'data'),
    sandboxRoot: path.join(r.root, 'host-sb'),
    standingRoot: path.join(r.root, '_agents'),
    repo: { url: 'x', basePath: path.join(r.root, 'base') },
    defaultBase: 'origin/master',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 6, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'default', effort: 'low' },
    unity: {},
  } as unknown as Config;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, mm, new Identity(cfg, () => []));
  mm.hooks = {
    specFor: (info, m) => {
      const sb = mm.requireSandbox(m.id, info.machineSandbox!);
      return { cwd: sb.path, sandbox: sb.id, settingSources: [], append: '', strictMcp: true, guard: { id: sb.id, ownPath: sb.path, protectedPaths: [], gameRepos: [] } };
    },
    handlersFor: () => ({}),
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', repoPath: r.main, home: r.root, portalUrl: url, sandboxRoot: r.sbRoot, maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 1 });
  const { d: poolDeps } = deps(r.main);
  const daemon = new Daemon({ portalUrl: url, id: 'pc', token, repoPath: r.main, appDir: path.join(r.root, 'app'), claude: 'no-such-claude', maxSessions: 4, maxEventsFile: null, sandboxCacheTrim: false }, (i, s, o, e) => new FakeAgent(i, s, o, e), PROBES, poolDeps);
  t.after(async () => {
    agents.orchestrators.close();
    clearInterval(agents.placeAgainTick);
    daemon.shutdown();
    server.close();
    // The link's close comes after the last update the daemon sent; then the saves land before the folders go (w1758: a
    // fixed 300 ms wait here was a guess at it, which a slow Windows runner can outlast).
    await until('the daemon gone', () => !mm.isOnline('pc'), 5000).catch(() => undefined);
    store.flush();
    await store.saved();
    r.cleanup();
  });
  daemon.start();
  await until('online with hello', () => mm.isOnline('pc') && !!store.machines.get('pc')?.info);
  await mm.createSandbox('pc', { name: 'sb1', branch: 'feature/w1' });
  await mm.createSandbox('pc', { name: 'sb2' });
  const sbOf = (id: string) => store.machines.get('pc')?.sandboxes?.find((s) => s.id === id);
  await until('both ready', () => sbOf('sb1')?.status === 'ready' && sbOf('sb2')?.status === 'ready');
  const path1 = sbOf('sb1')!.path;
  const path2 = sbOf('sb2')!.path;
  // A sandbox's git state read now, as the daemon's own look reads it (every 30 s), and reported to the portal. Not the
  // portal's copy alone (w3337): the daemon's next report, such as its first look with settings about 30 s after it
  // starts, carries the daemon's own older read and replaced it, so the release pass read git from before the worker's
  // last activity and released nothing (keptWhy), in about half of the full-suite runs.
  const pool = (daemon as unknown as { pool: { ticking: boolean; git: Map<string, GitStatus | undefined> } }).pool;
  const report = () => (daemon as unknown as { reportSandboxes: () => void }).reportSandboxes();
  const gitNow = async (id: string) => {
    // A look in flight writes what it read before this one: let it finish first.
    await until('no daemon look in flight', () => !pool.ticking);
    const g = await readGitStatus(sbOf(id)!.path);
    pool.git.set(id, g);
    report();
    await until('the portal has this read or a newer one', () => Date.parse(sbOf(id)?.git?.at ?? '') >= Date.parse(g?.at ?? ''));
  };
  const onDaemon = (id: string) => (daemon as unknown as { entries: Map<string, { spec?: { cwd: string } }> }).entries.get(id);
  return { r, store, sessions, mm, agents, sbOf, path1, path2, gitNow, onDaemon };
}

// ---------------------------------------------------------------- release trims the Library caches (w898)

/** Library/BuildCache and Library/BurstCache files in a sandbox: three Burst player builds (the oldest is stale, w2752) and live entries. */
export function fillCaches(dir: string) {
  const make = (rel: string, hours: number) => {
    const f = path.join(dir, 'Library', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x'.repeat(2000));
    const at = new Date(Date.now() - hours * 3_600_000);
    fs.utimesSync(f, at, at);
  };
  const lib = (c: string) => `BurstCache/Windows-Intel/${c.repeat(32)}.dll`;
  make('BuildCache/ab/h1/v1/old', 24 * 9);
  make('BuildCache/ab/h2/v1/new', 2);
  make(lib('a'), 24 * 9);
  make(lib('b'), 4);
  make(lib('c'), 2);
  make('BurstCache/JIT/old.dll', 24 * 9);
  make('ArtifactDB/keep', 24 * 9);
  return { gone: [lib('a')], kept: ['BuildCache/ab/h1/v1/old', 'BuildCache/ab/h2/v1/new', lib('b'), lib('c'), 'BurstCache/JIT/old.dll', 'ArtifactDB/keep'] };
}
