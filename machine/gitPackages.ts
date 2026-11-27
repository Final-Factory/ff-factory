/**
 * w6412: git packages a sandbox's Packages/manifest.json names that its Library/PackageCache lacks.
 *
 * A Windows sandbox editor runs at Low integrity (the worker fence, machine/lowIntegrity.ts). Its Package Manager fetches a
 * git package it has not cached with the git on the editor's PATH, the machine's own, which dies at Low ("sh.exe: fatal error
 * - NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...): 0xC0000022", w5333), and then has no credential for a private
 * repository ("could not read Username for https://github.com: terminal prompts disabled"). The editor stops on the
 * "Unity Package Manager Error" dialog (Retry / Quit / Continue). Seen on BEAST slot2 for w6403: origin/pre-1.0 pins
 * com.akb.knn at https://github.com/Final-Factory/KNN.git#375be6b9ff..., which master no longer does, so a sandbox that ran
 * master had no copy.
 *
 * What Unity 6000.3's Package Manager accepts (measured on m5, 2026-11-27, batchmode 6000.3.19f1, GitHub blocked for the run
 * with a command-scope url.insteadOf):
 * - A git package's cache folder is `<name>@<first 12 hex>` of the lock's commit hash, or with `?path=<p>` of
 *   sha1(<commit hash> + <p without its leading slash>) (checked on m5/slot1's five git packages and a fresh UniTask one).
 * - A folder put there by hand is NOT reused: the Package Manager clones again (and deletes the folder), in a fresh project
 *   and in an already resolved one, even with an entry added to Library/PackageManager/projectResolution.json. It reuses a
 *   cached git package only when the editor's own Library/PackageManager/ProjectCache lists it, internal state not forged here.
 * - An embedded copy (Packages/<name>) resolves with no fetch, but rewrites the tracked Packages/packages-lock.json (source
 *   "embedded"), so a worker could commit it.
 * - A command-scope `url.<mirror>.insteadOf=<the manifest's URL>` makes the Package Manager's own `git fetch --depth=1 origin
 *   <commit>` read a local bare mirror: it resolved with GitHub blocked, wrote the same cache folder name as a real sandbox
 *   (com.veriorpies.parrelsync@ca2a190a45f6) and left packages-lock.json's URL and hash as they were.
 *
 * So the route ("on"): the daemon fetches each missing package's repository into a bare mirror under
 * `<root>/cache-medium/git-packages/<host>/<owner>/<repo>.git` (a Medium-only root child: a Low editor reads it and cannot
 * write it) with its own git and credential, outside the fence; the Low editor starts with the workers' Git first on its PATH
 * (server/agentGit.ts, whose msys runs at Low) and one url.insteadOf per mirrored repository. No credential reaches the
 * editor and no tracked file changes. "warn" (the default) only names the missing packages and the route; "off" looks at
 * nothing (daemon.json `editorGitPackages`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MEDIUM_CACHE_CHILD } from '../server/claudeHome.ts';
import type { RunResult } from '../server/proc.ts';

export type GitPackagesMode = 'off' | 'warn' | 'on';

/** daemon.json `editorGitPackages`: anything but off and on is warn, the default. */
export function gitPackagesModeOf(v: unknown): GitPackagesMode {
  return v === 'off' || v === 'on' ? v : 'warn';
}

export interface GitDep {
  name: string;
  /** The value in manifest.json, as written. */
  spec: string;
  /** The repository URL: the spec without `?path=` and `#revision` (and without a `git+` prefix). */
  url: string;
  /** `?path=` as written, if any. */
  subPath?: string;
  /** `#revision` as written, if any (a commit, a tag or a branch). */
  revision?: string;
  /** The commit packages-lock.json records for this spec, when its entry has the same version. */
  lockHash?: string;
}

const SHA = /^[0-9a-f]{40}$/i;

