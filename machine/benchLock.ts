// A machine's bench lock (w1600): the lock the game repo's timed runs hold for their whole length
// (scripts/bench/quiet_gate.sh bench_lock, w1438), a directory `<FF_WORKER_ROOT>/tmp/bench.lock` with the holder's line in
// `owner`. The daemon reports it with its stats, so the portal keeps a Live view editor from starting beside a timed run
// (docs/live-view.md, "On BEAST first"): a streaming editor in play mode takes the CPU and GPU the run measures.
import fs from 'node:fs';
import path from 'node:path';
import type { BenchLock, BenchPriority, BenchQueueReport, NoTimedRuns, TimedAskMark } from '../shared/types.ts';
import type { TimedAskState } from '../server/timedAsk.ts';
import { benchQueueDir, queueTickets, type QueueTicket } from './benchQueue.ts';
import type { PassedMark } from './benchRaise.ts';

/** Where quiet_gate.sh keeps the lock: `$FF_WORKER_ROOT/tmp/bench.lock` (Git Bash's /f/ffw is F:\ffw). */
export const benchLockDir = (root: string) => path.join(root, 'tmp', 'bench.lock');

/**
 * An old-style lock (a branch from before w1615, no ticket in its owner line) older than this is a killed run's
 * (quiet_gate.sh BENCH_LOCK_STALE_MIN, 40 minutes): it no longer counts. A queue holder's lock (w1615, "[t00000042]" in
 * its line) counts while its ticket's helper process lives, however old: no age rule.
 */
export const BENCH_LOCK_STALE_MS = 40 * 60_000;

/** Whether a process lives (EPERM: it does, someone else's); node's signal 0 checks a native pid on Windows too. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The bench lock under the worker root while a run holds it, or undefined (free, stale, or no worker root). */
export function readBenchLock(root: string | undefined, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): BenchLock | undefined {
  if (!root) return undefined;
  const dir = benchLockDir(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return undefined;
  }
  if (!st.isDirectory()) return undefined;
  let owner = '';
  try {
    owner = fs.readFileSync(path.join(dir, 'owner'), 'utf8').trim().split(/\r?\n/)[0].slice(0, 200);
  } catch {
    // mkdir and the owner line are two steps: the line follows within a moment.
  }
  const ticket = /\[(t\d{8})\]/.exec(owner)?.[1];
  if (ticket) {
    const t = queueTickets(dir, alive).find((x) => x.ticket === ticket);
    if (!t?.granted || t.revoked) return undefined; // its holder is gone or revoked: the next waiter clears the dir
    return { owner, since: new Date(t.granted.ts * 1000).toISOString() };
  }
  if (now - st.mtimeMs > BENCH_LOCK_STALE_MS) return undefined;
  return { owner: owner || 'its owner line is not written yet', since: new Date(st.mtimeMs).toISOString() };
}

/**
 * The timed legs in the machine's bench queue (w1628): exclusive tickets whose helper lives and that were not revoked,
 * running or waiting, or undefined when there are none (or no worker root). A waiting one counts as much as a running one:
 * a build started now would run before it, or beside the run it is part of.
 */
export function readBenchQueue(root: string | undefined, alive: (pid: number) => boolean = pidAlive): BenchQueueReport | undefined {
  if (!root) return undefined;
  const timed = queueTickets(benchLockDir(root), alive).filter((t) => t.mode === 'exclusive' && !t.revoked);
  return timed.length ? { timed: timed.length, ...(timed[0].what ? { first: timed[0].what.slice(0, 120) } : {}) } : undefined;
}

/**
 * Write each worker's request priority where the bench queue reads it (w1628): <root>/tmp/bench.queue/priorities.json,
 * {at, v, sessions: {<session id>: {priority, requests, exempt?}}, single_worker}, replaced whole (a reader never sees
 * half a file). A ticket whose FF_SESSION_ID is not in it counts as normal. v 2 (w1832) says the exempt marks and
 * single_worker are this daemon's: bench_queue.py then honours a pre-empt ticket only from the session marked release.
 * `no_timed_runs` {why, elsewhere} (w1861): this machine takes no timed runs, so bench_queue.py refuses every exclusive
 * ticket here and names the machines in `elsewhere`. Errors are logged, never thrown: the queue then goes on in its old order.
 */
