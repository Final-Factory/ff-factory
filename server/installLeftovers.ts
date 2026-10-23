import fs from 'node:fs';
import path from 'node:path';
import { hasLocalWork, neverDelete, norm, sessionRelaxed, touchedSince, touchedWhy, within, type CleanupGuard, type CleanupItem } from './cleanup.ts';
import { CONTEXT_MAX_AGE_HOURS, requestIdsIn, type StaleContext, type StalePlan } from './staleOutput.ts';
import { mentions } from './ownLeftovers.ts';
import { gitIgnores } from './cleanupFolders.ts';

/**
 * Leftovers inside the install folder (w899, docs/self-recovery.md "Install-folder leftovers"): what w876 had to remove
 * by hand on LothDesktop on 2026-10-10 (D: fell from 104 GB to 60 GB free while the daemon's clean-up kept most of it
 * as "not attributable"):
 *
 * - per-commit player builds beyond the newest few, in each sandbox's `.nightly-builds/cache` and `Builds/cache`, old
 *   `Builds/bench*` folders and capture output (`.nightly-builds/clips`, `shots`);
 * - the nightly lab's (`<install>/nightly`, and `<install>/nightly-history` since w1099) builds beyond the newest few, runs,
 *   rehearsals and logs past their age;
 * - folders of sessions that stopped: `<install>/tmp/ffa-<session>` (also those holding fixture repos) and stale `scratch/`;
 *   one that cannot go whole (a clone with work on no remote, something changed lately, too many entries to judge) is taken
 *   entry by entry instead, so only that clone or entry stays (w1575: one 1-commit clone kept 48.7 GB on beast);
 * - per-commit player builds in every session's folder, live and resumed ones too, beyond the newest few (w1575: 24 builds,
 *   about 46 GB, in the folders of LothDesktop's open requests on 2026-10-19);
 * - the rebuildable caches in a session's folder that had no activity for a day, resumed sessions' too (w1719): player
 *   builds and the tars a release packs them into, a Unity project's Library/Temp/obj/Logs, node_modules, digested Profiler
 *   captures, frames beside their clip; while disk is below the soft threshold all but a whole Library go after 15 minutes
 *   with no write (w1813);
 * - a Claude task `.output` file past a cap (a runaway writer reached 99.6 GB; the space came back only when its
 *   process ended): the file goes and, when its session has stopped, so does the process still writing it.
 *
 * Lothsahn's rule (2026-10-10): clean-up deletes only inside the install folder. Every item is checked to lie
 * inside `root`, and Library, Assets, .git, Inbox and the other folders of a sandbox are never looked into: only the named
 * children below are. A live session's folder (the guard's inUse), a repo with local work, and anything touched
 * recently stay.
 */

export interface InstallLeftoverSettings {
  /** Per-commit builds (and bench/cache entries) of one folder: the newest this many are kept whatever their age. */
  keepBuilds: number;
  /** The others go once nothing inside changed for this many hours (a worker still building into one keeps it). */
  buildUntouchedHours: number;
  /** A `Builds/bench*` folder goes once untouched this many days. */
  benchDays: number;
  /** Capture output (`.nightly-builds/clips`, `shots`) goes once untouched this many days. */
  captureDays: number;
  /** The nightly lab's runs and logs past this many days (the newest run stays). */
  nightlyRunDays: number;
  /** The nightly lab's rehearsals past this many days. */
  rehearsalDays: number;
  /** A stopped session's folder in the agent temp root goes once untouched this many hours. */
  sessionTempHours: number;
  /** `scratch/` entries go once untouched this many days (and when no open request is named in them). */
  scratchDays: number;
  /** A Claude task `.output` file past this many GB is removed, and its writer ended when its session has stopped. */
  outputCapGB: number;
  /** A session's folder with nothing written for this many hours, and no worker or process on it, loses its rebuildable caches (w1719); 0: never. */
  idleCacheHours: number;
  /**
   * While free space is below the soft threshold, a stopped session's folder with nothing written for this many minutes loses
   * its rebuildable caches at once, a whole Library apart (only its build caches go: w1813); 0: never.
   */
  lowCacheSettleMinutes: number;
}

export const INSTALL_LEFTOVER_DEFAULTS: InstallLeftoverSettings = {
  keepBuilds: 2,
  buildUntouchedHours: 6,
  benchDays: 2,
  captureDays: 3,
  nightlyRunDays: 3,
  rehearsalDays: 2,
  sessionTempHours: 2,
  scratchDays: 3,
  outputCapGB: 2,
  idleCacheHours: 24,
  lowCacheSettleMinutes: 15,
};

