import fs from 'node:fs';
import path from 'node:path';

/** The Library folders that grow without bound as code and content change (Library/BuildCache, Library/BurstCache). */
export const LIBRARY_CACHES = ['BuildCache', 'BurstCache'];

/**
 * Pruning a sandbox's Unity Library caches of what nothing current uses (w898, w2752). Library/BuildCache and
 * Library/BurstCache only ever grow: every code or content change adds entries and nothing removes the old ones (4.8-12.7 GB
 * each per sandbox, 87 GB over lothdesktop's six, measured 2026-10-10). Wiping a live cache costs a cold rebuild on a machine
 * with no CPU to spare (lothsahn, 2026-11-01: "A cold unity station is quite slow so we should make sure to not do it often.
 * LothDszktop is almost always at full CPU and doesn't have any to spare"), so routine clean-up removes only superseded
 * entries, whole, never single files of one:
 *
 * - `BurstCache/<target>` (player builds; every folder but JIT): one `<hash>.dll` + `.pdb` per Burst compile of the whole
 *   player, a new one for every code change (lothdesktop/slot2: 12 of 91 MB in a day, measured 2026-11-01). Burst checks an
 *   entry before reusing it (Burst.Compiler.IL's CheckLibraryCacheEntryReusable) and compiles again on a miss, so the older
 *   ones are dead weight: the newest `playerBuildsKept` stay, with the manifest and Hashes beside them.
 * - `BuildCache`: the Scriptable Build Pipeline's entry folders, `BuildCache/<2 hex>/<hash>/<version>`. A folder's files
 *   reference each other, so a folder goes whole, as the pipeline's own prune does it (com.unity.scriptablebuildpipeline
 *   BuildCache.PruneCacheFolders: "Need to delete sets of files as the .info might reference a specific file artifact"); one
 *   file of it removed fails the next build ("Could not find file '...\Library\BuildCache\...'", w1211). Kept: everything the
 *   newest build wrote (within an hour of the newest write), then the newest folders up to `buildCacheGB`, like that prune's
 *   least-recently-used order (V: keeps no access times: a file's access time is its write time, measured 2026-11-01).
 * - Never: BurstCache/JIT (the editor's own Burst code; an entry of an unchanged package assembly is old and still in use,
 *   and nothing on disk tells which), PlayerDataCache and EntitySceneBundles (a build trusts them whole), Artifacts, Bee,
 *   ScriptAssemblies, PackageCache. Those go only as a last resort (cleanup.ts, `sandbox-lib-cache-last-resort`).
 *
 * Never while an editor or a batchmode build has the project open (Temp/UnityLockfile).
 */
export interface TrimPolicy {
  /** Burst player-build libraries kept per target folder, newest first. */
  playerBuildsKept: number;
  /** BuildCache entry folders beyond the newest build's own are kept, newest first, up to this many GB. */
  buildCacheGB: number;
  /** The trim is given up (the sandbox is handed back as it is) after this long. */
  timeoutMs: number;
}

/**
 * Two Burst player builds: the newest, and one more for a branch switched back. 2 GB of BuildCache: a full build of one commit
 * writes 0.4 GB (measured, w898) and a day of builds about 0.3 to 0.6 GB each (lothdesktop/slot2, measured 2026-11-01).
 */
export const TRIM_DEFAULTS: TrimPolicy = { playerBuildsKept: 2, buildCacheGB: 2, timeoutMs: 10 * 60_000 };

export interface TrimResult {
  /** Set when nothing was done: why. */
  skipped?: string;
  /** Set when it stopped early (a timeout, an editor or build that started meanwhile): why. What was removed stays removed. */
  stopped?: string;
  files: number;
  removedBytes: number;
  keptBytes: number;
  /** What `git lfs dedup` did in the released sandbox (w1576, machine/sandboxes.ts lfsDedup). */
  lfs?: { bytes: number } | { skipped: string };
  /** The build and capture output of the released sandbox taken with it (w913): entries and bytes. */
  swept?: { files: number; bytes: number };
}

/** Whether an editor or a batchmode build has the project open. */
export const projectOpen = (project: string) => fs.existsSync(path.join(project, 'Temp', 'UnityLockfile'));

/** One entry nothing current uses: a file or a folder that goes whole. */
export interface StaleEntry {
  path: string;
  bytes: number;
  why: string;
}

interface Entry {
  file: string;
  size: number;
  mtimeMs: number;
}