export function writeBenchPriorities(root: string | undefined, sessions: Record<string, BenchPriority>, at = new Date(), singleWorker?: boolean, noTimedRuns?: NoTimedRuns, timedAsk?: TimedAskMark, passed?: Record<string, PassedMark>, placed?: Record<string, string>): string | undefined {
  if (!root) return undefined;
  const dir = benchQueueDir(benchLockDir(root));
  const file = path.join(dir, 'priorities.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // w1832: `v: 2` (the release and nightly marks) only from a portal that sends them, which also sends `singleWorker`:
    // under v 2 the queue honours a pre-empt ticket only from a session marked release, so an older portal's file stays v 1
    const marks = typeof singleWorker === 'boolean' ? { v: 2, single_worker: singleWorker } : {};
    // w1969: `timed_ask` {required, why}: whether workers here ask timed_place before an exclusive timing ticket
    // w1962: `passed`, the daemon's own marks (machine/benchRaise.ts), kept here so a restarted daemon goes on with them
    const kept = passed && Object.keys(passed).length ? { passed } : {};
    // w2413: `placed` {session: sandbox}, where each worker session runs now: bench_queue.py own_sandboxes lets that
    // sandbox's editor ride along with the session's exclusive ticket (a worker placed again elsewhere, a timed_run ticket)
    const where = placed && Object.keys(placed).length ? { placed } : {};
    fs.writeFileSync(tmp, JSON.stringify({ at: at.toISOString(), ...marks, ...(noTimedRuns ? { no_timed_runs: noTimedRuns } : {}), ...(timedAsk ? { timed_ask: timedAsk } : {}), ...kept, ...where, sessions }));
    fs.renameSync(tmp, file);
    return file;
  } catch (e) {
    console.warn(`bench priorities: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * What the guard needs of the ask for one worker session (w1969, server/timedAsk.ts checkTimedAsk): this machine's
 * `timed_ask` mark and the session's verdict and exempt mark in priorities.json, or undefined with no file (it fails open).
 */
export function readTimedAsk(root: string | undefined, session: string | undefined): TimedAskState | undefined {
  if (!root) return undefined;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(benchQueueDir(benchLockDir(root)), 'priorities.json'), 'utf8')) as { timed_ask?: TimedAskMark; sessions?: Record<string, BenchPriority> };
    const s = session ? d.sessions?.[session] : undefined;
    return { ...(d.timed_ask ? { mark: d.timed_ask } : {}), ...(s?.timed ? { verdict: s.timed } : {}), ...(s?.exempt ? { exempt: s.exempt } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The timed run that holds this machine's bench lock now (w1829): the granted, unrevoked exclusive ticket whose helper
 * lives (bench_queue.py timed_hold), with the time its turn ends at the earliest; undefined when none. A turn past its
 * limit still counts while nobody waits (w1832): the queue revokes it at the deadline a waiter sets, and what it quieted
 * comes back then.
 */
export function timedHolder(root: string | undefined, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): (QueueTicket & { until: number; kept?: boolean }) | undefined {
  if (!root) return undefined;
  for (const t of queueTickets(benchLockDir(root), alive)) {
    if (t.mode !== 'exclusive' || !t.granted || t.revoked) continue;
    // w1832 (bench_queue.py timed_hold): a turn past its limit goes on while nobody queues behind it, so it still holds
    // the machine; its end is the deadline a waiter set, else its turn's end (or the 5-minute warning from now, past it)
    const turnEnd = t.granted.ts * 1000 + turnMinOf(t) * 60_000;
    const deadline = typeof t.limit?.deadline === 'number' ? t.limit.deadline * 1000 : undefined;
    // w1860: with no deadline and keep.json, only lower-priority work waits: it keeps the lock until it lets go
    const kept = deadline === undefined && !!t.keep;
    return { ...t, until: deadline ?? Math.max(turnEnd, now + BENCH_WARN_LEAD_MIN * 60_000), ...(kept ? { kept } : {}) };
  }
  return undefined;
}

/** The game repo's bench_queue.py WARN_LEAD_MIN and turn_min (w1832): a turn of at most 30 minutes, and a ticket from a
 * copy older than w1832 keeps the bound it was taken under (60 by default). */
export const BENCH_WARN_LEAD_MIN = 5;
const turnMinOf = (t: QueueTicket) => (t.turnMin ? Math.min(t.turnMin, 30) : (t.maxMin ?? 60));

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + 'Z';

/** When a timed hold ends, for people (w1860): "by 10:00Z at the latest", or for a holder that keeps the lock because
 * only lower-priority work waits (timedHolder `kept`), "when it lets go": no time can be promised then. */
export const holdEnds = (until: number, kept?: boolean) => (kept ? 'when it lets go (only lower-priority work waits, so it keeps the lock, w1860)' : `by ${hhmm(until)} at the latest`);

/**
 * w1750 (lothsahn, 2026-10-22, after a worker shot clips with a player on BEAST beside another worker's timed profile:
 * "Why is the game player running if the worker has an exclusive lock on beast?"): while another worker's timed run
 * holds this machine's bench lock, its message for a refused player launch or clip ("bench lock held by <worker>, until
 * <time>"), else undefined. A timed run is a granted, unrevoked exclusive ticket whose helper lives (timedHolder, the
 * game repo's bench_queue.py timed_hold rules), or a live old-style lock. The worker's own
 * (the same session) never counts: its other shell calls belong to its own run.
 */
export function foreignTimedHold(root: string | undefined, session: string | undefined, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): string | undefined {
  if (!root) return undefined;
  const t = timedHolder(root, now, alive);
  if (t) {
    if (session && t.session === session) return undefined;
    const bits = [(t.requests ?? []).join(','), [t.host, t.sandbox].filter(Boolean).join('/'), t.what ? `"${t.what.slice(0, 120)}"` : ''].filter(Boolean);
    const who = t.session ? `worker ${t.session}` : `pid ${t.pid}`;
    return `bench lock held by ${who}${bits.length ? ` (${bits.join(', ')})` : ''}, ${t.kept ? 'until it lets go (only lower-priority work waits, so it keeps the lock, w1860)' : `until ${hhmm(t.until)} at the latest`} (held since ${hhmm(t.granted!.ts * 1000)})`;
  }
  const old = readBenchLock(root, now, alive);
  if (old && !/\[t\d{8}\]/.test(old.owner)) return `bench lock held by an old-style lock: ${old.owner} (seen since ${hhmm(Date.parse(old.since))}, 40 minutes at most)`;
  return undefined;
}

/**
 * w1923: the granted exclusive ticket this worker session holds on this machine (`bench_queue.py timed`, a `--timed`
 * snippet, `bench_lock --timing`, `run --mode exclusive`), else undefined: a timing measurement runs only inside one
 * (server/timingGuard.ts). A session-less worker holds none.
 */
export function ownTimedHold(root: string | undefined, session: string | undefined, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): string | undefined {
  if (!root || !session) return undefined;
  const t = timedHolder(root, now, alive);
  return t && t.session === session ? t.ticket : undefined;
}

/** The daemon's passed marks as it last wrote them (w1962, writeBenchPriorities `passed`), or {} (none, or unreadable). */
export function readPassedMarks(root: string | undefined): Record<string, PassedMark> {
  if (!root) return {};
  try {
    const f = JSON.parse(fs.readFileSync(path.join(benchQueueDir(benchLockDir(root)), 'priorities.json'), 'utf8'));
    const p = f?.passed;
    if (!p || typeof p !== 'object') return {};
    return Object.fromEntries(Object.entries(p as Record<string, PassedMark>).filter(([k, v]) => /^t\d{8}$/.test(k) && typeof v?.by === 'string'));
  } catch {
    return {};
  }
}
