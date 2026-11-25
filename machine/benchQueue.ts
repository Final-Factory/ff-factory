// A machine's bench queue (w1615, lothsahn 2026-10-20: "a queued bench lock that also covers builds"): the game repo's
// scripts/bench/bench_queue.py keeps a first-come, first-served queue under <FF_WORKER_ROOT>/daemon/bench.queue (w5545). A timed
// bench leg takes an `exclusive` ticket and runs alone; a player build, a batch compile or an editor boot takes a
// `shared` one, which runs beside other shared ones but never beside an exclusive one. The game repo's
// Documentation/Bench-Lock.md has the design and its deadlock argument.
//
// The queue lives on OS file locks (flock, msvcrt), which node cannot take, so a ticket here is the game repo's own
// helper (`bench_queue.py hold`) run as a child: it takes the ticket for this process (its owner pid), writes its
// state to a status file, and lets go when the file `<status>.release` appears or this process dies. Every failure
// to run it (no python, a checkout from before w1615) fails open: the launch goes ahead without a ticket, said in the log.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { rpcCall, RpcRefused } from './daemonRpc.ts';
import { trustedGh, trustedPython } from './evidenceGate.ts';
import { ghAppPaths, readGhAppTokens } from './ghApp.ts';
import { appTokenFor } from '../shared/githubAppRoute.ts';

export type BenchMode = 'shared' | 'exclusive';

/** The game repo's queue script under a checkout, when that checkout has it. */
export function benchQueueScript(checkout: string | undefined): string | undefined {
  if (!checkout) return undefined;
  const p = path.join(checkout, 'scripts', 'bench', 'bench_queue.py');
  return fs.existsSync(p) ? p : undefined;
}

