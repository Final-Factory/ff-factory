import fs from 'node:fs';
import path from 'node:path';
import { run, type RunResult } from './proc.ts';
import { withBaseRepoLock } from './sandboxes.ts';

/**
 * Keep the base clone the orchestrators read on origin's newest code (w467, change 11 of docs/portal-on-ffbox-host.md).
 * Until now it was fetched only by list_branches and sandbox creation, and its working tree, which the orchestrators
 * read, never moved. Every `repo.refreshMinutes` (default 15, 0 off): fetch, then a detached checkout of
 * config.defaultBase (origin/develop), under the same lock as every other git call on that clone. A clone with
 * modified tracked files keeps its HEAD (someone is using it). The portal VM's fff-base-refresh.timer does the same
 * from outside; run one of the two (repo.refreshMinutes 0 there, or disable that timer).
 */

export const DEFAULT_REFRESH_MINUTES = 15;

type Git = (args: string[]) => Promise<RunResult>;

/** One refresh; returns what happened, in a line. */
export async function refreshBaseClone(basePath: string, ref: string, git: Git = (args) => run('git', ['-C', basePath, ...args], { timeoutMs: 10 * 60_000 })): Promise<string> {
  if (!fs.existsSync(path.join(basePath, '.git'))) return `no base clone at ${basePath}`;
  return withBaseRepoLock(async () => {
    const fetched = await git(['fetch', '--prune', '--quiet', 'origin']);
    if (fetched.code !== 0) return `fetch failed: ${(fetched.stderr || fetched.stdout).trim().slice(0, 300)}`;
    const status = await git(['status', '--porcelain', '--untracked-files=no']);
    if (status.code !== 0) return `git status failed: ${status.stderr.trim().slice(0, 300)}`;
    if (status.stdout.trim()) return 'the base clone has modified files: HEAD left where it is';
    const before = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const moved = await git(['checkout', '--quiet', '--detach', ref]);
    if (moved.code !== 0) return `checkout of ${ref} failed: ${moved.stderr.trim().slice(0, 300)}`;
    const after = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    return before === after ? `already at ${ref} (${after.slice(0, 9)})` : `moved to ${ref} (${before.slice(0, 9)} → ${after.slice(0, 9)})`;
  });
}

/** Start the timer (server startup); returns a stop function. A failed refresh is logged and tried again next time. */
export function startBaseRefresh(cfg: { repo: { basePath: string; refreshMinutes?: number }; defaultBase: string }, log: (line: string) => void = console.log): () => void {
  const minutes = cfg.repo.refreshMinutes ?? DEFAULT_REFRESH_MINUTES;
  if (!(minutes > 0)) return () => undefined;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const line = await refreshBaseClone(cfg.repo.basePath, cfg.defaultBase);
      if (!/^already at /.test(line)) log(`base clone: ${line}`);
    } catch (e) {
      log(`base clone: refresh failed: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, minutes * 60_000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
