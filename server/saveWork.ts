import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.ts';
import { parseStatus } from './gitStatus.ts';
import { fontAtlasNoise, mayBeDynamicFont, noiseFiles } from './editorNoise.ts';
import { guardRemote } from './remoteGuard.ts';

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
 * Untracked files that were already there when the sandbox was switched to the branch (recordForeign, w2988) are not the
 * worker's: they stay untracked, and the notes name them.
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
  /**
   * The side branch origin has it on instead of the worker's branch, when the save was told to hold the branch's push
   * (`holdPush`, w5067: its pull request's CI runs, and a push there would cancel the run).
   */
  sideRef?: string;
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

/** The untracked files of `dir` a save would take (ignored files and the build folders left out), paths from its root. */
async function untrackedFiles(dir: string): Promise<string[]> {
  return (await must(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...(await skipSpecs(dir))], 'listing untracked files')).split('\0').filter(Boolean);
}

/**
 * Where a worktree keeps the untracked files that were there before its branch's worker (w2988): its own git dir, so no
 * other worktree reads it and git never shows it. m5/slot1 was handed to w2979's branch on 2026-11-03 at 17:12Z still
 * holding Assets/_RM1Preview (9 files, 25 MB: another worker's `ffu-bake asteroid --preview` output from 12:20Z), and both
 * CI-wait saves of w2979's worker 5589ceba committed and pushed it (a9fc3dfa54, a0892916e7): the first made its PR
 * conflict, the second moved its head, so the merge on green failed with "Head branch was modified".
 */
async function foreignPath(dir: string): Promise<string> {
  return path.join((await must(dir, ['rev-parse', '--absolute-git-dir'], 'finding the git dir')).trim(), 'ff-foreign-untracked.json');
}

/** Record the untracked files in `dir` as not `branch`'s worker's, just after the sandbox was switched to it; returns them. */
export async function recordForeign(dir: string, branch: string): Promise<string[]> {
  const files = await untrackedFiles(dir);
  const at = await foreignPath(dir);
  if (files.length) fs.writeFileSync(at, JSON.stringify({ branch, files }));
  else fs.rmSync(at, { force: true });
  return files;
}

/** The untracked files recorded for `branch` by recordForeign; none for another branch or no record. */
export async function foreignFiles(dir: string, branch: string): Promise<Set<string>> {
  try {
    const rec = JSON.parse(fs.readFileSync(await foreignPath(dir), 'utf8')) as { branch?: string; files?: string[] };
    return new Set(rec.branch === branch && Array.isArray(rec.files) ? rec.files : []);
  } catch {
    return new Set();
  }
}

/** A few of `files` by name, for a note. */
export const someFiles = (files: string[], n = 5) => `${files.slice(0, n).join(', ')}${files.length > n ? ` and ${files.length - n} more` : ''}`;

