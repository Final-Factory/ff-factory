// Claude Code's own transcripts, scrubbed of secret values as they are written (w1688). The CLI writes every tool call and
// tool result to <home>/.claude/projects/<cwd>/<session id>.jsonl (with large results beside it in tool-results files, and
// subagents' transcripts below), and FF Factory never gets to redact them before they are on disk: a worker on beast printed
// its environment and the vault's FFSTEAM_PASSWORD value sat in clear in that file. Every daemon, and the portal for its own
// orchestrators, runs one CliScrubber over the projects folder: it watches for writes, and overwrites each known value (and
// its encodings, server/secrets.ts secretBytesMatcher) in place with a mask of the same length, so the line stays valid JSON,
// nothing moves, and the CLI appending to the file at that moment loses nothing (no rewrite, no rename). When a value is
// learnt that was not known, it looks back through every file for it once. It reports file paths and counts, never a value.
import fs from 'node:fs';
import path from 'node:path';
import { secretBytesMatcher, secretValuesSince, secretValuesVersion } from './secrets.ts';

/** Files the CLI writes that hold text: transcripts, tool results, notes. Images and PDFs are left alone. */
const TEXT = /\.(?:jsonl|json|txt|md|log)$/i;
/** w3855: 1 MB, about 15 ms of scanning on the portal VM (a guess from its 2026-11-09 15:11 stall profile), not 8 MB. */
const CHUNK = 1024 * 1024;

/** The same-length mask (ASCII, JSON-safe): "[redacted******]", or stars when the match is shorter than 10 bytes. */
export const inPlaceMask = (n: number) => Buffer.from(n >= 10 ? `[redacted${'*'.repeat(n - 10)}]` : '*'.repeat(n), 'latin1');

/**
 * Overwrite every match of `m` in `file` from byte `from` on (a little before it, so a value cut by the last scan's end is
 * found), in place: same length, nothing else touched. How many it found (on a dry run: would mask), and the size it read to.
 */
/** w6479: which file this is under its name: its inode (Windows' file index) and its birth time, as ext4 reuses inodes. */
const fileId = (st: fs.Stats) => `${st.ino}:${st.birthtimeMs}`;

export async function scrubInPlace(file: string, m: { re: RegExp; maxLen: number }, from = 0, o: { dryRun?: boolean } = {}): Promise<{ count: number; size: number; id: string }> {
  // w3855: read by the thread pool, CHUNK at a time, so a chunk's scan is the event loop's only long piece (it was 8 MB read here)
  const fh = await fs.promises.open(file, o.dryRun ? 'r' : 'r+');
  try {
    const st = await fh.stat();
    const size = st.size;
    const id = fileId(st);
    const overlap = m.maxLen - 1;
    let pos = Math.max(0, Math.min(from, size) - overlap);
    let count = 0;
    const buf = Buffer.alloc(CHUNK + overlap);
    while (pos < size) {
      const { bytesRead: n } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      const last = pos + n >= size;
      // a match starting in the overlap at the end is found by the next chunk, which starts there
      const upTo = last ? n : n - overlap;
      const s = buf.toString('latin1', 0, n);
      const re = new RegExp(m.re.source, 'g');
      for (let hit = re.exec(s); hit && hit.index < upTo; hit = re.exec(s)) {
        count++;
        if (!o.dryRun) {
          const mask = inPlaceMask(hit[0].length);
          await fh.write(mask, 0, mask.length, pos + hit.index);
        }
      }
      if (last) break;
      pos += upTo;
      await new Promise((r) => setImmediate(r));
    }
    return { count, size, id };
  } finally {
    await fh.close();
  }
}

/** Every text file below `root`, with its size, never following a link. */
function textFiles(root: string, ids?: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  // w5702: the root itself may be a link (a locked Linux worker's `projects` links to `<root>/transcripts`); links below it are skipped.
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = p === root ? fs.statSync(p) : fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const n of names) walk(path.join(p, n));
    } else if (st.isFile() && TEXT.test(p)) {
      out.set(p, st.size);
      ids?.set(p, fileId(st));
    }
  };
  walk(root);
  return out;
}

/**
 * The same, by the thread pool (w6479): the 2-minute sweep's walk (beast's 2,000 transcript files, lstat and readdir) ran
 * on the daemon's loop. One folder's entries at a time, so the loop only takes each answer.
 */