/** The settings in force: the defaults under whatever config gave (unknown or ill-typed values ignored). */
export function installLeftoverSettings(raw: unknown): InstallLeftoverSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = INSTALL_LEFTOVER_DEFAULTS;
  const n = (k: keyof InstallLeftoverSettings, min: number, max: number) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= min && (r[k] as number) <= max ? (r[k] as number) : d[k]);
  return {
    keepBuilds: n('keepBuilds', 1, 20),
    buildUntouchedHours: n('buildUntouchedHours', 1, 24 * 30),
    benchDays: n('benchDays', 1, 365),
    captureDays: n('captureDays', 1, 365),
    nightlyRunDays: n('nightlyRunDays', 1, 365),
    rehearsalDays: n('rehearsalDays', 1, 365),
    sessionTempHours: n('sessionTempHours', 1, 24 * 30),
    scratchDays: n('scratchDays', 1, 365),
    outputCapGB: n('outputCapGB', 0.1, 1000),
    idleCacheHours: n('idleCacheHours', 0, 24 * 30),
    lowCacheSettleMinutes: n('lowCacheSettleMinutes', 0, 24 * 60),
  };
}

/**
 * The limits when a sandbox is released (w913): its last worker is gone and its editor is down, so what that worker built is
 * not wanted again: the newest build per cache stays (the next worker's first run), the rest, benchmark builds and capture
 * output go once nothing changed in them for 15 minutes (a detached build still writing keeps its folder).
 */
export const RELEASE_SETTINGS: InstallLeftoverSettings = { ...INSTALL_LEFTOVER_DEFAULTS, keepBuilds: 1, buildUntouchedHours: 0.25, benchDays: 0.25 / 24, captureDays: 0.25 / 24 };

/** A process as the plan needs it. */
export interface ProcLite {
  pid: number;
  ppid: number;
  cmd: string;
}

/** A process still writing into a stopped session's folder. */
export interface Stray {
  pid: number;
  cmd: string;
  /** The session folder it belongs to. */
  dir: string;
  /** Why it is named: the oversize output file it holds. */
  why: string;
}

