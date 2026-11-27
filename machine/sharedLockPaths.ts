/**
 * w5615 (stage 2 of w5544): what the shared lock "on" makes read-only to sandbox workers, in one place for the three fences
 * (Windows labels: machine/lowIntegrity.ts lowTargets; macOS: server/workerFence.ts seatbeltProfile; Linux:
 * machine/writeLock.ts writeLockArgs). No imports beyond node: the fences and the slot caches all read it.
 *
 * Locked: the seeds of the cloned tool caches (machine/slotCaches.ts SLOT_CACHE_TOOLS, checked equal by its test), `players`
 * (the broker installs, the daemon launches) and `seed` (the Library seed, written by `worker.ts install`). In `tools`, the
 * folders Windows already keeps Medium (lowIntegrity.ts MEDIUM_TOOLS): node, low and unity-low. Workers still write
 * cache/slots, cache/uv-tools, cache/uv-bin, cache/cargo, cache/xdg and the other tools children.
 *
 * A folder on the way to a locked one (cache, cache/nuget, tools) is not locked, but its own entries are: a worker could
 * otherwise rename the locked folder out of it (a Low parent's FILE_DELETE_CHILD on Windows; Landlock's REMOVE right on the
 * parent's hierarchy on Linux) and write it there. So Windows keeps such a parent Medium with each other child Low on its
 * own, and Linux opens only its other children. macOS matches paths, so its denies on the locked paths are enough.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The seeds of the cloned caches, under `<root>/cache` ('/'-separated). */
export const SHARED_SEED_DIRS = ['uv', 'pip', 'npm', 'nuget/packages', 'upm', 'dotnet', 'ms-playwright'] as const;
/** The tools children the lock keeps from workers on every OS (lowIntegrity.ts MEDIUM_TOOLS, checked equal by its test). */
export const SHARED_LOCK_TOOLS = ['node', 'low', 'unity-low'] as const;
/**
 * The cache children workers write under the lock (machine/sharedCaches.ts workerToolCacheEnv, workerUvToolDir and the
 * rest; slotCaches.ts slotCacheDir). On Windows `cache` turns Medium, so a missing one could no longer be made by a worker:
 * the daemon makes them before it labels.
 */
export const WORKER_CACHE_CHILDREN = ['slots', 'uv-tools', 'uv-bin', 'cargo', 'asset-store', 'determinism-audit', 'xdg'] as const;

/** The locked paths relative to the root, '/'-separated. `withTools`: and the tools children (Windows keeps those already). */
export function sharedLockRel(withTools = true): string[] {
  return [...SHARED_SEED_DIRS.map((d) => `cache/${d}`), 'players', 'seed', ...(withTools ? SHARED_LOCK_TOOLS.map((t) => `tools/${t}`) : [])];
}

/** The locked paths, absolute. */
export function sharedLockPaths(root: string, withTools = true): string[] {
  return sharedLockRel(withTools).map((r) => path.join(root, ...r.split('/')));
}

/**
 * The folders on the way to the locked paths (not the root), each with the names of its entries that are locked or on the
 * way: `cache` -> uv, pip, npm, nuget, upm, dotnet, ms-playwright; `cache/nuget` -> packages; `tools` -> node, low, unity-low.
 */
export function sharedLockParents(withTools = true): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const rel of sharedLockRel(withTools)) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (!out.has(parent)) out.set(parent, new Set());
      out.get(parent)!.add(parts[i]);
    }
  }
  return out;
}

/**
 * Makes the folders the lock's fences list before they apply: the workers' own cache children (a Medium `cache` on Windows,
 * and Landlock's children of `cache` listed at each start, would refuse a worker the first one) and the folders on the way
 * (ff-landlock.py lists each one it is given). Never throws: a folder it cannot make is left to the next start.
 */
export function makeSharedLockDirs(root: string, mkdir: (p: string) => void = (p) => fs.mkdirSync(p, { recursive: true })): void {
  for (const rel of [...WORKER_CACHE_CHILDREN.map((c) => `cache/${c}`), ...sharedLockParents().keys()]) {
    try {
      mkdir(path.join(root, ...rel.split('/')));
    } catch {
      // the next start makes it
    }
  }
}
