// A machine's bench queue (w1615, lothsahn 2026-10-20: "a queued bench lock that also covers builds"): the game repo's
// scripts/bench/bench_queue.py keeps a first-come, first-served queue under <FF_WORKER_ROOT>/tmp/bench.queue. A timed
// bench leg takes an `exclusive` ticket and runs alone; a player build, a batch compile or an editor boot takes a
// `shared` one, which runs beside other shared ones but never beside an exclusive one. The game repo's
// Documentation/Bench-Lock.md has the design and its deadlock argument.
//
// The queue lives on OS file locks (flock, msvcrt), which node cannot take, so a ticket here is the game repo's own
// helper (`bench_queue.py hold`) run as a child: it takes the ticket for this process (its owner pid), writes its
// state to a status file, and lets go when the file `<status>.release` appears or this process dies. Every failure
// to run it (no python, a checkout from before w1615) fails open: the launch goes ahead without a ticket, said in the log.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

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

/** The lock dir the queue sits beside: $BENCH_LOCK, else <root>/tmp/bench.lock (quiet_gate.sh's place). */
export function benchLockPath(root: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BENCH_LOCK) return env.BENCH_LOCK;
  const r = root ?? env.FF_WORKER_ROOT;
  return r ? path.join(r, 'tmp', 'bench.lock') : undefined;
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

  /** Start the helper: it numbers the ticket and starts waiting. */
  take(): this {
    const args = [this.o.script, '--lock', this.o.lock, 'hold', '--mode', this.o.mode, '--what', this.o.what, '--owner-pid', String(this.o.ownerPid ?? process.pid), '--status', this.status];
    if (this.o.maxMin) args.push('--max-min', String(this.o.maxMin));
    if (this.o.reason) args.push('--reason', this.o.reason);
    try {
      this.child = spawn(this.o.python ?? pythonExe(this.o.env), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...(this.o.env ?? process.env) } });
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
export function benchTicketFor(o: Omit<BenchTicketOptions, 'script' | 'lock'> & { checkouts: (string | undefined)[]; root?: string }): { ticket?: BenchTicket; why?: string } {
  const env = o.env ?? process.env;
  // w1628: a checkout from before w1615 has no queue script; any sandbox's copy on this machine keeps the same queue
  // (the queue is its files, not its code), so the run still waits its turn instead of going ahead without a ticket.
  // w1962: and of the copies here, the one with the newest rules.
  const script = newestBenchQueueScript(o.checkouts, o.root);
  if (!script) return { why: 'no scripts/bench/bench_queue.py in this checkout (a branch from before w1615) or in any sandbox here' };
  const lock = benchLockPath(o.root, env);
  if (!lock) return { why: 'no worker root to keep the bench queue under' };
  return { ticket: new BenchTicket({ ...o, script, lock }).take() };
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
    out.push({ ticket: n, mode: info.mode === 'shared' ? 'shared' : 'exclusive', what: String(info.what ?? ''), pid: info.pid, sandbox: info.sandbox || undefined, cwd: info.cwd || undefined, created: info.created, granted: read(path.join(dir, n, 'granted')), revoked: read(path.join(dir, n, 'revoked')), session: info.session || undefined, host: info.host || undefined, requests: Array.isArray(info.requests) ? info.requests.map(String) : undefined, maxMin: typeof info.max_min === 'number' ? info.max_min : undefined, turnMin: typeof info.turn_min === 'number' ? info.turn_min : undefined, limit: read(path.join(dir, n, 'limit.json')), keep: read(path.join(dir, n, 'keep.json')), parked: read(path.join(dir, n, 'parked')), ownerPid: Number.isInteger(info.owner_check_pid) ? info.owner_check_pid : Number.isInteger(info.owner_pid) ? info.owner_pid : undefined });
  }
  return out;
}

/** The ticket named by $FF_BENCH_TICKET while it holds the lock (granted, not revoked, its helper alive), else undefined. */
export function heldTicket(lock: string | undefined, env: NodeJS.ProcessEnv, alive: (pid: number) => boolean): QueueTicket | undefined {
  const name = env.FF_BENCH_TICKET;
  if (!lock || !name || !/^t\d{8}$/.test(name)) return undefined;
  return queueTickets(lock, alive).find((t) => t.ticket === name && t.granted && !t.revoked);
}
