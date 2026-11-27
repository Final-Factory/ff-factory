import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether the module at `filename` (its import.meta.filename) is the script node was started with.
 *
 * Compares real paths: node resolves the main module through links, so import.meta.filename is the real file while
 * process.argv[1] keeps the path it was given. On Linux the daemon's code is `<daemon>/app`, a link to `code/app`
 * (w6434), so a plain path.resolve() compare never matched there and the daemon, agent hosts, gh helper, ff-pr and
 * unity-slot did nothing at all.
 */
export function isMainModule(filename: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fs.realpathSync(path.resolve(arg)) === fs.realpathSync(filename);
  } catch {
    return path.resolve(arg) === path.resolve(filename);
  }
}
