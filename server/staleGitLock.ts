import fs from 'node:fs';
import path from 'node:path';
import { run, type RunResult } from './proc.ts';

/**
 * w6432: a `git status` in a sandbox, given room to re-hash the LFS files when the index's stat data is stale. 120 s killed
 * w6431's start in lothdesktop/slot1 at 15:03:58Z on 2026-11-27 (start_agent at 15:01:54, a re-hash of 8.5 GB at 100% CPU:
 * 17.2 s for 400 MB there, measured, so about 6 min for all of it). Half the server's 10-minute wait for a whole switch or
 * save (server/machines.ts), so the fetch, checkout or commit after it still ends before the server gives up on it (w6453's
 * review); the dedup keeping the times (machine/sandboxes.ts lfsDedup) is what keeps the status short.
 */
export const STATUS_TIMEOUT_MS = 5 * 60_000;

/**
 * Why a git run failed, in words: its last stderr lines, or that it timed out or was killed. A git killed by its timeout
 * writes nothing, and Node's error says only "Command failed: git …", which is all the dispatcher was told about w6431.
 */
export function gitFailure(r: RunResult, timeoutMs: number): string {
  if (r.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)} s (git was stopped; a slow disk or a busy CPU, or a status that must re-read every file)`;
  const said = (r.stderr || r.stdout).trim();
  if (r.signal && /^Command failed:/.test(said)) return `git was ended by ${r.signal} before it said anything`;
  return said.split('\n').slice(-3).join(' ');
}

/**
 * How old a worktree's index.lock must be before FF Factory takes it for a crashed git's leftover (w6432). Git sets the lock's
 * mtime when it takes it and writes it only at the end, so its age is the holding git's runtime. The longest git FF Factory
 * runs in a sandbox is the provisioning `reset --hard`, killed at 60 min (machine/sandboxes.ts); a worker's own long
 * checkout or `git lfs pull` is bounded by its 2-hour background limit. Three hours is a margin over both (w6453's review).
 */
export const STALE_INDEX_LOCK_MS = 3 * 60 * 60_000;

/**
 * w6432: remove a stale `index.lock` from `dir`'s git dir, so the next git that writes the index does not fail on it. A git
 * killed mid-write leaves the lock behind, and every later add, commit or switch there fails with "Unable to create
 * '…/index.lock': File exists" until somebody removes it by hand. lothdesktop/slot4 carried one from w6030 on, and at
 * 15:05Z on 2026-11-27 FF Factory's save before reclaiming it for frantic w6431 failed on it ("git add failed"), every
 * retry the same. Answers what it did, for the caller's log, or undefined when there was nothing to do. Never throws.
 */
export async function clearStaleIndexLock(dir: string, now = Date.now(), maxAgeMs = STALE_INDEX_LOCK_MS): Promise<string | undefined> {
  const r = await run('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { timeoutMs: 30_000 }).catch(() => undefined);
  const gitDir = r?.code === 0 ? r.stdout.trim() : '';
  if (!gitDir) return undefined;
  return clearStaleLockIn(gitDir, now, maxAgeMs);
}

/** clearStaleIndexLock's part on a known git dir. Exported for tests. */
export function clearStaleLockIn(gitDir: string, now: number, maxAgeMs = STALE_INDEX_LOCK_MS): string | undefined {
  const lock = path.join(gitDir, 'index.lock');
  let st: fs.Stats;
  try {
    st = fs.statSync(lock);
  } catch {
    return undefined;
  }
  const age = now - st.mtimeMs;
  if (age < maxAgeMs) return undefined;
  try {
    fs.rmSync(lock, { force: true });
  } catch (e) {
    return `a stale index.lock (${Math.round(age / 60_000)} min old) could not be removed: ${(e as Error).message}`;
  }
  return `removed a stale index.lock, ${Math.round(age / 60_000)} min old, that a git ended mid-write left behind (w6432)`;
}
