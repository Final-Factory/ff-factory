import fs from 'node:fs';
import path from 'node:path';
import { hasLocalWork, localWorkWhy, neverDelete, unpushedWorkWhy, norm, sessionRelaxed, sizeOf, touchedSince, touchedWhy, within, type CleanupGuard, type CleanupItem } from './cleanup.ts';
import { CONTEXT_MAX_AGE_HOURS, requestIdsIn, type StaleContext, type StalePlan } from './staleOutput.ts';
import { mentions } from './ownLeftovers.ts';
import { gitIgnores } from './cleanupFolders.ts';
import { isPublished, type PublishedRecord } from './published.ts';
import { execFile } from 'node:child_process';
import { benchQueueDir } from '../machine/benchQueue.ts';
import { benchLockDir, pidAlive } from '../machine/benchLock.ts';
import { holdsJob, listenerLog, readListenerLog, runnerCensus } from '../machine/benchRunners.ts';

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
  /**
   * The folder of a stopped worker whose requests all closed goes once untouched this many minutes, on every pass (w3656);
   * only its clones with commits on no remote or a stash stay. 0: 15.
   */
  closedSessionMinutes: number;
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
  /**
   * A running or blocked worker's cargo target over this many GB goes once cargo is done with it (no cargo-like process in the
   * worker's tree, no write for lowCacheSettleMinutes, or 15 min when that is 0), whatever the drive's free space (w3426):
   * cargo never deletes what an older build left, so one worker's target grew to 23.6 GB. 8 GB is about 1.4 times a fresh
   * target (5.8 GB, measured), so three workers stay near 20 GB; 0: never.
   */
  cargoTargetCapGB: number;
  /**
   * The Unity `Library` folders in one worker's temp folder (a `scratch_clone.sh --library` copy of the source's Library, each
   * a whole copy) together over this many GB lose the oldest idle ones, on every pass and for running, blocked and stopped
   * workers alike (w3674): one running worker made four such copies in 50 minutes (14:18 to 15:08 UTC, 2026-11-08), each the
   * size of the source's Library (slot3's: 33.9 GB), used only the newest, and F: went from about 99 GB free to 0, while the
   * low pass never takes a running worker's Library. 40 lets one warm copy (about 34 GB) stay and not a second; 0: never.
   */
  libraryCopyCapGB: number;
  /**
   * A timed run's laid-out build (`<install>/timing/builds/b<i>`, machine/timedRunner.ts) goes once untouched this many hours
   * while no timing ticket is held or waiting and no timed run is in flight: the next run lays it out again from timing/cache
   * (w3502: 3.6 GB on LothDesktop's V:).
   */
  timingBuildHours: number;
  /** An FFU runner's job folder (`<install>/ffu-runners/<runner>/_work/<entry>`) goes once untouched this many days while that runner runs no job (w3502). */
  runnerWorkDays: number;
}

export const INSTALL_LEFTOVER_DEFAULTS: InstallLeftoverSettings = {
  keepBuilds: 2,
  buildUntouchedHours: 6,
  benchDays: 2,
  captureDays: 3,
  nightlyRunDays: 3,
  rehearsalDays: 2,
  sessionTempHours: 2,
  closedSessionMinutes: 30,
  scratchDays: 3,
  outputCapGB: 2,
  idleCacheHours: 24,
  lowCacheSettleMinutes: 15,
  cargoTargetCapGB: 8,
  libraryCopyCapGB: 40,
  timingBuildHours: 24,
  runnerWorkDays: 14,
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
    closedSessionMinutes: n('closedSessionMinutes', 0, 24 * 60),
    scratchDays: n('scratchDays', 1, 365),
    outputCapGB: n('outputCapGB', 0.1, 1000),
    idleCacheHours: n('idleCacheHours', 0, 24 * 30),
    lowCacheSettleMinutes: n('lowCacheSettleMinutes', 0, 24 * 60),
    cargoTargetCapGB: n('cargoTargetCapGB', 0, 10_000),
    libraryCopyCapGB: n('libraryCopyCapGB', 0, 10_000),
    timingBuildHours: n('timingBuildHours', 1, 24 * 30),
    runnerWorkDays: n('runnerWorkDays', 1, 365),
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

/**
 * Why the timed runner's folders (`<install>/timing/cache` and `builds`) must stay now, or undefined when they may go (w3502):
 * a timed run in flight (`inFlight`, the daemon's TimedRunner.busy()), or a bench ticket with reason timing held or waiting in
 * this install's queue (`<install>/tmp/bench.queue/t*`, its helper alive): every timing measurement takes one, the timed
 * runner's own (timedRunner.ts takeTicket) and bench_queue.py's `timed` alike.
 */
export function timingHeld(root: string, inFlight?: string, alive: (pid: number) => boolean = pidAlive): string | undefined {
  if (inFlight) return inFlight;
  const dir = benchQueueDir(benchLockDir(root));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^t\d{8}$/.test(n)).sort();
  } catch {
    return undefined;
  }
  for (const n of names) {
    let info: Record<string, unknown> | undefined;
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, n, 'info.json'), 'utf8'));
    } catch {
      continue; // as queueTickets: a ticket with no readable info.json is not a live one
    }
    if (!info || (info.reason !== 'timing' && info.timed_run !== true)) continue;
    if (Number.isInteger(info.pid) && !alive(info.pid as number)) continue;
    return `bench ticket ${n} (reason timing${info.what ? `: ${String(info.what).slice(0, 80)}` : ''}) is held or waiting`;
  }
  return undefined;
}

/**
 * Why an Actions runner's `_work` must stay now, or undefined when the runner holds no job (w3502): unknown processes, a
 * Runner.Worker of this runner, any process run from its _work folder, or a listener whose _diag log says it was just handed a
 * job (machine/benchRunners.ts holdsJob, the check that pauses LothDesktop's FFU runners safely). A runner whose listener is
 * not running takes no job.
 */
export function runnerJobWhy(runner: string, procs: ProcLite[] | undefined, now: number, readLog: (runner: string) => string | undefined = readListenerLog): string | undefined {
  if (!procs) return 'the process list could not be read, so a running job cannot be ruled out';
  const mine = (r: string) => norm(r) === norm(runner);
  const census = runnerCensus(procs);
  const worker = census.workers.find((w) => mine(w.root));
  if (worker) return `its Runner.Worker (pid ${worker.pid}) runs a job`;
  const work = `${norm(runner)}/_work/`;
  const user = procs.find((p) => p.cmd.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase().includes(work));
  if (user) return `process ${user.pid} runs from its _work folder`;
  const listener = census.listeners.find((l) => mine(l.root));
  if (listener) {
    const why = holdsJob(listenerLog(readLog(runner)), now);
    if (why) return `its listener (pid ${listener.pid}): ${why}`;
  }
  return undefined;
}

