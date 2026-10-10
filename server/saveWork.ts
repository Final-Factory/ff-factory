import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.ts';
import { parseStatus } from './gitStatus.ts';

/**
 * Save a released worker's uncommitted work before its sandbox goes to other work (w656, run by its machine's daemon):
 * everything git would show as changed or untracked (ignored files stay as they are) is committed on the worker's own
 * branch and pushed. Nothing is stashed: the stash list is shared by every worktree of a repository, and a commit on
 * its branch goes wherever the worker is placed again. `git reset HEAD~1` gives the worker its changes back uncommitted.
 *
 * Refused, so the sandbox stays held and list_sandboxes says why: the worktree is not on that branch, the branch is a
 * shared one (develop, master, main), or the untracked files are more than a commit should carry (SAVE_LIMITS: build
 * output, captures and recordings belong in the temp folder, not on a branch).
 */

/**
 * The most untracked files a save takes. GitHub refuses a file over 100 MiB and warns from 50 MiB (docs.github.com,
 * "About large files on GitHub"); a worker's new scripts, tests and their .meta files are a few kB each. On the M3 on
 * 2026-10-07 the one sandbox there held 41,491 untracked files, about 10 GB, a build, clips and audit runs (measured,
 * `git ls-files --others --exclude-standard`, `du -sh`): no limit of these lets that onto a branch.
 */
export const SAVE_LIMITS = { files: 500, fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 };

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const SHARED = /^(master|main|develop)$/;

export interface SaveResult {
  /** The commit made, or undefined when there was nothing to save. */
  sha?: string;
  /** How many files it holds (changed, deleted and new). */
  files: number;
  /** Whether origin has it; when not, `notes` says why (the commit is in the machine's repository either way). */
  pushed: boolean;
  notes: string[];
}

/** `net`: the environment of a push or fetch (w868: a person's GitHub token from the vault), over ENV. */
async function git(dir: string, args: string[], timeoutMs = 120_000, net?: NodeJS.ProcessEnv) {
  return run('git', ['-C', dir, ...args], { timeoutMs, env: net ? { ...ENV, ...net } : ENV });
}

async function must(dir: string, args: string[], what: string, timeoutMs?: number, net?: NodeJS.ProcessEnv) {
  const r = await git(dir, args, timeoutMs, net);
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** Why the untracked files of `dir` are too many or too big to commit, or undefined. Stops reading at the first excess. */
export async function untrackedProblem(dir: string, limits = SAVE_LIMITS): Promise<string | undefined> {
  const list = (await must(dir, ['ls-files', '--others', '--exclude-standard', '-z'], 'listing untracked files')).split('\0').filter(Boolean);
  if (list.length > limits.files) return `${list.length} untracked files there, more than the ${limits.files} a save commits (build output, captures or recordings belong in the temp folder): commit what matters, delete or ignore the rest`;
  let total = 0;
  for (const f of list) {
    let size = 0;
    try {
      size = fs.lstatSync(path.join(dir, f)).size;
    } catch {
      continue;
    }
    if (size > limits.fileBytes) return `the untracked file ${f} is ${mb(size)}, more than the ${mb(limits.fileBytes)} a save commits: commit what matters, delete or ignore the rest`;
    total += size;
    if (total > limits.totalBytes) return `the untracked files there are more than the ${mb(limits.totalBytes)} a save commits: commit what matters, delete or ignore the rest`;
  }
  return undefined;
}

export async function saveWork(opts: { dir: string; branch: string; message: string; limits?: typeof SAVE_LIMITS; env?: NodeJS.ProcessEnv }): Promise<SaveResult> {
  const { dir, branch } = opts;
  const st = parseStatus(await must(dir, ['status', '--porcelain=v2', '--branch'], 'git status'));
  if (st.branch !== branch) throw new Error(`the sandbox is on ${st.branch}, not the worker's branch ${branch}: nothing was saved`);
  if (SHARED.test(branch)) throw new Error(`its work is on ${branch}, a shared branch: committing there is a decision for a person`);
  if (!st.dirty && !st.untracked) return { files: 0, pushed: false, notes: ['nothing to save'] };
  const problem = st.untracked ? await untrackedProblem(dir, opts.limits) : undefined;
  if (problem) throw new Error(problem);
  await must(dir, ['add', '-A'], 'git add');
  const files = (await must(dir, ['diff', '--cached', '--name-only', '-z'], 'listing what is saved')).split('\0').filter(Boolean).length;
  await must(dir, ['commit', '-q', '--no-verify', '-m', opts.message], 'git commit');
  const sha = (await must(dir, ['rev-parse', '--short', 'HEAD'], 'reading the commit')).trim();
  const notes = [`committed ${files} file(s) on ${branch} as ${sha}`];
  const push = await git(dir, ['push', '-u', 'origin', `${branch}:${branch}`], 5 * 60_000, opts.env);
  if (push.code === 0) notes.push(`pushed ${branch}`);
  else notes.push(`not pushed (${(push.stderr || push.stdout).trim().split('\n').slice(-1)[0]}): the commit is in this machine's repository, and the next switch away pushes it`);
  return { sha, files, pushed: push.code === 0, notes };
}
