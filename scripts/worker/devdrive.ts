// A worker install's Dev Drive (w900, docs/worker-install.md "The Dev Drive"): the decisions, the root's two junctions and
// the move of an existing install's sandboxes. The VHDX itself is made, attached and lettered by devdrive.ps1 (elevated),
// the boot mount and the remount by scripts/privileged/ffsb-helper.ps1; worker.ts runs them. Everything here that needs no
// Windows runs anywhere, so the tests do.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkArray, readJsonDurable, writeJsonDurable } from '../../server/durable.ts';
import { saveWork, untrackedProblem, type SaveResult } from '../../server/saveWork.ts';
import { armScriptReimport } from '../../machine/scriptReimport.ts';
import { DISK_CRITICAL_GB_DEFAULT, DISK_WARN_GB_DEFAULT } from '../../shared/types.ts';

/** <root>/devdrive.json: what devdrive.ps1 and the helper keep about the drive (the letter is the one source of truth). */
export interface DevDriveState {
  vhdx: string;
  /** The drive letter it holds now (upper case, no colon). */
  letter: string;
  maxGB: number;
  label: string;
  fileSystem: string;
  /** Formatted as a Dev Drive (false: plain ReFS, a Windows before 11 22H2). */
  devDrive: boolean;
  blockClone: boolean;
  createdAt: string;
  checkedAt: string;
  /** This run made the VHDX (a re-run reuses it: false). */
  created?: boolean;
  /** The letter it had before this run, when this run had to change it (taken by another volume). */
  letterChangedFrom?: string;
}

/** What root.json records of it (Manifest.devDrive). */
export interface DevDriveRecord {
  vhdx: string;
  letter: string;
  maxGB: number;
  /** The sandboxes and the seed live on it (daemon.json points there). False: the drive is there, the folders still on the root's own volume. */
  inUse: boolean;
}

/** The two folders on the drive: canonical paths, the ones git, Unity and the daemon see (docs/worker-root.md 2.2: never through a junction). */
export function devDriveDirs(letter: string): { sandboxes: string; seed: string } {
  const l = letter.toUpperCase();
  return { sandboxes: `${l}:\\sandboxes`, seed: `${l}:\\seed` };
}

/**
 * The VHDX's maximum size in GB when no flag says. Windows' own minimum for a Dev Drive is 50 GB (sourced: Microsoft Learn,
 * "Set up a Dev Drive on Windows 11"); BEAST's is 900 GB on a volume of about 1 TB (devdrive.ps1). A dynamic VHDX takes only what
 * is written, so the maximum is a ceiling, not a reservation: 90 % of the host volume's size, at most 1 TB, at least 100 GB.
 * A guess, with those two for support; --dev-drive-max-gb overrides it.
 */
export function defaultMaxGB(hostTotalGB: number | undefined): number {
  if (!hostTotalGB || !Number.isFinite(hostTotalGB)) return 600;
  return Math.max(100, Math.min(1024, Math.floor(hostTotalGB * 0.9)));
}

export type DevDriveDecision = { action: 'ensure'; why: string } | { action: 'none'; why: string };

/**
 * Whether this run sets up (or keeps) a Dev Drive. The rule (w900): a fresh install on Windows has one unless --no-dev-drive;
 * an update never makes one on its own (the portal runs updates by itself after every deploy, docs/ops-worker.md "After a
 * verified deploy", and a drive made in the middle of work is not what an update is for): only with --dev-drive, or when the
 * install has one already, which it keeps. A root on ReFS already (BEAST's F:) needs none. Exported for tests.
 */
export function decideDevDrive(i: { platform: NodeJS.Platform; update: boolean; flag?: 'on' | 'off'; hasOne: boolean; rootFileSystem?: string }): DevDriveDecision {
  if (i.platform !== 'win32') return { action: 'none', why: i.flag === 'on' ? 'a Dev Drive is a Windows feature' : 'not Windows' };
  if (i.flag === 'off') return { action: 'none', why: i.hasOne ? '--no-dev-drive: the existing drive is left as it is' : '--no-dev-drive' };
  if (i.hasOne) return { action: 'ensure', why: 'the install has one' };
  if (/^refs$/i.test(i.rootFileSystem ?? '')) return { action: 'none', why: `the root's own volume is already ReFS (block clones work there)` };
  if (i.flag === 'on') return { action: 'ensure', why: '--dev-drive' };
  return i.update ? { action: 'none', why: 'an update makes no Dev Drive unless asked (--dev-drive)' } : { action: 'ensure', why: 'the default for a new Windows install' };
}

