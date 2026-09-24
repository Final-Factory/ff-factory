import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pruneEditorLogs } from './sandboxes.ts';
import type { CleanupPolicy } from './config.ts';

export { DEFAULT_CLEANUP, type CleanupPolicy } from './config.ts';

/**
 * Automatic clean-up of known-safe junk, for the disk guard (server/hostHealth.ts, docs/self-recovery.md).
 * Everything here is either scratch (test temp folders, headless-browser profiles), regenerable (rotated
 * editor logs), or matched by an explicit age rule in config. Anything in use or unreadable is skipped;
 * protected paths, the sandbox root, this app and its data are never touched.
 */
export interface CleanupItem {
  path: string;
  why: string;
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const within = (p: string, root: string) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + '/');

/** Whether a clone has work that exists nowhere else: uncommitted changes or commits no remote has. Unknown counts as yes. */
export function hasLocalWork(dir: string): boolean {
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  try {
    if (git('status', '--porcelain')) return true;
    return Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes')) > 0;
  } catch {
    return true;
  }
}

/** The git repos directly in `dir` or one level below (temp clones are `<name>/app`, `<name>/app2`, …). */
function reposIn(dir: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(dir, '.git'))) out.push(dir);
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git'))) out.push(path.join(dir, e.name));
    }
  } catch {
    // unreadable: no repos found, so it is judged by age alone below only if it matches a scratch pattern
  }
  return out;
}

/**
 * What a clean-up would remove now. Pure planning over the file system (reads only), so it can be shown
 * before anything is deleted. `keep` lists paths never to touch (protected paths, sandbox root, app, data).
 */
export function planCleanup(opts: {
  policy: CleanupPolicy;
  tempDir?: string;
  keep: string[];
  now?: number;
}): CleanupItem[] {
  const now = opts.now ?? Date.now();
  const tmp = opts.tempDir ?? os.tmpdir();
  const items: CleanupItem[] = [];
  const kept = (p: string) => opts.keep.some((k) => within(p, k) || within(k, p));
  const age = (p: string) => {
    try {
      return now - fs.statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    // no temp folder
  }
  const scratch = opts.policy.tempPatterns.map(glob);
  const clones = opts.policy.clonePatterns.map(glob);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(tmp, e.name);
    if (kept(p)) continue;
    const a = age(p);
    if (scratch.some((r) => r.test(e.name))) {
      if (a > opts.policy.tempOlderThanHours * 3_600_000) items.push({ path: p, why: `scratch (${e.name}), untouched for ${Math.round(a / 3_600_000)} h` });
      continue;
    }
    if (opts.policy.cloneOlderThanDays > 0 && clones.some((r) => r.test(e.name)) && a > opts.policy.cloneOlderThanDays * 86_400_000) {
      const repos = reposIn(p);
      if (repos.length && !repos.some(hasLocalWork)) items.push({ path: p, why: `agent temp clone untouched for ${Math.round(a / 86_400_000)} days, nothing unpushed` });
    }
  }
  for (const rule of opts.policy.ageRules) {
    if (kept(rule.path)) continue;
    let list: string[] = [];
    try {
      list = fs.readdirSync(rule.path);
    } catch {
      continue;
    }
    for (const n of list) {
      const p = path.join(rule.path, n);
      if (!kept(p) && age(p) > rule.olderThanDays * 86_400_000) items.push({ path: p, why: `older than ${rule.olderThanDays} days (age rule for ${rule.path})` });
    }
  }
  return items;
}

/** Remove what planCleanup chose, plus rotated editor logs beyond the newest three. Returns what went. */
export function runCleanup(items: CleanupItem[], editorLogs: { logsDir: string; current: string }[] = []): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const it of items) {
    try {
      fs.rmSync(it.path, { recursive: true, force: true, maxRetries: 2 });
      removed.push(it.path);
    } catch {
      failed.push(it.path); // in use or unreadable: next time
    }
  }
  for (const l of editorLogs) removed.push(...pruneEditorLogs(l.logsDir, l.current));
  return { removed, failed };
}
