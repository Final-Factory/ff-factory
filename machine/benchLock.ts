// A machine's bench lock (w1600): the lock the game repo's timed runs hold for their whole length
// (scripts/bench/quiet_gate.sh bench_lock, w1438), a directory `<FF_WORKER_ROOT>/tmp/bench.lock` with the holder's line in
// `owner`. The daemon reports it with its stats, so the portal keeps a Live view editor from starting beside a timed run
// (docs/live-view.md, "On BEAST first"): a streaming editor in play mode takes the CPU and GPU the run measures.
import fs from 'node:fs';
import path from 'node:path';
import type { BenchLock } from '../shared/types.ts';
import { queueTickets } from './benchQueue.ts';

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
