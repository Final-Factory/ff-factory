import fs from 'node:fs';
import path from 'node:path';
import type { ImageFile } from '../shared/types.ts';

/** Image files an agent may show or a gallery may list (docs: README, Screenshots). */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
export const MEDIA_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
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

/** Read an image file under one of `roots`: its type and bytes. Throws with a plain reason otherwise. */
export function readImage(file: string, roots: string[]): { mediaType: string; data: Buffer } {
  if (!path.isAbsolute(file) && !/^[a-zA-Z]:[\\/]/.test(file)) throw new Error('path must be absolute');
  if (!IMAGE_FILE.test(file)) throw new Error('not an image file');
  if (!inRoots(file, roots)) throw new Error('outside this agent\'s folders');
  const real = fs.realpathSync(file);
  if (!inRoots(real, roots.map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : r)))) throw new Error('outside this agent\'s folders');
  const st = fs.statSync(real);
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) throw new Error('not a file, or too large');
  const ext = real.split('.').pop()!.toLowerCase();
  return { mediaType: MEDIA_TYPE[ext], data: fs.readFileSync(real) };
}

/** Recent images under `root`'s screenshot folders, newest first. Bounded: never walks the whole tree. */
export function listImages(root: string, dirs: string[] = DEFAULT_SCREENSHOT_DIRS, limit = 120): ImageFile[] {
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
      } else if (e.isFile() && IMAGE_FILE.test(e.name) && !seen.has(p)) {
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
