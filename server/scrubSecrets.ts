import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { knownSecretValues, redactInPlace, redactSecrets, redactValue } from './secrets.ts';

/**
 * Redact secrets already on disk (w1584): what was written before a store redacted, or before a token shape was known.
 * A worker's failing test printed its vault GitHub token (w1519) into its transcript; this walks the portal's data folder
 * (transcripts, state.json, work.json and their saved generations, logs) and a Claude Code projects folder (the CLI's own
 * transcripts and tool-result files) and masks every token shape and every value the vault holds, the way the stores
 * mask them as they write (server/secrets.ts redactSecrets: `github_pat_[redacted …yVC9]`). It reports paths and counts,
 * never a value. The portal runs it over its data folder at each start; `fffctl scrub-secrets` (server/scrubSecretsCli.ts)
 * runs it by hand, with a dry run.
 */

/** Files that hold secrets on purpose, or a person's own bytes, never rewritten: the vault, keys, logins, uploads. */
const SKIP_NAMES = /^(?:vault\.json|machine-tokens\.json|vapid\.json|push-subscriptions\.json|config\.json|users\.json|api-keys\.json|member-keys\.json|credentials\.json|\.credentials\.json)(?:\..*)?$|\.(?:key|pem)$/i;
/** Folders not walked: the attachment and upload stores (a file's name is its SHA-256), secrets, git, node_modules. */
const SKIP_DIRS = new Set(['attachments', 'uploads', 'secrets', '.git', 'node_modules']);
/** What is text a store wrote: JSON lines, JSON, logs, text, Markdown; also a saved generation (`state.json.1`) or gzip of one. */
const TEXT_FILE = /\.(?:jsonl|json|log|txt|md)(?:\.\d+)?(?:\.gz)?$/i;
/** Larger files are left alone and named (read whole into memory). */
export const MAX_BYTES = 1024 * 1024 * 1024;

const markers = (s: string) => s.split('[redacted').length - 1;

/** `text` with its secrets masked, by the file's kind: JSON lines and JSON string by string (an escape such as `\n` before a token cannot hide it), anything else as text. How many were masked. */
export function redactFileText(name: string, text: string): { text: string; n: number } {
  const base = name.replace(/\.gz$/i, '').replace(/\.\d+$/, '').toLowerCase();
  let out: string;
  if (base.endsWith('.jsonl')) {
    out = text
      .split('\n')
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const v = JSON.parse(line) as unknown;
          const clean = redactValue(v);
          return clean === v ? line : JSON.stringify(clean);
        } catch {
          return redactSecrets(line);
        }
      })
      .join('\n');
  } else if (base.endsWith('.json')) {
    try {
      const v = JSON.parse(text) as unknown;
      if (redactInPlace(v) === 0) out = text;
      else {
        const indent = /^[[{]\r?\n( +)/.exec(text)?.[1].length ?? 0;
        out = JSON.stringify(v, null, indent || undefined) + (text.endsWith('\n') ? '\n' : '');
      }
    } catch {
      out = redactSecrets(text);
    }
  } else out = redactSecrets(text);
  return { text: out, n: out === text ? 0 : Math.max(1, markers(out) - markers(text)) };
}

/** Where a masked copy of `file` is written before it replaces it (scrubFiles skips such a file). */
export const scrubTmp = (file: string) => `${file}.scrub-${process.pid}.tmp`;

/** Write `data` over `file` by a rename, keeping its mode and (as root) its owner, so the portal can still read it. */
function replaceFile(file: string, data: string | Buffer) {
  const st = fs.statSync(file);
  const tmp = scrubTmp(file);
  fs.writeFileSync(tmp, data, { mode: st.mode & 0o777 });
  try {
    if (process.getuid?.() === 0) fs.chownSync(tmp, st.uid, st.gid);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Mask one file's secrets (none written on a dry run). How many it held. */
export function scrubFile(file: string, o: { dryRun?: boolean } = {}): number {
  const gz = /\.gz$/i.test(file);
  const raw = fs.readFileSync(file);
  const text = (gz ? zlib.gunzipSync(raw) : raw).toString('utf8');
  const { text: clean, n } = redactFileText(path.basename(file), text);
  if (n && !o.dryRun) replaceFile(file, gz ? zlib.gzipSync(clean) : clean);
  return n;
}

export interface ScrubReport {
  /** Files read. */
  scanned: number;
  /** Each file that held secrets, and how many: paths and counts, never a value. */
  files: { file: string; count: number }[];
  /** Secrets masked (on a dry run: found). */
  total: number;
  /** Files that could not be read or written, with why (no value). */
  errors: { file: string; error: string }[];
  /** Files over the size limit, not read. */
  skipped: string[];
  /** The start-up scrub (w5613): its longest piece of work on the portal's own thread, in ms (starting the thread, a swap). */
  longestTurnMs?: number;
  /**
   * The same pieces' CPU time on the portal's thread, in ms: the work the scrub itself puts there. Unlike the wall time it
   * leaves out the scheduler's preemption on a loaded machine (a CI runner's 285 ms wall for a piece, w5559).
   */
  longestTurnCpuMs?: number;
}

export const emptyReport = (): ScrubReport => ({ scanned: 0, files: [], total: 0, errors: [], skipped: [] });

/** Every text file below `roots` (files or folders) that a store writes, minus the ones that hold secrets on purpose. */
export function scrubFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) return;
      let names: string[] = [];
      try {
        names = fs.readdirSync(p).sort();
      } catch {
        return;
      }
      for (const n of names) walk(path.join(p, n));
    } else if (st.isFile() && TEXT_FILE.test(p) && !SKIP_NAMES.test(path.basename(p)) && !/\.scrub-\d+\.tmp$/.test(p)) out.push(p);
  };
  for (const r of roots) walk(r);
  return out;
}