async function textFilesAsync(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (p: string): Promise<void> => {
    let st: fs.Stats;
    try {
      st = p === root ? await fs.promises.stat(p) : await fs.promises.lstat(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(p);
      } catch {
        return;
      }
      for (const n of names) await walk(path.join(p, n));
    } else if (st.isFile() && TEXT.test(p)) out.set(p, st.size);
  };
  await walk(root);
  return out;
}

/** One pass's findings: paths and counts only. */
export interface CliScrubReport {
  kind: 'secret-scrub';
  at: string;
  root: string;
  /** "watch" (new writes), "back-scan" (a value learnt just now, looked for in every file), "sweep" (the periodic check). */
  trigger: 'watch' | 'back-scan' | 'sweep';
  scanned: number;
  files: { file: string; count: number }[];
  total: number;
  errors: { file: string; error: string }[];
}

export interface CliScrubOptions {
  /** The projects folder (server/cliTranscript.ts cliProjectsDir). */
  root: string;
  /** A line for the log: paths and counts. */
  log: (line: string) => void;
  /** Each pass that masked something or failed (the daemon sends it to the portal's clean-up log). */
  report?: (r: CliScrubReport) => void;
  /** How long after a write it scans (the CLI writes a line in several appends). Default 500 ms. */
  debounceMs?: number;
  /** How often it checks every file's size for writes the watcher missed, and for newly learnt values. Default 2 min (a walk of beast's 2,000 transcript files takes about 170 ms, measured). */
  sweepMs?: number;
  /**
   * More folders the CLI writes into, swept but not watched: each agent's temp folder's `claude` folder (its background
   * tasks' output files).
   */
  extraRoots?: () => string[];
}

/**
 * Keeps a Claude Code projects folder free of known secret values (server/secrets.ts), in place. start() watches it; each
 * write is scanned from where the last scan ended; a value learnt that was not known is looked for in every file once
 * (except values minted just now, which no older file can hold).
 */
export class CliScrubber {
  /** Bytes of each file already scanned with the values of `version`. */
  private read = new Map<string, number>();
  /** w6479: each scanned file's identity (scrubInPlace's id), so a file made again under its name is scanned whole. */
  private ids = new Map<string, string>();
  private version = secretValuesVersion();
  private dirty = new Set<string>();
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sweeper: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private o: CliScrubOptions;
  constructor(o: CliScrubOptions) {
    this.o = o;
  }

  /**
   * Watch and sweep from now on. The first full pass reads every file with the values known now, so what was written before
   * this process is found too; with `backScanAfter` (w5888, the portal's start) that pass waits for it, and meanwhile what
   * is written from now on is scanned as it comes, from each file's size at start.
   */
  start(o: { backScanAfter?: Promise<unknown> } = {}): this {
    // Claude Code makes it at its first session; made here so the watch holds from the start
    try {
      fs.mkdirSync(this.o.root, { recursive: true });
    } catch {
      // no right to: the sweep looks for it
    }
    const backScan = () => {
      this.version = -1;
      void this.sweep();
    };
    if (o.backScanAfter) {
      // w5888: after a portal restart the full pass (every Claude Code transcript, 52 s of the main thread measured on
      // 2026-11-26) ran beside the resumed coordinators' first turns; the bytes already there were scanned by the process
      // before, so they wait for the resumes, the new bytes do not
      this.version = secretValuesVersion();
      // w6479: with each file's identity, so one made again under its name before its first scan is scanned whole
      for (const [f, size] of this.files(this.ids)) this.read.set(f, size);
      void o.backScanAfter.then(backScan, backScan);
    }
    this.watch();
    this.sweeper = setInterval(() => void this.sweep(), this.o.sweepMs ?? 120_000);
    this.sweeper.unref();
    if (!o.backScanAfter) backScan();
    return this;
  }