/** The first checkout among `dirs` (or a folder above one of them) that has the queue script. */
export function findBenchQueueScript(dirs: (string | undefined)[]): string | undefined {
  for (const d of dirs) {
    let cur = d ? path.resolve(d) : undefined;
    for (let i = 0; cur && i < 8; i++) {
      const s = benchQueueScript(cur);
      if (s) return s;
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return undefined;
}

/** The newest scripts/bench/bench_queue.py among <root>/sandboxes/* (w1628), or undefined. */
export function sandboxBenchQueueScript(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const dir = path.join(root, 'sandboxes');
  let best: { s: string; t: number } | undefined;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const n of names) {
    const s = benchQueueScript(path.join(dir, n));
    if (!s) continue;
    try {
      const t = fs.statSync(s).mtimeMs;
      if (!best || t > best.t) best = { s, t };
    } catch {
      // gone meanwhile
    }
  }
  return best?.s;
}

/** A copy's queue rules version (bench_queue.py RULES_VERSION, w1962); 0 for a copy from before it, or unreadable. */
export function rulesVersion(script: string): number {
  try {
    const m = /^RULES_VERSION = (\d+)/m.exec(fs.readFileSync(script, 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * The queue script a ticket runs under (w1962): the copy with the newest rules among the checkout's own and every
 * sandbox's, the checkout's own on a tie. Each ticket's helper applies its own copy's rules at every look, and a branch
 * that has not merged master for a while carries old ones: on LothDesktop, 2026-10-24, slot5's copy (from before w1860)
 * set a deadline on t00000936 that the newer copies dropped again, every second for an hour, so the turn never ended.
 */
export function newestBenchQueueScript(checkouts: (string | undefined)[], root: string | undefined): string | undefined {
  const own = findBenchQueueScript(checkouts);
  let best = own ? { s: own, v: rulesVersion(own) } : undefined;
  const dir = root ? path.join(root, 'sandboxes') : undefined;
  let names: string[] = [];
  try {
    names = dir ? fs.readdirSync(dir).sort() : [];
  } catch {
    // no sandboxes here
  }
  for (const n of names) {
    const s = benchQueueScript(path.join(dir!, n));
    if (!s) continue;
    const v = rulesVersion(s);
    if (!best || v > best.v) best = { s, v };
  }
  return best?.s ?? sandboxBenchQueueScript(root);
}

/** The lock dir the queue sits beside: $BENCH_LOCK, else <root>/daemon/bench.lock (w5545: the daemon's own folder; benchLock.ts benchLockDir). */
export function benchLockPath(root: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BENCH_LOCK) return env.BENCH_LOCK;
  const r = root ?? env.FF_WORKER_ROOT;
  return r ? path.join(r, 'daemon', 'bench.lock') : undefined;
}

/** The python the queue runs under: FF_PYTHON, else python on Windows and python3 elsewhere (the game repo's choice). */
export const pythonExe = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) =>
  env.FF_PYTHON || (platform === 'win32' ? 'python' : 'python3');

export interface BenchTicketOptions {
  script: string;
  lock: string;
  mode: BenchMode;
  what: string;
  /** Lower the hold bound for this ticket (bench_queue.py MAX_HOLD_MIN; it can only lower it). */
  maxMin?: number;
  python?: string;
  env?: NodeJS.ProcessEnv;
  /** Where its status file goes (default the OS temp folder). */
  tempDir?: string;
  /** An exclusive ticket's reason (bench_queue.py --reason, w1832/w1948): 'timing' for a timed run. */
  reason?: 'timing' | 'machine';
  /** The process the ticket follows (default this one); w1996: a timed run's own owner child, so BenchTurn spares only it. */
  ownerPid?: number;
  /**
   * w4624: an exclusive ticket taken again for the same waiting work after a daemon restart keeps this earlier place
   * (the lost ticket's number, `bench_queue.py hold --place`). Passed only to a copy that knows the flag (supportsPlace).
   */
  place?: number;
  /** w5572: the python's own arguments before the script (`-s` for the trusted copy). */
  pythonArgs?: string[];
  /** w5572: the helper's working folder (the trusted copy's own, never a sandbox: Windows looks in it for ps, git, bash). */
  cwd?: string;
}

/** Whether a copy of the queue script takes `hold --place` (w4624); a copy from before it would refuse the flag. */
export function supportsPlace(script: string): boolean {
  try {
    return fs.readFileSync(script, 'utf8').includes('"--place"');
  } catch {
    return false;
  }
}

/**
 * w4624: the copy a ticket that keeps its place runs under: `script` when it takes --place, else another copy here of the
 * same rules version or newer that does (a sandbox whose branch merged master first), else undefined (the ticket then
 * queues without its place, as before).
 */
export function placeScript(script: string, checkouts: (string | undefined)[], root: string | undefined): string | undefined {
  if (supportsPlace(script)) return script;
  const v = rulesVersion(script);
  const dir = root ? path.join(root, 'sandboxes') : undefined;
  let names: string[] = [];
  try {
    names = dir ? fs.readdirSync(dir).sort() : [];
  } catch {
    // no sandboxes here
  }
  const copies = [findBenchQueueScript(checkouts), ...names.map((n) => benchQueueScript(path.join(dir!, n)))];
  return copies.find((s): s is string => !!s && rulesVersion(s) >= v && supportsPlace(s));
}

export type TicketState =
  | { kind: 'waiting'; line: string }
  | { kind: 'granted'; ticket: string; line: string }
  | { kind: 'failed'; line: string };

/** One ticket held for this process by a `bench_queue.py hold` child. */
export class BenchTicket {
  readonly status: string;
  private child?: ChildProcess;
  private exited?: string;
  private released = false;
  private readonly o: BenchTicketOptions;

  constructor(o: BenchTicketOptions) {
    this.o = o;
    this.status = path.join(o.tempDir ?? os.tmpdir(), `ff-bench-${process.pid}-${randomBytes(4).toString('hex')}`);
  }

  /** The earlier place this ticket was taken at (w4624), when the helper was asked to keep one. */
  get keptPlace(): number | undefined {
    return this.o.mode === 'exclusive' ? this.o.place : undefined;
  }

  /** Start the helper: it numbers the ticket and starts waiting. */
  take(): this {
    const args = [this.o.script, '--lock', this.o.lock, 'hold', '--mode', this.o.mode, '--what', this.o.what, '--owner-pid', String(this.o.ownerPid ?? process.pid), '--status', this.status];
    if (this.o.maxMin) args.push('--max-min', String(this.o.maxMin));
    if (this.o.reason) args.push('--reason', this.o.reason);
    if (this.o.place !== undefined && this.o.mode === 'exclusive') args.push('--place', String(this.o.place));
    try {
      // w5545: a helper this process starts holds the ticket itself (the daemon's own, or a worker's without the RPC): with
      // the daemon's token it would ask the daemon again (the game repo's bench_queue.py proxies whenever both are set).
      const { FF_DAEMON_RPC: _r, FF_DAEMON_TOKEN: _t, ...env } = this.o.env ?? process.env;
      this.child = spawn(this.o.python ?? pythonExe(this.o.env), [...(this.o.pythonArgs ?? []), ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env, ...(this.o.cwd ? { cwd: this.o.cwd } : {}) });
    } catch (e) {
      this.exited = (e as Error).message;
      return this;
    }
    let err = '';
    this.child.stderr?.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-400)));
    this.child.on('error', (e) => (this.exited = e.message));
    this.child.on('exit', (code) => (this.exited ??= `exited ${code}${err ? `: ${err.trim().split(/\r?\n/).pop()}` : ''}`));
    return this;
  }

  /** What the helper says now. */
  state(): TicketState {
    let line = '';
    try {
      line = fs.readFileSync(this.status, 'utf8').trim().split(/\r?\n/)[0] ?? '';
    } catch {
      // not written yet
    }
    const g = /^granted (t\d{8})/.exec(line);
    if (g) return { kind: 'granted', ticket: g[1], line };
    if (/^(gave up|revoked|released)/.test(line)) return { kind: 'failed', line };
    if (this.exited !== undefined) return { kind: 'failed', line: `the bench queue helper ${this.exited}` };
    return { kind: 'waiting', line: line.replace(/^waiting /, '') || 'taking a ticket' };
  }

  /** Wait until granted or failed, or `ms` passes (then the state is 'waiting'). `onLine` hears each new line. */
  async wait(ms = Infinity, onLine?: (line: string) => void, sleep = (n: number) => new Promise((r) => setTimeout(r, n))): Promise<TicketState> {
    const until = Date.now() + ms;
    let last = '';
    for (;;) {
      const s = this.state();
      if (s.kind !== 'waiting') return s;
      if (s.line !== last) onLine?.((last = s.line));
      if (Date.now() >= until) return s;
      await sleep(Math.min(500, Math.max(0, until - Date.now())));
    }
  }

  /** Let go (owner-checked by the helper itself, which only ever releases its own ticket). */
  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      fs.writeFileSync(`${this.status}.release`, '');
    } catch {
      // the helper also ends when this process does
    }
    const c = this.child;
    if (c && c.exitCode === null) setTimeout(() => c.exitCode === null && c.kill(), 15_000).unref();
    setTimeout(() => {
      for (const f of [this.status, `${this.status}.release`, `${this.status}.tmp`]) fs.rmSync(f, { force: true });
    }, 20_000).unref();
  }
}

