import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.ts';
import { parseStatus } from './gitStatus.ts';
import { noiseFiles } from './editorNoise.ts';

/**
 * Save a released worker's uncommitted work before its sandbox goes to other work (w656, run by its machine's daemon):
 * everything git would show as changed or untracked (ignored files stay as they are) is committed on the worker's own
 * branch and pushed. Nothing is stashed: the stash list is shared by every worktree of a repository, and a commit on
 * its branch goes wherever the worker is placed again. `git reset HEAD~1` gives the worker its changes back uncommitted.
 *
 * Refused, so the sandbox stays held and list_sandboxes says why: the worktree is not on that branch, the branch is a
 * shared one (develop, master, main), or the untracked files are more than a commit should carry (SAVE_LIMITS: build
 * output, captures and recordings belong in the temp folder, not on a branch). Build output in the sandbox's own build
 * folders (SAVE_SKIPS) is neither saved nor counted: it stays where it is, uncommitted, and the release sweep clears it.
 * Materials the Unity editor only re-serialized in play mode (editorNoise.ts, w2782) are restored to HEAD, not committed.
 */

/**
 * The most untracked files a save takes. GitHub refuses a file over 100 MiB and warns from 50 MiB (docs.github.com,
 * "About large files on GitHub"); a worker's new scripts, tests and their .meta files are a few kB each. On the M3 on
 * 2026-10-07 the one sandbox there held 41,491 untracked files, about 10 GB, a build, clips and audit runs (measured,
 * `git ls-files --others --exclude-standard`, `du -sh`): no limit of these lets that onto a branch.
 */
export const SAVE_LIMITS = { files: 500, fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 };

/**
 * The sandbox's build folders, top level, any case (the ones the clean-up reads as sandbox output, cleanupFolders.ts): a
 * save leaves their untracked files out (w1983). lothdesktop/slot6 stayed held from 03:27Z on 2026-10-24 by "the untracked
 * file .nightly-builds/5f7b5ad5…-win/player/UnityPlayer.dll is 80 MB": the game repo does not ignore .nightly-builds/, and
 * only some machines' clones exclude it (BEAST's info/exclude does, LothDesktop's did not), so a player build pinned it.
 */
export const SAVE_SKIPS = ['.nightly-builds/', 'builds/'];

/**
 * The exclude pathspecs for the build folders this sandbox has, by their names on disk, leaving out one git already
 * ignores. An exclude pathspec that names an ignored folder makes `git add` answer "The following paths are ignored by one
 * of your .gitignore files: Builds ... Use -f" with exit 1, though it staged the rest (git 2.47, measured): the game repo
 * ignores Builds/, so every save of lothdesktop/slot6 from 06:56Z on 2026-10-24 failed "git add failed: Builds hint: Use
 * -f if you really want to add them" and the sandbox stayed held (w1983).
 */
async function skipSpecs(dir: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && SAVE_SKIPS.includes(`${e.name.toLowerCase()}/`)).map((e) => e.name);
  } catch {
    return [];
  }
  const specs: string[] = [];
  for (const n of names) if ((await git(dir, ['check-ignore', '-q', '--', `${n}/`])).code !== 0) specs.push(`:(exclude,literal)${n}/`);
  return specs;
}

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
  const list = (await must(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...(await skipSpecs(dir))], 'listing untracked files')).split('\0').filter(Boolean);
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

/**
 * Restore to HEAD the modified .mat files whose every change is the editor's own (editorNoise.ts, w2782), and name them.
 * The diff is against HEAD, so a staged change counts like an unstaged one; the restore resets both.
 */
export async function restoreEditorNoise(dir: string): Promise<string[]> {
  const diff = await must(dir, ['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--no-textconv', '--', '*.mat'], 'reading the material changes');
  const files = noiseFiles(diff);
  if (files.length) await must(dir, ['checkout', 'HEAD', '--', ...files.map((f) => `:(literal)${f}`)], 'restoring editor noise');
  return files;
}

export async function saveWork(opts: { dir: string; branch: string; message: string; limits?: typeof SAVE_LIMITS; env?: NodeJS.ProcessEnv }): Promise<SaveResult> {
  const { dir, branch } = opts;
  const st = parseStatus(await must(dir, ['status', '--porcelain=v2', '--branch'], 'git status'));
  if (st.branch !== branch) throw new Error(`the sandbox is on ${st.branch}, not the worker's branch ${branch}: nothing was saved`);
  if (SHARED.test(branch)) throw new Error(`its work is on ${branch}, a shared branch: committing there is a decision for a person`);
  if (!st.dirty && !st.untracked) return { files: 0, pushed: false, notes: ['nothing to save'] };
  const problem = st.untracked ? await untrackedProblem(dir, opts.limits) : undefined;
  if (problem) throw new Error(problem);
  const restored = st.dirty ? await restoreEditorNoise(dir) : [];
  const noise = restored.length ? [`restored ${restored.length} material(s) the Unity editor only re-serialized to HEAD instead of saving them (w2782): ${restored.join(', ')}`] : [];
  await must(dir, ['add', '-A', '--', '.', ...(await skipSpecs(dir))], 'git add');
  const files = (await must(dir, ['diff', '--cached', '--name-only', '-z'], 'listing what is saved')).split('\0').filter(Boolean).length;
  if (!files) return { files: 0, pushed: false, notes: [...noise, restored.length ? 'nothing else to save' : `nothing to save (build output in ${SAVE_SKIPS.join(' or ')} stays, uncommitted)`] };
  await must(dir, ['commit', '-q', '--no-verify', '-m', opts.message], 'git commit');
  const sha = (await must(dir, ['rev-parse', '--short', 'HEAD'], 'reading the commit')).trim();
  const notes = [...noise, `committed ${files} file(s) on ${branch} as ${sha}`];
  const push = await git(dir, ['push', '-u', 'origin', `${branch}:${branch}`], 5 * 60_000, opts.env);
  if (push.code === 0) notes.push(`pushed ${branch}`);
  else notes.push(`not pushed (${(push.stderr || push.stdout).trim().split('\n').slice(-1)[0]}): the commit is in this machine's repository, and the next switch away pushes it`);
  return { sha, files, pushed: push.code === 0, notes };
}