export interface InstallPlan extends StalePlan {
  strays: Stray[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;
/** Names that are never looked into, under any place. */
const NEVER_SEGMENT = /^(library|assets|projectsettings|packages|usersettings|inbox|\.git|\.claude|node_modules)$/i;
/**
 * Fixture repos of tests (ffbox-test-*; ff-factory's e2e/server.ts ffsb-e2e-<port>/base; the game repo's scripts/tests
 * mkdtemp repos, which Windows leaves half deleted since rmtree(ignore_errors=True) skips git's read-only objects): scratch
 * though they hold commits by design. Any folder on the way to the repo may carry the name.
 */
const FIXTURE_REPO = /^(ffbox-test-|ffsb-e2e-|build-player-restore-|w\d+-lostlines-|w\d+-lines-)/i;
/** How deep a stopped session's folder is taken apart when it cannot go whole. */
const SPLIT_DEPTH = 3;
/** How deep a session's folder is searched for player builds. */
const BUILD_DEPTH = 5;
/**
 * How far below an item its git repos are looked for (w1575): a worker's legs nest clones deeper than one level
 * (`demo-222946/portal/base`), and an entry taken alone must not take a repo with work inside it.
 */
const REPO_DEPTH = 4;
/** Not looked into for repos: a repo's own insides, dependencies, Unity's caches. */
const NO_REPO_LOOK = /^(\.git|node_modules|library)$/i;
/** How deep an idle session's folder is searched for rebuildable caches (w1719): as deep as for player builds. */
const CACHE_DEPTH = 5;
/** A Unity project's folders the editor rebuilds on open (beside its ProjectSettings/ProjectVersion.txt); Logs since w1813. */
const UNITY_CACHE = /^(library|temp|obj|logs)$/i;
/**
 * The folders of a Unity project's Library that a build or a compile rebuilds by itself (w1813): what goes from a stopped
 * session's project while disk is low, before its folder is idle long enough for the whole Library (Artifacts, the costly
 * import, stays until then).
 */
const LIBRARY_BUILD_CACHES = /^(bee|buildcache|burstcache|shadercache|playerdatacache|il2cpp_cache)$/i;
/** How many entries a session's folder is walked for its last write (w1813): 12 game clones (~630,000 entries) fit. */
const ACTIVITY_BUDGET = 1_000_000;
/** The first bytes of a Unity Profiler capture (`.raw`, -profiler-log-file); all 155 on biscuit on 2026-10-22 had them. */
const PROFILER_MAGIC = 'PD3U';
const IMAGE = /\.(png|jpe?g|bmp|webp|tga)$/i;
const VIDEO = /\.(mp4|mkv|webm|mov|avi)$/i;

/** A player build: a folder holding UnityPlayer.dll or .so, or an .app holding UnityPlayer.dylib. */
function isPlayerBuild(p: string, name: string): boolean {
  return fs.existsSync(path.join(p, 'UnityPlayer.dll')) || fs.existsSync(path.join(p, 'UnityPlayer.so')) || (/\.app$/i.test(name) && fs.existsSync(path.join(p, 'Contents', 'Frameworks', 'UnityPlayer.dylib')));
}

/** A Unity Profiler capture whose digest is done: a `.csv` or `.txt` beside it written after it (bench/cpu_budget_run.sh's budget.txt, the per-frame CSVs). */
async function digestedCapture(file: string, siblings: fs.Dirent[]): Promise<boolean> {
  const st = await fs.promises.lstat(file).catch(() => undefined);
  if (!st?.isFile() || st.size < 1024 ** 2) return false;
  const head = Buffer.alloc(4);
  const fd = await fs.promises.open(file, 'r').catch(() => undefined);
  if (!fd) return false;
  try {
    await fd.read(head, 0, 4, 0);
  } finally {
    await fd.close();
  }
  if (head.toString('latin1') !== PROFILER_MAGIC) return false;
  const dir = path.dirname(file);
  for (const s of siblings) if (s.isFile() && /\.(csv|txt)$/i.test(s.name) && (await mtimeOf(path.join(dir, s.name))) >= st.mtimeMs) return true;
  return false;
}

/**
 * A tar holding a player build (w1813): urgent_release.py packs each player into <run>/stage/<target>/release.<edition>.tar
 * (about 2 GB each, six of them a release) and uploads it; the player it packs is rebuildable from its commit. Read by its
 * headers (ustar, GNU long names and pax paths), up to `maxEntries`, looking for UnityPlayer.dll, .so or .dylib.
 */
export async function tarOfPlayer(file: string, maxEntries = 20_000): Promise<boolean> {
  const fd = await fs.promises.open(file, 'r').catch(() => undefined);
  if (!fd) return false;
  const block = Buffer.alloc(512);
  const field = (b: Buffer, at: number, len: number) => {
    const s = b.toString('utf8', at, at + len);
    const z = s.indexOf('\0');
    return z < 0 ? s : s.slice(0, z);
  };
  try {
    const size = (await fd.stat()).size;
    let longName: string | undefined;
    for (let pos = 0, n = 0; pos + 512 <= size && n < maxEntries; n++) {
      if ((await fd.read(block, 0, 512, pos)).bytesRead < 512 || block.every((x) => x === 0)) return false;
      const len = parseInt(field(block, 124, 12).trim() || '0', 8);
      if (!Number.isFinite(len) || len < 0) return false;
      const type = String.fromCharCode(block[156]!);
      const name = longName ?? [field(block, 345, 155), field(block, 0, 100)].filter(Boolean).join('/');
      longName = undefined;
      if ((type === 'L' || type === 'x') && len <= 65_536) {
        const data = Buffer.alloc(len);
        await fd.read(data, 0, len, pos + 512);
        const text = field(data, 0, len);
        longName = type === 'L' ? text : text.split('\n').map((l) => / path=(.*)$/.exec(l)?.[1]).find((x) => x !== undefined);
      } else if (PLAYER_IN_TAR.test(name)) return true;
      pos += 512 + Math.ceil(len / 512) * 512;
    }
    return false;
  } finally {
    await fd.close();
  }
}
const PLAYER_IN_TAR = /(^|\/)UnityPlayer\.(dll|so|dylib)$/;

/** A folder of nothing but images: frames taken from a clip, or the clip encoded from them. */
async function onlyImages(dir: string): Promise<boolean> {
  const es = await children(dir);
  return es.length > 0 && es.every((e) => e.isFile() && IMAGE.test(e.name));
}

export interface IdleCache {
  path: string;
  what: string;
}

export interface IdleCacheOptions {
  /**
   * Whether a Unity project whose Temp/UnityLockfile exists is open in an editor or a batchmode build. Default: yes. The
   * planner answers by the processes (w1813): a lockfile a crashed editor left behind holds nothing.
   */
  projectOpen?: (project: string) => boolean;
  /** Only what a build or a compile rebuilds by itself: a project's Library build caches, not its whole Library (w1813, low disk). */
  quick?: boolean;
}

/**
 * The rebuildable caches in `dir` (w1719), found by what they hold, so the same on every OS: player builds (a worker builds
 * one per commit), a Unity project's Library, Temp and obj, npm's node_modules beside a package.json, Unity Profiler captures
 * whose digest sits beside them (the game repo's bench/capture_raw.sh deletes its own once digested), and a `frames` folder of
 * images beside the clip they came from or went into. Never a `.git`, the session's Claude task folders, nor anything else:
 * clips, stills, logs, reports, saves and clones stay.
 */
export async function idleCachesIn(dir: string, depth = 1, out: IdleCache[] = [], o: IdleCacheOptions = {}): Promise<IdleCache[]> {
  const es = await children(dir);
  const unity = fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'));
  // An editor or a batchmode build has the project open while Temp/UnityLockfile exists: its caches are not ours.
  const unityOpen = unity && fs.existsSync(path.join(dir, 'Temp', 'UnityLockfile')) && (o.projectOpen?.(dir) ?? true);
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isFile()) {
      if (/\.raw$/i.test(e.name) && (await digestedCapture(p, es))) out.push({ path: p, what: 'a Unity Profiler capture with its digest beside it' });
      else if (/\.tar$/i.test(e.name) && (await sizeIs(p)) >= 1024 ** 2 && (await tarOfPlayer(p))) out.push({ path: p, what: 'a player build packed into a tar (a release stage)' });
      continue;
    }
    if (!e.isDirectory() || /^\.git$/i.test(e.name) || (depth === 1 && /^claude/i.test(e.name))) continue;
    if (isPlayerBuild(p, e.name)) out.push({ path: p, what: 'a player build' });
    else if (unity && UNITY_CACHE.test(e.name)) {
      if (unityOpen) continue;
      if (o.quick && /^library$/i.test(e.name)) {
        for (const c of await children(p)) if (c.isDirectory() && LIBRARY_BUILD_CACHES.test(c.name)) out.push({ path: path.join(p, c.name), what: `a Unity project's Library/${c.name} (a build cache)` });
      } else out.push({ path: p, what: `a Unity project's ${e.name}` });
    } else if (e.name === 'node_modules') {
      if (fs.existsSync(path.join(dir, 'package.json'))) out.push({ path: p, what: 'npm packages (node_modules)' });
    } else if (/^frames$/i.test(e.name) && es.some((x) => x.isFile() && VIDEO.test(x.name)) && (await onlyImages(p))) out.push({ path: p, what: 'frames beside the clip they belong to' });
    else if (depth < CACHE_DEPTH && !NEVER_SEGMENT.test(e.name)) await idleCachesIn(p, depth + 1, out, o);
  }
  return out;
}

