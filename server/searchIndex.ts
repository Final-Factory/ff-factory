// The transcript search index (w5111). search_transcripts read and tested every line of every transcript on each call:
// 4,058 transcripts took about 61 s on the live portal (2026-11-22, a query that matched nothing), and its 20 ms slices
// held the event loop for seconds a minute (stall profiles). The index keeps no text: it cuts each transcript into
// chunks of about CHUNK_BYTES at line ends, and keeps for each chunk its byte range, the times of its first and last
// events, and a signature of the three-character runs (trigrams) its lower-cased text holds. A search reads only the
// chunks in its time window whose signature holds every trigram of its words, newest chunk first, and stops once the
// newest `limit` matches are found. Each line it reads is tested exactly as before (searchText.ts matchLine), so a
// signature can only let a chunk through that holds no match (a false positive), never drop one that does.
//
// It runs in a worker thread (server/searchWorker.ts) and is rebuilt there when the portal starts; files are only ever
// appended to, rewritten whole by a rename (Store.amend) or compressed (server/dataGuard.ts), and each is caught by its
// size, inode, modification time and the bytes before where the index stopped.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { TranscriptEvent } from '../shared/types.ts';
import { matchLine, prefilterParts, searchableText, snippet } from './searchText.ts';

/** A chunk's size: one line longer than that is a chunk of its own. */
export const CHUNK_BYTES = 1 << 20;
/** A signature is built in this many bits, then folded to about twice the trigrams it holds (at most a third of its bits set). */
const SCRATCH_BITS = 1 << 20;
const MIN_BITS = 1 << 10;
/** The bytes before the indexed end that must still be there for the index of a grown file to be kept. */
const TAIL = 64;
/** Decompressed transcripts kept while one search runs. */
const GZ_CACHE_BYTES = 256 << 20;
/** The early stop leaves a second for times written in other forms ("…:00Z" against "…:00.123Z"). */
const STOP_MARGIN_MS = 1000;

interface Chunk {
  start: number;
  end: number;
  /** Event times in ms; an event whose time does not parse makes them -Infinity and Infinity (it passes every window). */
  minT: number;
  maxT: number;
  bits: Uint32Array;
}

interface FileEntry {
  id: string;
  name: string;
  gz: boolean;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes of the (decompressed) content indexed: always at a line end. */
  indexed: number;
  tail: Buffer;
  chunks: Chunk[];
}

export interface IndexQuery {
  words: string[];
  sessionIds?: string[];
  since: number;
  until: number;
  limit: number;
}

/** A match before it is masked and named on the main thread. */
export interface RawHit {
  sessionId: string;
  seq: number;
  t: string;
  kind: TranscriptEvent['kind'];
  snippet: string;
}

export interface IndexStats {
  files: number;
  chunks: number;
  /** Text bytes indexed (decompressed). */
  bytes: number;
  /** Bytes the signatures and ranges take in memory. */
  indexBytes: number;
}

export interface IndexSearchResult {
  hits: RawHit[];
  /** Transcripts with a chunk in the time window and the session filter. */
  scanned: number;
  chunksRead: number;
  bytesRead: number;
  refreshMs: number;
  searchMs: number;
  stats: IndexStats;
}

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

/** The trigram hashes of each prefilter part of three or more characters. Exported for tests. */
export function probesOf(words: string[]): number[] {
  const out = new Set<number>();
  for (const p of prefilterParts(words)) for (let i = 0; i + 2 < p.length; i++) out.add(hash3(p.charCodeAt(i), p.charCodeAt(i + 1), p.charCodeAt(i + 2)));
  return [...out];
}

const has = (bits: Uint32Array, h: number) => {
  const i = h & (bits.length * 32 - 1);
  return (bits[i >>> 5] & (1 << (i & 31))) !== 0;
};

/** An event line's time: the one top-level "t" when it appears once (a JSON string value can't hold it unescaped), else parsed. */
function lineTime(line: string): number | undefined {
  const i = line.indexOf('"t":"');
  if (i >= 0 && line.indexOf('"t":"', i + 5) < 0) {
    const j = line.indexOf('"', i + 5);
    if (j > 0) return Date.parse(line.slice(i + 5, j));
  }
  try {
    const e = JSON.parse(line) as { t?: unknown };
    return Date.parse(e.t as string);
  } catch {
    return undefined; // a torn line: search skips it too
  }
}

export class TranscriptIndex {
  private readonly files = new Map<string, FileEntry>();
  private readonly scratch = new Uint32Array(SCRATCH_BITS / 32);

  readonly dir: string;
  /** The size a chunk is cut at; smaller in tests, so a small made-up corpus has many chunks. */
  readonly chunkBytes: number;
  constructor(dir: string, chunkBytes = CHUNK_BYTES) {
    this.dir = dir;
    this.chunkBytes = chunkBytes;
  }

