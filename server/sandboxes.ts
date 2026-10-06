// Sandbox names, branches, labels, the base-clone lock and the editor log files: shared by the portal and every
// machine daemon (machine/sandboxes.ts). The portal itself holds no sandboxes (w510); a machine's pool does.
import fs from 'node:fs';
import path from 'node:path';

export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ---- pure checks (exported for tests) ----

/** Branches a sandbox may never be on: its worktree's plain `git push` must not be able to reach them. */
const PROTECTED_BRANCHES = new Set(['master', 'main', 'develop', 'head']);

/**
 * Why `branch` cannot be a sandbox branch, or undefined if it can. Covers the rules git's own
 * check-ref-format does not know about; a pool's create also runs `git check-ref-format --branch`.
 */
export function branchProblem(branch: string): string | undefined {
  if (!branch) return 'branch name is empty';
  if (branch.startsWith('-')) return `branch "${branch}" starts with "-"`;
  let n = branch.toLowerCase();
  // Strip every spelling that still names the same branch: refs/heads/x, heads/x, refs/remotes/origin/x, origin/x.
  for (let prev = ''; prev !== n; ) {
    prev = n;
    n = n.replace(/^refs\//, '').replace(/^(heads|remotes)\//, '').replace(/^origin\//, '');
  }
  if (PROTECTED_BRANCHES.has(n)) {
    return `branch "${branch}" is not allowed: a sandbox works on its own branch, never master, main or develop`;
  }
  return undefined;
}

const PURPOSE_MAX = 200;

/** A purpose label as stored: one line, whitespace collapsed. Throws on an empty or over-long label. */
export function normalizePurpose(purpose: string): string {
  const one = purpose.replace(/\s+/g, ' ').trim();
  if (!one) throw new Error('purpose is empty');
  if (one.length > PURPOSE_MAX) throw new Error(`purpose is ${one.length} characters; keep it to one line of at most ${PURPOSE_MAX}`);
  return one;
}

// ---- base-repo lock ----

let baseRepoTail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` while holding the one lock for git operations on the shared base clone. Concurrent
 * fetch / worktree add / worktree remove race on the base repo's ref and worktree locks.
 */
export function withBaseRepoLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = baseRepoTail.then(fn, fn);
  baseRepoTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * The log file for an editor about to start, in `logsDir`. Normally Logs/sandbox-editor.log, with the
 * previous run's log kept as sandbox-editor-<time>.log. A process that outlived a crashed editor can still
 * hold the old log open without delete sharing (Unity's bug reporter, which the crashed editor starts, or
 * a compiler server it spawned: they inherit its handle), and then the old log can be neither deleted nor
 * renamed; this run then logs to a fresh sandbox-editor-<time>.log instead of failing. Callers take the
 * returned path everywhere (unity.logPath: watchdog, wait_for_unity, the Log button).
 */
export function pickEditorLog(logsDir: string, now = new Date()): string {
  fs.mkdirSync(logsDir, { recursive: true });
  const base = path.join(logsDir, 'sandbox-editor.log');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20260924T084437Z
  const stamped = path.join(logsDir, `sandbox-editor-${stamp}.log`);
  if (!fs.existsSync(base)) return base;
  try {
    fs.renameSync(base, stamped);
    return base;
  } catch (e) {
    console.warn(`unity log: ${base} is held by another process (${(e as NodeJS.ErrnoException).code}); this run logs to ${stamped}`);
    return stamped;
  }
}

/**
 * Remove old kept editor logs (sandbox-editor-*.log, a few hundred MB each after a long run), newest
 * `keep` first, never `current`. A log another process still holds is skipped and tried again next time.
 */
export function pruneEditorLogs(logsDir: string, current: string, keep = 3): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(logsDir).filter((n) => /^sandbox-editor-.+\.log$/.test(n));
  } catch {
    return [];
  }
  const old = names
    .map((n) => path.join(logsDir, n))
    .filter((p) => path.resolve(p) !== path.resolve(current))
    .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(keep);
  const removed: string[] = [];
  for (const { p } of old) {
    try {
      fs.rmSync(p);
      removed.push(p);
    } catch {
      // still held; next start tries again
    }
  }
  return removed;
}