const sizeIs = async (p: string) => (await fs.promises.lstat(p).catch(() => undefined))?.size ?? 0;

/**
 * The newest write in a session's folder (w1813), or 'too-big' past `budget` entries; it stops at the first write after
 * `stopAfter`. What lies inside a cache, a Library or node_modules is seen only at its top (the folder and its direct entries,
 * which a build or an editor touches), and a repo's object store not at all: w1719 walked every entry up to 200,000, so a
 * folder holding a few game clones always looked active and kept its caches for good.
 */
export async function newestWrite(dir: string, stopAfter: number, caches: Set<string>, budget = ACTIVITY_BUDGET): Promise<number | 'too-big'> {
  const stack: { p: string; shallow: boolean }[] = [{ p: dir, shallow: false }];
  let newest = 0;
  let seen = 0;
  while (stack.length) {
    const { p, shallow } = stack.pop()!;
    const st = await fs.promises.lstat(p).catch(() => undefined);
    if (!st) continue;
    newest = Math.max(newest, st.mtimeMs);
    if (newest > stopAfter) return newest;
    if (++seen > budget) return 'too-big';
    if (!st.isDirectory() || shallow) continue;
    const name = path.basename(p);
    // A repo's object store says nothing a commit does not also write to its index and refs.
    if (/^objects$/i.test(name) && /^\.git$/i.test(path.basename(path.dirname(p)))) continue;
    const top = caches.has(norm(p)) || /^(library|node_modules)$/i.test(name);
    let names: string[];
    try {
      names = await fs.promises.readdir(p);
    } catch {
      return Number.POSITIVE_INFINITY; // unreadable inside: not ours to judge
    }
    for (const n of names) stack.push({ p: path.join(p, n), shallow: top });
  }
  return newest;
}

async function children(dir: string): Promise<fs.Dirent[]> {
  return fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
}

const mtimeOf = async (p: string) => (await fs.promises.lstat(p).catch(() => undefined))?.mtimeMs ?? 0;

/** A build folder's last activity: the folder itself and the files a build writes at its top. */
async function lastActivity(dir: string): Promise<number> {
  return Math.max(await mtimeOf(dir), await mtimeOf(path.join(dir, 'build.log')), await mtimeOf(path.join(dir, 'build-manifest.json')));
}

/** The processes that are `pid` or below it. */
export function descendants(procs: ProcLite[], pid: number): ProcLite[] {
  const out: ProcLite[] = [];
  const seen = new Set<number>([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) if (!seen.has(p.pid) && seen.has(p.ppid)) (seen.add(p.pid), out.push(p), (grew = true));
  }
  return out;
}

