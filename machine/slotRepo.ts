/**
 * Slot repos (w5614, stage 1 of w5544; docs/machines.md "Slot repos"): a sandbox that is its own git repo instead of a
 * worktree of the machine's main clone (the store). Its `.git` is a folder whose objects/info/alternates names the
 * store's objects, so it reads every object the store has without a copy, and everything it writes (commits, refs, its
 * index, a fetch from GitHub, its stash) lands in its own `.git`, never in the store.
 *
 * Measured on LothDesktop, 2026-11-25 (r384, w5614):
 * - git-lfs 3.8.1 reads LFS objects through the alternate (`<alt>/../lfs/objects` is a LocalReferenceDir); on ReFS the
 *   copy it makes into the slot shares the store object's extents, so it takes no space.
 * - converting slot4 (a stopped worktree) kept its files and index: the next editor start imported nothing (Imports
 *   total=0, Asset File Changes 0/0/0/0), as a control start of the worktree did.
 * - a commit took 0.7-1.8 s in the slot repo against 9-11.5 s as a worktree; fetch and status did not change.
 *
 * What the store must keep: an object a slot borrows and no store ref reaches (a slot's branch whose origin branch was
 * deleted) would go in the store's next prune. guardStorePrune sets gc.pruneExpire=never on the store before the first
 * slot repo borrows from it; and a removed slot's branches are fetched into the store first (keepSlotBranches).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RunResult } from '../server/proc.ts';

/** PoolDeps['git']: git run in the store (`git -C <store> ...`); a leading `-C <dir>` runs it in another folder. */
export type StoreGit = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<RunResult>;

/** Store config a slot repo copies: how files are checked out, the LFS filter, where origin is, who commits. */
export const COPIED_KEYS = [
  'core.filemode',
  'core.ignorecase',
  'core.symlinks',
  'core.autocrlf',
  'core.longpaths',
  'filter.lfs.clean',
  'filter.lfs.smudge',
  'filter.lfs.process',
  'filter.lfs.required',
  'lfs.repositoryformatversion',
  'remote.origin.url',
  'user.name',
  'user.email',
];

/** Refs a store holds for origin's branches, which every slot repo gets a copy of (the refs only: the objects are borrowed). */
const ORIGIN_REFS = '+refs/remotes/origin/*:refs/remotes/origin/*';

/** Whether `dir` is a slot repo: its .git is a folder that borrows objects through objects/info/alternates. */
export function isSlotRepo(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory() && fs.existsSync(path.join(dir, '.git', 'objects', 'info', 'alternates'));
  } catch {
    return false;
  }
}