/** An Actions runner's tool cache and action downloads: kept, as the actions-work rule keeps them (server/cleanup.ts). */
const RUNNER_KEPT = /^_(tool|actions)$/i;

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
/**
 * How deep a session's folder is searched for player builds: six levels, since a Mac player of an urgent release sits at
 * `urgent-<v>/workers/osx-main/release/player/finalfactory.app` (w1813: at five, LothDesktop's ffa-409f9363 lost its
 * Windows and Linux players to the clean-up and kept both Mac ones, which nothing saw).
 */
const BUILD_DEPTH = 6;
/**
 * How far below an item its git repos are looked for (w1575): a worker's legs nest clones deeper than one level
 * (`demo-222946/portal/base`), and an entry taken alone must not take a repo with work inside it.
 */
const REPO_DEPTH = 4;
/** Not looked into for repos: a repo's own insides, dependencies, Unity's caches. */
const NO_REPO_LOOK = /^(\.git|node_modules|library)$/i;
/** How deep an idle session's folder is searched for rebuildable caches (w1719): as deep as for player builds. */
const CACHE_DEPTH = BUILD_DEPTH;
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

/**
 * A Rust build folder (w3330): cargo writes this CACHEDIR.TAG at the top of every target directory it builds into, whatever
 * its name (an FFU worker's `$TMPDIR/ffu-target`, a clone's `target`). One FFU worker's held 15.4 GB on LothDesktop
 * (measured, 2026-11-07: debug/deps 10.4 GB, 6.5 GB of it .pdb debug info; debug/incremental 3.9 GB); a cold build
 * of what it holds takes minutes (ffu-build-test: ffu-client release 1 min 40 s, ffu-headless 31 s, measured).
 */
const CARGO_TAG = 'Signature: 8a477f597d28d172789f06886806bc55';
function isCargoTarget(p: string): boolean {
  try {
    const tag = fs.readFileSync(path.join(p, 'CACHEDIR.TAG'), 'utf8');
    return tag.startsWith(CARGO_TAG) && /created by cargo/i.test(tag);
  } catch {
    return false;
  }
}

