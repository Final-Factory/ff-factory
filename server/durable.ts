// Crash-safe data files (docs/self-recovery.md, "Crash-safe data files"). On 2026-09-30 BEAST hard-crashed (a WHEA
// hardware error) and Windows left data/state.json full of zero bytes: the rename of a freshly written file had reached
// the disk, its data had not. The server failed to parse it on every start, and the portal stayed down until someone
// restored it by hand. Here every write is fsynced before the rename that makes it current, the last few good versions
// stay beside the file, and a load that finds the file damaged falls back to the newest good version by itself.
import fs from 'node:fs';
import path from 'node:path';

export interface DurableOptions {
  /** Older versions kept beside the file (see rotate()); 0 keeps none. Default 3. */
  generations?: number;
  /** How far apart the older versions are: .2 moves on at most every spacingMs, .3 every 10 x spacingMs. Default 60 s. */
  spacingMs?: number;
  /** File mode for a new file (tokens: 0o600). Versions share it: they are hard links. */
  mode?: number;
}

/** A data file found damaged at load, and what was done about it. */
export interface DataRecovery {
  file: string;
  /** How to name it when the file name alone is ambiguous ("orchestrator memory person-ben/MEMORY.md"). */
  label?: string;
  /** What was wrong: "all zero bytes", "cut off (not valid JSON: ...)", "missing", "unreadable (EBUSY)", a schema complaint. */
  problem: string;
  /** Where the damaged file was moved (it is never deleted). */
  movedTo?: string;
  /** The version it was restored from, and when that version was written. Absent: no good version, started empty. */
  from?: string;
  fromTime?: string;
  /** When the damaged file was last written: what was lost is roughly fromTime..damagedTime. */
  damagedTime?: string;
}

const DEFAULT_GENERATIONS = 3;
const DEFAULT_SPACING_MS = 60_000;
const isWindows = process.platform === 'win32';

/** Every recovery since this process started, for the restart summary (server/index.ts). */
export const dataRecoveries: DataRecovery[] = [];

export const generationPath = (file: string, k: number) => `${file}.${k}`;

/** Where a damaged file goes: beside it, stamped, never overwriting an earlier one. */
export function asidePath(file: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let p = `${file}.damaged-${stamp}`;
  for (let i = 2; fs.existsSync(p); i++) p = `${file}.damaged-${stamp}-${i}`;
  return p;
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows refuses a rename or a read for a moment while an indexer or antivirus has the file open. */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES']);

function retrySync<T>(fn: () => T, tries = 5, ms = 50): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      sleepSync(ms * i);
    }
  }
}

const mtimeOf = (p: string): number | undefined => fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs;

