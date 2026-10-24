import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { SearchHit, SessionInfo, TranscriptEvent } from '../shared/types.ts';
import { redactSecrets } from './secrets.ts';

const gunzip = promisify(zlib.gunzip);

export interface SearchQuery {
  /** Words; every one must appear (case-insensitive). "quoted phrases" count as one word. */
  q: string;
  /** Only these sessions (from the sandbox / machine / agent filters). */
  sessionIds?: Set<string>;
  /** ISO dates or datetimes; `until` is inclusive of its whole day when it is a bare date. */
  since?: string;
  until?: string;
  limit?: number;
  /** How long one stretch of scanning may hold the event loop before it gives it back (default SEARCH_SLICE_MS; tests pass 0). */
  sliceMs?: number;
}

/**
 * A search gives the event loop back after this much scanning (w2044): one search_transcripts call over every transcript
 * held the portal 16 to 18 s at a time (stall profiles 2026-10-24 15:52 and 15:58Z), and daemons drop at 45 s.
 */
export const SEARCH_SLICE_MS = 20;

/** Split a query into lower-case terms, keeping "quoted phrases" whole. Exported for tests. */
export function terms(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

/** The text of an event that search looks at. */
export function searchableText(e: TranscriptEvent): string {
  switch (e.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'error':
    case 'result':
      return e.text;
    case 'tool_use':
      return `${e.name} ${JSON.stringify(e.input)}`;
    case 'tool_result':
      return e.text;
    case 'permission':
      return `${e.toolName} ${JSON.stringify(e.input)}`;
  }
}

/** ~160 characters around the first term, on one line. */
export function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const at = Math.max(0, lower.indexOf(words[0] ?? ''));
  const start = Math.max(0, at - 70);
  const end = Math.min(flat.length, at + (words[0]?.length ?? 0) + 90);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Full-text search over every transcript (data/transcripts/*.jsonl), newest first. A plain scan: each
 * line is tested as raw text before it is parsed, so the cost is roughly reading the files once. The reads and
 * unzips are asynchronous and the scan gives the loop back every `sliceMs` (w2044); `slices` counts its stretches.
 */
export async function searchTranscripts(dir: string, sessions: Map<string, SessionInfo>, query: SearchQuery): Promise<{ hits: SearchHit[]; scanned: number; ms: number; slices: number }> {
  const started = Date.now();
  const words = terms(query.q);
  if (!words.length) return { hits: [], scanned: 0, ms: 0, slices: 0 };
  const sliceMs = query.sliceMs ?? SEARCH_SLICE_MS;
  let slices = 1;
  let sliceFrom = Date.now();
  const yieldIfDue = async () => {
    if (Date.now() - sliceFrom < sliceMs) return;
    await new Promise<void>((r) => setImmediate(r));
    slices++;
    sliceFrom = Date.now();
  };
  const since = query.since ? Date.parse(query.since) : -Infinity;
  const untilRaw = query.until ? Date.parse(query.until) : Infinity;
  const until = query.until && /^\d{4}-\d{2}-\d{2}$/.test(query.until) ? untilRaw + 86_400_000 - 1 : untilRaw;
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  // The raw-line prefilter tests single words: a phrase's words may sit around an escaped newline.
  const parts = [...new Set(words.flatMap((w) => w.split(' ')))].filter((w) => w && !/["\\]/.test(w));
  const hits: SearchHit[] = [];
  let scanned = 0;
  let files: string[] = [];
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'));
  } catch {
    return { hits, scanned, ms: 0, slices };
  }
  const names = new Set(files);
  for (const f of files) {
    const sessionId = f.replace(/\.jsonl(\.gz)?$/, '');
    // Both files at once (a session resumed since the guard compressed it): the plain one is newer and holds the compressed one's events too.
    if (f.endsWith('.gz') && names.has(`${sessionId}.jsonl`)) continue;
    if (query.sessionIds && !query.sessionIds.has(sessionId)) continue;
    const file = path.join(dir, f);
    // A transcript last written before `since` has nothing newer.
    if (Number.isFinite(since)) {
      try {
        if ((await fs.promises.stat(file)).mtimeMs < since) continue;
      } catch {
        continue;
      }
    }
    let raw: string;
    try {
      raw = f.endsWith('.gz') ? (await gunzip(await fs.promises.readFile(file))).toString('utf8') : await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    scanned++;
    const s = sessions.get(sessionId);
    await yieldIfDue();
    let n = 0;
    for (const line of raw.split('\n')) {
      if (++n % 256 === 0) await yieldIfDue();
      if (!line) continue;
      const lower = line.toLowerCase();
      // JSON escapes quotes, backslashes and newlines, so words with those skip this prefilter;
      // the parsed text below is the real test.
      if (!parts.every((w) => lower.includes(w))) continue;
      let e: TranscriptEvent;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(e.t);
      if (t < since || t > until) continue;
      const text = searchableText(e) ?? '';
      const tl = text.replace(/\s+/g, ' ').toLowerCase();
      if (!words.every((w) => tl.includes(w))) continue;
      hits.push({
        sessionId,
        seq: e.seq,
        t: e.t,
        kind: e.kind,
        snippet: redactSecrets(snippet(text, words)),
        title: s?.title ?? sessionId,
        sessionKind: s?.kind,
        sandboxId: s?.sandboxId,
        machineId: s?.machineId,
        machineSandbox: s?.machineSandbox,
        standingId: s?.standingId,
      });
    }
  }
  hits.sort((a, b) => b.t.localeCompare(a.t));
  return { hits: hits.slice(0, limit), scanned, ms: Date.now() - started, slices };
}
