/**
 * Trim a cargo target by its units' last read (w4255): the cargo units of one hash (libfoo-<16 hex>.rlib, foo-<hash>.d,
 * build/foo-<hash>/, .fingerprint/foo-<hash>/ under each <profile>/ dir) go whole, the ones no build read for staleDays
 * first, then the least recently read, until the target is under the cap. Cargo never deletes a unit it stops building, so
 * a target kept warm between workers grows without bound (biscuit's ffu slots: 26.6 and 27.1 GB on 2026-11-15, over the
 * 16 GB cap the clean-up could not apply because their workers were building). A missing unit is rebuilt by the next
 * build, so a trim costs only that rebuild, where a whole target makes the next build cold.
 *
 * It trusts access times only where a read of a file already read days ago moves one (a probe: Linux relatime and strictatime
 * do; noatime, APFS, which moves one only when it is older than the file's write, and NTFS with last-access updates off do
 * not); elsewhere it trims nothing and says so. Relatime refreshes an access time older than a day, so
 * "least recently read" is exact to about a day. The ffu runners' own sweep is ffu's tools/ci-runners/sweep_target.sh.
 */
import fs from 'node:fs';
import path from 'node:path';

const UNIT_DIRS = ['deps', 'build', '.fingerprint', 'examples'];
const HASH = /-([0-9a-f]{16})(\.|$)/;
const DAY = 86_400_000;

export interface CargoUnit {
  /** <profile dir>, the hash: one unit. An incremental cache entry is its own unit, keyed by its path. */
  key: string;
  paths: string[];
  bytes: number;
  /** Newest access time of its files, ms. */
  lastRead: number;
}

export interface SweepResult {
  /** Why nothing was trimmed, when nothing could be. */
  skipped?: string;
  removed: number;
  freedBytes: number;
  beforeBytes: number;
  afterBytes: number;
}

function walk(p: string, each: (file: string, st: fs.Stats) => void): void {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const q = path.join(p, e.name);
    if (e.isDirectory()) walk(q, each);
    else if (e.isFile()) {
      try {
        each(q, fs.statSync(q));
      } catch {
        // gone meanwhile
      }
    }
  }
}

export function treeBytes(dir: string): number {
  let n = 0;
  walk(dir, (_f, st) => void (n += st.size));
  return n;
}

/** Whether reading a file in `dir` again, days after its last read, moves its access time (writes and removes a probe file). */
export function readsMoveAtime(dir: string): boolean {
  const probe = path.join(dir, '.ff-atime-probe');
  try {
    fs.writeFileSync(probe, 'probe');
    // read after an earlier read, days later: the case a warm target needs (APFS moves an access time only when it is older
    // than the write, so a unit read once after its build never looks read again there: measured on m3, 2026-11-14)
    fs.utimesSync(probe, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 3 * DAY));
    fs.readFileSync(probe);
    return Date.now() - fs.statSync(probe).atimeMs < 3_600_000;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/** The profile dirs of a target: <target>/<p> and <target>/<a>/<p> (a custom target dir or triple) holding a unit dir. */
function profileDirs(target: string): string[] {
  const out: string[] = [];
  const kids = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(d, e.name));
    } catch {
      return [];
    }
  };
  const isProfile = (d: string) => UNIT_DIRS.some((u) => fs.existsSync(path.join(d, u))) || fs.existsSync(path.join(d, 'incremental'));
  for (const a of kids(target)) {
    if (isProfile(a)) out.push(a);
    for (const b of kids(a)) if (isProfile(b)) out.push(b);
  }
  return out;
}

export function cargoUnits(target: string): CargoUnit[] {
  const units = new Map<string, CargoUnit>();
  const add = (key: string, entry: string, file: string, st: fs.Stats) => {
    let u = units.get(key);
    if (!u) units.set(key, (u = { key, paths: [], bytes: 0, lastRead: 0 }));
    if (!u.paths.includes(entry)) u.paths.push(entry);
    u.bytes += st.size;
    u.lastRead = Math.max(u.lastRead, st.atimeMs);
  };
  for (const prof of profileDirs(target)) {
    for (const kind of UNIT_DIRS) {
      const dir = path.join(prof, kind);
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents) {
        const m = HASH.exec(e.name);
        if (!m) continue;
        const entry = path.join(dir, e.name);
        const key = `${prof}\t${m[1]}`;
        if (e.isDirectory()) walk(entry, (f, st) => add(key, entry, f, st));
        else if (e.isFile()) add(key, entry, entry, fs.statSync(entry));
      }
    }
    const inc = path.join(prof, 'incremental');
    try {
      for (const e of fs.readdirSync(inc, { withFileTypes: true })) {
        const entry = path.join(inc, e.name);
        if (e.isDirectory()) walk(entry, (f, st) => add(entry, entry, f, st));
      }
    } catch {
      // no incremental cache
    }
  }
  return [...units.values()];
}

/**
 * Trim `target` to `capBytes`: units unread for staleDays first, then the least recently read. Call it only when nothing
 * builds into the target (the caller's check). Under the cap it removes only the stale units.
 */
export function sweepCargoTarget(target: string, o: { capBytes: number; staleDays: number; now?: number }): SweepResult {
  const now = o.now ?? Date.now();
  const beforeBytes = treeBytes(target);
  const none = (skipped?: string): SweepResult => ({ skipped, removed: 0, freedBytes: 0, beforeBytes, afterBytes: beforeBytes });
  if (!fs.existsSync(target)) return none('no target');
  if (!readsMoveAtime(target)) return none('a read does not move access times on this drive, so which units are in use is unknown');
  const units = cargoUnits(target).sort((a, b) => a.lastRead - b.lastRead);
  let left = beforeBytes;
  let removed = 0;
  for (const u of units) {
    const stale = now - u.lastRead > o.staleDays * DAY;
    if (!stale && left <= o.capBytes) break;
    for (const p of u.paths) fs.rmSync(p, { recursive: true, force: true });
    left -= u.bytes;
    removed++;
  }
  const afterBytes = treeBytes(target);
  return { removed, freedBytes: beforeBytes - afterBytes, beforeBytes, afterBytes };
}

/** The newest write into a target's unit dirs, ms (a build adds files there, which moves its dir's time), or 0. */
export function newestUnitDirWrite(target: string): number {
  let newest = 0;
  for (const prof of profileDirs(target)) {
    for (const kind of [...UNIT_DIRS, 'incremental']) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(prof, kind)).mtimeMs);
      } catch {
        // no such dir
      }
    }
  }
  return newest;
}