/** A process that builds into, or runs from, a cargo target: cargo, the compiler and linkers, a build script (w3396). */
const CARGO_PROC = /(^|[\\/\s"'])(cargo|rustc|rustdoc|clippy-driver|rust-lld|lld-link|link|ld|cc|build-script-[\w-]+)(\.exe)?(["'\s]|$)/i;

/**
 * Why a live or blocked worker's cargo target `target` must stay on a low pass, or undefined once cargo is done with it
 * (w3396): a process names the target (rustc's --out-dir, a test binary running from it), a cargo-like process runs in the
 * worker's process tree (a shell naming its folder `session`, and what it started: cargo's own command line names neither),
 * or something in the target was written after `since` (a build adds files to deps/, .fingerprint/ and incremental/, which
 * moves those folders' times: the top three levels are read, not the tens of thousands of artifacts). No process list: kept.
 */
export async function cargoTargetBusy(target: string, session: string, procs: ProcLite[] | undefined, since: number, now = Date.now()): Promise<string | undefined> {
  if (!procs) return 'the process list could not be read, so a build in it cannot be ruled out';
  const user = procs.find((p) => mentions(p.cmd, target));
  if (user) return `a running process uses it (pid ${user.pid}: ${user.cmd.slice(0, 160)})`;
  const tree = new Map<number, ProcLite>();
  for (const p of procs) if (mentions(p.cmd, session)) for (const d of [p, ...descendants(procs, p.pid)]) tree.set(d.pid, d);
  const builder = [...tree.values()].find((p) => CARGO_PROC.test(p.cmd));
  if (builder) return `its worker runs a build (pid ${builder.pid}: ${builder.cmd.slice(0, 160)})`;
  const stack: { p: string; depth: number }[] = [{ p: target, depth: 0 }];
  while (stack.length) {
    const { p, depth } = stack.pop()!;
    const st = await fs.promises.lstat(p).catch(() => undefined);
    if (!st) continue;
    if (st.mtimeMs > since) return `written ${agoText(now - st.mtimeMs)} ago (${p}), within the settle time while disk is low`;
    if (!st.isDirectory() || depth >= 3) continue;
    for (const e of await children(p)) if (e.isDirectory() || depth < 2) stack.push({ p: path.join(p, e.name), depth: depth + 1 });
  }
  return undefined;
}

/** The newest write in a cargo target's top three levels (cargoTargetBusy reads the same): what a build touches, without its artifacts. */
async function newestTopWrite(target: string): Promise<number> {
  let newest = 0;
  const stack: { p: string; depth: number }[] = [{ p: target, depth: 0 }];
  while (stack.length) {
    const { p, depth } = stack.pop()!;
    const st = await fs.promises.lstat(p).catch(() => undefined);
    if (!st) continue;
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory() || depth >= 3) continue;
    for (const e of await children(p)) if (e.isDirectory() || depth < 2) stack.push({ p: path.join(p, e.name), depth: depth + 1 });
  }
  return newest;
}

/**
 * The Library folders of the Unity projects at or under `dir` (w3674), found as idleCachesIn finds a project (a folder with
 * ProjectSettings/ProjectVersion.txt), down to CACHE_DEPTH; a project is not searched for nested ones.
 */
async function libraryCopiesIn(dir: string, depth = 1, out: { project: string; library: string }[] = []): Promise<{ project: string; library: string }[]> {
  if (fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) {
    for (const e of await children(dir)) if (e.isDirectory() && /^library$/i.test(e.name)) out.push({ project: dir, library: path.join(dir, e.name) });
    return out;
  }
  for (const e of await children(dir)) {
    if (!e.isDirectory() || /^\.git$/i.test(e.name) || (depth === 1 && /^claude/i.test(e.name)) || NEVER_SEGMENT.test(e.name)) continue;
    if (depth < CACHE_DEPTH) await libraryCopiesIn(path.join(dir, e.name), depth + 1, out);
  }
  return out;
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
 * images beside the clip they came from or went into, and a Rust build folder cargo tagged (w3330). Never a `.git`, the session's Claude task folders, nor anything else:
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
    else if (isCargoTarget(p)) out.push({ path: p, what: 'a Rust build folder (cargo target)' });
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

/** "12 min", "5.2 h" or "3.1 days". */
const agoText = (ms: number) => (ms < 2 * HOUR ? `${Math.max(0, Math.round(ms / 60_000))} min` : ms < 2 * DAY ? `${(ms / HOUR).toFixed(1)} h` : `${(ms / DAY).toFixed(1)} days`);

/**
 * Review evidence (w2223): what a person looks at or a worker handed over, kept in a finished worker's folder unless it was
 * published (server/published.ts). Logs, JSON and XML reports are test output: a rerun makes them again.
 */
const EVIDENCE = /\.(png|jpe?g|gif|bmp|webp|tga|svg|mp4|mkv|webm|mov|avi|md|pdf|html?|zip)$/i;
/** An image a capture writes frame by frame (w2796). */
const FRAME_IMAGE = /\.(png|jpe?g|bmp|tga|webp)$/i;
/**
 * A folder of at least this many images and nothing else that is evidence is a capture's frames (w2796), not stills a
 * person looks at. Measured on LothDesktop 2026-11-01: the per-run folders the reopen hold kept (tour*, audit-*, before-/
 * after-*) held 416 to 5,450 JPGs per frame folder (about 40 GB in all), and a set of stills beside them 7 PNGs.
 */
export const FRAME_MIN_IMAGES = 100;

/**
 * The number of frames in `dir` when it is a capture's frame folder (w2796): only files, at least FRAME_MIN_IMAGES images
 * and no other evidence (a clip, a note, a page) beside them; sidecars such as an ffmpeg list or a CSV do not count.
 * What a person reviews is the clip or the stills taken from them; a reopened worker records again.
 */
export async function frameFolder(dir: string): Promise<number | undefined> {
  let images = 0;
  for (const e of await children(dir)) {
    if (!e.isFile()) return undefined;
    if (FRAME_IMAGE.test(e.name)) images++;
    else if (EVIDENCE.test(e.name)) return undefined;
  }
  return images >= FRAME_MIN_IMAGES ? images : undefined;
}
/** What only a Unity Library holds: a folder with two of these is a copy of one, whatever its name (w2223). */
const LIBRARY_MARK = /^(artifactdb|sourceassetdb|artifacts|bee|scriptassemblies|packagecache|burstcache|buildcache|shadercache|playerdatacache|il2cpp_cache)$/i;
/** How deep a finished worker's folder is taken apart around what it keeps. */
const BULK_DEPTH = 4;
/** A loose file of test output smaller than this stays: a worker's scripts and notes are not where the space is. */
const LOOSE_MIN_BYTES = 1024 ** 2;
/** Entries a folder is searched for what keeps it before it counts as too big to take whole (then it is taken apart). */
const BULK_SCAN_BUDGET = 200_000;

export interface FinishedBulkOptions {
  /** The machine's published files (server/published.ts): evidence published elsewhere may go. */
  published?: Map<string, PublishedRecord[]>;
  /** Why a repo holds work (uncommitted changes, commits on no remote, a stash), or undefined (cleanup.ts localWorkWhy). */
  localWork?: (repo: string) => Promise<string | undefined>;
  /** The evidence files git ignores in a repo's work tree (they go with the clone); undefined when git could not say. */
  ignoredEvidence?: (repo: string) => Promise<string[] | undefined>;
  projectOpen?: (project: string) => boolean;
}

export interface FinishedBulk {
  take: IdleCache[];
  /** What stays and why: a repo with work on no remote, evidence published nowhere else. */
  keep: { path: string; why: string }[];
}

/**
 * Ignored folders a build downloads into a game checkout, each with the file that marks the download: what is in them is
 * fetched again on demand, never a worker's review evidence (w3434: the pinned AgentKit release, which
 * Assets/Editor/AgentKitFetch.cs unpacks into Tools/AgentKit/{win,mac} with a VERSION file before every player build; its
 * 28 SKILL.md, CLAUDE.md and HowToPlay.md files kept about nine finished workers' 18 GB clones on BEAST for a person).
 */
const FETCHED_FOLDERS: { dir: string; marker: string }[] = [{ dir: 'Tools/AgentKit', marker: 'VERSION' }];

/** The evidence files git ignores in `repo`, Unity's and npm's caches and fetched folders apart; undefined when git fails or times out. */
export function gitIgnoredEvidence(repo: string, timeoutMs = 60_000): Promise<string[] | undefined> {
  const skip = ['Library', 'Temp', 'obj', 'Logs', 'node_modules'].map((d) => `:(exclude,glob)**/${d}/**`);
  for (const f of FETCHED_FOLDERS) if (fs.existsSync(path.join(repo, ...f.dir.split('/'), f.marker))) skip.push(`:(exclude,glob)${f.dir}/**`);
  return new Promise((resolve) =>
    execFile('git', ['--no-optional-locks', '-C', repo, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.', ...skip], { timeout: timeoutMs, maxBuffer: 256 * 1024 ** 2, windowsHide: true }, (e, out) =>
      resolve(e ? undefined : String(out).split('\0').filter((f) => f && EVIDENCE.test(f)).map((f) => path.join(repo, f))),
    ),
  );
}

/**
 * The rebuildable bulk of a finished worker's temp folder (w2223): every request it was on is closed, and only the reopen
 * hold (server/resumable.ts, w1575) keeps the folder. Beyond the caches idleCachesIn finds (its whole Library included):
 * a git clone, checkout or worktree with nothing on no remote (cloned again on demand) unless git ignores evidence in it
 * that was published nowhere else; a copy of a Unity Library outside its project; and test output, a folder holding no
 * repo, no Unity project and no unpublished evidence, or a loose file of 1 MiB or more that is not evidence; and a
 * capture's frames (frameFolder, w2796), so a per-run folder (a tour, an audit, a before/after leg) loses its frames while
 * its stills, clips and notes published nowhere else stay. What stays:
 * evidence published nowhere else, a repo with work on no remote, a Unity project's own files, the Claude task folders and
 * the Inbox. A cache inside a repo that stays goes only when git ignores it, as idle caches do.
 */
export async function finishedBulkIn(session: string, o: FinishedBulkOptions = {}): Promise<FinishedBulk> {
  const take: IdleCache[] = [];
  const keep: FinishedBulk['keep'] = [];
  const published = o.published ?? new Map<string, PublishedRecord[]>();
  const localWork = o.localWork ?? ((d: string) => localWorkWhy(d, 60_000));
  const ignoredEvidence = o.ignoredEvidence ?? ((d: string) => gitIgnoredEvidence(d));
  const caches = await idleCachesIn(session, 1, [], { projectOpen: o.projectOpen });
  const cacheAt = new Set(caches.map((c) => norm(c.path)));
  const unpublished = (f: string) => EVIDENCE.test(f) && !isPublished(published, f);
  let evidence = 0;
  const isRepo = (d: string) => fs.existsSync(path.join(d, '.git'));
  /** Why `dir` cannot go whole, or undefined: a repo, a Unity project or unpublished evidence in it, or too many entries. */
  const holds = async (dir: string): Promise<string | undefined> => {
    const stack = [dir];
    let seen = 0;
    while (stack.length) {
      const d = stack.pop()!;
      if (isRepo(d)) return 'repo';
      if (fs.existsSync(path.join(d, 'ProjectSettings', 'ProjectVersion.txt'))) return 'unity';
      for (const e of await children(d)) {
        if (++seen > BULK_SCAN_BUDGET) return 'too-big';
        const p = path.join(d, e.name);
        if (cacheAt.has(norm(p)) || e.isSymbolicLink()) continue;
        if (e.isFile() && unpublished(p)) return 'evidence';
        if (e.isDirectory() && !(await frameFolder(p))) stack.push(p);
      }
    }
    return undefined;
  };
  const repos: { repo: string; taken: boolean }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const e of await children(dir)) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink() || cacheAt.has(norm(p))) continue;
      if (depth === 1 && (/^claude/i.test(e.name) || /^inbox$/i.test(e.name))) continue;
      if (e.isFile()) {
        if (unpublished(p)) evidence++;
        else if ((await sizeIs(p)) >= LOOSE_MIN_BYTES) take.push({ path: p, what: EVIDENCE.test(p) ? 'a file published to the portal' : 'test output (a file)' });
        continue;
      }
      if (!e.isDirectory() || NEVER_SEGMENT.test(e.name)) continue;
      if (isRepo(p)) {
        const fixture = norm(p).slice(norm(session).length).split('/').some((seg) => FIXTURE_REPO.test(seg));
        const work = fixture ? undefined : await localWork(p);
        if (work) {
          keep.push({ path: p, why: `a git repo with work on no remote: ${work}` });
          repos.push({ repo: p, taken: false });
          continue;
        }
        const ignored = await ignoredEvidence(p);
        const un = ignored?.filter(unpublished) ?? [];
        if (!ignored || un.length) {
          keep.push({ path: p, why: ignored ? `git ignores ${un.length} review file(s) in it that were published nowhere else (${path.relative(p, un[0]!)})` : 'git could not list the files it ignores, so its evidence cannot be judged' });
          repos.push({ repo: p, taken: false });
          continue;
        }
        take.push({ path: p, what: 'a git clone or checkout with nothing on no remote (cloned again on demand)' });
        repos.push({ repo: p, taken: true });
        continue;
      }
      if ((await children(p)).filter((c) => LIBRARY_MARK.test(c.name)).length >= 2) {
        take.push({ path: p, what: "a copy of a Unity project's Library caches" });
        continue;
      }
      const frames = await frameFolder(p);
      if (frames) {
        take.push({ path: p, what: `a capture's frames (${frames} images and no clip, note or other evidence beside them; what a person reviews is the clip or stills made from them)` });
        continue;
      }
      if (isPlayerBuild(p, e.name)) continue; // idleCachesIn has it, or it lies past its depth: a build is never test output here
      const why = await holds(p);
      if (!why) take.push({ path: p, what: 'test output (no repo, Unity project or unpublished evidence in it)' });
      else if (depth < BULK_DEPTH) await walk(p, depth + 1);
      else if (why === 'evidence') evidence++;
    }
  };
  await walk(session, 1);
  // The caches: one in a repo that goes whole goes with it; one in a repo that stays only when git ignores it; never one holding a repo.
  for (const c of caches) {
    const around = repos.find((r) => within(c.path, r.repo) && norm(c.path) !== norm(r.repo));
    if (around?.taken) continue;
    if (around && !(await gitIgnores(around.repo, c.path))) continue;
    if (repos.some((r) => within(r.repo, c.path))) continue;
    take.push(c);
  }
  if (evidence) keep.push({ path: session, why: `${evidence} review file(s) or folder(s) of them published nowhere else (images, clips, notes, saves): kept until the folder's hold ends` });
  // What lies inside an item taken whole is not listed again.
  const out = take.filter((t) => !take.some((u) => u !== t && within(t.path, u.path) && norm(t.path) !== norm(u.path)));
  return { take: out, keep };
}