async function listFiles(dir: string, out: Entry[], stop: () => string | undefined): Promise<void> {
  let names: fs.Dirent[];
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of names) {
    if (stop()) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(p, out, stop);
    else if (e.isFile()) {
      const st = await fs.promises.lstat(p).catch(() => undefined);
      if (st) out.push({ file: p, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
}

const dirs = async (dir: string) => (await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])).filter((e) => e.isDirectory()).map((e) => e.name);

/** A Burst library's files: `<32 hex>.dll`, `.pdb` and the like (not the manifest, not Hashes). */
const BURST_LIB = /^([0-9a-f]{32})\.[a-z0-9]+$/i;

/**
 * What of `<project>/Library/{BuildCache,BurstCache}` nothing current uses (the rules in this file's header), and how many
 * bytes the two caches keep. Reads only.
 */
export async function staleCacheEntries(project: string, policy: TrimPolicy = TRIM_DEFAULTS, stop: () => string | undefined = () => undefined): Promise<{ stale: StaleEntry[]; keptBytes: number }> {
  const stale: StaleEntry[] = [];
  let total = 0;
  const burst = path.join(project, 'Library', 'BurstCache');
  for (const target of await dirs(burst)) {
    const all: Entry[] = [];
    await listFiles(path.join(burst, target), all, stop);
    total += all.reduce((n, e) => n + e.size, 0);
    if (target === 'JIT') continue;
    const libs = new Map<string, { files: Entry[]; newest: number }>();
    for (const e of all) {
      if (path.dirname(e.file) !== path.join(burst, target)) continue;
      const m = BURST_LIB.exec(path.basename(e.file));
      if (!m) continue;
      const lib = libs.get(m[1].toLowerCase()) ?? { files: [], newest: 0 };
      lib.files.push(e);
      lib.newest = Math.max(lib.newest, e.mtimeMs);
      libs.set(m[1].toLowerCase(), lib);
    }
    const older = [...libs.values()].sort((a, b) => b.newest - a.newest).slice(Math.max(0, policy.playerBuildsKept));
    for (const lib of older) for (const e of lib.files) stale.push({ path: e.file, bytes: e.size, why: `a superseded Burst player build (${target}; the newest ${policy.playerBuildsKept} stay)` });
  }
  const build = path.join(project, 'Library', 'BuildCache');
  const folders: { path: string; bytes: number; newest: number }[] = [];
  for (const a of await dirs(build)) {
    for (const b of await dirs(path.join(build, a))) {
      for (const c of await dirs(path.join(build, a, b))) {
        const p = path.join(build, a, b, c);
        const files: Entry[] = [];
        await listFiles(p, files, stop);
        folders.push({ path: p, bytes: files.reduce((n, e) => n + e.size, 0), newest: Math.max(0, ...files.map((e) => e.mtimeMs)) });
      }
    }
  }
  folders.sort((x, y) => y.newest - x.newest);
  const latest = (folders[0]?.newest ?? 0) - 3_600_000;
  const cap = policy.buildCacheGB * 1024 ** 3;
  let kept = 0;
  let full = false;
  for (const f of folders) {
    total += f.bytes;
    if (f.newest >= latest || (!full && kept + f.bytes <= cap)) kept += f.bytes;
    else (full = true), stale.push({ path: f.path, bytes: f.bytes, why: `a build-cache entry older than the newest build, past the newest ${policy.buildCacheGB} GB` });
  }
  return { stale, keptBytes: total - stale.reduce((n, e) => n + e.bytes, 0) };
}

/** Remove the empty folders under `dir` (not `dir` itself). */
async function pruneEmpty(dir: string): Promise<void> {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    await pruneEmpty(p);
    await fs.promises.rmdir(p).catch(() => undefined); // fails while not empty: fine
  }
}

/**
 * Prune `<project>/Library/{BuildCache,BurstCache}` of its stale entries when the sandbox is released. `signal` aborts it
 * between entries; the project being opened by an editor or build meanwhile stops it too. Resolves with what was done; never
 * throws for an entry that is gone or locked. A BuildCache folder is renamed before it is deleted, so one with a file open
 * inside stays whole.
 */
export async function trimLibraryCaches(project: string, policy: TrimPolicy = TRIM_DEFAULTS, o: { now?: number; signal?: AbortSignal } = {}): Promise<TrimResult> {
  const res: TrimResult = { files: 0, removedBytes: 0, keptBytes: 0 };
  if (projectOpen(project)) return { ...res, skipped: 'an editor or build has the project open' };
  let n = 0;
  const stop = (): string | undefined => {
    if (o.signal?.aborted) return 'timed out';
    if (++n % 200 === 0 && projectOpen(project)) return 'an editor or build opened the project';
    return undefined;
  };
  const { stale, keptBytes } = await staleCacheEntries(project, policy, stop);
  res.keptBytes = keptBytes;
  const why = stop();
  if (why) return { ...res, keptBytes: keptBytes + stale.reduce((s, e) => s + e.bytes, 0), stopped: why };
  for (const [i, e] of stale.entries()) {
    const w = o.signal?.aborted ? 'timed out' : projectOpen(project) ? 'an editor or build opened the project' : undefined;
    if (w) return { ...res, keptBytes: res.keptBytes + stale.slice(i).reduce((s, x) => s + x.bytes, 0), stopped: w };
    try {
      const st = await fs.promises.lstat(e.path);
      if (st.isDirectory()) {
        const away = `${e.path}.ffclean-${Date.now()}`;
        await fs.promises.rename(e.path, away);
        await fs.promises.rm(away, { recursive: true, force: true });
      } else await fs.promises.unlink(e.path);
      res.files++;
      res.removedBytes += e.bytes;
    } catch {
      res.keptBytes += e.bytes; // locked or gone: it stays
    }
  }
  await pruneEmpty(path.join(project, 'Library', 'BuildCache'));
  return res;
}