/** The line devdrive.ps1 ends with (`FFW-DEVDRIVE {json}`), parsed; undefined when there is none or it is not JSON. */
export function parseDevDriveOutput(text: string): (Partial<DevDriveState> & { removed?: boolean; exists?: boolean; attached?: boolean; letter?: string }) | undefined {
  const m = /^FFW-DEVDRIVE (\{.*\})\s*$/m.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

/** The host guard daemon.json gets with the drive (machine/hostGuard.ts): the drive's remount, and the volume the VHDX grows on. Exported for tests. */
export function devDriveGuard(rootDrive: string, pool: { diskWarnGB?: number; diskCriticalGB?: number } = {}): Record<string, unknown> {
  const warn = pool.diskWarnGB ?? DISK_WARN_GB_DEFAULT;
  return {
    pollSeconds: 30,
    // The pool's own thresholds, not BEAST's 80 and 40: this guard exists to bring the drive back, and it must not refuse
    // work sooner than the pool does. A dynamic VHDX that cannot grow takes the drive away (BEAST, 2026-09-24), so the
    // volume it grows on is watched (hostDiskPaths); the drive's own free space is a ceiling it never reaches first.
    warnFreeGB: warn,
    criticalFreeGB: Math.min(pool.diskCriticalGB ?? DISK_CRITICAL_GB_DEFAULT, warn),
    hysteresisGB: 10,
    remountMinFreeGB: 30,
    hostDiskPaths: [`${rootDrive.replace(/[:\\/]+$/, '').toUpperCase()}:/`],
    reapBrowsersAfterHours: 0,
    reapEveryMinutes: 15,
  };
}

// ---------------------------------------------------------------- the root's two junctions

export interface LinkResult {
  name: string;
  action: 'created' | 'kept' | 'retargeted' | 'blocked';
  detail: string;
}

const norm = (p: string) => p.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

/**
 * Make <root>/sandboxes and <root>/seed directory junctions to the drive's folders, so tools that look under the root (the
 * uninstall's risk check, player_slots.py's realpath of <root>/sandboxes) find the sandboxes where they are. The daemon is
 * configured with the drive's own paths, never these (docs/worker-root.md 2.2). A real folder with something in it is not
 * touched: `blocked`, and the caller decides (the move empties it first). Exported for tests.
 */
export function linkRootFolders(root: string, target: { sandboxes: string; seed: string }, junction: (target: string, link: string) => void = (t, l) => fs.symlinkSync(t, l, 'junction')): LinkResult[] {
  const out: LinkResult[] = [];
  for (const name of ['sandboxes', 'seed'] as const) {
    const link = path.join(root, name);
    const to = target[name];
    fs.mkdirSync(to, { recursive: true });
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(link);
    } catch {
      st = undefined;
    }
    if (!st) {
      junction(to, link);
      out.push({ name, action: 'created', detail: `${link} -> ${to}` });
    } else if (st.isSymbolicLink()) {
      let now = '';
      try {
        now = fs.readlinkSync(link);
      } catch {
        // dangling or unreadable: replaced below
      }
      if (norm(now) === norm(to)) out.push({ name, action: 'kept', detail: `${link} -> ${to}` });
      else {
        fs.rmSync(link, { force: true, recursive: false });
        junction(to, link);
        out.push({ name, action: 'retargeted', detail: `${link} -> ${to} (was ${now || 'a missing folder'})` });
      }
    } else if (st.isDirectory() && fs.readdirSync(link).length === 0) {
      fs.rmdirSync(link);
      junction(to, link);
      out.push({ name, action: 'created', detail: `${link} -> ${to}` });
    } else {
      out.push({ name, action: 'blocked', detail: `${link} is a real folder with ${st.isDirectory() ? fs.readdirSync(link).length : 'its own'} entries in it` });
    }
  }
  return out;
}