/** Make a rename in `dir` durable. Windows cannot open a directory for this (NTFS journals the rename itself). */
function fsyncDir(dir: string) {
  if (isWindows) return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // some file systems refuse; the data itself is already on disk
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function fsyncDirAsync(dir: string) {
  if (isWindows) return;
  const h = await fs.promises.open(dir, 'r').catch(() => undefined);
  if (!h) return;
  await h.sync().catch(() => undefined);
  await h.close();
}

/**
 * Keep the version about to be replaced: `.1` is always the previous write (a hard link, so no copy); `.2` takes the
 * old `.1` at most every spacingMs, `.3` the old `.2` at most every 10 x spacingMs. After a crash `.1` is seconds old,
 * `.2` up to a minute, `.3` one to eleven minutes: a failure that damaged every recent write still leaves an older one.
 * A version is replaced only by a newer good one, and a slot moves on only once it is old enough (its content's mtime).
 */
function rotate(file: string, generations: number, spacingMs: number, tries: number) {
  if (generations <= 0 || !fs.existsSync(file)) return;
  const now = Date.now();
  let top = 1;
  for (let k = 2; k <= generations; k++) {
    const t = mtimeOf(generationPath(file, k));
    if (t !== undefined && now - t < spacingMs * 10 ** (k - 2)) break;
    top = k;
  }
  for (let k = top; k >= 2; k--) {
    const from = generationPath(file, k - 1);
    if (fs.existsSync(from)) retrySync(() => fs.renameSync(from, generationPath(file, k)), tries);
  }
  const g1 = generationPath(file, 1);
  retrySync(() => fs.rmSync(g1, { force: true }), tries);
  try {
    fs.linkSync(file, g1);
  } catch {
    // no hard links on this file system: a copy, on disk before it counts
    fs.copyFileSync(file, g1);
    const fd = fs.openSync(g1, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

let rotateWarnedAt = 0;

/**
 * Make the fsynced temp file the current one: keep the old version, then rename over. `tries`: attempts at each rename
 * a Windows indexer or antivirus may refuse for a moment, sleeping in between (blocking: only where a caller waits anyway).
 */
function commit(file: string, tmp: string, o: DurableOptions, tries: number) {
  try {
    rotate(file, o.generations ?? DEFAULT_GENERATIONS, o.spacingMs ?? DEFAULT_SPACING_MS, tries);
  } catch (e) {
    // Losing an old version is not worth failing the write; say so now and then.
    if (Date.now() - rotateWarnedAt > 10 * 60_000) {
      rotateWarnedAt = Date.now();
      console.warn(`durable: could not keep the previous version of ${path.basename(file)}: ${(e as Error).message}`);
    }
  }
  retrySync(() => fs.renameSync(tmp, file), tries);
}

/** Write a file so that a crash at any moment leaves either the old or the new content, never a torn or zeroed file. */
export function writeFileDurable(file: string, data: string | Buffer, o: DurableOptions = {}) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', o.mode ?? 0o666);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  commit(file, tmp, o, 5);
  fsyncDir(path.dirname(file));
}

export const writeJsonDurable = (file: string, value: unknown, o: DurableOptions & { indent?: number } = {}) =>
  writeFileDurable(file, JSON.stringify(value, null, o.indent) + (o.indent ? '\n' : ''), o);

/**
 * The same, with the write and the fsync (the slow part) off the main thread. `stillWanted` is asked once the data is
 * on disk: false (a newer version was written meanwhile) drops this one. The rename runs on the main thread, so a
 * synchronous write in between cannot be overtaken by an older one; it is tried once, never slept on: a refused rename
 * throws, and the caller writes again later. Returns whether it was committed.
 */
export async function writeFileDurableAsync(file: string, data: string | Buffer, o: DurableOptions & { stillWanted?: () => boolean } = {}): Promise<boolean> {
  const tmp = `${file}.async.tmp`;
  const h = await fs.promises.open(tmp, 'w', o.mode ?? 0o666);
  try {
    await h.writeFile(data);
    await h.sync();
  } finally {
    await h.close();
  }
  if (o.stillWanted && !o.stillWanted()) {
    fs.rmSync(tmp, { force: true });
    return false;
  }
  commit(file, tmp, o, 1);
  await fsyncDirAsync(path.dirname(file));
  return true;
}

// ------------------------------------------------------------------------------------------------ loading

/** A schema check: why the parsed value is not a sane version of this file, or undefined when it is. */
export type Check = (v: unknown) => string | undefined;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const checkObject: Check = (v) => (isObject(v) ? undefined : 'not a JSON object');
export const checkArray: Check = (v) => (Array.isArray(v) ? undefined : 'not a JSON list');
export const checkStringMap: Check = (v) => (isObject(v) && Object.values(v).every((x) => typeof x === 'string') ? undefined : 'not a map of strings');

type Read = { ok: true; value: unknown; text: string; missing?: undefined } | { ok: false; problem: string; missing?: boolean };

function readCandidate(p: string, check: Check | undefined): Read {
  let buf: Buffer;
  try {
    buf = retrySync(() => fs.readFileSync(p), 4, 100);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { ok: false, problem: 'missing', missing: true } : { ok: false, problem: `unreadable (${code ?? (e as Error).message})` };
  }
  if (!buf.length) return { ok: false, problem: 'empty (0 bytes)' };
  if (!buf.some((b) => b !== 0)) return { ok: false, problem: `all zero bytes (${buf.length} bytes)` };
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    const zeros = buf.indexOf(0);
    return { ok: false, problem: zeros >= 0 ? `partly written (zero bytes from byte ${zeros} of ${buf.length})` : `cut off or garbled (${(e as Error).message})` };
  }
  const bad = check?.(value);
  return bad ? { ok: false, problem: `not a sane version of this file (${bad})` } : { ok: true, value, text };
}

function moveAside(p: string): string | undefined {
  const to = asidePath(p);
  try {
    retrySync(() => fs.renameSync(p, to));
    return to;
  } catch {
    try {
      // cannot move it (held open): keep a copy at least
      fs.copyFileSync(p, to);
      return to;
    } catch {
      return undefined;
    }
  }
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

/**
 * Load a JSON data file, healing it when it is damaged. Tries the file, then its versions .1, .2, ... and `extra` (an
 * older scheme's backup, such as config.json.prev), newest first, and takes the first that parses and passes `check`.
 * A damaged candidate is moved aside (never deleted) and the good version is written back in place, so the next load
 * is normal. Every recovery is logged loudly and kept in dataRecoveries for the restart summary.
 * Returns undefined when there is no file at all (a first start) or when nothing good is left (then it starts empty,
 * and the recovery says so).
 */
export function readJsonDurable<T>(file: string, o: { check?: Check; generations?: number; extra?: string[]; mode?: number } = {}): T | undefined {
  const first = readCandidate(file, o.check);
  if (first.ok) return first.value as T;
  const candidates = [...Array.from({ length: o.generations ?? DEFAULT_GENERATIONS }, (_, i) => generationPath(file, i + 1)), ...(o.extra ?? [])];
  if (first.missing && !candidates.some((c) => fs.existsSync(c))) return undefined;

  const rec: DataRecovery = { file, problem: first.problem, damagedTime: iso(mtimeOf(file)) };
  if (!first.missing) rec.movedTo = moveAside(file);
  const skipped: string[] = [];
  for (const c of candidates) {
    const r = readCandidate(c, o.check);
    if (r.missing) continue;
    if (!r.ok) {
      const to = moveAside(c);
      skipped.push(`${path.basename(c)} ${r.problem}${to ? ` (kept as ${path.basename(to)})` : ''}`);
      continue;
    }
    rec.from = c;
    rec.fromTime = iso(mtimeOf(c));
    try {
      writeFileDurable(file, r.text, { generations: 0, mode: o.mode });
    } catch (e) {
      console.error(`durable: restored ${path.basename(file)} from ${path.basename(c)} in memory, but could not write it back: ${(e as Error).message}`);
    }
    recordRecovery(rec, skipped);
    return r.value as T;
  }
  recordRecovery(rec, skipped);
  return undefined;
}

/** One line on a recovery, for logs and the restart summary. */
export function describeRecovery(r: DataRecovery): string {
  const name = r.label ?? path.basename(r.file);
  const kept = r.movedTo ? ` The damaged file is kept as ${r.movedTo}.` : '';
  if (!r.from) return `${name} was ${r.problem} and no good earlier version was left: started it EMPTY.${kept}`;
  const gap = r.fromTime && r.damagedTime ? Date.parse(r.damagedTime) - Date.parse(r.fromTime) : undefined;
  const lost = gap === undefined ? '' : gap <= 0 ? ' (nothing newer was lost)' : ` (up to ${fmtGap(gap)} of changes before the crash are lost)`;
  return `${name} was ${r.problem}; restored the version saved at ${r.fromTime ?? '?'} (${r.label ? r.from : path.basename(r.from)})${r.damagedTime ? `, last written ${r.damagedTime}` : ''}${lost}.${kept}`;
}

export function fmtGap(ms: number): string {
  if (ms < 1000) return 'under a second';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

/** Keep a recovery for the restart summary, and say it loudly in the log. */
export function recordRecovery(rec: DataRecovery, skipped: string[] = []) {
  dataRecoveries.push(rec);
  console.error(`\n!!!!!!!! DATA RECOVERY: ${describeRecovery(rec)}${skipped.length ? ` Also damaged: ${skipped.join('; ')}.` : ''}\n`);
}

// ------------------------------------------------------------------------------------------------ background saves

export interface SnapshotOptions extends DurableOptions {
  /** A write starts at most this long after the first change of a burst. */
  delayMs: number;
  /** And never sooner than this after the previous one started, however busy. */
  intervalMs: number;
  /** For log lines. */
  label: string;
}

/**
 * One JSON file saved in the background. Changes are coalesced: a write starts at most delayMs after the first change
 * (a steady stream of changes can no longer postpone it, as the old trailing debounce did) and at most once per
 * intervalMs. The snapshot is serialized on the main thread; the write and the fsync run off it. A crash loses at most
 * about delayMs..intervalMs plus the write's own time.
 */
export class SnapshotFile {
  private timer?: NodeJS.Timeout;
  private writing = false;
  private dirty = false;
  private version = 0;
  private committed = 0;
  private lastStart = 0;
  private failures = 0;
  /** The last background write, for tests and shutdown. */
  private inFlight: Promise<void> = Promise.resolve();
  readonly file: string;
  private readonly serialize: () => string;
  private readonly o: SnapshotOptions;

  constructor(file: string, serialize: () => string, o: SnapshotOptions) {
    this.file = file;
    this.serialize = serialize;
    this.o = o;
  }

  /** Something in the snapshot changed. */
  changed() {
    this.dirty = true;
    this.schedule();
  }

  get pending() {
    return this.dirty || this.writing;
  }

  private schedule() {
    if (this.timer || this.writing || !this.dirty) return;
    const backoff = this.failures ? Math.min(30_000, 500 * 2 ** this.failures) : 0;
    const wait = Math.max(this.o.delayMs, this.lastStart + this.o.intervalMs - Date.now(), backoff);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.writeInBackground();
    }, wait);
    this.timer.unref();
  }

  private async writeInBackground() {
    if (!this.dirty) return;
    this.dirty = false;
    this.writing = true;
    this.lastStart = Date.now();
    const v = ++this.version;
    try {
      if (await writeFileDurableAsync(this.file, this.serialize(), { ...this.o, stillWanted: () => v > this.committed })) this.committed = v;
      this.failures = 0;
    } catch (e) {
      this.failed(e);
    } finally {
      this.writing = false;
      this.schedule();
    }
  }

  private failed(e: unknown) {
    // The folder is gone (a test's temp folder, or the data drive): nothing to retry into.
    if (!fs.existsSync(path.dirname(this.file))) {
      this.dirty = false;
      return;
    }
    this.dirty = true;
    this.failures++;
    console.warn(`${this.o.label} save failed, retrying:`, (e as Error).message);
  }

  /** Write now, on the main thread (shutdown, tests). Supersedes a background write still in flight. */
  flushSync() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const v = ++this.version;
    try {
      writeFileDurable(this.file, this.serialize(), this.o);
      this.committed = v;
      this.dirty = false;
      this.failures = 0;
    } catch (e) {
      this.failed(e);
      this.schedule();
    }
  }

  /** Resolves once no background write is running or due (tests). */
  async idle() {
    while (this.timer || this.writing) {
      await this.inFlight;
      if (this.timer) await new Promise((r) => setTimeout(r, 10));
    }
  }
}
