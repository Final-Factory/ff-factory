/**
 * The daemon's own logs (w2038): a restart never erases recent evidence, and the folder never fills a disk.
 *
 * `<app_dir>/logs` holds the live files (daemon.log, daemon.err.log on Windows, supervisor.log on Windows) and their
 * archives, `<base>.<UTC stamp>` (`daemon.log.20261024T081500123Z`), the stamp being when that file was closed:
 * - Windows: the supervisor (server/machineDeployWin.ts supervisorScript) moves daemon.log and daemon.err.log to an
 *   archive before every start. A `<base>.prev` an older supervisor left is adopted here as an archive at its mtime,
 *   so the next restart's `.prev` overwrites nothing.
 * - macOS (launchd StandardOutPath) and Linux (systemd `append:`) append to daemon.log across restarts with O_APPEND,
 *   so nothing is lost at a restart; once a live file passes `rollBytes` it is copied to an archive and truncated
 *   (an O_APPEND writer goes on at the new end). Windows' redirected handles are not appended, so there only
 *   supervisor.log (opened per line) is rolled this way.
 * Every archive but each base's newest is gzipped (`.gz`). The oldest are removed while the folder (live files
 * included) is over `maxTotalBytes`, or while one is older than `keepDays` and more than `keepAtLeast` remain.
 * Only names matching a live base or its archive are touched; nothing outside the folder is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export interface LogRetention {
  /** The whole logs folder (live files and archives) stays at or under this. */
  maxTotalBytes: number;
  /** Archives younger than this are kept (within maxTotalBytes). */
  keepDays: number;
  /** At least this many archives are kept whatever their age (within maxTotalBytes). */
  keepAtLeast: number;
  /** A live file this big is rolled into an archive where that is safe (see the header). */
  rollBytes: number;
}

export const LOG_RETENTION: LogRetention = { maxTotalBytes: 200 * 1024 * 1024, keepDays: 14, keepAtLeast: 20, rollBytes: 20 * 1024 * 1024 };
/** How often the running daemon looks (it also looks once at start). */
export const LOG_MAINTAIN_EVERY_MS = 10 * 60_000;
export const LOG_BASES = ['daemon.log', 'daemon.err.log', 'supervisor.log'] as const;

const ARCHIVE = /^(daemon\.log|daemon\.err\.log|supervisor\.log)\.(?:(\d{8}T\d{9}Z)(?:-\d+)?|prev)(\.gz)?$/;

/** `20261024T081500123Z` for a date: the stamp the supervisor writes too (yyyyMMdd'T'HHmmssfff'Z', UTC). */
export function logStamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

function stampTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : NaN;
}

export interface LogArchive {
  name: string;
  base: string;
  /** When it was closed: its stamp, else (a .prev) its mtime. */
  at: number;
  bytes: number;
  gz: boolean;
  prev: boolean;
}