/**
 * A ticket for a launch, or undefined when this machine cannot keep one (no queue script in the checkouts given, no
 * lock place): the caller goes ahead without, and says why with `why`.
 */
export function benchTicketFor(o: Omit<BenchTicketOptions, 'script' | 'lock'> & { checkouts: (string | undefined)[]; root?: string; trusted?: TrustedBench }): { ticket?: BenchTicket; why?: string } {
  if (o.trusted) return trustedBenchTicket(o, o.trusted);
  const env = o.env ?? process.env;
  // w1628: a checkout from before w1615 has no queue script; any sandbox's copy on this machine keeps the same queue
  // (the queue is its files, not its code), so the run still waits its turn instead of going ahead without a ticket.
  // w1962: and of the copies here, the one with the newest rules.
  // w5026: the root defaults to FF_WORKER_ROOT, as benchLockPath's does: unity-slot run passed none, so a checkout with
  // no copy (pre-1.0 on beast) never looked in the other sandboxes and exited 69 with no shared bench ticket.
  const root = o.root ?? (env.FF_WORKER_ROOT || undefined);
  const script = newestBenchQueueScript(o.checkouts, root);
  if (!script) return { why: 'no scripts/bench/bench_queue.py in this checkout (a branch from before w1615) or in any sandbox here' };
  const lock = benchLockPath(root, env);
  if (!lock) return { why: 'no worker root to keep the bench queue under' };
  if (o.place !== undefined) {
    const s = placeScript(script, o.checkouts, root);
    if (!s) return { ticket: new BenchTicket({ ...o, place: undefined, script, lock }).take(), why: 'no queue script here takes --place yet (w4624): queued without its earlier place' };
    return { ticket: new BenchTicket({ ...o, script: s, lock }).take() };
  }
  return { ticket: new BenchTicket({ ...o, script, lock }).take() };
}

