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
 * Review w6380: a name ending in a dot or a space. Windows drops those from a path it opens without the \\?\ prefix, so
 * icacls handed `cache\evil.` opens `cache\evil`, a junction beside it, while Node lists `evil.` as a plain folder and every
 * link check passes (measured on BEAST). A Low worker can make such a name (through \\?\); none of the folders we lock
 * holds one of ours (Node itself can make one, review w6452).
 *
 * Review w6452: a Windows device name too (NUL, CON, PRN, AUX, COM0-9, LPT0-9, COM and LPT with a superscript 1-3,
 * CONIN$, CONOUT$; any case, with or without an extension or spaces before it): icacls on `<dir>\NUL`, or `<dir>\*` with a
 * NUL in it, fails with exit 87 (measured on Windows 11), which failed the whole pass, on and off alike; older Windows opens
 * the others as devices as well. On Linux and macOS such a name is just a name, and skipping it there too keeps the tests
 * one on every OS.
 */
export const isTrickName = (name: string) => name !== '.' && name !== '..' && (/[. ]$/.test(name) || DEVICE_NAME.test(name));
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$) *(\..*)?$/i;

/** What a trick name is, for the lines that say one was skipped. */
export const TRICK_WHY = 'a name ending in a dot or a space, or a device name such as NUL, which icacls would open as another path or fail on';

/** Whether any part of path `p` is a trick name (isTrickName). A drive (`V:`) is not one. */
export const hasTrickName = (p: string) => p.split(/[\\/]/).some((s) => s !== '' && isTrickName(s));

/**
 * Whether anything (a link included) is at `p`, by its exact name: on Windows an absolute path is looked at by its `\\?\`
 * path, since the plain one drops a trailing dot or space (`x.` would answer for `x`; w6462).
 */
export function presentAt(p: string): boolean {
  const exact = process.platform === 'win32' && path.isAbsolute(p) && !p.startsWith('\\\\') ? `\\\\?\\${path.resolve(p)}` : p;
  try {
    return fs.lstatSync(exact, { throwIfNoEntry: false }) !== undefined;
  } catch (e) {
    // Not to be read (EPERM, EBUSY): something is there.
    return (e as NodeJS.ErrnoException).code !== 'ENOTDIR';
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