/** The archives in a logs folder, oldest first. */
export function listArchives(dir: string): LogArchive[] {
  const out: LogArchive[] = [];
  for (const name of safeReaddir(dir)) {
    const m = ARCHIVE.exec(name);
    if (!m) continue;
    const st = safeStat(path.join(dir, name));
    if (!st?.isFile()) continue;
    const t = m[2] ? stampTime(m[2]) : NaN;
    out.push({ name, base: m[1], at: Number.isFinite(t) ? t : st.mtimeMs, bytes: st.size, gz: !!m[3], prev: !m[2] });
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/** A free archive name for a base closed at `at`. */
function archivePath(dir: string, base: string, at: Date): string {
  const stem = path.join(dir, `${base}.${logStamp(at)}`);
  let p = stem;
  for (let i = 1; fs.existsSync(p) || fs.existsSync(`${p}.gz`); i++) p = `${stem}-${i}`;
  return p;
}

export interface LogMaintenance {
  adopted: string[];
  rolled: string[];
  compressed: string[];
  removed: { name: string; bytes: number; why: string }[];
  errors: string[];
  totalBytes: number;
}

/**
 * One pass over a logs folder: adopt `.prev` files, roll big live files where safe, gzip all but each base's newest
 * archive, prune the oldest. Never throws; what failed is in `errors`.
 */
export function maintainLogs(dir: string, o: { now?: Date; platform?: NodeJS.Platform; retention?: Partial<LogRetention> } = {}): LogMaintenance {
  const r = { ...LOG_RETENTION, ...o.retention };
  const now = o.now ?? new Date();
  const platform = o.platform ?? process.platform;
  const res: LogMaintenance = { adopted: [], rolled: [], compressed: [], removed: [], errors: [], totalBytes: 0 };
  const tryDo = (what: string, f: () => void) => {
    try {
      f();
    } catch (e) {
      res.errors.push(`${what}: ${(e as Error).message}`);
    }
  };
  if (!safeStat(dir)?.isDirectory()) return res;

  for (const a of listArchives(dir).filter((x) => x.prev)) {
    tryDo(`adopt ${a.name}`, () => {
      const to = archivePath(dir, a.base, new Date(a.at)) + (a.gz ? '.gz' : '');
      fs.renameSync(path.join(dir, a.name), to);
      res.adopted.push(`${a.name} -> ${path.basename(to)}`);
    });
  }

  for (const base of LOG_BASES) {
    // Windows' daemon.log and daemon.err.log are held by the running daemon's redirect (not O_APPEND): the supervisor rolls them.
    if (platform === 'win32' && base !== 'supervisor.log') continue;
    const live = path.join(dir, base);
    const st = safeStat(live);
    if (!st?.isFile() || st.size < r.rollBytes) continue;
    tryDo(`roll ${base}`, () => {
      const to = archivePath(dir, base, now);
      fs.copyFileSync(live, to);
      fs.truncateSync(live, 0);
      res.rolled.push(path.basename(to));
    });
  }

  const all = listArchives(dir);
  for (const base of LOG_BASES) {
    const mine = all.filter((a) => a.base === base);
    for (const a of mine.slice(0, -1).filter((x) => !x.gz)) {
      const from = path.join(dir, a.name);
      if (a.bytes === 0) {
        tryDo(`remove empty ${a.name}`, () => fs.unlinkSync(from));
        continue;
      }
      tryDo(`gzip ${a.name}`, () => {
        const st = fs.statSync(from);
        const to = `${from}.gz`;
        const tmp = `${to}.tmp`;
        fs.writeFileSync(tmp, gzipSync(fs.readFileSync(from)));
        fs.utimesSync(tmp, st.atime, st.mtime);
        fs.renameSync(tmp, to);
        fs.unlinkSync(from);
        res.compressed.push(a.name);
      });
    }
  }

  const archives = listArchives(dir);
  const liveBytes = LOG_BASES.reduce((n, b) => n + (safeStat(path.join(dir, b))?.size ?? 0), 0);
  let total = liveBytes + archives.reduce((n, a) => n + a.bytes, 0);
  const oldBefore = now.getTime() - r.keepDays * 86_400_000;
  while (archives.length) {
    const a = archives[0];
    const why = total > r.maxTotalBytes ? `the folder is over ${r.maxTotalBytes} bytes` : a.at < oldBefore && archives.length > r.keepAtLeast ? `older than ${r.keepDays} days` : '';
    if (!why) break;
    archives.shift();
    let gone = false;
    tryDo(`remove ${a.name}`, () => {
      fs.unlinkSync(path.join(dir, a.name));
      gone = true;
    });
    if (gone) {
      total -= a.bytes;
      res.removed.push({ name: a.name, bytes: a.bytes, why });
    }
  }
  res.totalBytes = total;
  return res;
}

/** One log line for a pass that did something, else undefined. */
export function maintenanceLine(m: LogMaintenance): string | undefined {
  const parts = [
    m.adopted.length && `adopted ${m.adopted.join(', ')}`,
    m.rolled.length && `rolled ${m.rolled.join(', ')}`,
    m.compressed.length && `gzipped ${m.compressed.length}`,
    m.removed.length && `removed ${m.removed.map((x) => `${x.name} (${x.why})`).join(', ')}`,
    m.errors.length && `failed: ${m.errors.join('; ')}`,
  ].filter(Boolean);
  return parts.length ? `logs: ${parts.join('; ')}; the folder holds ${Math.round(m.totalBytes / 1024 / 1024)} MB` : undefined;
}

function safeReaddir(d: string): string[] {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

function safeStat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}
