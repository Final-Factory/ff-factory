import fs from 'node:fs';
import path from 'node:path';
import { norm } from './cleanup.ts';

/**
 * The files a machine's workers published (w2223): publish_review and publish_attachment send a copy to the portal, so a
 * finished worker's clean-up may take that file from its temp folder and keep the ones published nowhere else. The daemon
 * appends a line per file after the portal accepted it; a file counts as published while it is still the bytes that went
 * (same path, size and modification time). A file moved, edited or published before w2223 is not in it, and stays.
 */
export interface PublishedRecord {
  path: string;
  size: number;
  mtimeMs: number;
  /** When it was published (ISO). */
  at: string;
}

/** Beside the clean-up facts in the daemon's folder, where `ff-leftovers` reads it too. */
export const publishedFile = (appDir: string) => path.join(appDir, 'published.jsonl');

/** Past this size the file is rewritten with only the records whose file still exists. */
const COMPACT_BYTES = 2 * 1024 ** 2;

/** Record `paths` as published (after the portal accepted them). Never throws: a missing record only keeps a file longer. */
export function recordPublished(file: string, paths: string[], now = Date.now()): void {
  try {
    const lines: string[] = [];
    for (const p of paths) {
      const st = fs.statSync(p, { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      lines.push(JSON.stringify({ path: path.resolve(p), size: st.size, mtimeMs: Math.round(st.mtimeMs), at: new Date(now).toISOString() } satisfies PublishedRecord));
    }
    if (!lines.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.join('\n') + '\n');
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > COMPACT_BYTES) {
      const kept = [...readPublished(file).values()].flat().filter((r) => fs.existsSync(r.path));
      fs.writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
    }
  } catch {
    /* a record that could not be written only keeps the file */
  }
}

/** The records by normalized path; empty when the file is missing or unreadable. */
export function readPublished(file: string | undefined): Map<string, PublishedRecord[]> {
  const out = new Map<string, PublishedRecord[]>();
  if (!file) return out;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as PublishedRecord;
      if (typeof r.path !== 'string' || typeof r.size !== 'number' || typeof r.mtimeMs !== 'number') continue;
      const k = norm(r.path);
      const list = out.get(k);
      if (list) list.push(r);
      else out.set(k, [r]);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

/** `p` is a file that was published and has not changed since. */
export function isPublished(index: Map<string, PublishedRecord[]>, p: string): boolean {
  const list = index.get(norm(p));
  if (!list) return false;
  const st = fs.statSync(p, { throwIfNoEntry: false });
  return !!st?.isFile() && list.some((r) => r.size === st.size && r.mtimeMs === Math.round(st.mtimeMs));
}
