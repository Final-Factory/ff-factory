// The transcript thread (w5888): before a conversation resumes, its seal's check hashes the whole transcript (w5563) and the
// tool refresh scans it (w2626); on the event loop both waited behind the portal's own work. On 2026-11-26 09:06 UTC (deploy
// ed34a73) the loop ran 56-60 s of CPU a minute and the dispatcher's 1.49 GB transcript took 427.8 s to check and 245.6 s to
// scan before it could answer, 712 s after it was asked. This thread holds every running hash of the portal's own sessions
// (a sha256 state cannot cross threads, so the event loop keeps only a reference, server/transcriptThreadClient.ts) and does
// the reads, the hashing and the scan; the event loop only asks.
import crypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { feedHash } from './transcriptHash.ts';
import { scanFile, type ToolNow } from './keptToolsScan.ts';

export type TranscriptAsk =
  | { op: 'new' }
  | { op: 'copy'; ref: number }
  | { op: 'hex'; ref: number }
  | { op: 'feed'; ref: number; file: string; from: number; to: number; next: number; every: number }
  | { op: 'scan'; file: string; now: Map<string, ToolNow>; window?: number };
export type TranscriptRequest = (TranscriptAsk & { id: number }) | { op: 'free'; refs: number[] };

/** Bytes per read here, where a read holds nothing else up. */
const CHUNK = 8 << 20;

const hashes = new Map<number, crypto.Hash>();
let nextRef = 1;
const put = (h: crypto.Hash) => {
  const ref = nextRef++;
  hashes.set(ref, h);
  return ref;
};
const get = (ref: number) => {
  const h = hashes.get(ref);
  if (!h) throw new Error(`the transcript thread holds no running hash ${ref}`);
  return h;
};

async function answer(m: TranscriptAsk): Promise<unknown> {
  switch (m.op) {
    case 'new':
      return { ref: put(crypto.createHash('sha256')) };
    case 'copy':
      return { ref: put(get(m.ref).copy()) };
    case 'hex':
      return get(m.ref).copy().digest('hex');
    case 'feed': {
      const marks: { at: number; ref: number }[] = [];
      const done = await feedHash(get(m.ref), m.file, m.from, m.to, m.next ?? Infinity, m.every, (at, copy) => marks.push({ at, ref: put(copy) }), CHUNK);
      return { ok: done, marks };
    }
    case 'scan': {
      const s = scanFile(m.file, m.now, m.window);
      return { writes: s.writes, dropped: [...s.dropped] };
    }
  }
}

parentPort!.on('message', (m: TranscriptRequest) => {
  if (m.op === 'free') {
    for (const ref of m.refs) hashes.delete(ref);
    return;
  }
  answer(m).then(
    (ok) => parentPort!.postMessage({ id: m.id, ok }),
    (e: Error) => parentPort!.postMessage({ id: m.id, error: e?.message ?? String(e) }),
  );
});