/** What a launch needs of a ticket: the helper's state, a wait for it, and a release. */
export type TicketLike = Pick<BenchTicket, 'state' | 'wait' | 'release'>;

/**
 * w5545: a ticket an agent's process takes through the daemon's calls (machine/benchProxy.ts): the daemon's helper holds
 * it under the caller's own session, in the queue no worker writes. state() is the last answer (read every `pollMs`).
 */
export class RpcBenchTicket implements TicketLike {
  private last: TicketState = { kind: 'waiting', line: 'taking a ticket' };
  private handle?: string;
  private timer?: ReturnType<typeof setInterval>;
  private released = false;
  private readonly o: { mode: BenchMode; what: string; maxMin?: number; reason?: 'timing' | 'machine'; ownerPid?: number; env?: NodeJS.ProcessEnv; pollMs?: number };

  constructor(o: RpcBenchTicket['o']) {
    this.o = o;
  }

  async take(): Promise<this> {
    try {
      const r = await rpcCall<{ handle: string }>('bench/take', { mode: this.o.mode, what: this.o.what, ownerPid: this.o.ownerPid ?? process.pid, ...(this.o.maxMin ? { maxMin: this.o.maxMin } : {}), ...(this.o.reason ? { reason: this.o.reason } : {}) }, this.o.env);
      this.handle = r.handle;
    } catch (e) {
      this.last = { kind: 'failed', line: `the daemon took no ticket: ${(e as Error).message}` };
      return this;
    }
    const poll = async () => {
      if (!this.handle || this.released) return;
      try {
        const s = await rpcCall<{ kind: TicketState['kind']; line: string; ticket?: string }>('bench/state', { handle: this.handle }, this.o.env);
        this.last = s.kind === 'granted' && s.ticket ? { kind: 'granted', ticket: s.ticket, line: s.line } : s.kind === 'failed' ? { kind: 'failed', line: s.line } : { kind: 'waiting', line: s.line };
      } catch (e) {
        // The daemon restarting: the helper holds on meanwhile; a handle it no longer knows is gone.
        if (e instanceof RpcRefused && e.status === 404) this.last = { kind: 'failed', line: `the daemon no longer knows this ticket: ${e.message}` };
      }
    };
    await poll();
    this.timer = setInterval(() => void poll(), this.o.pollMs ?? 1000);
    this.timer.unref?.();
    return this;
  }

  state(): TicketState {
    return this.last;
  }

