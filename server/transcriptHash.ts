// Feeding a transcript's bytes to a running sha256 (w5563 seals, w5931 checkpoints), with no imports beyond node's own: the
// transcript thread (server/transcriptThread.ts, w5888) runs it, and so does the event loop when the thread is off or gone.
import type crypto from 'node:crypto';
import fs from 'node:fs';

/** How far apart the checkpoints of a seal's check are kept (w5931). */
export const HASH_CHECKPOINT_BYTES = 64 << 20;

/**
 * Feeds `hash` bytes [from, to) of `file`; false when the file is shorter than `to`. Each time it passes `next` it calls `mark`
 * with where it is and a copy of the hash, and the next mark is `every` bytes further on. `chunk`: bytes per read.
 */
export async function feedHash(
  hash: crypto.Hash,
  file: string,
  from: number,
  to: number,
  next = Infinity,
  every = HASH_CHECKPOINT_BYTES,
  mark?: (at: number, copy: crypto.Hash) => void,
  chunk = 1 << 20,
): Promise<boolean> {
  if (to <= from) return true;
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunk, to - from, every)));
    for (let at = from; at < to; ) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, to - at), at);
      if (bytesRead === 0) return false;
      hash.update(buf.subarray(0, bytesRead));
      at += bytesRead;
      if (mark && at >= next) {
        mark(at, hash.copy());
        next = at + every;
      }
    }
    return true;
  } finally {
    await fh.close();
  }
}
