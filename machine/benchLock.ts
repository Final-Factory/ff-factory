// A machine's bench lock (w1600): the lock the game repo's timed runs hold for their whole length
// (scripts/bench/quiet_gate.sh bench_lock, w1438), a directory `<FF_WORKER_ROOT>/tmp/bench.lock` with the holder's line in
// `owner`. The daemon reports it with its stats, so the portal keeps a Live view editor from starting beside a timed run
// (docs/live-view.md, "On BEAST first"): a streaming editor in play mode takes the CPU and GPU the run measures.
import fs from 'node:fs';
import path from 'node:path';
import type { BenchLock, BenchPriority, BenchQueueReport } from '../shared/types.ts';
import { benchQueueDir, queueTickets } from './benchQueue.ts';

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
 * Errors are logged, never thrown: the queue then goes on in its old order.
 */
export function writeBenchPriorities(root: string | undefined, sessions: Record<string, BenchPriority>, at = new Date(), singleWorker = false): string | undefined {
  if (!root) return undefined;
  const dir = benchQueueDir(benchLockDir(root));
  const file = path.join(dir, 'priorities.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: at.toISOString(), v: 2, sessions, single_worker: singleWorker }));
    fs.renameSync(tmp, file);
    return file;
  } catch (e) {
    console.warn(`bench priorities: ${(e as Error).message}`);
    return undefined;
  }
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + 'Z';

/**
 * w1750 (lothsahn, 2026-10-22, after a worker shot clips with a player on BEAST beside another worker's timed profile:
 * "Why is the game player running if the worker has an exclusive lock on beast?"): while another worker's timed run
 * holds this machine's bench lock, its message for a refused player launch or clip ("bench lock held by <worker>, until
 * <time>"), else undefined. A timed run is a granted, unrevoked exclusive ticket whose helper lives and that is inside
 * its hold bound (the game repo's bench_queue.py timed_hold, the same rules), or a live old-style lock. The worker's own
 * (the same session) never counts: its other shell calls belong to its own run.
 */
export function foreignTimedHold(root: string | undefined, session: string | undefined, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): string | undefined {
  if (!root) return undefined;
  for (const t of queueTickets(benchLockDir(root), alive)) {
    if (t.mode !== 'exclusive' || !t.granted || t.revoked) continue;
    if (session && t.session === session) return undefined;
    const since = t.granted.ts * 1000;
    const until = since + (t.maxMin ?? 60) * 60_000;
    if (now >= until) continue; // past its bound: the next waiter revokes it
    const bits = [(t.requests ?? []).join(','), [t.host, t.sandbox].filter(Boolean).join('/'), t.what ? `"${t.what.slice(0, 120)}"` : ''].filter(Boolean);
    const who = t.session ? `worker ${t.session}` : `pid ${t.pid}`;
    return `bench lock held by ${who}${bits.length ? ` (${bits.join(', ')})` : ''}, until ${hhmm(until)} at the latest (held since ${hhmm(since)})`;
  }
  const old = readBenchLock(root, now, alive);
  if (old && !/\[t\d{8}\]/.test(old.owner)) return `bench lock held by an old-style lock: ${old.owner} (seen since ${hhmm(Date.parse(old.since))}, 40 minutes at most)`;
  return undefined;
}
