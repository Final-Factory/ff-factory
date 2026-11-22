// The transcript search index's thread (w5111, server/searchIndex.ts): it builds the index, keeps it up to date and
// answers searches, so neither the build nor a search holds the portal's event loop.
import { parentPort } from 'node:worker_threads';
import { TranscriptIndex, type IndexQuery } from './searchIndex.ts';

/** Between searches the index catches up with the folder this often, so a search finds little new to index. */
const REFRESH_MS = 2 * 60_000;

export type SearchWorkerAsk = { dir: string; warm: true } | { dir: string; query: IndexQuery };
export type SearchWorkerRequest = SearchWorkerAsk & { id: number };

const indexes = new Map<string, TranscriptIndex>();
const indexOf = (dir: string) => {
  let x = indexes.get(dir);
  if (!x) indexes.set(dir, (x = new TranscriptIndex(dir)));
  return x;
};

let timer: NodeJS.Timeout | undefined;
const keepFresh = () => {
  if (timer) return;
  timer = setInterval(() => {
    for (const x of indexes.values()) {
      try {
        x.refresh();
      } catch {
        // the next search refreshes again and reports
      }
    }
  }, REFRESH_MS);
  timer.unref();
};

parentPort!.on('message', (m: SearchWorkerRequest) => {
  try {
    const x = indexOf(m.dir);
    if ('warm' in m) {
      const t0 = performance.now();
      x.refresh();
      keepFresh();
      parentPort!.postMessage({ id: m.id, ok: { ms: performance.now() - t0, stats: x.stats() } });
    } else {
      parentPort!.postMessage({ id: m.id, ok: x.search(m.query) });
    }
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