  /** Bring the index up to date with the folder: new and grown transcripts are indexed, gone ones dropped. */
  refresh(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'));
    } catch {
      this.files.clear();
      return;
    }
    const all = new Set(names);
    const seen = new Set<string>();
    for (const name of names) {
      const id = name.replace(/\.jsonl(\.gz)?$/, '');
      const gz = name.endsWith('.gz');
      // Both files at once (a session resumed since the guard compressed it): the plain one is newer and holds the compressed one's events too.
      if (gz && all.has(`${id}.jsonl`)) continue;
      seen.add(id);
      try {
        this.refreshFile(id, name, gz);
      } catch {
        this.files.delete(id); // gone or unreadable mid-way: as search skipped it before
      }
    }
    for (const id of this.files.keys()) if (!seen.has(id)) this.files.delete(id);
  }

  private refreshFile(id: string, name: string, gz: boolean): void {
    const file = path.join(this.dir, name);
    const st = fs.statSync(file);
    const old = this.files.get(id);
    if (old && old.name === name && old.ino === st.ino && old.size === st.size && old.mtimeMs === st.mtimeMs) return;
    let content: Buffer;
    let base = 0;
    // The common case: a plain transcript appended to. Only its new bytes are read.
    if (old && !gz && !old.gz && old.ino === st.ino && st.size > old.size && old.indexed <= st.size) {
      const fd = fs.openSync(file, 'r');
      try {
        const from = Math.max(0, old.indexed - TAIL);
        const tail = Buffer.alloc(old.indexed - from);
        fs.readSync(fd, tail, 0, tail.length, from);
        if (tail.equals(old.tail)) {
          const last = old.chunks.at(-1);
          // A short last chunk is indexed again with what follows it.
          base = last && last.end - last.start < this.chunkBytes ? last.start : old.indexed;
          const readFrom = Math.max(0, base - TAIL);
          content = Buffer.alloc(st.size - readFrom);
          fs.readSync(fd, content, 0, content.length, readFrom);
          const chunks = base === old.indexed ? old.chunks : old.chunks.slice(0, -1);
          const kept = { ...old, size: st.size, mtimeMs: st.mtimeMs, chunks, indexed: base };
          this.files.set(id, this.indexInto(kept, content, base - readFrom, base));
          return;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    content = gz ? zlib.gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file);
    const entry: FileEntry = { id, name, gz, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, indexed: 0, tail: Buffer.alloc(0), chunks: [] };
    // Compressed, or its compressed file unpacked again (a resumed session): the same bytes, so the chunks already built stay.
    // A plain file that changed without growing was rewritten: every chunk is built again.
    if (old && (gz !== old.gz || name !== old.name) && content.length >= old.indexed && content.subarray(Math.max(0, old.indexed - TAIL), old.indexed).equals(old.tail)) {
      const last = old.chunks.at(-1);
      const keep = last && last.end - last.start < this.chunkBytes ? old.chunks.slice(0, -1) : old.chunks;
      entry.chunks = keep;
      entry.indexed = keep.at(-1)?.end ?? 0;
    }
    this.files.set(id, this.indexInto(entry, content, entry.indexed, entry.indexed));
  }

  /**
   * Index `content` from offset `at` (a line end; the file offset `base`) up to its last line end. The bytes before `at`
   * are only there for the tail.
   */
  private indexInto(entry: FileEntry, content: Buffer, at: number, base: number): FileEntry {
    const buf = content.subarray(at);
    const end = buf.lastIndexOf(0x0a) + 1;
    if (end === 0) return { ...entry, indexed: base, tail: Buffer.from(content.subarray(Math.max(0, at - TAIL), at)) };
    const chunks = [...entry.chunks];
    let s = 0;
    while (s < end) {
      let e = s + this.chunkBytes >= end ? end : buf.indexOf(0x0a, s + this.chunkBytes - 1) + 1;
      if (e <= s || e > end) e = end;
      chunks.push(this.chunk(buf, s, e, base));
      s = e;
    }
    return { ...entry, chunks, indexed: base + end, tail: Buffer.from(content.subarray(Math.max(0, at + end - TAIL), at + end)) };
  }

  private chunk(buf: Buffer, s: number, e: number, base: number): Chunk {
    const raw = buf.toString('utf8', s, e);
    let minT = Infinity;
    let maxT = -Infinity;
    for (let i = 0; i < raw.length; ) {
      let j = raw.indexOf('\n', i);
      if (j < 0) j = raw.length;
      if (j > i) {
        const t = lineTime(raw.slice(i, j));
        if (t !== undefined) {
          if (Number.isNaN(t)) {
            minT = -Infinity;
            maxT = Infinity;
          } else {
            if (t < minT) minT = t;
            if (t > maxT) maxT = t;
          }
        }
      }
      i = j + 1;
    }
    const lower = raw.toLowerCase();
    const sc = this.scratch;
    sc.fill(0);
    const mask = SCRATCH_BITS - 1;
    let a = lower.charCodeAt(0);
    let b = lower.charCodeAt(1);
    for (let i = 2; i < lower.length; i++) {
      const c = lower.charCodeAt(i);
      const h = hash3(a, b, c) & mask;
      sc[h >>> 5] |= 1 << (h & 31);
      a = b;
      b = c;
    }
    let n = 0;
    for (let i = 0; i < sc.length; i++) if (sc[i]) n += popcount(sc[i]);
    let m = MIN_BITS;
    while (m < 2 * n && m < SCRATCH_BITS) m *= 2;
    const bits = new Uint32Array(m / 32);
    const wm = bits.length - 1;
    for (let i = 0; i < sc.length; i++) if (sc[i]) bits[i & wm] |= sc[i];
    return { start: base + s, end: base + e, minT, maxT, bits };
  }

  stats(): IndexStats {
    let chunks = 0;
    let bytes = 0;
    let indexBytes = 0;
    for (const f of this.files.values()) {
      chunks += f.chunks.length;
      bytes += f.indexed;
      indexBytes += 200 + f.tail.length;
      for (const c of f.chunks) indexBytes += 64 + c.bits.byteLength;
    }
    return { files: this.files.size, chunks, bytes, indexBytes };
  }

  /** Refresh, then search: the newest `limit` matches, newest first. */
  search(q: IndexQuery): IndexSearchResult {
    const t0 = performance.now();
    this.refresh();
    const t1 = performance.now();
    const { words, since, until } = q;
    const limit = Math.min(Math.max(q.limit, 1), 500);
    const parts = prefilterParts(words);
    const probes = probesOf(words);
    const ids = q.sessionIds ? new Set(q.sessionIds) : undefined;
    const todo: { f: FileEntry; c: Chunk }[] = [];
    let scanned = 0;
    for (const f of this.files.values()) {
      if (ids && !ids.has(f.id)) continue;
      let inWindow = false;
      for (const c of f.chunks) {
        if (c.maxT < since || c.minT > until) continue;
        inWindow = true;
        if (probes.every((h) => has(c.bits, h))) todo.push({ f, c });
      }
      if (inWindow) scanned++;
    }
    todo.sort((x, y) => y.c.maxT - x.c.maxT || (x.f.id < y.f.id ? -1 : x.f.id > y.f.id ? 1 : x.c.start - y.c.start));
    let hits: RawHit[] = [];
    const byTime = (a: RawHit, b: RawHit) => b.t.localeCompare(a.t);
    const gzCache = new Map<string, Buffer>();
    let gzBytes = 0;
    let chunksRead = 0;
    let bytesRead = 0;
    for (const { f, c } of todo) {
      if (hits.length >= limit) {
        hits.sort(byTime);
        hits = hits.slice(0, limit);
        if (c.maxT < Date.parse(hits[limit - 1].t) - STOP_MARGIN_MS) break;
      }
      let raw: string;
      try {
        raw = this.read(f, c, gzCache, (n) => (gzBytes += n), () => gzBytes);
      } catch {
        continue;
      }
      chunksRead++;
      bytesRead += c.end - c.start;
      for (const line of raw.split('\n')) {
        const e = matchLine(line, words, parts, since, until);
        if (!e) continue;
        hits.push({ sessionId: f.id, seq: e.seq, t: e.t, kind: e.kind, snippet: snippet(searchableText(e) ?? '', words) });
      }
    }
    hits.sort(byTime);
    return { hits: hits.slice(0, limit), scanned, chunksRead, bytesRead, refreshMs: t1 - t0, searchMs: performance.now() - t1, stats: this.stats() };
  }

  private read(f: FileEntry, c: Chunk, cache: Map<string, Buffer>, add: (n: number) => void, held: () => number): string {
    const file = path.join(this.dir, f.name);
    if (!f.gz) {
      const buf = Buffer.alloc(c.end - c.start);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, buf.length, c.start);
      } finally {
        fs.closeSync(fd);
      }
      return buf.toString('utf8');
    }
    let all = cache.get(f.id);
    if (!all) {
      all = zlib.gunzipSync(fs.readFileSync(file));
      while (cache.size && held() + all.length > GZ_CACHE_BYTES) {
        const [k, v] = cache.entries().next().value!;
        cache.delete(k);
        add(-v.length);
      }
      cache.set(f.id, all);
      add(all.length);
    }
    return all.toString('utf8', c.start, c.end);
  }
}