/** Scrub every file below `roots`. A dry run only counts. */
export function scrubTree(roots: readonly string[], o: { dryRun?: boolean } = {}): ScrubReport {
  const report = emptyReport();
  for (const file of scrubFiles(roots)) {
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        report.skipped.push(file);
        continue;
      }
      report.scanned++;
      const count = scrubFile(file, o);
      if (count) {
        report.files.push({ file, count });
        report.total += count;
      }
    } catch (e) {
      // the message names the file and the system call, never its content
      report.errors.push({ file, error: (e as NodeJS.ErrnoException).code ?? (e as Error).name });
    }
  }
  return report;
}

/** The report as lines: each file with its count, then the totals. */
export function reportLines(r: ScrubReport, o: { dryRun?: boolean; remaining?: number } = {}): string[] {
  const verb = o.dryRun ? 'would redact' : 'redacted';
  return [
    ...r.files.map((f) => `${f.file}: ${verb} ${f.count}`),
    ...r.skipped.map((f) => `${f}: skipped (over 1 GB)`),
    ...r.errors.map((e) => `${e.file}: not scrubbed (${e.error})`),
    `scanned ${r.scanned} file(s); ${r.files.length} held secrets; ${verb} ${r.total}`,
    ...(o.remaining !== undefined ? [`remaining: ${o.remaining}`] : []),
  ];
}

/**
 * Raise when the masking learns something new (a token shape): each portal then scrubs its data folder again at its next
 * start. 2 (w1688): every value in its URL-encoded, base64 and JSON-escaped forms too. 3 (w5526): JWTs, AWS access keys,
 * Slack tokens, Bearer credentials and passwords in URLs (shared/secretShapes.ts).
 */
export const SCRUB_VERSION = 3;
/** `<dataDir>/secret-scrub.json`: the scrub version this data folder was last scrubbed at, when, and how many were masked. */
export const SCRUB_MARKER = 'secret-scrub.json';

/** A masked copy the scrub's thread wrote (`tmp`) of `file` as it read it: its inode, the bytes read, its mtime then. */
export interface ScrubCommit {
  file: string;
  tmp: string;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Secrets masked in what was read. */
  n: number;
  gz: boolean;
}
/** The portal's answer: swapped in with this many masked, gone (deleted meanwhile), changed (read it again) or an error code. */
export type ScrubReply = { ok: number } | { gone: true } | { changed: true } | { error: string };

/**
 * Swap a masked copy in, on the portal's own thread and within one turn (w5613), so no write of the portal's lands between
 * the check and the rename. A file only appended to since the read (same inode, longer) keeps what was appended, masked here
 * (a few lines); a file replaced, cut or rewritten since is read again by the thread (`changed`). The copy is removed on
 * anything but `ok`.
 */