  async wait(ms = Infinity, onLine?: (line: string) => void, sleep = (n: number) => new Promise((r) => setTimeout(r, n))): Promise<TicketState> {
    const until = Date.now() + ms;
    let last = '';
    for (;;) {
      const s = this.state();
      if (s.kind !== 'waiting') return s;
      if (s.line !== last) onLine?.((last = s.line));
      if (Date.now() >= until) return s;
      await sleep(Math.min(500, Math.max(0, until - Date.now())));
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    if (this.handle) void rpcCall('bench/release', { handle: this.handle }, this.o.env).catch(() => undefined);
  }
}

/** A caller that holds the bench lock waits this long at most for anything else (bench_queue.py HELD_WAIT_CAP_S). */
export const HELD_WAIT_CAP_MS = 120_000;

/** The queue folder beside a lock dir (bench.lock -> bench.queue), as bench_queue.py queue_dir names it. */
export const benchQueueDir = (lock: string) => path.join(path.dirname(lock), `${path.basename(lock).replace(/\.lock$/, '')}.queue`);

export interface QueueTicket {
  ticket: string;
  mode: BenchMode;
  what: string;
  pid: number;
  sandbox?: string;
  cwd?: string;
  created?: string;
  granted?: { at: string; ts: number };
  revoked?: { at: string; why: string };
  /** The worker session that took it (FF_SESSION_ID), its host, its requests and its hold bound in minutes (w1750). */
  session?: string;
  host?: string;
  requests?: string[];
  maxMin?: number;
  /** w1832: an exclusive ticket's turn in minutes (bench_queue.py turn_min; none from a copy older than w1832) and the
   * deadline a waiter set on it (limit.json, epoch s). */
  turnMin?: number;
  limit?: { deadline?: number; warned?: number; why?: string };
  /** w1860: the holder keeps the lock because only lower-priority work waits behind it (keep.json: since, epoch s; why; the
   * waiters; its priority, or its shared group's): no deadline, no warning, no revoke until one of its priority or higher waits. */
  keep?: { since?: number; why?: string; waiters?: string[]; priority?: string };
  /** The process whose life the ticket follows (bench_queue.py owner_check_pid: a Git Bash script's Windows pid), w1829. */
  ownerPid?: number;
  /** w1984/w2410: a waiting ticket bench_queue.py parked because its worker is away (parked: at, ts, why); it holds nobody back. */
  parked?: { at?: string; ts?: number; why?: string };
  /** w3186: taken under a person's approved turn (info.json `approved`), and when its clock started (turn.json start,
   * epoch s: once the machine's CI jobs drained). Only the session's priorities.json mark makes the approval count. */
  approved?: boolean;
  turnStart?: number;
  /** w3454: the grant still waits out the machine's CI jobs (turn.json ci_wait): its turn's clock has not started. */
  ciWait?: boolean;
}

/** w3186: a ticket's approval and its turn's start (bench_queue.py start_approved_turn), when it has them; w3454: any
 * timing's turn starts at turn.json start ("time now", after its CI wait), and has not started while ci_wait is set. */
function turnOf(info: Record<string, unknown>, turn: { start?: unknown; ci_wait?: unknown } | undefined): Pick<QueueTicket, 'approved' | 'turnStart' | 'ciWait'> {
  const approved = !!info.approved && typeof info.approved === 'object';
  return {
    ...(approved ? { approved: true } : {}),
    ...(typeof turn?.start === 'number' ? { turnStart: turn.start } : turn?.ci_wait !== undefined && turn?.ci_wait !== null ? { ciWait: true } : {}),
  };
}

/** The tickets in the queue whose helper process lives, in order (read only: the helpers' OS locks are the truth). */
export function queueTickets(lock: string, alive: (pid: number) => boolean): QueueTicket[] {
  const dir = benchQueueDir(lock);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^t\d{8}$/.test(n)).sort();
  } catch {
    return [];
  }
  const read = (f: string) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const out: QueueTicket[] = [];
  for (const n of names) {
    const info = read(path.join(dir, n, 'info.json'));
    if (!info || !Number.isInteger(info.pid) || !alive(info.pid)) continue;
    out.push({ ticket: n, mode: info.mode === 'shared' ? 'shared' : 'exclusive', what: String(info.what ?? ''), pid: info.pid, sandbox: info.sandbox || undefined, cwd: info.cwd || undefined, created: info.created, granted: read(path.join(dir, n, 'granted')), revoked: read(path.join(dir, n, 'revoked')), session: info.session || undefined, host: info.host || undefined, requests: Array.isArray(info.requests) ? info.requests.map(String) : undefined, maxMin: typeof info.max_min === 'number' ? info.max_min : undefined, turnMin: typeof info.turn_min === 'number' ? info.turn_min : undefined, limit: read(path.join(dir, n, 'limit.json')), keep: read(path.join(dir, n, 'keep.json')), parked: read(path.join(dir, n, 'parked')), ...turnOf(info, read(path.join(dir, n, 'turn.json'))), ownerPid: Number.isInteger(info.owner_check_pid) ? info.owner_check_pid : Number.isInteger(info.owner_pid) ? info.owner_pid : undefined });
  }
  return out;
}