const sizeIs = async (p: string) => (await fs.promises.lstat(p).catch(() => undefined))?.size ?? 0;

/**
 * The newest write in a session's folder (w1813), or 'too-big' past `budget` entries; it stops at the first write after
 * `stopAfter`. What lies inside a cache, a Library or node_modules is seen only at its top (the folder and its direct entries,
 * which a build or an editor touches), and a repo's object store not at all: w1719 walked every entry up to 200,000, so a
 * folder holding a few game clones always looked active and kept its caches for good.
 */
export async function newestWrite(dir: string, stopAfter: number, caches: Set<string>, budget = ACTIVITY_BUDGET, found: { path?: string; unreadable?: boolean } = {}): Promise<number | 'too-big'> {
  const stack: { p: string; shallow: boolean }[] = [{ p: dir, shallow: false }];
  let newest = 0;
  let seen = 0;
  while (stack.length) {
    const { p, shallow } = stack.pop()!;
    const st = await fs.promises.lstat(p).catch(() => undefined);
    if (!st) continue;
    if (st.mtimeMs > newest) [newest, found.path] = [st.mtimeMs, p];
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
      [found.path, found.unreadable] = [p, true];
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
  /** Whether a repo holds commits on no remote or a stash (tests; default cleanup.ts unpushedWorkWhy). */
  unpushedWork?: (dir: string) => Promise<boolean>;
  /**
   * Session folders of stopped workers whose requests all closed (w3656: no open, stalled or paused request is on them and
   * none waits for them; the daemon's closedSessionDirs). Absent: the portal has not said, and none is judged closed.
   */
  closed?: string[];
  /** 'sandboxes': only each sandbox's own build and capture output (the sandbox release sweep, w913). 'cargo-cap': only the
   * cargo-target-cap rule over the sessions' temp folders, for the passes the stale-output rules skip (w3471); since w3674 it
   * covers the Unity Library copy cap (library-copy-cap) too. */
  scope?: 'all' | 'sandboxes' | 'cargo-cap';
  /** Free space is below the soft threshold (or a person asked for a pass): stopped sessions' caches go after lowCacheSettleMinutes (w1813). */
  low?: boolean;
  /** A low pass says which check kept a temp folder's rebuildable caches once they reach this size (plan.held; default 256 MiB). */
  heldMinBytes?: number;
  /** Session folders of finished workers: stopped, every request they were on closed, held only by the reopen window (w2223). */
  finished?: string[];
  /** The machine's published files (server/published.ts): a finished worker's evidence published there may go. */
  published?: Map<string, PublishedRecord[]>;
  /** Why a repo holds work, or undefined (tests; default cleanup.ts localWorkWhy). */
  localWhy?: (repo: string) => Promise<string | undefined>;
  /** The evidence files git ignores in a repo (tests; default gitIgnoredEvidence). */
  ignoredEvidence?: (repo: string) => Promise<string[] | undefined>;
  /** Why a timed run is in flight here now (the daemon's TimedRunner.busy()), or undefined: the timing folders stay while it is (w3502). */
  timedBusy?: () => string | undefined;
  /** Whether a pid lives (tests; default benchLock.ts pidAlive): a bench ticket's helper. */
  alive?: (pid: number) => boolean;
  /** A runner's listener log tail (tests; default benchRunners.ts readListenerLog). */
  runnerLog?: (runner: string) => string | undefined;
}): Promise<InstallPlan> {
  const plan: InstallPlan = { items: [], listed: [], strays: [] };
  if (!o.root) return plan; // not a worker-root install: nothing here is the install folder
  const root = o.root;
  const s = o.settings ?? INSTALL_LEFTOVER_DEFAULTS;
  const now = o.now ?? Date.now();
  const localWork = o.localWork ?? ((d: string) => hasLocalWork(d, 60_000));
  const unpushedWork = o.unpushedWork ?? (async (d: string) => (await unpushedWorkWhy(d, 60_000)) !== undefined);
  const closed = new Set((o.closed ?? []).map(norm));
  const items = new Map<string, CleanupItem>();
  const listed = new Map<string, string>();
  const held: NonNullable<InstallPlan['held']> = [];
  const ctx = o.ctx && now - Date.parse(o.ctx.at) < CONTEXT_MAX_AGE_HOURS * HOUR ? o.ctx : undefined;
  const open = new Set(ctx?.open ?? []);
  const finished = new Set((o.finished ?? []).map(norm));
  const relaxed = (base: string): CleanupGuard => ({ ...o.guard, keep: o.guard.keep.filter((k) => !(norm(base) === norm(k) || norm(base).startsWith(norm(k) + '/'))) });
  const live = (p: string) => o.guard.inUse.some((k) => k && (within(p, k) || within(k, p)));

  /** Why `p` must stay, or undefined; `list`: worth showing a person; `split`: the rest of what is in it may still go. */
  const blocked = async (p: string, base: string, untouchedMs: number | undefined, anyRepo = false, closedWork = false): Promise<{ why: string; list: boolean; split?: boolean } | undefined> => {
    if (!within(p, root)) return { why: 'outside the install folder', list: false };
    if (norm(p) === norm(root) || norm(p) === norm(base)) return { why: 'the install folder or a place itself', list: false };
    const rel = norm(p).slice(norm(base).length).split('/').filter(Boolean);
    if (rel.some((seg) => NEVER_SEGMENT.test(seg))) return { why: 'a Library, Assets, .git or similar folder', list: false };
    const no = neverDelete(p, relaxed(base));
    if (no) return { why: no, list: false };
    const touched = untouchedMs === undefined ? undefined : await touchedWhy(p, now - untouchedMs);
    if (touched === 'changed') return { why: 'changed recently', list: false, split: true };
    if (touched === 'too-big') return { why: 'too many entries to judge its age (over 200,000)', list: true, split: true };
    if (anyRepo) return undefined; // a CI job's checkout: the job recreates it, and its commits are on the remote
    const repos: string[] = [];
    const down = async (d: string, depth: number) => {
      if (fs.existsSync(path.join(d, '.git'))) return void repos.push(d); // its nested repos are submodules: its status covers them
      if (depth >= REPO_DEPTH) return;
      for (const e of await children(d)) if (e.isDirectory() && !NO_REPO_LOOK.test(e.name)) await down(path.join(d, e.name), depth + 1);
    };
    await down(p, 0);
    for (const r of repos) {
      if (norm(r).slice(norm(base).length).split('/').some((seg) => FIXTURE_REPO.test(seg))) continue;
      if (closedWork ? await unpushedWork(r) : await localWork(r)) return { why: closedWork ? `holds a git repo with commits on no remote or a stash (${r})` : `holds a git repo with uncommitted or unpushed work (${r})`, list: true, split: true };
    }
    return undefined;
  };
  const take = async (p: string, base: string, rule: string, why: string, untouchedMs: number | undefined, anyRepo = false) => {
    if (items.has(p)) return;
    const b = await blocked(p, base, untouchedMs, anyRepo);
    if (!b) items.set(p, { path: p, rule, why, base });
    else if (b.list) listed.set(p, b.why);
  };
  /**
   * A stopped session's folder, or (when it cannot go whole) its entries one by one, down to SPLIT_DEPTH (w1575): a clone with
   * work on no remote stays and is listed, what changed lately stays, the rest goes. A repo is never taken apart.
   */
  const takeApart = async (p: string, base: string, why: string, untouchedMs: number, depth: number, closedWork = false): Promise<void> => {
    if (items.has(p)) return;
    const b = await blocked(p, base, untouchedMs, false, closedWork);
    if (!b) return void items.set(p, { path: p, rule: closedWork ? 'closed-session-temp' : 'stopped-session-temp', why, base });
    const st = await fs.promises.lstat(p).catch(() => undefined);
    if (!b.split || depth >= SPLIT_DEPTH || !st?.isDirectory() || fs.existsSync(path.join(p, '.git'))) {
      if (b.list) listed.set(p, b.why);
      return;
    }
    for (const e of await children(p)) await takeApart(path.join(p, e.name), base, why, untouchedMs, depth + 1, closedWork);
  };
  /**
   * The folder of a stopped worker whose requests all closed (w3656, lothsahn, 2026-11-08: "once a request closes, why
   * doesn't its temp directory get cleaned up?"): it goes whole once nothing in it was written for closedSessionMinutes,
   * on every pass, hourly ones included. Only a clone with commits on no remote or a stash stays, listed; uncommitted
   * changes and an unreadable git do not keep it (cleanup.ts unpushedWorkWhy). A live session, a process naming the folder,
   * or an unknown process list keeps it all; Windows' rename before the delete skips a folder with a file open in it.
   * True when the folder was judged here.
   */
  const closedSession = async (dir: string, t: string): Promise<boolean> => {
    if (!closed.has(norm(dir)) || live(dir)) return false;
    if (!o.procs || o.procs.some((p) => mentions(p.cmd, dir))) return true;
    const mins = s.closedSessionMinutes || 15;
    await takeApart(dir, t, `the temp folder of a stopped worker whose requests all closed, untouched for ${mins} min (w3656)`, mins * 60_000, 0, true);
    return true;
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
  /**
   * A worker's cargo targets over cargoTargetCapGB together go once cargo is done with them, on any pass (w3426): cargo never
   * deletes the artifacts an older build left, so a worker that rebuilt all day held 23.6 GB (13.8 GB in debug/deps, 34 copies
   * of one crate) while a fresh target is 3.3-5.5 GB, and a drive with room never reached the low pass that prunes it (w3396).
   * The cap is on the sum of the worker's targets (w3617): one on biscuit held 12 targets, one per leg (ffu-target,
   * ffu-target-m13, ...), 22 GB together and each under the cap (measured, 2026-11-08). Oldest first (by the newest write in
   * a target's top three levels): first each idle target's debug/incremental, then, while still over, whole idle targets.
   * The same checks as the low pass (cargoTargetBusy): no process names it, no cargo-like process in the worker's tree,
   * nothing written in its top three levels within the settle time. Running, blocked and stopped workers alike; the worker's
   * next build rebuilds it.
   */
  const capCargo = async (session: string, t: string) => {
    if (!s.cargoTargetCapGB || !o.procs) return;
    const capBytes = s.cargoTargetCapGB * 1024 ** 3;
    const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
    const projectOpen = (d: string) => o.procs!.some((p) => mentions(p.cmd, d));
    const settle = s.lowCacheSettleMinutes || 15;
    const targets: { path: string; what: string; bytes: number; newest: number }[] = [];
    for (const c of await idleCachesIn(session, 1, [], { projectOpen, quick: true })) {
      if (!/cargo target/.test(c.what) || items.has(c.path) || !within(c.path, root)) continue;
      targets.push({ path: c.path, what: c.what, bytes: await sizeOf(c.path), newest: await newestTopWrite(c.path) });
    }
    let total = targets.reduce((a, c) => a + c.bytes, 0);
    if (total <= capBytes) return;
    const over =
      targets.length > 1 ? `${gb(total)} in this worker's ${targets.length} cargo targets, over the ${s.cargoTargetCapGB} GB cap` : `over the ${s.cargoTargetCapGB} GB cap`;
    const sizeOfTarget = (c: { bytes: number }) => `${gb(c.bytes)}, ${over}`;
    targets.sort((a, b) => a.newest - b.newest || a.path.localeCompare(b.path));
    const why = `with no cargo process and no write for ${settle} min (rebuildable)`;
    const idle: { path: string; what: string; bytes: number; inc: number }[] = [];
    for (const c of targets) {
      const busy = await cargoTargetBusy(c.path, session, o.procs, now - settle * 60_000, now);
      const no = busy ?? neverDelete(c.path, sessionRelaxed(session, relaxed(t))) ?? (await gitHolds(c.path, session));
      // On every pass, not only a low one (w3471): an hourly pass lists no kept item, so a target over the cap that stays
      // could not be told from a rule that never looked at it.
      if (no) held.push({ path: c.path, bytes: c.bytes, why: `1 rebuildable cache(s) kept: ${sizeOfTarget(c)}, but ${no}` });
      else idle.push({ ...c, inc: await sizeOf(path.join(c.path, 'debug', 'incremental')) });
    }
    // Measured on BEAST (w3426, ffu main, a rebuild after an edit to ffu-sim): 30 s with the target whole, 52 s without
    // debug/incremental, 173 s without debug/deps and incremental, 215 s without debug (a clean build: 213 s). So incremental
    // goes first; a whole target goes only when the incremental caches cannot bring the worker under the cap, since losing
    // deps costs about a clean build, which also drops release/ and the stale build-script output.
    const trimmed = new Set<string>();
    const all = idle.reduce((a, c) => a + c.inc, 0);
    for (const c of idle) {
      if (total <= capBytes || total - all > capBytes) break;
      if (c.inc <= 0) continue;
      const incremental = path.join(c.path, 'debug', 'incremental');
      items.set(incremental, { path: incremental, rule: 'cargo-target-cap', why: `the incremental cache of ${c.what} (${gb(c.inc)} of its ${sizeOfTarget(c)}), ${why}`, base: t, inSession: session });
      trimmed.add(c.path);
      total -= c.inc;
    }
    for (const c of idle) {
      if (total <= capBytes) break;
      if (trimmed.has(c.path)) continue;
      items.set(c.path, { path: c.path, rule: 'cargo-target-cap', why: `${c.what}, ${sizeOfTarget(c)}, ${why}`, base: t, inSession: session });
      total -= c.bytes;
    }
  };
  /**
   * A worker's Unity Library copies over libraryCopyCapGB together lose the oldest idle ones, whole, on every pass whatever the
   * free space (w3674): a worker that ran `scratch_clone.sh --library` four times in 50 minutes held four copies of a 33.9 GB
   * Library, used the newest, and drove F: from 99 GB free to 0; the low pass never takes a running worker's Library. Oldest
   * first, by the newest write in a Library's top levels. A project stays when any process names its folder (an open editor or
   * a batchmode build, build_player.sh, -projectPath: that covers an open lockfile), when anything in its Library's top levels
   * was written within the settle time, or when the guard or git holds it. Those count toward the sum and are reported kept.
   * Running, blocked and stopped workers alike; the next build or editor start reimports what goes.
   */
  const capLibraries = async (session: string, t: string) => {
    if (!s.libraryCopyCapGB || !o.procs) return;
    const capBytes = s.libraryCopyCapGB * 1024 ** 3;
    const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
    const settle = s.lowCacheSettleMinutes || 15;
    const copies: { project: string; library: string; bytes: number; newest: number }[] = [];
    for (const c of await libraryCopiesIn(session)) {
      const st = await fs.promises.lstat(c.library).catch(() => undefined);
      if (!st?.isDirectory() || items.has(c.library) || !within(c.library, root) || o.sandboxes.some((sb) => within(c.library, sb) || within(sb, c.library))) continue;
      copies.push({ ...c, bytes: await sizeOf(c.library), newest: await newestTopWrite(c.library) });
    }
    let total = copies.reduce((a, c) => a + c.bytes, 0);
    if (total <= capBytes) return;
    const over = `${gb(total)} in this worker's ${copies.length} Library cop${copies.length === 1 ? 'y' : 'ies'}, over the ${s.libraryCopyCapGB} GB cap`;
    copies.sort((a, b) => a.newest - b.newest || a.library.localeCompare(b.library));
    for (const c of copies) {
      if (total <= capBytes) break;
      const user = o.procs.find((p) => mentions(p.cmd, c.project));
      const busy = user
        ? `a running process names the project (pid ${user.pid}: ${user.cmd.slice(0, 160)})`
        : c.newest > now - settle * 60_000
          ? `its Library was written ${agoText(now - c.newest)} ago, within ${settle} min`
          : undefined;
      const no = busy ?? neverDelete(c.library, sessionRelaxed(session, relaxed(t))) ?? (await gitHolds(c.library, session));
      if (no) {
        held.push({ path: c.library, bytes: c.bytes, why: `1 rebuildable cache(s) kept: ${gb(c.bytes)}, ${over}, but ${no}` });
        continue;
      }
      items.set(c.library, { path: c.library, rule: 'library-copy-cap', why: `a Unity project's Library in a worker's scratch clone, ${gb(c.bytes)}, ${over}, with no process naming the project and no write for ${settle} min (rebuildable: the next build or editor start reimports it)`, base: t, inSession: session });
      total -= c.bytes;
    }
  };
  const idleCaches = async (session: string, t: string) => {
    if (!within(session, root)) return;
    await capLibraries(session, t);
    if (!o.low) await capCargo(session, t);
    const quickOn = !!o.low && s.lowCacheSettleMinutes > 0;
    if (!s.idleCacheHours && !quickOn) return;
    // A live session's caches are its worker's: only a low pass looks at them, to say so (w1813).
    const isLive = live(session);
    if (isLive && !o.low) return;
    const named = (o.procs ?? []).find((p) => mentions(p.cmd, session));
    if (named && !o.low) return;
    const projectOpen = (d: string) => !o.procs || o.procs.some((p) => mentions(p.cmd, d));
    const full = s.idleCacheHours ? await idleCachesIn(session, 1, [], { projectOpen }) : [];
    const quick = quickOn ? await idleCachesIn(session, 1, [], { projectOpen, quick: true }) : [];
    if (!full.length && !quick.length) return;
    const keep = (why: string) => hold(session, quickOn ? quick : full, why);
    if (quickOn && (isLive || named)) {
      // w3396: a running or blocked FFU worker's cargo target refilled LothDesktop's V: (four of them, 9-20 GB each, r133).
      // While disk is low it goes once cargo is done with it; the worker's next build rebuilds it. Everything else stays.
      const rest: IdleCache[] = [];
      for (const c of quick) {
        if (!/cargo target/.test(c.what)) {
          rest.push(c);
          continue;
        }
        const why = await cargoTargetBusy(c.path, session, o.procs, now - s.lowCacheSettleMinutes * 60_000, now);
        if (why) {
          await hold(c.path, [c], why);
          continue;
        }
        const g = sessionRelaxed(session, relaxed(t));
        const no = neverDelete(c.path, g) ?? (await gitHolds(c.path, session));
        if (no) await hold(c.path, [c], no);
        else if (!items.has(c.path)) items.set(c.path, { path: c.path, rule: 'live-session-cargo-target', why: `${c.what}, in a running or blocked worker's temp folder, with no cargo process and no write for ${s.lowCacheSettleMinutes} min while disk is low (rebuildable)`, base: t, inSession: session });
      }
      if (!rest.length) return;
      return hold(session, rest, isLive ? 'its worker runs: a live session (a stopped one whose request resumed it counts too)' : `a running process names it (pid ${named!.pid}: ${named!.cmd.slice(0, 160)})`);
    }
    if (isLive) return keep('its worker runs: a live session (a stopped one whose request resumed it counts too)');
    if (named) return keep(`a running process names it (pid ${named.pid}: ${named.cmd.slice(0, 160)})`);
    const ageCut = now - s.idleCacheHours * HOUR;
    const settleCut = now - s.lowCacheSettleMinutes * 60_000;
    const found: { path?: string; unreadable?: boolean } = {};
    const last = await newestWrite(session, quickOn ? Math.max(settleCut, ageCut) : ageCut, new Set([...full, ...quick].map((c) => norm(c.path))), ACTIVITY_BUDGET, found);
    if (last === 'too-big') return keep(`its last write cannot be judged: more than ${ACTIVITY_BUDGET.toLocaleString('en-US')} entries outside its caches`);
    let caches: IdleCache[];
    let after: string;
    if (s.idleCacheHours && last <= ageCut) [caches, after] = [full, `with no activity for ${s.idleCacheHours} h`];
    else if (quickOn && last <= settleCut) [caches, after] = [quick, `with no activity for ${s.lowCacheSettleMinutes} min while disk is low`];
    else if (found.unreadable) return keep(`a folder in it cannot be read (${found.path}), so its last write cannot be judged`);
    else return keep(`written ${agoText(now - last)} ago (${found.path}), within the ${quickOn ? `${s.lowCacheSettleMinutes} min` : `${s.idleCacheHours} h`} it must stay unwritten`);
    const g = sessionRelaxed(session, relaxed(t));
    for (const c of caches) {
      if (items.has(c.path) || !within(c.path, root)) continue;
      const no = neverDelete(c.path, g) ?? (await gitHolds(c.path, session));
      if (no) await hold(c.path, [c], no);
      else items.set(c.path, { path: c.path, rule: 'session-idle-cache', why: `${c.what}, in a worker's temp folder ${after} (rebuildable)`, base: t, inSession: session });
    }
  };
  /**
   * The rebuildable bulk of a finished worker's folder (w2223: LothDesktop's clean-up freed 0 GB of 60 while 55 GB sat in four
   * finished workers' folders): every request it was on closed, so only the reopen hold keeps the folder (o.finished). Its clones
   * with nothing on no remote, Library copies and test output go too (finishedBulkIn), on the idle caches' clock: no write
   * for idleCacheHours, or for lowCacheSettleMinutes while disk is low (then a whole Library goes too: a finished worker
   * rebuilds nothing until a reopen). Unpushed work and evidence published nowhere else stay, and a repo with work is listed.
   */
  const finishedBulk = async (session: string, t: string) => {
    if (!within(session, root) || !finished.has(norm(session)) || live(session)) return;
    const quickOn = !!o.low && s.lowCacheSettleMinutes > 0;
    if (!s.idleCacheHours && !quickOn) return;
    if ((o.procs ?? []).some((p) => mentions(p.cmd, session))) return;
    const projectOpen = (d: string) => !o.procs || o.procs.some((p) => mentions(p.cmd, d));
    const bulk = await finishedBulkIn(session, { published: o.published, localWork: o.localWhy, ignoredEvidence: o.ignoredEvidence, projectOpen });
    for (const k of bulk.keep) if (k.path !== session) listed.set(k.path, `in a finished worker's folder: ${k.why}`);
    if (!bulk.take.length) return;
    const ageCut = now - s.idleCacheHours * HOUR;
    const settleCut = now - s.lowCacheSettleMinutes * 60_000;
    const found: { path?: string; unreadable?: boolean } = {};
    const last = await newestWrite(session, quickOn ? Math.max(settleCut, ageCut) : ageCut, new Set(bulk.take.map((c) => norm(c.path))), ACTIVITY_BUDGET, found);
    let after: string;
    if (last === 'too-big') return hold(session, bulk.take, `its last write cannot be judged: more than ${ACTIVITY_BUDGET.toLocaleString('en-US')} entries outside its bulk`);
    if (s.idleCacheHours && last <= ageCut) after = `with no write for ${s.idleCacheHours} h`;
    else if (quickOn && last <= settleCut) after = `with no write for ${s.lowCacheSettleMinutes} min while disk is low`;
    else return hold(session, bulk.take, found.unreadable ? `a folder in it cannot be read (${found.path})` : `written ${agoText(now - last)} ago (${found.path})`);
    const g = sessionRelaxed(session, relaxed(t));
    for (const c of bulk.take) {
      if (items.has(c.path) || !within(c.path, root)) continue;
      const no = neverDelete(c.path, g);
      if (no) await hold(c.path, [c], no);
      else items.set(c.path, { path: c.path, rule: 'finished-session-bulk', why: `${c.what}, in a finished worker's temp folder (its requests closed) ${after} (rebuildable)`, base: t, inSession: session });
    }
  };
  /**
   * What a low pass kept and why (w1813: LothDesktop's ffa-409f9363 kept 15.6 GB with nothing in the log to say which check
   * held it): the caches of `at` (a session's folder, or one cache the guard or git holds), measured, once past heldMinBytes.
   */
  const hold = async (at: string, caches: IdleCache[], why: string) => {
    if (!o.low) return;
    let bytes = 0;
    for (const c of caches) bytes += await sizeOf(c.path, 300_000);
    if (bytes >= (o.heldMinBytes ?? 256 * 1024 ** 2)) held.push({ path: at, bytes, why: `${caches.length} rebuildable cache(s) kept: ${why}` });
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

  if (o.scope === 'cargo-cap') {
    for (const t of [...new Set(o.tempRoots)]) {
      if (!within(t, root)) continue;
      for (const e of await children(t)) {
        if (!e.isDirectory() || !/^ffa-/i.test(e.name) || !within(path.join(t, e.name), root)) continue;
        await capLibraries(path.join(t, e.name), t);
        await capCargo(path.join(t, e.name), t);
        // A closed worker's folder goes on the hourly pass too, not only on a low or daily one (w3656).
        await closedSession(path.join(t, e.name), t);
      }
    }
    for (const p of [...items.keys()]) if ([...items.keys()].some((q) => q !== p && within(p, q))) items.delete(p);
    plan.items = [...items.values()];
    for (const l of [...listed.keys()]) if (plan.items.some((i) => within(l, i.path))) listed.delete(l);
    if (listed.size) plan.listed = [...listed].map(([p, why]) => ({ path: p, why }));
    const kept = held.filter((h) => !plan.items.some((i) => within(h.path, i.path)));
    if (kept.length) plan.held = kept;
    return plan;
  }

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

  // ---- the timed runner's own folders (w3502, machine/timedRunner.ts): its build pieces in timing/cache (it trims them to 8 GB
  // itself after a run) and the builds it lays out of them in timing/builds/b<i>. Nothing else trimmed them: on LothDesktop
  // 2026-11-07 they held 8.9 + 3.6 GB of a V: at 14.2 GB free, freed by hand (w3482). Both are fetched or laid out again by the
  // next run, so they go only while no timing ticket is held or waiting and no timed run is in flight: the builds once untouched
  // timingBuildHours, the cache only below the soft threshold; both after lowCacheSettleMinutes with no write in a low pass.
  // timing/runs (the results) is the runner's own: it keeps 10.
  const settleMs = (s.lowCacheSettleMinutes || 15) * 60_000;
  const keptBig = async (p: string, why: string) => {
    if (!o.low || !fs.existsSync(p)) return;
    const bytes = await sizeOf(p, 300_000);
    if (bytes >= (o.heldMinBytes ?? 256 * 1024 ** 2)) held.push({ path: p, bytes, why });
  };
  const timing = path.join(root, 'timing');
  const timingWhy = timingHeld(root, o.timedBusy?.(), o.alive);
  if (timingWhy) {
    await keptBig(path.join(timing, 'cache'), `the timed runs' build cache kept: ${timingWhy}`);
    await keptBig(path.join(timing, 'builds'), `the timed runs' laid-out builds kept: ${timingWhy}`);
  } else {
    for (const e of await children(path.join(timing, 'builds'))) {
      const age = o.low ? settleMs : s.timingBuildHours * HOUR;
      await take(path.join(timing, 'builds', e.name), timing, 'timing-build', `a timed run's laid-out build (${e.name}), no timed run in flight or queued, untouched for ${o.low ? `${age / 60_000} min (the disk is low)` : `${s.timingBuildHours} h`}; the next run lays it out again`, age);
    }
    if (o.low) {
      for (const e of await children(path.join(timing, 'cache'))) {
        await take(path.join(timing, 'cache', e.name), timing, 'timing-cache', `a timed run's cached build piece, no timed run in flight or queued, untouched for ${settleMs / 60_000} min (the disk is low); the next run fetches it again`, settleMs);
      }
    }
  }

  // ---- FFU runners' job folders (w3502): <install>/ffu-runners/<runner>/_work, which the actions-work rule (server/cleanup.ts,
  // actions-runner* under home or a drive root) never matched. A job recreates them (a cold cargo build costs minutes), so they
  // go only while that runner runs no job: once untouched runnerWorkDays, or lowCacheSettleMinutes in a low pass. _tool and
  // _actions stay, as in actions-work.
  const runners = path.join(root, 'ffu-runners');
  for (const r of await children(runners)) {
    if (!r.isDirectory()) continue;
    const runner = path.join(runners, r.name);
    const work = path.join(runner, '_work');
    const entries = (await children(work)).filter((e) => !RUNNER_KEPT.test(e.name));
    if (!entries.length) continue;
    const busy = runnerJobWhy(runner, o.procs, now, o.runnerLog);
    if (busy) {
      await keptBig(work, `an FFU runner's job folders kept: ${busy}`);
      continue;
    }
    const age = o.low ? settleMs : s.runnerWorkDays * DAY;
    for (const e of entries) {
      await take(path.join(work, e.name), runner, 'ffu-runner-work', `FFU runner ${r.name}'s job folder (${e.name}), no job running, untouched for ${o.low ? `${age / 60_000} min (the disk is low)` : `${s.runnerWorkDays} days`}; the next job recreates it`, age, true);
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
        await idleCaches(dir, t);
        continue;
      }
      await finishedBulk(dir, t);
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
      if (await closedSession(dir, t)) continue;
      await takeApart(dir, t, `the temp folder of a session that stopped, untouched for ${s.sessionTempHours} h`, s.sessionTempHours * HOUR, 0);
    }
  }

  for (const p of items.keys()) for (const l of [...listed.keys()]) if (within(l, p)) listed.delete(l);
  // An old build inside a folder that goes whole goes with it.
  for (const p of [...items.keys()]) if ([...items.keys()].some((q) => q !== p && within(p, q))) items.delete(p);
  plan.items = [...items.values()];
  plan.listed = [...listed].map(([p, why]) => ({ path: p, why }));
  // A folder that goes whole (its session stopped long enough) is not also said to be kept.
  const kept = held.filter((h) => !plan.items.some((i) => within(h.path, i.path)));
  if (kept.length) plan.held = kept;
  return plan;
}

/** `a` and `b` as one plan: what `b` takes is no longer listed by `a`. */
export function mergePlans(a: StalePlan, b: InstallPlan): InstallPlan {
  const items = new Map<string, CleanupItem>();
  for (const it of [...a.items, ...b.items]) items.set(it.path, it);
  const listed = new Map<string, string>();
  for (const l of [...a.listed, ...b.listed]) if (![...items.keys()].some((p) => within(l.path, p))) listed.set(l.path, l.why);
  return { items: [...items.values()], listed: [...listed].map(([path, why]) => ({ path, why })), strays: b.strays, ...(b.held ? { held: b.held } : {}) };
}
