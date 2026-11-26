import fs from 'node:fs';
import path from 'node:path';

/**
 * A junction, a mount point or a symbolic link. Missing: false.
 *
 * lstat alone is not enough on Windows: it called a junction a plain folder on LothDesktop's Node 24.22 (w5774), and every
 * junction a Low-integrity process makes (each BEAST worker: its target is \??\Global\F:\...) on BEAST's Node 24 (w5915,
 * measured: lstat isSymbolicLink false, readdir's entry a link, readlink EINVAL). Where `p` really is (the system resolves
 * every redirect) then differs from its folder's real place plus its name.
 */
export function isLink(p: string): boolean {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  try {
    const real = fs.realpathSync.native(p);
    return real.toLowerCase() !== path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)).toLowerCase();
  } catch {
    return true;
  }
}

/**
 * Take link `p` away, never what it leads to. rmSync refuses a junction lstat calls a folder (ERR_FS_EISDIR, and unlink
 * EPERM, measured on BEAST, w5915); rmdir removes the junction only, and refuses a real folder with anything in it.
 */
export function removeLink(p: string): void {
  try {
    fs.rmSync(p, { force: true, recursive: false });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ERR_FS_EISDIR' || !isLink(p)) throw e;
    fs.rmdirSync(p);
  }
}

/** Where link `p` leads, as the system resolves it (readlink answers EINVAL for a Low-integrity junction, w5915). */
export function linkTarget(p: string): string {
  try {
    return fs.readlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EINVAL' || !isLink(p)) throw e;
    return fs.realpathSync.native(p);
  }
}
