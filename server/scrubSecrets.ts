import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { redactInPlace, redactSecrets, redactValue } from './secrets.ts';

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
const MAX_BYTES = 1024 * 1024 * 1024;

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

/** Write `data` over `file` by a rename, keeping its mode and (as root) its owner, so the portal can still read it. */
function replaceFile(file: string, data: string | Buffer) {
  const st = fs.statSync(file);
  const tmp = `${file}.scrub-${process.pid}.tmp`;
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
}

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
  const report: ScrubReport = { scanned: 0, files: [], total: 0, errors: [], skipped: [] };
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

/** Raise when the masking learns something new (a token shape): each portal then scrubs its data folder again at its next start. */
export const SCRUB_VERSION = 1;
/** `<dataDir>/secret-scrub.json`: the scrub version this data folder was last scrubbed at, when, and how many were masked. */
export const SCRUB_MARKER = 'secret-scrub.json';

/**
 * The portal's own pass at start: once per SCRUB_VERSION, every file below its data folder, one file per turn of the event
 * loop so the portal keeps answering. Each file is read and replaced within one turn, so nothing the portal appends in
 * between is lost. Logs paths and counts. Resolves to the report, or undefined when the folder is scrubbed already.
 */
export async function scrubAtStart(dataDir: string, log: (line: string) => void, o: { force?: boolean } = {}): Promise<ScrubReport | undefined> {
  const marker = path.join(dataDir, SCRUB_MARKER);
  try {
    if (!o.force && (JSON.parse(fs.readFileSync(marker, 'utf8')) as { version?: number }).version! >= SCRUB_VERSION) return undefined;
  } catch {
    // never scrubbed
  }
  const report: ScrubReport = { scanned: 0, files: [], total: 0, errors: [], skipped: [] };
  for (const file of scrubFiles([dataDir])) {
    await new Promise((r) => setImmediate(r));
    const one = scrubTree([file]);
    report.scanned += one.scanned;
    report.files.push(...one.files);
    report.total += one.total;
    report.errors.push(...one.errors);
    report.skipped.push(...one.skipped);
  }
  for (const line of reportLines(report)) if (report.total || report.errors.length || line.startsWith('scanned')) log(line);
  try {
    fs.writeFileSync(marker, JSON.stringify({ version: SCRUB_VERSION, at: new Date().toISOString(), redacted: report.total }) + '\n', { mode: 0o600 });
  } catch (e) {
    log(`could not record the scrub (${(e as NodeJS.ErrnoException).code ?? 'error'}): the next start scrubs again`);
  }
  return report;
}