/** Task output files of a session folder (`<ffa>/claude…/<project>/<session>/tasks/<id>.output`) over `capBytes`. */
async function oversizeOutputs(session: string, capBytes: number): Promise<{ file: string; bytes: number }[]> {
  const out: { file: string; bytes: number }[] = [];
  for (const c of await children(session)) {
    if (!c.isDirectory() || !/^claude/i.test(c.name)) continue;
    for (const proj of await children(path.join(session, c.name))) {
      if (!proj.isDirectory()) continue;
      for (const sess of await children(path.join(session, c.name, proj.name))) {
        const tasks = path.join(session, c.name, proj.name, sess.name, 'tasks');
        for (const f of await children(tasks)) {
          if (!f.isFile() || !f.name.endsWith('.output')) continue;
          const file = path.join(tasks, f.name);
          const st = await fs.promises.stat(file).catch(() => undefined);
          if (st && st.size > capBytes) out.push({ file, bytes: st.size });
        }
      }
    }
  }
  return out;
}

/**
 * The plan: reads only. `root` is the install folder (nothing outside it is ever planned); `sandboxes` are the pool's
 * folders; `tempRoots` the agent temp roots; `procs` the process list (absent: no process is named). `guard` is the
 * clean-up's: its inUse covers live sessions' temp folders, and each item is checked again right before its removal.
 */