/** The ticket named by $FF_BENCH_TICKET while it holds the lock (granted, not revoked, its helper alive), else undefined. */
export function heldTicket(lock: string | undefined, env: NodeJS.ProcessEnv, alive: (pid: number) => boolean): QueueTicket | undefined {
  const name = env.FF_BENCH_TICKET;
  if (!lock || !name || !/^t\d{8}$/.test(name)) return undefined;
  return queueTickets(lock, alive).find((t) => t.ticket === name && t.granted && !t.revoked);
}

/**
 * w5572: the daemon and the agent host take their tickets with this copy only. A worker can write any sandbox, so the
 * newest copy among them (newestBenchQueueScript) would run a planted bench_queue.py at the host's level: the host runs
 * the game repo's master copy, fetched with the machine's gh into the daemon's folder, which no worker can write
 * (machine/evidenceGate.ts trustedAppDir).
 */
export interface TrustedBench {
  /** The daemon's folder (appDirOfConfig). */
  appDir: string;
  /** For tests: what fetches the file (default `gh api` of FinalFactory's master). */
  fetch?: () => { text?: string; error?: string };
  now?: () => number;
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
}

export const BENCH_REPO = 'Final-Factory/FinalFactory';
export const BENCH_SCRIPT_PATH = 'scripts/bench/bench_queue.py';
/** The trusted copy's place: one file, never a pick among versions. */
export const trustedBenchScript = (appDir: string) => path.join(appDir, 'trusted', 'bench', 'bench_queue.py');
/** How old the trusted copy may be before a ticket fetches it again (master's rules move with merges, w1962). */
export const TRUSTED_BENCH_MAX_AGE_MS = 10 * 60_000;

/**
 * Fetches master's bench_queue.py with gh on a trusted PATH, in the daemon's folder: the machine's gh login (or the host's
 * GH_TOKEN), and when that cannot read it, a GitHub App installation token the portal gave this daemon (machine/ghApp.ts).
 */