/** Whether `dir` is a worktree: its .git is a file ("gitdir: ..."). */
export function isWorktree(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

/** The object folders a slot repo borrows from (objects/info/alternates), as written. */
export function alternatesOf(dir: string): string[] {
  try {
    return fs
      .readFileSync(path.join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** A path as git writes it into alternates on every OS: forward slashes (V:/ffw/repo/objects; measured with git 2.5x). */
export function gitPathForm(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

function samePath(a: string, b: string): boolean {
  // The real path: a Windows 8.3 short name (C:\Users\RUNNER~1, the CI runner's TEMP) and git's long form are one folder.
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const k = (p: string) => real(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? k(a).toLowerCase() === k(b).toLowerCase() : k(a) === k(b);
}

/** Whether a slot repo at `dir` borrows from the store whose git folder is `storeGitDir`. */
export function borrowsFrom(dir: string, storeGitDir: string): boolean {
  return alternatesOf(dir).some((a) => samePath(a, path.join(storeGitDir, 'objects')));
}

const short = (s: string) => s.trim().split('\n').slice(-3).join(' | ').slice(0, 400);

async function must(git: StoreGit, args: string[], what: string, signal?: AbortSignal, timeoutMs = 10 * 60_000): Promise<string> {
  const r = await git(args, { timeoutMs, signal });
  if (r.code !== 0) throw new Error(`${what} failed (${r.code}): ${short(r.stderr || r.stdout)}`);
  return r.stdout;
}

/** The store's own git folder (a bare clone's is the clone itself), absolute. */
export async function storeGitDir(git: StoreGit, signal?: AbortSignal): Promise<string> {
  return (await must(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'finding the main clone\'s git folder', signal, 60_000)).trim();
}

/**
 * Keep every object a slot borrows: an unreachable object stays in the store (in a cruft pack) instead of being pruned
 * two weeks on. Idempotent; a value someone set on purpose is left as it is. Call under withBaseRepoLock.
 */
export async function guardStorePrune(git: StoreGit, signal?: AbortSignal): Promise<string | undefined> {
  const cur = await git(['config', '--get', 'gc.pruneExpire'], { signal });
  if (cur.code === 0 && cur.stdout.trim()) return undefined;
  await must(git, ['config', 'gc.pruneExpire', 'never'], 'setting gc.pruneExpire on the main clone', signal, 60_000);
  return 'the main clone keeps unreachable objects now (gc.pruneExpire=never): slot repos borrow them';
}

/** A config file's entries as `git config --list -z` gives them: [key, value], a bare key's value 'true'. */
async function readConfig(git: StoreGit, file: string, signal?: AbortSignal): Promise<[string, string][]> {
  const out = await must(git, ['config', '--file', file, '--list', '-z'], `reading ${file}`, signal, 60_000);
  return out.split('\0').filter(Boolean).map((e) => {
    const i = e.indexOf('\n');
    return i < 0 ? [e, 'true'] : [e.slice(0, i), e.slice(i + 1)];
  });
}

/**
 * A git config file holding `entries` in order, one section per section and subsection. Values are quoted with `\\`,
 * `"`, newline and tab escaped, so git reads back exactly what --list gave (configText's test reads it back).
 */
export function configText(entries: [string, string][]): string {
  const q = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
  const sections = new Map<string, string[]>();
  for (const [k, v] of entries) {
    const a = k.indexOf('.');
    const b = k.lastIndexOf('.');
    if (a <= 0 || b === k.length - 1) continue;
    const head = a === b ? `[${k.slice(0, a)}]` : `[${k.slice(0, a)} ${q(k.slice(a + 1, b)).replace(/\\n|\\t/g, '')}]`;
    if (!sections.has(head)) sections.set(head, []);
    sections.get(head)!.push(`\t${k.slice(b + 1)} = ${q(v)}`);
  }
  return [...sections].map(([h, lines]) => `${h}\n${lines.join('\n')}\n`).join('');
}

/**
 * A fresh slot git folder at `gd`: config from the store (COPIED_KEYS, `branch`'s upstream, then `extra`), origin's
 * fetch refspec, alternates to the store's objects. One store read and one file write (each git config call was a
 * spawn: about 20 of them per slot repo).
 */
async function initGitDir(git: StoreGit, store: string, gd: string, branch: string | undefined, extra: [string, string][], signal?: AbortSignal) {
  fs.rmSync(gd, { recursive: true, force: true });
  await must(git, ['init', '--quiet', '--bare', gd], 'git init', signal, 60_000);
  const storeCfg = await readConfig(git, path.join(store, 'config'), signal);
  const pick = (k: string) => storeCfg.filter(([key]) => key === k);
  const up = branch ? [`branch.${branch}.remote`, `branch.${branch}.merge`] : [];
  const entries: [string, string][] = [
    ['core.repositoryformatversion', '0'],
    ['core.bare', 'false'],
    ['core.logallrefupdates', 'true'],
    ...COPIED_KEYS.flatMap((k) => pick(k.toLowerCase()).slice(-1)),
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ...up.flatMap((k) => storeCfg.filter(([key]) => key.toLowerCase() === k.toLowerCase()).slice(-1)),
    ...extra,
  ];
  fs.writeFileSync(path.join(gd, 'config'), configText(entries));
  fs.writeFileSync(path.join(gd, 'objects', 'info', 'alternates'), `${gitPathForm(path.join(store, 'objects'))}\n`);
}

/**
 * Make `dir/.git` a slot repo on `branch`, with no checkout (the caller's `reset --hard` checks it out): the store's
 * branch if it has one, else origin's (tracked), else a new branch at `base`. Returns the base it used. Built in
 * `.git.new` and moved into place last, so a cut-off run leaves no half-made .git. Call under withBaseRepoLock (it
 * reads the store's refs). `dir` must hold no .git.
 */
export async function makeSlotRepo(git: StoreGit, dir: string, branch: string, base: string, signal?: AbortSignal): Promise<{ base: string }> {
  if (fs.existsSync(path.join(dir, '.git'))) throw new Error(`${dir} already has a .git`);
  const store = await storeGitDir(git, signal);
  const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { signal });
  const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { signal });
  fs.mkdirSync(dir, { recursive: true });
  const gd = path.join(dir, '.git.new');
  const tracked = local.code !== 0 && remote.code === 0;
  const extra: [string, string][] = tracked ? [[`branch.${branch}.remote`, 'origin'], [`branch.${branch}.merge`, `refs/heads/${branch}`]] : [];
  await initGitDir(git, store, gd, local.code === 0 ? branch : undefined, extra, signal);
  const into = ['--git-dir', gd];
  const refs = [ORIGIN_REFS, ...(local.code === 0 ? [`+refs/heads/${branch}:refs/heads/${branch}`] : [])];
  await must(git, [...into, 'fetch', '--quiet', '--no-tags', '--update-head-ok', store, ...refs], 'fetching refs from the main clone', signal);
  if (local.code === 0) {
    // fetched above, upstream config copied by initGitDir
  } else if (tracked) {
    await must(git, [...into, 'update-ref', `refs/heads/${branch}`, remote.stdout.trim()], 'git update-ref', signal, 60_000);
    base = `origin/${branch}`;
  } else {
    // The store resolves the base (origin/master, a sha, HEAD); its commit is one the slot borrows.
    const sha = (await must(git, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], `finding ${base}`, signal, 60_000)).trim();
    await must(git, [...into, 'update-ref', `refs/heads/${branch}`, sha], 'git update-ref', signal, 60_000);
  }
  fs.writeFileSync(path.join(gd, 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.renameSync(gd, path.join(dir, '.git'));
  return { base };
}

/**
 * Turn a worktree of the store at `dir` into a slot repo in place (the editor must be stopped and nobody working there):
 * its HEAD, index and branch come along, so no file in it changes and Unity imports nothing (measured, w5614 step 2).
 * The worktree's record in the store is removed last, so the branch is no longer "checked out" there. Its old .git
 * pointer is kept as .git/worktree-pointer. Call under withBaseRepoLock. Returns what it did, in words.
 */
export async function convertToSlotRepo(git: StoreGit, dir: string, signal?: AbortSignal): Promise<string> {
  if (!isWorktree(dir)) throw new Error(`${dir} is not a worktree (its .git is not a file)`);
  const [own, common] = (await must(git, ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], 'reading the worktree', signal, 60_000)).trim().split('\n').map((s) => s.trim());
  const store = await storeGitDir(git, signal);
  if (!own || !common || !samePath(common, store)) throw new Error(`${dir} is a worktree of ${common}, not of the main clone ${store}`);
  const head = await git(['-C', dir, 'symbolic-ref', '--quiet', 'HEAD'], { signal });
  const branch = head.code === 0 ? head.stdout.trim().replace(/^refs\/heads\//, '') : undefined;
  const gd = path.join(dir, '.git.new');
  const cfgWt = path.join(own, 'config.worktree');
  const extra = fs.existsSync(cfgWt) ? await readConfig(git, cfgWt, signal) : [];
  await initGitDir(git, store, gd, branch, extra, signal);
  const into = ['--git-dir', gd];
  const refs = [ORIGIN_REFS, ...(branch ? [`+refs/heads/${branch}:refs/heads/${branch}`] : [])];
  await must(git, [...into, 'fetch', '--quiet', '--no-tags', '--update-head-ok', store, ...refs], 'fetching refs from the main clone', signal);
  for (const f of ['HEAD', 'index', 'ORIG_HEAD', 'MERGE_HEAD', 'FETCH_HEAD']) {
    const src = path.join(own, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(gd, f));
  }
  // armScriptReimport's lines (scriptReimport.ts) are written to the git common dir's info/exclude: keep them.
  const exclude = path.join(store, 'info', 'exclude');
  if (fs.existsSync(exclude)) fs.copyFileSync(exclude, path.join(gd, 'info', 'exclude'));
  const pointer = fs.readFileSync(path.join(dir, '.git'), 'utf8');
  fs.writeFileSync(path.join(gd, 'worktree-pointer'), pointer);
  // The swap: two renames in the sandbox's own folder. A cut between them leaves .git missing and .git.new whole, which
  // finishConversion completes.
  fs.renameSync(path.join(dir, '.git'), path.join(dir, '.git.worktree'));
  fs.renameSync(gd, path.join(dir, '.git'));
  fs.rmSync(path.join(dir, '.git.worktree'), { force: true });
  // The store forgets the worktree: its folder under worktrees/ (the pointer names it), so the branch is free there.
  const wt = worktreeRecordOf(pointer, dir, store);
  if (wt) fs.rmSync(wt, { recursive: true, force: true });
  const left = await git(['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { signal, timeoutMs: 10 * 60_000 });
  const changed = left.code === 0 ? left.stdout.split('\n').filter(Boolean).length : undefined;
  return `converted to a slot repo on ${branch ?? 'a detached HEAD'}${changed === undefined ? '' : `, ${changed} tracked change(s) kept`}`;
}

/** The store's worktrees/<name> folder a worktree's .git pointer names, if it is inside the store's worktrees folder. */
export function worktreeRecordOf(pointer: string, dir: string, store: string): string | undefined {
  const m = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!m) return undefined;
  const p = path.resolve(dir, m[1]!.trim());
  const root = path.join(store, 'worktrees');
  return samePath(path.dirname(p), root) ? p : undefined;
}

/**
 * A conversion a crash cut between its two renames: .git is gone and .git.new holds the whole slot git folder. Moves it
 * into place; returns whether it did. A .git.new beside a .git is a conversion or make that never reached its swap:
 * removed.
 */
export function finishConversion(dir: string): boolean {
  const gd = path.join(dir, '.git.new');
  if (!fs.existsSync(gd)) return false;
  if (fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(gd, { recursive: true, force: true });
    fs.rmSync(path.join(dir, '.git.worktree'), { force: true });
    return false;
  }
  if (!fs.existsSync(path.join(gd, 'worktree-pointer')) && !fs.existsSync(path.join(gd, 'HEAD'))) return false;
  fs.renameSync(gd, path.join(dir, '.git'));
  fs.rmSync(path.join(dir, '.git.worktree'), { force: true });
  return true;
}

/**
 * Before a slot repo is deleted: its branches go into the store, so no commit is lost with the folder (a worktree's
 * branches lived in the store already). Each lands at refs/sandbox-kept/<id>/<branch>, and the one it is on also at
 * refs/heads/<branch> when that is new there or a fast-forward of it. Call under withBaseRepoLock. Returns a problem in
 * words, or undefined.
 */
export async function keepSlotBranches(git: StoreGit, id: string, dir: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
  const kept = await git(['fetch', '--quiet', '--no-tags', dir, `+refs/heads/*:refs/sandbox-kept/${id}/*`], { signal, timeoutMs: 10 * 60_000 });
  if (kept.code !== 0) return `its branches could not be kept in the main clone (${kept.code}): ${short(kept.stderr || kept.stdout)}`;
  // Not forced: a store branch that moved on its own (another sandbox, a fetch) stays as it is; refs/sandbox-kept has this one.
  await git(['fetch', '--quiet', '--no-tags', dir, `refs/heads/${branch}:refs/heads/${branch}`], { signal, timeoutMs: 10 * 60_000 });
  return undefined;
}

/**
 * Before a slot repo switches to `branch` it does not have: take the store's copy (kept there by keepSlotBranches when
 * another sandbox saved or switched away from it, its push failed or held), so a worker placed again in another sandbox
 * finds its commits as it did when every sandbox was a worktree of one repository. Its upstream is origin's branch when
 * origin has one; switchBranch then fast-forwards it if it only lags. Returns a note, or undefined when nothing was done.
 */
export async function takeStoreBranch(git: StoreGit, dir: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
  if ((await git(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { signal })).code === 0) return undefined;
  if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { signal })).code !== 0) return undefined;
  const store = await storeGitDir(git, signal);
  await must(git, ['-C', dir, 'fetch', '--quiet', '--no-tags', store, `refs/heads/${branch}:refs/heads/${branch}`], `taking ${branch} from the main clone`, signal);
  if ((await git(['-C', dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { signal })).code === 0) {
    await must(git, ['-C', dir, 'config', `branch.${branch}.remote`, 'origin'], 'git config', signal, 60_000);
    await must(git, ['-C', dir, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`], 'git config', signal, 60_000);
  }
  return `took ${branch} from the main clone, where another sandbox had kept it`;
}
