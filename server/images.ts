import fs from 'node:fs';
import path from 'node:path';
import type { ImageFile } from '../shared/types.ts';

/** Image files an agent may show or a gallery may list (docs: README, Screenshots). */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
/** Video files: streamed with HTTP Range (openVideo), not read whole. A Unity ".mp4.meta" is not one. */
export const VIDEO_FILE = /\.(mp4|m4v|webm)$/i;
export const MEDIA_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
};
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Where agents leave screenshots, relative to a sandbox or clone: `*` matches one folder name.
 * Overridable with config.screenshotDirs.
 */
export const DEFAULT_SCREENSHOT_DIRS = ['Assets/Screenshots', 'Screenshots', 'specs/*/proofs', 'Logs', 'Temp/Screenshots', 'screenshots'];

const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

/** Whether `file` is inside one of `roots` (after resolving `..`). */
export function inRoots(file: string, roots: string[]): boolean {
  const f = norm(file);
  return roots.some((r) => {
    const n = norm(r);
    return f === n || f.startsWith(n + '/');
  });
}

/** A media file under one of `roots` (after resolving links): its real path, size and type. Throws otherwise. */
function resolveMedia(file: string, roots: string[], kind: RegExp, what: string): { real: string; size: number; mediaType: string } {
  if (!path.isAbsolute(file) && !/^[a-zA-Z]:[\\/]/.test(file)) throw new Error('path must be absolute');
  if (!kind.test(file)) throw new Error(`not ${what} file`);
  if (!inRoots(file, roots)) throw new Error('outside this agent\'s folders');
  const real = fs.realpathSync(file);
  if (!inRoots(real, roots.map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : r)))) throw new Error('outside this agent\'s folders');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('not a file');
  return { real, size: st.size, mediaType: MEDIA_TYPE[real.split('.').pop()!.toLowerCase()] };
}

/** Read an image file under one of `roots`: its type and bytes. Throws with a plain reason otherwise. */
export function readImage(file: string, roots: string[]): { mediaType: string; data: Buffer } {
  const m = resolveMedia(file, roots, IMAGE_FILE, 'an image');
  if (m.size > MAX_IMAGE_BYTES) throw new Error('too large');
  return { mediaType: m.mediaType, data: fs.readFileSync(m.real) };
}

/** A video under one of `roots`, to stream (no size limit: it is sent in ranges). */
export function openVideo(file: string, roots: string[]): { path: string; size: number; mediaType: string } {
  const m = resolveMedia(file, roots, VIDEO_FILE, 'a video');
  return { path: m.real, size: m.size, mediaType: m.mediaType };
}

/**
 * An HTTP Range header for a file of `size` bytes: the one range to send, 'unsatisfiable' (416), or
 * undefined for the whole file (no header, or a form we do not serve, such as several ranges).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    const n = Number(m[2]); // the last n bytes
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Recent images (and with `videos`, videos) under `root`'s screenshot folders, newest first. Bounded: never walks the whole tree. */
export function listImages(root: string, dirs: string[] = DEFAULT_SCREENSHOT_DIRS, limit = 120, opts: { videos?: boolean } = {}): ImageFile[] {
  const out: ImageFile[] = [];
  const seen = new Set<string>();
  let budget = 20_000; // directory entries looked at, in all
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget < 0) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0 && !e.name.startsWith('.')) walk(p, depth - 1);
      } else if (e.isFile() && (IMAGE_FILE.test(e.name) || (opts.videos && VIDEO_FILE.test(e.name))) && !seen.has(p)) {
        seen.add(p);
        try {
          const st = fs.statSync(p);
          out.push({ path: p, size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  for (const pattern of dirs) {
    for (const dir of expand(root, pattern.split('/').filter(Boolean))) walk(dir, 4);
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, limit);
}

/** Folders matching a relative pattern whose segments may be `*`. */
function expand(base: string, segs: string[]): string[] {
  if (!segs.length) return fs.existsSync(base) ? [base] : [];
  const [head, ...rest] = segs;
  if (head !== '*') return expand(path.join(base, head), rest);
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .flatMap((e) => expand(path.join(base, e.name), rest));
  } catch {
    return [];
  }
}