  stop() {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** Every text file below the projects folder and the extra folders, with its size. */
  private files(ids?: Map<string, string>): Map<string, number> {
    const out = textFiles(this.o.root, ids);
    for (const r of this.o.extraRoots?.() ?? []) for (const [f, size] of textFiles(r, ids)) out.set(f, size);
    return out;
  }

  private watch() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.o.root, { recursive: true, persistent: false }, (_e, name) => {
        if (!name) return;
        const f = path.join(this.o.root, String(name));
        if (!TEXT.test(f)) return;
        this.dirty.add(f);
        if (!this.timer) {
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.pass('watch');
          }, this.o.debounceMs ?? 500);
          this.timer.unref();
        }
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // no folder yet (no agent ran here), or no recursive watch: the sweep finds the writes, and watches once it can
      this.watcher = undefined;
    }
  }

  /** The same by the thread pool (w6479), for the sweep and the back-scan, which run while the daemon serves. */
  private async filesAsync(): Promise<Map<string, number>> {
    const out = await textFilesAsync(this.o.root);
    for (const r of this.o.extraRoots?.() ?? []) for (const [f, size] of await textFilesAsync(r)) out.set(f, size);
    return out;
  }

  /**
   * The periodic check: watch again if the watcher was lost, scan what grew or what a new value must be looked for in, and
   * forget the files that are gone. w6479: the forgetting ran at the end of every pass, an existsSync of every file ever
   * read (7 of the 11 stalls of 5-12.9 s on LothDesktop's daemon, 2026-11-27 18:06-18:59 UTC); a deletion the watcher sees
   * is forgotten by its own pass (ENOENT), so only the files the walk no longer lists are looked at here, by the pool.
   */
  async sweep(): Promise<void> {
    this.watch();
    const now = await this.filesAsync();
    for (const [f, size] of now) if ((this.read.get(f) ?? -1) !== size) this.dirty.add(f);
    for (const f of [...this.read.keys()]) {
      if (now.has(f)) continue;
      try {
        await fs.promises.access(f);
      } catch {
        this.read.delete(f);
        this.ids.delete(f);
      }
    }
    await this.pass('sweep');
  }

  /** Scan what changed (and, after a new value, every file for it); one pass at a time. */
  async pass(trigger: 'watch' | 'sweep'): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.once(trigger);
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async once(trigger: 'watch' | 'sweep') {
    const all = secretBytesMatcher();
    const now = secretValuesVersion();
    let back: { re: RegExp; maxLen: number } | undefined;
    let backAll = false;
    if (now !== this.version) {
      const since = this.version < 0 ? undefined : secretValuesSince(this.version);
      if (!since) backAll = true;
      else if (!since.recent && since.values.length) back = secretBytesMatcher(since.values);
      this.version = now;
    }
    if (!all) {
      this.dirty.clear();
      return;
    }
    const report: CliScrubReport = { kind: 'secret-scrub', at: new Date().toISOString(), root: this.o.root, trigger: back || backAll ? 'back-scan' : trigger, scanned: 0, files: [], total: 0, errors: [] };
    const files = back || backAll ? await this.filesAsync() : new Map([...this.dirty].map((f) => [f, 0]));
    this.dirty.clear();
    for (const f of files.keys()) {
      try {
        const prev = backAll ? 0 : (this.read.get(f) ?? 0);
        let count = 0;
        // values learnt now: every byte already read, for them only; then the new bytes for every value
        if (back && prev > 0) count += (await scrubInPlace(f, back, 0)).count;
        let r = await scrubInPlace(f, all, prev);
        // w6479: shorter than what was read, or not the file read (made again under its name, which is forgotten only at the
        // next sweep now, or never seen gone in an unwatched folder): all of it
        const was = this.ids.get(f);
        if (prev > 0 && (r.size < prev || (was !== undefined && r.id !== was))) r = await scrubInPlace(f, all, 0);
        count += r.count;
        this.read.set(f, r.size);
        this.ids.set(f, r.id);
        report.scanned++;
        if (count) {
          report.files.push({ file: f, count });
          report.total += count;
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          this.read.delete(f);
          this.ids.delete(f);
        }
        else report.errors.push({ file: f, error: code ?? (e as Error).name });
      }
    }
    if (report.total || report.errors.length) {
      for (const x of report.files) this.o.log(`secrets: ${x.file}: masked ${x.count} secret value(s) in place (${report.trigger})`);
      for (const x of report.errors) this.o.log(`secrets: ${x.file}: not scrubbed (${x.error})`);
      this.o.report?.(report);
    }
  }
}