/** Take a junction away without touching what it points at (rmdir on a junction removes the link only). */
export function unlinkRootFolder(link: string): boolean {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    fs.rmSync(link, { force: true, recursive: false });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- moving an existing install's sandboxes

/** A sandbox as the daemon's pool records it (machine/sandboxes.ts Rec): the fields the move reads and rewrites. */
export interface PoolRec {
  id: string;
  branch: string;
  base: string;
  path: string;
  createdAt: string;
  status: string;
  statusDetail?: string;
  logPath?: string;
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the move does to the machine; tests give fakes for the copies and the saves. */
export interface MoveDeps {
  git(args: string[], timeoutMs?: number): Promise<Ran>;
  /** Move a folder to another volume file by file (robocopy /MOVE), so the source frees as the target fills. */
  moveTree(src: string, dst: string): Promise<void>;
  /** Copy a folder on the drive: a block clone there (Copy-Item on ReFS). */
  cloneTree(src: string, dst: string): Promise<void>;
  removeTree(dir: string): Promise<void>;
  /** Commit what a sandbox holds uncommitted on its branch, and push it (server/saveWork.ts). */
  save(dir: string, branch: string, message: string): Promise<SaveResult>;
  say(line: string): void;
  /** ~/.claude/projects: a sandbox's conversations are kept under its path's slug, so they move with it. */
  claudeProjects?: string;
  now?(): number;
}

export interface MoveOptions {
  /** The root's clone (bare): the sandboxes are its worktrees. */
  repo: string;
  /** The pool's record, <root>/daemon/sandboxes.json. */
  stateFile: string;
  oldSandboxes: string;
  oldSeed: string;
  newSandboxes: string;
  newSeed: string;
  /** Why the work is being saved (the commit message's tail). */
  reason?: string;
}

export interface MoveReport {
  moved: { id: string; from: string; to: string; saved?: string; pushed?: boolean }[];
  skipped: string[];
  seedFrom?: string;
  /** Folders under the old sandboxes folder that are not the pool's: left where they are. */
  leftovers: string[];
}

const GB = 1024 ** 3;
export const claudeSlug = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');
const under = (p: string, dir: string) => norm(p).startsWith(norm(dir) + '\\');

function hasFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function newestMtime(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Re-create the pool's sandboxes on the drive, from the seed on the drive, and nothing else (w900, lothsahn: re-create from
 * the seed rather than copy six full Libraries). For each sandbox: its uncommitted work is committed on its branch and
 * pushed (the push may fail in a session with no GitHub credential: the commit is in the root's clone, which the new
 * worktree uses, so nothing is lost); its old worktree and Library are removed; a worktree of the same branch is made on the
 * drive and the Library block-cloned from the seed. The seed itself is moved, not copied: the old seed folder, else the
 * Library of the sandbox changed last, file by file, so the host volume never holds both. The pool's record then points at
 * the new paths. Safe to run again after a stop: a sandbox already on the drive is skipped, one cut off between removal and
 * creation is created.
 *
 * The caller has checked that no agent and no editor is in a sandbox and has stopped the daemon.
 */
export async function moveSandboxes(o: MoveOptions, d: MoveDeps): Promise<MoveReport> {
  const say = d.say;
  const recs = readJsonDurable<PoolRec[]>(o.stateFile, { check: checkArray }) ?? [];
  const report: MoveReport = { moved: [], skipped: [], leftovers: [] };
  const todo = recs.filter((r) => under(r.path, o.oldSandboxes));
  for (const r of recs) if (!todo.includes(r) && !under(r.path, o.newSandboxes)) report.skipped.push(`${r.id} (${r.path} is outside ${o.oldSandboxes})`);

  // 1. Everything that could stop the move is looked at before anything changes.
  const branchOf = new Map<string, string>();
  const problems: string[] = [];
  for (const r of todo) {
    if (r.status === 'creating' || r.status === 'deleting') problems.push(`${r.id} is ${r.status}: wait for it to finish`);
    if (!fs.existsSync(r.path)) {
      branchOf.set(r.id, r.branch);
      continue;
    }
    const b = await d.git(['-C', r.path, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = b.code === 0 ? b.stdout.trim() : '';
    if (!branch || branch === 'HEAD') {
      problems.push(`${r.id} is on a detached HEAD: its work cannot be kept by a branch`);
      continue;
    }
    branchOf.set(r.id, branch);
    const st = await d.git(['-C', r.path, 'status', '--porcelain=v1', '--untracked-files=normal']);
    const dirty = st.stdout.split('\n').filter(Boolean).filter((l) => !/\s(Library|Logs|Temp|obj|Builds|UserSettings)\/?$/.test(l));
    if (dirty.length) {
      if (/^(master|main|develop)$/.test(branch)) problems.push(`${r.id} has ${dirty.length} uncommitted file(s) on the shared branch ${branch}: committing there is a person's decision`);
      else {
        const why = await untrackedProblem(r.path);
        if (why) problems.push(`${r.id}: ${why}`);
      }
    }
  }
  if (problems.length) throw new Error(`nothing was moved:\n- ${problems.join('\n- ')}`);

  // 2. Save every sandbox's work first, so a failure later cannot lose any.
  const saved = new Map<string, SaveResult>();
  for (const r of todo) {
    if (!fs.existsSync(r.path)) continue;
    const branch = branchOf.get(r.id)!;
    const res = await d.save(r.path, branch, `FF Factory: saved ${r.id}'s uncommitted work before its sandbox moved to the Dev Drive (w900)\n\n\`git reset HEAD~1\` gives the work back uncommitted.`);
    if (res.sha) say(`Sandbox ${r.id}: ${res.notes.join('; ')}.`);
    else say(`Sandbox ${r.id}: nothing to save on ${branch}.`);
    const unpushed = await d.git(['-C', r.path, 'log', '--oneline', '--no-decorate', 'HEAD', '--not', '--remotes', '--']);
    if (unpushed.code === 0 && unpushed.stdout.trim()) say(`Sandbox ${r.id}: ${unpushed.stdout.trim().split('\n').length} commit(s) on ${branch} are not on origin yet; they stay in the root's clone, which the new worktree uses.`);
    saved.set(r.id, res);
  }

  // 3. The seed, moved onto the drive: the old seed, else the freshest sandbox Library.
  const newLib = path.join(o.newSeed, 'Library');
  if (hasFiles(newLib)) say(`The seed is on the drive already (${newLib}).`);
  else {
    const oldLib = path.join(o.oldSeed, 'Library');
    const fromSandbox = todo.map((r) => path.join(r.path, 'Library')).filter(hasFiles).sort((a, b) => newestMtime(b) - newestMtime(a))[0];
    const src = hasFiles(oldLib) ? oldLib : fromSandbox;
    if (src) {
      say(`Moving the Library seed ${src} -> ${newLib} (file by file; the host volume frees as the drive fills)...`);
      fs.mkdirSync(o.newSeed, { recursive: true });
      await d.moveTree(src, newLib);
      report.seedFrom = src;
    } else say('No Library on this machine to seed from: new sandboxes import their own (an hour or more, the first time).');
  }

  // 4. One sandbox at a time: out of the old place, into the new, a Library cloned from the seed.
  fs.mkdirSync(o.newSandboxes, { recursive: true });
  const rewritten = new Map<string, PoolRec>();
  const flush = () => writeJsonDurable(o.stateFile, recs.map((r) => rewritten.get(r.id) ?? r), { indent: 2 });
  for (const r of todo) {
    const branch = branchOf.get(r.id)!;
    const to = path.join(o.newSandboxes, path.basename(r.path));
    if (fs.existsSync(r.path)) {
      say(`Sandbox ${r.id}: removing the old worktree ${r.path}...`);
      const lib = path.join(r.path, 'Library');
      if (fs.existsSync(lib)) await d.removeTree(lib);
      await d.git(['-C', o.repo, 'worktree', 'remove', '--force', '--force', r.path], 30 * 60_000);
      if (fs.existsSync(r.path)) await d.removeTree(r.path);
      if (fs.existsSync(r.path)) throw new Error(`could not remove ${r.path} (a process may hold a file in it); run this again once it is gone`);
    }
    await d.git(['-C', o.repo, 'worktree', 'prune']);
    if (fs.existsSync(to) && fs.existsSync(path.join(to, '.git'))) say(`Sandbox ${r.id}: ${to} is there already.`);
    else {
      say(`Sandbox ${r.id}: creating ${to} on ${branch}...`);
      const add = await d.git(['-C', o.repo, 'worktree', 'add', '--no-checkout', to, branch], 10 * 60_000);
      if (add.code !== 0) throw new Error(`git worktree add ${to} ${branch} failed: ${(add.stderr || add.stdout).trim().split('\n').slice(-2).join(' ')}`);
      const co = await d.git(['-C', to, 'reset', '--hard', '--quiet'], 60 * 60_000);
      if (co.code !== 0) throw new Error(`checkout of ${branch} in ${to} failed: ${(co.stderr || co.stdout).trim().split('\n').slice(-2).join(' ')}`);
    }
    if (hasFiles(newLib) && !hasFiles(path.join(to, 'Library'))) {
      await d.cloneTree(newLib, path.join(to, 'Library'));
      const common = await d.git(['-C', to, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (common.code === 0) armScriptReimport(to, common.stdout.trim());
    }
    const rec: PoolRec = { ...r, path: to };
    if (r.logPath) rec.logPath = under(r.logPath, r.path) ? path.join(to, path.relative(r.path, r.logPath)) : r.logPath;
    rewritten.set(r.id, rec);
    flush();
    if (d.claudeProjects) {
      const from = path.join(d.claudeProjects, claudeSlug(r.path));
      const dest = path.join(d.claudeProjects, claudeSlug(to));
      if (fs.existsSync(from) && !fs.existsSync(dest)) {
        fs.renameSync(from, dest);
        say(`Sandbox ${r.id}: its Claude conversations moved with it, so its agents resume at the new path.`);
      }
    }
    say(`Sandbox ${r.id}: on the drive at ${to}.`);
    const res = saved.get(r.id);
    report.moved.push({ id: r.id, from: r.path, to, ...(res?.sha ? { saved: res.sha, pushed: res.pushed } : {}) });
  }

  // 5. What is left in the old folders is not the pool's: named, never deleted.
  try {
    report.leftovers = fs.readdirSync(o.oldSandboxes).map((n) => path.join(o.oldSandboxes, n));
  } catch {
    report.leftovers = [];
  }
  return report;
}

/** The real effects: git, robocopy /MOVE, Copy-Item (a block clone on ReFS), rd, saveWork. Windows. */
export function realMoveDeps(run: (cmd: string, args: string[], o?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<Ran>, say: (line: string) => void): MoveDeps {
  const ok = (what: string, r: Ran) => {
    if (r.code !== 0) throw new Error(`${what} failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  };
  return {
    git: (args, timeoutMs = 120_000) => run('git', args, { timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }),
    moveTree: async (src, dst) => {
      // robocopy: 0-7 are success; /MOVE deletes each source file after copying it, then the emptied folders.
      const r = await run('robocopy.exe', [src, dst, '/E', '/MOVE', '/MT:8', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeoutMs: 6 * 60 * 60_000 });
      if (r.code >= 8) throw new Error(`robocopy ${src} -> ${dst} failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    },
    cloneTree: async (src, dst) => {
      // The Windows copy engine block-clones on ReFS when both sit on one volume. Paths travel in the environment, never in the script text.
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Copy-Item -LiteralPath $env:FFW_SRC -Destination $env:FFW_DST -Recurse -Force'], { timeoutMs: 60 * 60_000, env: { ...process.env, FFW_SRC: src, FFW_DST: dst } });
      ok(`copying ${src}`, r);
    },
    removeTree: async (dir) => void (await run('cmd.exe', ['/d', '/c', 'rd', '/s', '/q', dir], { timeoutMs: 60 * 60_000 })),
    save: (dir, branch, message) => saveWork({ dir, branch, message }),
    say,
    claudeProjects: path.join(os.homedir(), '.claude', 'projects'),
  };
}

/** GB of a size in bytes, one decimal (the report's numbers). */
export const gbOf = (bytes: number) => Math.round((bytes / GB) * 10) / 10;
