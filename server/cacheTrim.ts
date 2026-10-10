import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_CACHES } from './cleanup.ts';

/**
 * Trimming a sandbox's Unity Library caches when the sandbox is released (w898). Library/BuildCache and Library/BurstCache
 * only ever grow: every code change adds entries and nothing removes the old ones (4.8-12.7 GB each per sandbox, 87 GB over
 * lothdesktop's six, measured 2026-10-10). A trim keeps what a restart of the same work needs (entries written in the last
 * `keepHours`, the newest first up to `capGB` per cache) and drops the rest. It is a trim, not a wipe: the next worker's first
 * build stays warm. Never while an editor or a batchmode build has the project open (Temp/UnityLockfile).
 */
export interface TrimPolicy {
  /** Files written within this many hours stay. */
  keepHours: number;
  /** Each cache is cut, oldest first, to at most this many GB. 0: no cap. */
  capGB: number;
  /** The trim is given up (the sandbox is handed back as it is) after this long. */
  timeoutMs: number;
}

export const TRIM_DEFAULTS: TrimPolicy = { keepHours: 24, capGB: 4, timeoutMs: 10 * 60_000 };

export interface TrimResult {
  /** Set when nothing was done: why. */
  skipped?: string;
  /** Set when it stopped early (a timeout, an editor or build that started meanwhile): why. What was removed stays removed. */
  stopped?: string;
  files: number;
  removedBytes: number;
  keptBytes: number;
}

/** Whether an editor or a batchmode build has the project open. */
export const projectOpen = (project: string) => fs.existsSync(path.join(project, 'Temp', 'UnityLockfile'));

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
 * Trim `<project>/Library/{BuildCache,BurstCache}`. `signal` aborts it between files; the project being opened by an
 * editor or build meanwhile stops it too. Resolves with what was done; never throws for a file that is gone or locked.
 */
export async function trimLibraryCaches(project: string, policy: TrimPolicy = TRIM_DEFAULTS, o: { now?: number; signal?: AbortSignal } = {}): Promise<TrimResult> {
  const res: TrimResult = { files: 0, removedBytes: 0, keptBytes: 0 };
  if (projectOpen(project)) return { ...res, skipped: 'an editor or build has the project open' };
  const now = o.now ?? Date.now();
  const cutoff = now - policy.keepHours * 3_600_000;
  let n = 0;
  const stop = (): string | undefined => {
    if (o.signal?.aborted) return 'timed out';
    if (++n % 200 === 0 && projectOpen(project)) return 'an editor or build opened the project';
    return undefined;
  };
  for (const cache of LIBRARY_CACHES) {
    const dir = path.join(project, 'Library', cache);
    const all: Entry[] = [];
    await listFiles(dir, all, stop);
    const why = stop();
    if (why) return { ...res, stopped: why };
    const cap = policy.capGB > 0 ? policy.capGB * 1024 ** 3 : Infinity;
    // Old files go; then, newest kept first, whatever does not fit under the cap.
    const young = all.filter((e) => e.mtimeMs >= cutoff).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let kept = 0;
    const doomed = all.filter((e) => e.mtimeMs < cutoff);
    for (const e of young) {
      if (kept + e.size > cap) doomed.push(e);
      else kept += e.size;
    }
    for (const e of doomed) {
      const w = stop();
      if (w) return { ...res, keptBytes: res.keptBytes + kept, stopped: w };
      try {
        await fs.promises.unlink(e.file);
        res.files++;
        res.removedBytes += e.size;
      } catch {
        kept += e.size; // locked or gone: it stays
      }
    }
    await pruneEmpty(dir);
    res.keptBytes += kept;
  }
  return res;
}
