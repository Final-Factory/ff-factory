// A machine's bench lock (w1600): the lock the game repo's timed runs hold for their whole length
// (scripts/bench/quiet_gate.sh bench_lock, w1438), a directory `<FF_WORKER_ROOT>/tmp/bench.lock` with the holder's line in
// `owner`. The daemon reports it with its stats, so the portal keeps a Live view editor from starting beside a timed run
// (docs/live-view.md, "On BEAST first"): a streaming editor in play mode takes the CPU and GPU the run measures.
import fs from 'node:fs';
import path from 'node:path';
import type { BenchLock } from '../shared/types.ts';

/** Where quiet_gate.sh keeps the lock: `$FF_WORKER_ROOT/tmp/bench.lock` (Git Bash's /f/ffw is F:\ffw). */
export const benchLockDir = (root: string) => path.join(root, 'tmp', 'bench.lock');

/** A lock older than this is a killed run's (quiet_gate.sh BENCH_LOCK_STALE_MIN, 40 minutes; a run is under 15): it no longer counts. */
export const BENCH_LOCK_STALE_MS = 40 * 60_000;

/** The bench lock under the worker root while a run holds it, or undefined (free, stale, or no worker root). */
export function readBenchLock(root: string | undefined, now: number = Date.now()): BenchLock | undefined {
  if (!root) return undefined;
  const dir = benchLockDir(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return undefined;
  }
  if (!st.isDirectory() || now - st.mtimeMs > BENCH_LOCK_STALE_MS) return undefined;
  let owner = '';
  try {
    owner = fs.readFileSync(path.join(dir, 'owner'), 'utf8').trim().split(/\r?\n/)[0].slice(0, 200);
  } catch {
    // mkdir and the owner line are two steps: the line follows within a moment.
  }
  return { owner: owner || 'its owner line is not written yet', since: new Date(st.mtimeMs).toISOString() };
}