function ghFetchBench(root: string | undefined, appDir: string, cwd: string): { text?: string; error?: string } {
  const run = (extra: NodeJS.ProcessEnv) => spawnSync(trustedGh(root, appDir), ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${BENCH_REPO}/contents/${BENCH_SCRIPT_PATH}?ref=master`], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', ...extra },
  });
  let r = run({});
  if (r.status !== 0) {
    const tokens = readGhAppTokens(ghAppPaths(appDir).file);
    const app = appTokenFor(tokens, BENCH_REPO.toLowerCase(), [...new Set(tokens.map((t) => t.app))], Date.now());
    if (app) r = run({ GH_TOKEN: app.token });
  }
  if (r.status !== 0) return { error: `gh api ${BENCH_SCRIPT_PATH}: ${String(r.stderr || r.error?.message || `exit ${r.status}`).replace(/\s+/g, ' ').trim().slice(0, 200)}` };
  return { text: r.stdout };
}

/**
 * w5572: brings the trusted copy up to date when it is missing or older than TRUSTED_BENCH_MAX_AGE_MS: written beside it
 * and renamed into place, so a helper never starts half a file. Answers what failed; a failed fetch keeps the copy it had.
 */
export function refreshTrustedBench(t: TrustedBench, root: string | undefined): string | undefined {
  const file = trustedBenchScript(t.appDir);
  const now = t.now ?? Date.now;
  try {
    if (now() - fs.statSync(file).mtimeMs < TRUSTED_BENCH_MAX_AGE_MS) return undefined;
  } catch {
    // none yet
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return `${path.dirname(file)}: ${(e as Error).message}`;
  }
  const got = (t.fetch ?? (() => ghFetchBench(root, t.appDir, path.dirname(file))))();
  if (!got.text) return got.error ?? 'nothing fetched';
  if (!/^RULES_VERSION = \d+/m.test(got.text)) return `the fetched ${BENCH_SCRIPT_PATH} has no RULES_VERSION`;
  try {
    const tmp = `${file}.${process.pid}-${now()}`;
    fs.writeFileSync(tmp, got.text);
    fs.renameSync(tmp, file);
    return undefined;
  } catch (e) {
    return `${file}: ${(e as Error).message}`;
  }
}

/**
 * The trusted copy and how to run it (w5572): the script, a python outside the worker root with its clean env (`-s`,
 * fsmonitor off) and its own folder as cwd; or why there is none. The daemon's own tickets and the tickets it holds for
 * a worker's call (w5545, benchProxy.ts) both run it this way.
 */
export function trustedBenchRun(t: TrustedBench, root: string | undefined, env: NodeJS.ProcessEnv): { script: string; python: string; pythonArgs: string[]; env: NodeJS.ProcessEnv; cwd: string } | { why: string } {
  const failed = refreshTrustedBench(t, root);
  const script = trustedBenchScript(t.appDir);
  if (!fs.existsSync(script)) return { why: `no trusted bench_queue.py in the daemon's folder (w5572): ${failed}` };
  if (failed) console.warn(`bench queue: kept the trusted copy from before: ${failed}`);
  const py = trustedPython({ workerEnv: env, root, appDir: t.appDir, ...(t.platform ? { platform: t.platform } : {}), ...(t.exists ? { exists: t.exists } : {}) });
  if ('error' in py) return { why: `bench queue (w5572): ${py.error}` };
  // bench_queue.py runs git in a worker's checkout (wip_note): a repository's fsmonitor setting is a program it names.
  const n = Number(py.env.GIT_CONFIG_COUNT) || 0;
  const gitEnv = { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${n}`]: 'false' };
  return { script, python: py.python, pythonArgs: ['-s'], env: { ...py.env, ...gitEnv }, cwd: path.dirname(script) };
}

function trustedBenchTicket(o: Omit<BenchTicketOptions, 'script' | 'lock'> & { root?: string }, t: TrustedBench): { ticket?: BenchTicket; why?: string } {
  const env = o.env ?? process.env;
  const root = o.root ?? (env.FF_WORKER_ROOT || undefined);
  const lock = benchLockPath(root, env);
  if (!lock) return { why: 'no worker root to keep the bench queue under' };
  const tr = trustedBenchRun(t, root, env);
  if ('why' in tr) return { why: tr.why };
  const { script } = tr;
  const run = { ...o, ...tr, lock };
  if (o.place !== undefined && !supportsPlace(script)) return { ticket: new BenchTicket({ ...run, place: undefined }).take(), why: 'the trusted queue script takes no --place: queued without its earlier place' };
  return { ticket: new BenchTicket(run).take() };
}