/** Why the untracked files of `dir` (but `skip`) are too many or too big to commit, or undefined. Stops at the first excess. */
export async function untrackedProblem(dir: string, limits = SAVE_LIMITS, skip: Set<string> = new Set()): Promise<string | undefined> {
  const list = (await untrackedFiles(dir)).filter((f) => !skip.has(f));
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
 * Restore to HEAD the modified files whose every change is the Unity editor's own, and name them: .mat files the editor
 * re-serialized (editorNoise.ts, w2782) and dynamic TMP font assets that only grew their atlas (fontAtlasNoise, w5067).
 * The diff is against HEAD, so a staged change counts like an unstaged one; the restore resets both.
 */
export async function restoreEditorNoise(dir: string): Promise<string[]> {
  const diff = await must(dir, ['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--no-textconv', '--', '*.mat'], 'reading the material changes');
  const files = noiseFiles(diff);
  const assets = (await must(dir, ['diff', 'HEAD', '--name-only', '-z', '--diff-filter=M', '--no-renames', '--', '*.asset'], 'listing the changed assets')).split('\0').filter(Boolean);
  for (const f of assets) {
    let now: string;
    try {
      now = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    if (!mayBeDynamicFont(f, now)) continue;
    const head = await git(dir, ['show', `HEAD:${f}`]);
    if (head.code === 0 && fontAtlasNoise(head.stdout, now)) files.push(f);
  }
  if (files.length) await must(dir, ['checkout', 'HEAD', '--', ...files.map((f) => `:(literal)${f}`)], 'restoring editor noise');
  return files;
}

/** The side branch a held save goes to on origin (w5067), one per save, like switchBranch's backups: nothing force-pushes it. */
export const savedBranch = (branch: string, sha: string) => `ff-saved/${branch}-${sha}`;

/**
 * `holdPush`: why the worker's branch must not move on origin now (w5067: a worker on it waits on its pull request's
 * CI, and a push would cancel the run; de2893f4's PR #4137 lost a run so on 2026-11-22). The commit is then made on the
 * branch here as always, and pushed to its own side branch (savedBranch) instead: origin keeps it, the push updates the
 * remote-tracking ref, so the next switch away finds nothing unpushed and does not push the branch either, and the PR's
 * head stays where CI runs it. The worker pushes it with its next push, or drops it.
 */
export async function saveWork(opts: { dir: string; branch: string; message: string; limits?: typeof SAVE_LIMITS; env?: NodeJS.ProcessEnv; holdPush?: string }): Promise<SaveResult> {
  const { dir, branch } = opts;
  const st = parseStatus(await must(dir, ['status', '--porcelain=v2', '--branch'], 'git status'));
  if (st.branch !== branch) throw new Error(`the sandbox is on ${st.branch}, not the worker's branch ${branch}: nothing was saved`);
  if (SHARED.test(branch)) throw new Error(`its work is on ${branch}, a shared branch: committing there is a decision for a person`);
  if (!st.dirty && !st.untracked) return { files: 0, pushed: false, notes: ['nothing to save'] };
  const foreign = st.untracked ? await foreignFiles(dir, branch) : new Set<string>();
  const problem = st.untracked ? await untrackedProblem(dir, opts.limits, foreign) : undefined;
  if (problem) throw new Error(problem);
  const restored = st.dirty ? await restoreEditorNoise(dir) : [];
  const noise = restored.length ? [`restored ${restored.length} file(s) the Unity editor only rewrote by itself (re-serialized materials, w2782; a dynamic font atlas that grew, w5067) to HEAD instead of saving them: ${restored.join(', ')}`] : [];
  const left = foreign.size ? (await untrackedFiles(dir)).filter((f) => foreign.has(f)) : [];
  if (left.length) noise.push(`left ${left.length} untracked file(s) uncommitted that were already in the sandbox when it was switched to ${branch}, so not this worker's (w2988): ${someFiles(left)}`);
  // w6099: before anything is committed, so a refused save leaves the sandbox as it was.
  const no = await guardRemote(async (a) => {
    const g = await git(dir, a);
    return g.code === 0 ? g.stdout : undefined;
  }, `the save's push in ${dir}`);
  if (no) throw new Error(no);
  const specs = ['.', ...(await skipSpecs(dir)), ...left.map((f) => `:(exclude,literal)${f}`)];
  // From a file: another worker's leftovers can be hundreds of paths, past Windows' command line.
  const specFile = path.join(path.dirname(await foreignPath(dir)), 'ff-save-pathspec');
  fs.writeFileSync(specFile, specs.join('\0'));
  await must(dir, ['add', '-A', `--pathspec-from-file=${specFile}`, '--pathspec-file-nul'], 'git add');
  const files = (await must(dir, ['diff', '--cached', '--name-only', '-z'], 'listing what is saved')).split('\0').filter(Boolean).length;
  if (!files) return { files: 0, pushed: false, notes: [...noise, restored.length || left.length ? 'nothing else to save' : `nothing to save (build output in ${SAVE_SKIPS.join(' or ')} stays, uncommitted)`] };
  await must(dir, ['commit', '-q', '--no-verify', '-m', opts.message], 'git commit');
  const sha = (await must(dir, ['rev-parse', '--short', 'HEAD'], 'reading the commit')).trim();
  const notes = [...noise, `committed ${files} file(s) on ${branch} as ${sha}`];
  if (opts.holdPush) {
    const side = savedBranch(branch, sha);
    const held = await git(dir, ['push', 'origin', `HEAD:refs/heads/${side}`], 5 * 60_000, opts.env);
    if (held.code !== 0) {
      // Left unpushed, the switch that hands the sandbox over would push the branch (switchBranch): put the work back
      // uncommitted and refuse, so the sandbox stays held and the save is tried again.
      await must(dir, ['reset', '-q', 'HEAD~1'], 'putting the work back uncommitted');
      throw new Error(`pushing the save to the side branch ${side} failed (${(held.stderr || held.stdout).trim().split('\n').slice(-1)[0]}), and ${branch} is not pushed while ${opts.holdPush} (w5067): nothing was changed there`);
    }
    notes.push(`not pushed to ${branch} (${opts.holdPush}: a push there would cancel the run, w5067); pushed to the side branch ${side} instead, and ${branch} here is a commit ahead of origin`);
    return { sha, files, pushed: true, sideRef: side, notes };
  }
  const push = await git(dir, ['push', '-u', 'origin', `${branch}:${branch}`], 5 * 60_000, opts.env);
  if (push.code === 0) notes.push(`pushed ${branch}`);
  else notes.push(`not pushed (${(push.stderr || push.stdout).trim().split('\n').slice(-1)[0]}): the commit is in this machine's repository, and the next switch away pushes it`);
  return { sha, files, pushed: push.code === 0, notes };
}