export function commitScrubbed(c: ScrubCommit): ScrubReply {
  const drop = () => fs.rmSync(c.tmp, { force: true });
  let st: fs.Stats;
  try {
    st = fs.statSync(c.file);
  } catch {
    drop();
    return { gone: true };
  }
  try {
    let n = c.n;
    if (st.ino !== c.ino || st.size < c.size || (st.size === c.size && st.mtimeMs !== c.mtimeMs) || (st.size > c.size && c.gz)) {
      drop();
      return { changed: true };
    }
    if (st.size > c.size) {
      const tail = Buffer.alloc(st.size - c.size);
      const fd = fs.openSync(c.file, 'r');
      try {
        fs.readSync(fd, tail, 0, tail.length, c.size);
      } finally {
        fs.closeSync(fd);
      }
      const clean = redactFileText(path.basename(c.file), tail.toString('utf8'));
      fs.appendFileSync(c.tmp, clean.text);
      n += clean.n;
    }
    fs.renameSync(c.tmp, c.file);
    return { ok: n };
  } catch (e) {
    drop();
    return { error: (e as NodeJS.ErrnoException).code ?? (e as Error).name };
  }
}

/**
 * The walk, the reads and the masking on a thread of their own (server/scrubThread.ts), each masked copy swapped in on this
 * thread by commitScrubbed. Rejects when the thread could not run.
 */
function scrubOnThread(dataDir: string): Promise<ScrubReport> {
  return new Promise((resolve, reject) => {
    let longest = 0;
    let longestCpu = 0;
    const timed = <T>(fn: () => T): T => {
      const t0 = performance.now();
      const c0 = process.threadCpuUsage();
      try {
        return fn();
      } finally {
        longest = Math.max(longest, performance.now() - t0);
        const c = process.threadCpuUsage(c0);
        longestCpu = Math.max(longestCpu, (c.user + c.system) / 1000);
      }
    };
    const w = timed(() => new Worker(new URL('./scrubThread.ts', import.meta.url), { workerData: { dataDir, values: [...knownSecretValues()] } }));
    let done = false;
    w.on('message', (m: { commit?: ScrubCommit; done?: ScrubReport }) => {
      if (m.commit) {
        const c = m.commit;
        w.postMessage(timed(() => commitScrubbed(c)));
      } else if (m.done) {
        done = true;
        resolve({ ...m.done, longestTurnMs: Math.round(longest), longestTurnCpuMs: Math.round(longestCpu) });
        void w.terminate();
      }
    });
    w.on('error', (e) => reject(e));
    w.on('exit', (code) => {
      if (!done) reject(new Error(`the scrub thread stopped (exit ${code})`));
    });
  });
}

/**
 * The portal's own pass at start: once per SCRUB_VERSION, every file below its data folder. The reading and masking run on
 * a thread of their own so the portal keeps answering (w5613: on this thread, one big transcript held the event loop 10 s);
 * each masked file is swapped in on this thread in one turn, so nothing the portal appends meanwhile is lost. Logs paths and
 * counts. Resolves to the report, or undefined when the folder is scrubbed already or the thread could not run (logged; the
 * next start tries again).
 */
export async function scrubAtStart(dataDir: string, log: (line: string) => void, o: { force?: boolean } = {}): Promise<ScrubReport | undefined> {
  const marker = path.join(dataDir, SCRUB_MARKER);
  try {
    if (!o.force && (JSON.parse(fs.readFileSync(marker, 'utf8')) as { version?: number }).version! >= SCRUB_VERSION) return undefined;
  } catch {
    // never scrubbed
  }
  let report: ScrubReport;
  const started = performance.now();
  try {
    report = await scrubOnThread(dataDir);
  } catch (e) {
    log(`could not scrub the data folder (${(e as NodeJS.ErrnoException).code ?? (e as Error).name}): the next start scrubs again`);
    return undefined;
  }
  for (const line of reportLines(report)) if (report.total || report.errors.length || line.startsWith('scanned')) log(line);
  log(`scrubbed on its own thread in ${((performance.now() - started) / 1000).toFixed(1)} s; the longest piece on the portal's thread took ${report.longestTurnMs} ms`);
  try {
    fs.writeFileSync(marker, JSON.stringify({ version: SCRUB_VERSION, at: new Date().toISOString(), redacted: report.total }) + '\n', { mode: 0o600 });
  } catch (e) {
    log(`could not record the scrub (${(e as NodeJS.ErrnoException).code ?? 'error'}): the next start scrubs again`);
  }
  return report;
}