/** Whether a manifest dependency value is a git URL (Unity's forms: https/ssh/git/file URLs to a .git repo, git+ URLs, scp-like git@host:). */
export function isGitSpec(v: string): boolean {
  if (/^git\+/i.test(v)) return true;
  if (/^git@[^:]+:/i.test(v)) return true;
  const base = v.replace(/[?#].*$/, '');
  return /^(https?|ssh|git):\/\//i.test(v) && /\.git\/?$/i.test(base);
}

export function parseGitSpec(name: string, spec: string): GitDep {
  const noPlus = spec.replace(/^git\+/i, '');
  const hashAt = noPlus.indexOf('#');
  const revision = hashAt >= 0 ? noPlus.slice(hashAt + 1) || undefined : undefined;
  const beforeRev = hashAt >= 0 ? noPlus.slice(0, hashAt) : noPlus;
  const q = beforeRev.indexOf('?');
  const url = q >= 0 ? beforeRev.slice(0, q) : beforeRev;
  const query = q >= 0 ? new URLSearchParams(beforeRev.slice(q + 1)) : undefined;
  const subPath = query?.get('path') || undefined;
  return { name, spec, url, ...(subPath ? { subPath } : {}), ...(revision ? { revision } : {}) };
}

/** The git dependencies of a manifest, each with its locked commit when packages-lock.json has one for the same spec. */
export function gitDepsOf(manifestText: string, lockText?: string): GitDep[] {
  let deps: Record<string, unknown> = {};
  try {
    deps = (JSON.parse(manifestText) as { dependencies?: Record<string, unknown> }).dependencies ?? {};
  } catch {
    return [];
  }
  let lock: Record<string, { version?: unknown; source?: unknown; hash?: unknown }> = {};
  try {
    lock = lockText ? ((JSON.parse(lockText) as { dependencies?: typeof lock }).dependencies ?? {}) : {};
  } catch {
    lock = {};
  }
  const out: GitDep[] = [];
  for (const [name, v] of Object.entries(deps)) {
    if (typeof v !== 'string' || !isGitSpec(v)) continue;
    const dep = parseGitSpec(name, v);
    const l = lock[name];
    if (l && l.version === v && l.source === 'git' && typeof l.hash === 'string' && SHA.test(l.hash)) dep.lockHash = l.hash.toLowerCase();
    else if (dep.revision && SHA.test(dep.revision)) dep.lockHash = dep.revision.toLowerCase();
    out.push(dep);
  }
  return out;
}

/**
 * Library/PackageCache's folder for a git package at `hash` (measured, see the header): `<name>@<hash[0:12]>`, or with a
 * subfolder `<name>@<sha1(hash + path without its leading slash)[0:12]>`.
 */
export function cacheFolderName(name: string, hash: string, subPath?: string): string {
  const p = subPath?.replace(/^\/+/, '');
  const id = p ? crypto.createHash('sha1').update(hash + p).digest('hex') : hash.toLowerCase();
  return `${name}@${id.slice(0, 12)}`;
}

export interface ProjectFs {
  readFile(p: string): string;
  readdir(p: string): string[];
  exists(p: string): boolean;
}

export const realProjectFs: ProjectFs = {
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  readdir: (p) => fs.readdirSync(p),
  exists: (p) => fs.existsSync(p),
};

/**
 * The git packages of the project at `repo` that its Library/PackageCache lacks: with a locked commit, its exact folder;
 * without one, any `<name>@` folder counts as there. An embedded copy (Packages/<name>/package.json) wins over the
 * manifest, so it is never missing.
 */
export function missingGitPackages(repo: string, f: ProjectFs = realProjectFs, platform: NodeJS.Platform = process.platform): GitDep[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let manifest: string;
  try {
    manifest = f.readFile(p.join(repo, 'Packages', 'manifest.json'));
  } catch {
    return [];
  }
  let lock: string | undefined;
  try {
    lock = f.readFile(p.join(repo, 'Packages', 'packages-lock.json'));
  } catch {
    lock = undefined;
  }
  const cache = p.join(repo, 'Library', 'PackageCache');
  let cached: string[] = [];
  try {
    cached = f.readdir(cache);
  } catch {
    cached = [];
  }
  return gitDepsOf(manifest, lock).filter((d) => {
    if (f.exists(p.join(repo, 'Packages', d.name, 'package.json'))) return false;
    if (d.lockHash) return !cached.includes(cacheFolderName(d.name, d.lockHash, d.subPath));
    return !cached.some((c) => c.startsWith(`${d.name}@`));
  });
}

/** `owner/repo` of a github.com https URL (the route the daemon's credential covers), else undefined. */
export function githubRepoOf(url: string): { owner: string; repo: string } | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/?$/i.exec(url);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export const gitPackagesMirrorRoot = (root: string) => path.join(root, MEDIUM_CACHE_CHILD, 'git-packages');

/** The bare mirror of a github.com repository: `<root>/cache-medium/git-packages/github.com/<owner>/<repo>.git`. */
export function mirrorDirOf(root: string, url: string): string | undefined {
  const g = githubRepoOf(url);
  return g ? path.join(gitPackagesMirrorRoot(root), 'github.com', g.owner, `${g.repo}.git`) : undefined;
}

/** A file URL git accepts for a local path on either OS (file:///F:/ffw/... on Windows). */
export function fileUrlOf(dir: string): string {
  const fwd = dir.replace(/\\/g, '/');
  return fwd.startsWith('/') ? `file://${fwd}` : `file:///${fwd}`;
}

/**
 * Command-scope git config (GIT_CONFIG_*) that sends each mirrored URL to its mirror, appended after the entries `prior`
 * already has (server/launch.ts githubCredentialEnv does the same).
 */
export function insteadOfEnv(mirrors: { url: string; dir: string }[], prior: Record<string, string | undefined>): Record<string, string> {
  if (!mirrors.length) return {};
  const n = Number(prior.GIT_CONFIG_COUNT ?? 0) || 0;
  const out: Record<string, string> = {};
  mirrors.forEach((m, i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = `url.${fileUrlOf(m.dir)}.insteadOf`;
    out[`GIT_CONFIG_VALUE_${n + i}`] = m.url;
  });
  out.GIT_CONFIG_COUNT = String(n + mirrors.length);
  return out;
}

/** The workers' Git first on a PATH (lowIntegrity.ts lowEnv's order: cmd, then usr\bin), for the Low editor. */
export function lowGitPath(gitDir: string, pathNow: string | undefined): string {
  return [path.win32.join(gitDir, 'cmd'), path.win32.join(gitDir, 'usr', 'bin'), pathNow].filter(Boolean).join(';');
}

const short = (d: GitDep) => `${d.name} (${d.url}${d.subPath ? `?path=${d.subPath}` : ''}${d.revision ? `#${d.revision.slice(0, 12)}` : ''})`;

/**
 * What `unity status`, the start note and the Package Manager dialog notice say about missing git packages: the cause,
 * and the route for the mode. Undefined when none is missing.
 */
export function missingNote(missing: GitDep[], mode: GitPackagesMode, lowFenced: boolean): string | undefined {
  if (!missing.length || mode === 'off') return undefined;
  const what = `git package${missing.length > 1 ? 's' : ''} missing from Library/PackageCache: ${missing.map(short).join(', ')}`;
  if (!lowFenced) return `${what}; the Package Manager fetches ${missing.length > 1 ? 'them' : 'it'} at the editor's start`;
  const cause =
    "a Low-integrity editor's Package Manager cannot fetch one itself (the machine's Git dies at Low: msys NtCreateDirectoryObject 0xC0000022, then no credential: \"could not read Username\") and stops on the \"Unity Package Manager Error\" dialog";
  const route =
    mode === 'on'
      ? 'route: daemon.json editorGitPackages on mirrors each into <root>/cache-medium/git-packages at the next start (w6412)'
      : 'route: daemon.json editorGitPackages on (ops_worker machine_update editor_git_packages on) mirrors them outside the fence at the next start; until then, clone each at that commit with your own git into Packages/<name> as a temporary embedded package and delete it after (it rewrites Packages/packages-lock.json: never commit that)';
  return `${what}; ${cause}; ${route}`;
}

export type MirrorGit = (args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

const firstLine = (r: RunResult) => (r.stderr || r.stdout).trim().split('\n').slice(-1)[0]?.slice(0, 200) ?? '';

/**
 * Fetch `dep`'s repository into its mirror with the daemon's own git (and so its credential: nothing is passed in or
 * printed here), so that its locked commit (or its revision) is there. Returns the mirror, or why not.
 */
export async function ensureMirror(root: string, dep: GitDep, git: MirrorGit, f: { exists(p: string): boolean; mkdir(p: string): void } = { exists: fs.existsSync, mkdir: (p) => fs.mkdirSync(p, { recursive: true }) }): Promise<{ dir: string } | { why: string }> {
  const dir = mirrorDirOf(root, dep.url);
  if (!dir) return { why: `${dep.url} is not a github.com https URL, the only route the daemon's credential covers` };
  const gd = [`--git-dir=${dir}`];
  if (!f.exists(path.join(dir, 'HEAD'))) {
    f.mkdir(dir);
    const init = await git(['init', '--quiet', '--bare', dir]);
    if (init.code !== 0) return { why: `git init of ${dir} failed: ${firstLine(init)}` };
  }
  // The origin and refspecs are set every time, so a mirror's config is always this one.
  for (const args of [
    ['config', 'remote.origin.url', dep.url],
    ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'],
    ['config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*'],
  ]) {
    const r = await git([...gd, ...args]);
    if (r.code !== 0) return { why: `git config in ${dir} failed: ${firstLine(r)}` };
  }
  const want = dep.lockHash;
  const have = async (sha: string) => (await git([...gd, 'cat-file', '-e', `${sha}^{commit}`])).code === 0;
  if (want && (await have(want))) return { dir };
  const fetched = await git([...gd, 'fetch', '--quiet', '--prune', 'origin'], { timeoutMs: 10 * 60_000 });
  if (fetched.code !== 0) return { why: `git fetch of ${dep.url} failed: ${firstLine(fetched)}` };
  const head = await git([...gd, 'ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs: 60_000 });
  const sym = /^ref: (refs\/heads\/\S+)\s+HEAD/m.exec(head.stdout);
  if (sym) await git([...gd, 'symbolic-ref', 'HEAD', sym[1]]);
  if (want && !(await have(want))) {
    // A commit no branch or tag holds: fetched by its id and kept by a ref of ours, so a later --prune keeps it.
    const one = await git([...gd, 'fetch', '--quiet', 'origin', want], { timeoutMs: 10 * 60_000 });
    if (one.code !== 0 || !(await have(want))) return { why: `${dep.url} has no commit ${want} the daemon can fetch: ${firstLine(one)}` };
  }
  if (want) await git([...gd, 'update-ref', `refs/ff-pin/${want}`, want]);
  return { dir };
}

export interface PrepareResult {
  /** Variables the editor starts with on top of its own (empty when nothing is mirrored). */
  env: Record<string, string>;
  /** What the start says about git packages, if anything. */
  note?: string;
}

/**
 * Before a sandbox editor starts: in "on", for a Windows Low-fenced editor with the workers' Git, the missing git packages
 * are mirrored and the editor gets the Git on PATH and the url.insteadOf entries; otherwise only the note. One mirror's
 * fetch at a time (two sandboxes starting together share it).
 */
export interface GitPackagesOptions {
  mode: () => GitPackagesMode;
  root: string | undefined;
  git: MirrorGit;
  fs?: ProjectFs;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  /** Make a mirror's folder (tests: nothing). */
  mkdir?: (p: string) => void;
  exists?: (p: string) => boolean;
}

export class GitPackages {
  private readonly busy = new Map<string, Promise<{ dir: string } | { why: string }>>();
  private readonly o: GitPackagesOptions;
  constructor(o: GitPackagesOptions) {
    this.o = o;
  }

  get mode(): GitPackagesMode {
    return this.o.mode();
  }

  /** The note `unity status` and the dialog notice carry now (fresh from disk). */
  note(repo: string, lowFenced: boolean): string | undefined {
    const mode = this.mode;
    if (mode === 'off') return undefined;
    return missingNote(missingGitPackages(repo, this.o.fs, this.o.platform), mode, lowFenced);
  }

  private mirror(dep: GitDep): Promise<{ dir: string } | { why: string }> {
    const root = this.o.root as string;
    const key = `${mirrorDirOf(root, dep.url)}#${dep.lockHash ?? ''}`;
    let p = this.busy.get(key);
    if (!p) {
      p = ensureMirror(root, dep, this.o.git, { exists: this.o.exists ?? fs.existsSync, mkdir: this.o.mkdir ?? ((d) => fs.mkdirSync(d, { recursive: true })) }).catch((e: Error) => ({ why: e.message }));
      this.busy.set(key, p);
      void p.finally(() => this.busy.delete(key));
    }
    return p;
  }

  /**
   * After a switch: the note for the switch's result, and in "on" for a Low editor the mirrors fetched now in the
   * background, so the editor's next start finds them ready. Never throws.
   */
  afterSwitch(repo: string, lowFenced: boolean): string | undefined {
    try {
      const mode = this.mode;
      if (mode === 'off') return undefined;
      const missing = missingGitPackages(repo, this.o.fs, this.o.platform);
      if (!missing.length) return undefined;
      if (mode === 'on' && lowFenced && this.o.root) {
        for (const d of missing) void this.mirror(d).then((r) => ('why' in r ? this.o.log?.(`git packages: ${repo}: could not mirror ${d.name}: ${r.why}`) : undefined));
        return `git package${missing.length > 1 ? 's' : ''} ${missing.map((d) => d.name).join(', ')} missing from Library/PackageCache: the daemon is mirroring ${missing.length > 1 ? 'them' : 'it'} for the editor's next start (editorGitPackages on, w6412)`;
      }
      return missingNote(missing, mode, lowFenced);
    } catch {
      return undefined;
    }
  }

  /** `lowGitDir`: the workers' Git when the editor starts at Low on Windows (undefined: not Low-fenced). */
  async prepare(repo: string, lowGitDir: string | undefined, env: Record<string, string | undefined>, lowFenced = !!lowGitDir): Promise<PrepareResult> {
    const mode = this.mode;
    if (mode === 'off') return { env: {} };
    const missing = missingGitPackages(repo, this.o.fs, this.o.platform);
    if (!missing.length) return { env: {} };
    if (mode === 'warn' || !lowFenced) return { env: {}, note: missingNote(missing, mode, lowFenced) };
    if (!this.o.root) return { env: {}, note: `${missingNote(missing, 'warn', true)} (editorGitPackages is on but this daemon has no root for the mirrors)` };
    if (!lowGitDir) return { env: {}, note: `${missingNote(missing, 'warn', true)} (editorGitPackages is on but the workers' Git is not at <root>\\tools\\git yet)` };
    const served: { url: string; dir: string; name: string }[] = [];
    const failed: string[] = [];
    for (const d of missing) {
      const r = await this.mirror(d);
      if ('dir' in r) served.push({ url: d.url, dir: r.dir, name: d.name });
      else failed.push(`${d.name}: ${r.why}`);
    }
    for (const fl of failed) this.o.log?.(`git packages: ${repo}: could not mirror ${fl}`);
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const out = served.length ? { [pathKey]: lowGitPath(lowGitDir, env[pathKey]), ...insteadOfEnv(served, env) } : {};
    const parts = [
      served.length ? `git package${served.length > 1 ? 's' : ''} ${served.map((s) => s.name).join(', ')} missing from Library/PackageCache: the Package Manager fetches ${served.length > 1 ? 'them' : 'it'} from the daemon's mirror${served.length > 1 ? 's' : ''} under ${gitPackagesMirrorRoot(this.o.root)} with the workers' Git (w6412)` : '',
      failed.length ? `could not mirror ${failed.join('; ')}: the editor may stop on the Package Manager dialog` : '',
    ].filter(Boolean);
    return { env: out, note: parts.join('; ') };
  }
}