export async function planInstallLeftovers(o: {
  root?: string;
  sandboxes: string[];
  tempRoots: string[];
  guard: CleanupGuard;
  ctx?: StaleContext;
  procs?: ProcLite[];
  settings?: InstallLeftoverSettings;
  now?: number;
  /** Pids never named a stray (this daemon and its parents). */
  self?: number[];
  localWork?: (dir: string) => Promise<boolean>;
  /** 'sandboxes': only each sandbox's own build and capture output (the sandbox release sweep, w913). */
  scope?: 'all' | 'sandboxes';
  /** Free space is below the soft threshold (or a person asked for a pass): stopped sessions' caches go after lowCacheSettleMinutes (w1813). */
  low?: boolean;
}): Promise<InstallPlan> {
  const plan: InstallPlan = { items: [], listed: [], strays: [] };
  if (!o.root) return plan; // not a worker-root install: nothing here is the install folder
  const root = o.root;
  const s = o.settings ?? INSTALL_LEFTOVER_DEFAULTS;
  const now = o.now ?? Date.now();
  const localWork = o.localWork ?? ((d: string) => hasLocalWork(d, 60_000));
  const items = new Map<string, CleanupItem>();
  const listed = new Map<string, string>();
  const ctx = o.ctx && now - Date.parse(o.ctx.at) < CONTEXT_MAX_AGE_HOURS * HOUR ? o.ctx : undefined;
  const open = new Set(ctx?.open ?? []);
  const relaxed = (base: string): CleanupGuard => ({ ...o.guard, keep: o.guard.keep.filter((k) => !(norm(base) === norm(k) || norm(base).startsWith(norm(k) + '/'))) });
  const live = (p: string) => o.guard.inUse.some((k) => k && (within(p, k) || within(k, p)));

  /** Why `p` must stay, or undefined; `list`: worth showing a person; `split`: the rest of what is in it may still go. */
  const blocked = async (p: string, base: string, untouchedMs: number | undefined): Promise<{ why: string; list: boolean; split?: boolean } | undefined> => {
    if (!within(p, root)) return { why: 'outside the install folder', list: false };
    if (norm(p) === norm(root) || norm(p) === norm(base)) return { why: 'the install folder or a place itself', list: false };
    const rel = norm(p).slice(norm(base).length).split('/').filter(Boolean);
    if (rel.some((seg) => NEVER_SEGMENT.test(seg))) return { why: 'a Library, Assets, .git or similar folder', list: false };
    const no = neverDelete(p, relaxed(base));
    if (no) return { why: no, list: false };
    const touched = untouchedMs === undefined ? undefined : await touchedWhy(p, now - untouchedMs);
    if (touched === 'changed') return { why: 'changed recently', list: false, split: true };
    if (touched === 'too-big') return { why: 'too many entries to judge its age (over 200,000)', list: true, split: true };
    const repos: string[] = [];
    const down = async (d: string, depth: number) => {
      if (fs.existsSync(path.join(d, '.git'))) return void repos.push(d); // its nested repos are submodules: its status covers them
      if (depth >= REPO_DEPTH) return;
      for (const e of await children(d)) if (e.isDirectory() && !NO_REPO_LOOK.test(e.name)) await down(path.join(d, e.name), depth + 1);
    };
    await down(p, 0);
    for (const r of repos) {
      if (norm(r).slice(norm(base).length).split('/').some((seg) => FIXTURE_REPO.test(seg))) continue;
      if (await localWork(r)) return { why: `holds a git repo with uncommitted or unpushed work (${r})`, list: true, split: true };
    }
    return undefined;
  };
  const take = async (p: string, base: string, rule: string, why: string, untouchedMs: number | undefined) => {
    if (items.has(p)) return;
    const b = await blocked(p, base, untouchedMs);
    if (!b) items.set(p, { path: p, rule, why, base });
    else if (b.list) listed.set(p, b.why);
  };
  /**
   * A stopped session's folder, or (when it cannot go whole) its entries one by one, down to SPLIT_DEPTH (w1575): a clone with
   * work on no remote stays and is listed, what changed lately stays, the rest goes. A repo is never taken apart.
   */
  const takeApart = async (p: string, base: string, why: string, untouchedMs: number, depth: number): Promise<void> => {
    if (items.has(p)) return;
    const b = await blocked(p, base, untouchedMs);
    if (!b) return void items.set(p, { path: p, rule: 'stopped-session-temp', why, base });
    const st = await fs.promises.lstat(p).catch(() => undefined);
    if (!b.split || depth >= SPLIT_DEPTH || !st?.isDirectory() || fs.existsSync(path.join(p, '.git'))) {
      if (b.list) listed.set(p, b.why);
      return;
    }
    for (const e of await children(p)) await takeApart(path.join(p, e.name), base, why, untouchedMs, depth + 1);
  };
  /** The player builds under `dir`: a folder holding UnityPlayer.dll or .so, or an .app holding UnityPlayer.dylib. */
  const buildsIn = async (dir: string, depth: number, out: string[]): Promise<string[]> => {
    for (const e of await children(dir)) {
      if (!e.isDirectory() || NEVER_SEGMENT.test(e.name) || /^claude/i.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (isPlayerBuild(p, e.name)) out.push(p);
      else if (depth < BUILD_DEPTH && !fs.existsSync(path.join(p, '.git'))) await buildsIn(p, depth + 1, out);
    }
    return out;
  };
  /** A build's last activity: the folder and the folders at its top (its _Data folder). */
  const buildAt = async (b: string) => Math.max(await mtimeOf(b), ...(await Promise.all((await children(b)).filter((e) => e.isDirectory()).map((e) => mtimeOf(path.join(b, e.name))))));
  /**
   * Old player builds of one session's folder, live or not (w1575: every worker builds a ~2 GB player per commit into its
   * temp folder, and nothing removed the older ones while its request stayed open): the newest keepBuilds stay; the others
   * go once untouched for buildUntouchedHours and while no process names them (a player still running from one keeps it).
   */
  const oldBuilds = async (session: string, t: string) => {
    const builds = await buildsIn(session, 1, []);
    if (builds.length <= s.keepBuilds) return;
    const dated = await Promise.all(builds.map(async (b) => ({ b, at: await buildAt(b) })));
    dated.sort((a, b) => b.at - a.at);
    for (const { b } of dated.slice(s.keepBuilds)) {
      if (items.has(b) || !within(b, root)) continue;
      if (neverDelete(b, sessionRelaxed(session, relaxed(t)))) continue;
      if ((o.procs ?? []).some((p) => mentions(p.cmd, b))) continue;
      if (await touchedSince(b, now - s.buildUntouchedHours * HOUR)) continue;
      items.set(b, { path: b, rule: 'session-old-build', why: `a player build beyond its session's newest ${s.keepBuilds}, untouched for ${s.buildUntouchedHours} h (rebuildable)`, base: t, inSession: session });
    }
  };
  /** Why git holds `p`, or undefined: a repo inside it, or the repo around it (below the session's folder) does not ignore it. */
  const gitHolds = async (p: string, session: string): Promise<string | undefined> => {
    const down = async (d: string, depth: number): Promise<string | undefined> => {
      if (fs.existsSync(path.join(d, '.git'))) return d;
      if (depth >= REPO_DEPTH) return undefined;
      for (const e of await children(d)) if (e.isDirectory() && !NO_REPO_LOOK.test(e.name)) {
        const r = await down(path.join(d, e.name), depth + 1);
        if (r) return r;
      }
      return undefined;
    };
    const inside = await down(p, 0);
    if (inside) return `holds a git repo (${inside})`;
    for (let d = path.dirname(p); within(d, session); d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) return (await gitIgnores(d, p)) ? undefined : `in the work tree of ${d}, which does not ignore it`;
      if (norm(d) === norm(session)) break;
    }
    return undefined;
  };
  /**
   * The rebuildable caches of a session's folder with no activity for idleCacheHours (w1719, lothsahn: "delete caches after 24
   * hours of inactivity for that test folder"). Its request may still resume the worker, so the folder stays (judgeSession,
   * resumable), but what a resumed worker rebuilds by itself goes. Activity: the session runs (the guard's inUse), a process
   * names its folder, or something in the folder was written within the window (newestWrite: a cache, a Library or a repo's
   * objects only by its top, so a folder of game clones can be judged; one past ACTIVITY_BUDGET entries counts as active).
   * While disk is low (w1813, ben: "This applies on low disk at once"), all but a whole Library goes once the folder had no
   * write for lowCacheSettleMinutes (a detached writer's grace); a Library loses only its build caches then, and the rest
   * once the folder is idle for idleCacheHours. A Unity lockfile no process names was left by a crashed editor: it holds nothing.
   * Nothing git holds goes: an item inside a repo's work tree only when git ignores it, never one holding a repo.
   */
  const idleCaches = async (session: string, t: string) => {
    if (live(session) || !within(session, root)) return;
    const quickOn = !!o.low && s.lowCacheSettleMinutes > 0;
    if (!s.idleCacheHours && !quickOn) return;
    if ((o.procs ?? []).some((p) => mentions(p.cmd, session))) return;
    const projectOpen = (d: string) => !o.procs || o.procs.some((p) => mentions(p.cmd, d));
    const full = s.idleCacheHours ? await idleCachesIn(session, 1, [], { projectOpen }) : [];
    const quick = quickOn ? await idleCachesIn(session, 1, [], { projectOpen, quick: true }) : [];
    if (!full.length && !quick.length) return;
    const ageCut = now - s.idleCacheHours * HOUR;
    const settleCut = now - s.lowCacheSettleMinutes * 60_000;
    const last = await newestWrite(session, quickOn ? Math.max(settleCut, ageCut) : ageCut, new Set([...full, ...quick].map((c) => norm(c.path))));
    if (last === 'too-big') return;
    let caches: IdleCache[];
    let after: string;
    if (s.idleCacheHours && last <= ageCut) [caches, after] = [full, `with no activity for ${s.idleCacheHours} h`];
    else if (quickOn && last <= settleCut) [caches, after] = [quick, `with no activity for ${s.lowCacheSettleMinutes} min while disk is low`];
    else return;
    const g = sessionRelaxed(session, relaxed(t));
    for (const c of caches) {
      if (items.has(c.path) || !within(c.path, root) || neverDelete(c.path, g)) continue;
      if (await gitHolds(c.path, session)) continue;
      items.set(c.path, { path: c.path, rule: 'session-idle-cache', why: `${c.what}, in a worker's temp folder ${after} (rebuildable)`, base: t, inSession: session });
    }
  };
  /** The entries of `dir`, newest first (by last activity). */
  const newestFirst = async (dir: string, only?: (e: fs.Dirent) => boolean) => {
    const es = (await children(dir)).filter((e) => (only ? only(e) : e.isDirectory()));
    const dated = await Promise.all(es.map(async (e) => ({ e, at: await lastActivity(path.join(dir, e.name)) })));
    return dated.sort((a, b) => b.at - a.at).map((x) => x.e);
  };
  /** Keep the newest `keepBuilds` entries of `dir`; the others go once idle for buildUntouchedHours. */
  const keepNewest = async (dir: string, base: string, rule: string, what: string) => {
    for (const e of (await newestFirst(dir)).slice(s.keepBuilds)) {
      await take(path.join(dir, e.name), base, rule, `${what} ${e.name.slice(0, 12)}, beyond the newest ${s.keepBuilds}, untouched for ${s.buildUntouchedHours} h (rebuildable)`, s.buildUntouchedHours * HOUR);
    }
  };

  // ---- each sandbox: per-commit builds, bench builds, capture output
  for (const sb of o.sandboxes) {
    await keepNewest(path.join(sb, '.nightly-builds', 'cache'), sb, 'build-cache', 'a cached player build');
    await keepNewest(path.join(sb, 'Builds', 'cache'), sb, 'build-cache', 'a cached build');
    for (const e of await children(path.join(sb, 'Builds'))) {
      if (e.isDirectory() && /^bench/i.test(e.name)) await take(path.join(sb, 'Builds', e.name), sb, 'bench-build', `a benchmark build untouched for ${s.benchDays} days`, s.benchDays * DAY);
    }
    for (const e of await children(path.join(sb, '.nightly-builds'))) {
      if (e.isDirectory() && /^(clips|shots)$/i.test(e.name)) await take(path.join(sb, '.nightly-builds', e.name), sb, 'capture-output', `capture output (${e.name}) untouched for ${s.captureDays} days`, s.captureDays * DAY);
    }
  }

  if (o.scope === 'sandboxes') {
    plan.items = [...items.values()];
    plan.listed = [...listed].map(([p, why]) => ({ path: p, why }));
    return plan;
  }

  // ---- the nightly lab inside the install folder, and since w1099 the history a sandbox night keeps (nightly-history:
  // state, logs, runs, reports, fixtures; no builds). Its state, reports and fixtures (a player's save) are never looked at.
  for (const nightly of [path.join(root, 'nightly'), path.join(root, 'nightly-history')]) {
    await keepNewest(path.join(nightly, 'builds'), nightly, 'nightly-build', 'a nightly player build');
    const runs = await newestFirst(path.join(nightly, 'runs'));
    for (const e of runs.slice(1)) await take(path.join(nightly, 'runs', e.name), nightly, 'nightly-run', `a nightly run (not the newest) untouched for ${s.nightlyRunDays} days`, s.nightlyRunDays * DAY);
    for (const e of await children(path.join(nightly, 'rehearsals'))) await take(path.join(nightly, 'rehearsals', e.name), nightly, 'nightly-rehearsal', `a nightly rehearsal untouched for ${s.rehearsalDays} days`, s.rehearsalDays * DAY);
    for (const e of await children(path.join(nightly, 'logs'))) {
      if (e.isFile()) await take(path.join(nightly, 'logs', e.name), nightly, 'nightly-log', `a nightly log untouched for ${s.nightlyRunDays} days`, s.nightlyRunDays * DAY);
    }
  }

  // ---- stale scratch: named after an open request it stays; the rest goes by age
  const scratch = path.join(root, 'scratch');
  for (const e of await children(scratch)) {
    const p = path.join(scratch, e.name);
    const ids = requestIdsIn(e.name);
    if (ids.some((id) => open.has(id))) continue;
    await take(p, scratch, 'stale-scratch', `scratch untouched for ${s.scratchDays} days${ids.length ? `, ${ids.join(', ')} not open` : ''}`, s.scratchDays * DAY);
  }

  // ---- sessions' temp folders: stopped ones go; an oversize task output goes with the process still writing it
  const cap = s.outputCapGB * GB;
  const procs = o.procs;
  const self = new Set(o.self ?? []);
  for (const t of [...new Set(o.tempRoots)]) {
    if (!within(t, root)) continue;
    for (const e of await children(t)) {
      if (!e.isDirectory() || !/^ffa-/i.test(e.name)) continue;
      const dir = path.join(t, e.name);
      const big = await oversizeOutputs(dir, cap);
      await oldBuilds(dir, t);
      if (live(dir)) {
        for (const b of big) listed.set(b.file, `a task output of a LIVE session past ${s.outputCapGB} GB (${(b.bytes / GB).toFixed(1)} GB): kept, someone should look`);
        continue;
      }
      await idleCaches(dir, t);
      for (const b of big) {
        const no = (await blocked(b.file, t, undefined))?.why;
        if (no) continue;
        items.set(b.file, { path: b.file, rule: 'oversize-output', why: `a task output of a stopped session past ${s.outputCapGB} GB (${(b.bytes / GB).toFixed(1)} GB)`, base: t });
        const holders = (procs ?? []).filter((p) => !self.has(p.pid) && mentions(p.cmd, dir));
        const all = new Map<number, ProcLite>();
        for (const h of holders) for (const p of [h, ...descendants(procs ?? [], h.pid)]) if (!self.has(p.pid)) all.set(p.pid, p);
        for (const p of all.values()) if (!plan.strays.some((x) => x.pid === p.pid)) plan.strays.push({ pid: p.pid, cmd: p.cmd.slice(0, 300), dir, why: `holds ${b.file} (${(b.bytes / GB).toFixed(1)} GB)` });
        if (!all.size) listed.set(`${b.file} (writer unknown)`, 'no process names this stopped session; if space does not come back, its writer still runs');
      }
      await takeApart(dir, t, `the temp folder of a session that stopped, untouched for ${s.sessionTempHours} h`, s.sessionTempHours * HOUR, 0);
    }
  }

  for (const p of items.keys()) for (const l of [...listed.keys()]) if (within(l, p)) listed.delete(l);
  // An old build inside a folder that goes whole goes with it.
  for (const p of [...items.keys()]) if ([...items.keys()].some((q) => q !== p && within(p, q))) items.delete(p);
  plan.items = [...items.values()];
  plan.listed = [...listed].map(([p, why]) => ({ path: p, why }));
  return plan;
}

/** `a` and `b` as one plan: what `b` takes is no longer listed by `a`. */
export function mergePlans(a: StalePlan, b: InstallPlan): InstallPlan {
  const items = new Map<string, CleanupItem>();
  for (const it of [...a.items, ...b.items]) items.set(it.path, it);
  const listed = new Map<string, string>();
  for (const l of [...a.listed, ...b.listed]) if (![...items.keys()].some((p) => within(l.path, p))) listed.set(l.path, l.why);
  return { items: [...items.values()], listed: [...listed].map(([path, why]) => ({ path, why })), strays: b.strays };
}
