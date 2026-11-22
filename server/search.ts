import { Worker } from 'node:worker_threads';
import type { SearchHit, SessionInfo } from '../shared/types.ts';
import { redactSecrets } from './secrets.ts';
import { terms } from './searchText.ts';
import type { IndexSearchResult, IndexStats } from './searchIndex.ts';
import type { SearchWorkerAsk } from './searchWorker.ts';

export { searchableText, snippet, terms } from './searchText.ts';

export interface SearchQuery {
  /** Words; every one must appear (case-insensitive). "quoted phrases" count as one word. */
  q: string;
  /** Only these sessions (from the sandbox / machine / agent filters). */
  sessionIds?: Set<string>;
  /** ISO dates or datetimes; `until` is inclusive of its whole day when it is a bare date. */
  since?: string;
  until?: string;
  limit?: number;
}

/**
 * The index's worker thread (server/searchWorker.ts, server/searchIndex.ts, w5111), one per process. It holds the
 * process open only while a request to it is pending.
 */
let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ask<T>(req: SearchWorkerAsk): Promise<T> {
  if (!worker) {
    const w = new Worker(new URL('./searchWorker.ts', import.meta.url));
    w.unref();
    w.on('message', (m: { id: number; ok?: unknown; error?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (!pending.size) w.unref();
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.ok);
    });
    const fail = (e: Error) => {
      if (worker === w) worker = undefined;
      for (const p of pending.values()) p.reject(e);
      pending.clear();
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(new Error(`the transcript search thread stopped (exit ${code})`)));
    worker = w;
  }
  const id = nextId++;
  const w = worker;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.ref();
    w.postMessage({ ...req, id });
  });
}

const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

/** Build the index when the portal starts, off the event loop, so the first search does not wait for it. */
export async function warmSearchIndex(dir: string): Promise<{ ms: number; stats: IndexStats }> {
  const r = await ask<{ ms: number; stats: IndexStats }>({ dir, warm: true });
  console.log(`transcript search: index built in ${(r.ms / 1000).toFixed(1)} s over ${r.stats.files} transcript(s), ${mb(r.stats.bytes)} of text; ${r.stats.chunks} chunk(s), ${mb(r.stats.indexBytes)} in memory`);
  return r;
}

/**
 * Full-text search over every transcript (data/transcripts/*.jsonl and .jsonl.gz), newest first. The index's thread reads
 * only the chunks that can hold a match, newest first, and stops at `limit` (server/searchIndex.ts); each line it reads is
 * tested as the plain scan before it tested it (searchText.ts matchLine). Snippets are masked here, where the vault's
 * values are known.
 */
export async function searchTranscripts(dir: string, sessions: Map<string, SessionInfo>, query: SearchQuery): Promise<{ hits: SearchHit[]; scanned: number; ms: number }> {
  const started = Date.now();
  const words = terms(query.q);
  if (!words.length) return { hits: [], scanned: 0, ms: 0 };
  const since = query.since ? Date.parse(query.since) : -Infinity;
  const untilRaw = query.until ? Date.parse(query.until) : Infinity;
  const until = query.until && /^\d{4}-\d{2}-\d{2}$/.test(query.until) ? untilRaw + 86_400_000 - 1 : untilRaw;
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const r = await ask<IndexSearchResult>({ dir, query: { words, sessionIds: query.sessionIds && [...query.sessionIds], since, until, limit } });
  const hits: SearchHit[] = r.hits.map((h) => {
    const s = sessions.get(h.sessionId);
    return {
      ...h,
      snippet: redactSecrets(h.snippet),
      title: s?.title ?? h.sessionId,
      sessionKind: s?.kind,
      sandboxId: s?.sandboxId,
      machineId: s?.machineId,
      machineSandbox: s?.machineSandbox,
      standingId: s?.standingId,
    };
  });
  const ms = Date.now() - started;
  console.log(`transcript search: ${ms} ms (index refresh ${r.refreshMs.toFixed(0)} ms, search ${r.searchMs.toFixed(0)} ms); ${hits.length} hit(s); read ${r.chunksRead} of ${r.stats.chunks} chunk(s), ${mb(r.bytesRead)} of ${mb(r.stats.bytes)}; ${r.scanned} of ${r.stats.files} transcript(s) in the window`);
  return { hits, scanned: r.scanned, ms };
}
