// The scan behind the tool refresh (server/keptTools.ts, w2626), with no imports beyond node's own, so the transcript thread
// (server/transcriptThread.ts, w5888) runs it without loading the MCP SDK.
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export interface ToolNow {
  description: string;
  input_schema: unknown;
}

export const MARK = Buffer.from('"deferred_tools_record"');

export interface Stale {
  writes: { at: number; bytes: Buffer }[];
  dropped: Set<string>;
}

/**
 * The record lines from `hit` on, into `out`; returns where to go on when `stop` said so, else -1. `base`: where `buf` starts in
 * the file, added to each write's offset.
 */
export function scanRecords(buf: Buffer, now: Map<string, ToolNow>, hit: number, out: Stale, stop: () => boolean = () => false, base = 0): number {
  const { writes, dropped } = out;
  while (hit >= 0) {
    if (stop()) return hit;
    const start = buf.lastIndexOf(0x0a, hit) + 1;
    let end = buf.indexOf(0x0a, hit);
    if (end < 0) end = buf.length;
    hit = buf.indexOf(MARK, end);
    const raw = buf.subarray(start, end);
    let line: { attachment?: { type?: string; entries?: { name?: string; description?: unknown; input_schema?: unknown }[] } };
    try {
      line = JSON.parse(raw.toString('utf8'));
    } catch {
      continue; // a line still being written, or not JSON: not ours to touch
    }
    const a = line?.attachment;
    if (a?.type !== 'deferred_tools_record' || !Array.isArray(a.entries)) continue;
    const stale = a.entries.filter((e) => {
      const cur = typeof e?.name === 'string' ? now.get(e.name) : undefined;
      return cur !== undefined && (e.description !== cur.description || !isDeepStrictEqual(e.input_schema, cur.input_schema));
    });
    if (stale.length === 0) continue;
    a.entries = a.entries.filter((e) => !stale.includes(e));
    const json = Buffer.from(JSON.stringify(line), 'utf8');
    if (json.length > raw.length) continue;
    writes.push({ at: base + start, bytes: Buffer.concat([json.subarray(0, json.length - 1), Buffer.alloc(raw.length - json.length, 0x20), json.subarray(json.length - 1)]) });
    for (const e of stale) dropped.add(e.name as string);
  }
  return -1;
}

/** How much of a transcript the windowed scan holds at once (w5888). */
export const SCAN_WINDOW_BYTES = 64 << 20;

/**
 * scanRecords over the whole file, read `window` bytes at a time and cut at line ends (w5888: the dispatcher's 1.49 GB transcript
 * was read whole into the portal's heap at each resume). The same lines as one pass over the whole file: a line longer than the
 * window is read on until it ends, and the last line counts as it is, ended or not. Throws when the file cannot be read.
 */
export function scanFile(file: string, now: Map<string, ToolNow>, window = SCAN_WINDOW_BYTES): Stale {
  const out: Stale = { writes: [], dropped: new Set() };
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(window, size)));
    let base = 0;
    let carry = Buffer.alloc(0);
    while (base + carry.length < size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - base - carry.length), base + carry.length);
      if (n === 0) break;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const cut = base + buf.length >= size ? buf.length : buf.lastIndexOf(0x0a) + 1;
      if (cut === 0) {
        carry = Buffer.from(buf); // no line ends in it yet: read on
        continue;
      }
      const lines = buf.subarray(0, cut);
      scanRecords(lines, now, lines.indexOf(MARK), out, undefined, base);
      carry = Buffer.from(buf.subarray(cut)); // a copy: `chunk` is read into again
      base += cut;
    }
    if (carry.length) scanRecords(carry, now, carry.indexOf(MARK), out, undefined, base);
  } finally {
    fs.closeSync(fd);
  }
  return out;
}
