import fs from 'node:fs';
import path from 'node:path';

/**
 * w6434: on Linux the daemon's code lives in `<appDir>/code/app`, and `<appDir>/app` is a symlink to it that never
 * changes. An update builds code/app.new and swaps it in by rename inside code/, a rollback swaps code/app.old back.
 *
 * Why: Landlock grants reads by inode when a run starts. The read fence closes `<appDir>` and gives back its children
 * one by one, so a folder renamed into `<appDir>` after a run started (the old `app.new -> app`) was unreadable to it,
 * and every run already going lost ghApp.ts, the credential helper, ff-pr and unity-slot until it ended (lockout
 * re-review B4 of #1193). code/ is given back as a whole folder (server/daemonReads.ts), so anything renamed inside
 * it stays readable. Landlock does not check the symlink itself, only the file it leads to.
 *
 * A daemon on the old layout (a real `app` folder) moves over on its next update: that `app` becomes code/app.old,
 * so a rollback finds it.
 */
export const linuxCodeDir = (appDir: string) => path.join(appDir, 'code');

/** The app link's target, relative so the daemon's folder can move. */
const LINK = path.join('code', 'app');

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Point `<appDir>/app` at code/app, replacing a link to anything else by one rename. */
function ensureLink(appDir: string) {
  const app = path.join(appDir, 'app');
  if (isLink(app) && fs.readlinkSync(app) === LINK) return;
  if (exists(app) && !isLink(app)) throw new Error(`${app} is a real folder, not the code link`);
  const tmp = path.join(appDir, 'app.link');
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(LINK, tmp);
  fs.renameSync(tmp, app);
}

/** Where an update builds the new code: `<appDir>/code/app.new`, emptied. */
export function newLinuxCode(appDir: string): string {
  const dir = path.join(linuxCodeDir(appDir), 'app.new');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** code/app.new -> code/app, the running code kept as code/app.old; the old layout's `app` folder moves over. */
export function swapInLinuxCode(appDir: string) {
  const code = linuxCodeDir(appDir);
  const app = path.join(appDir, 'app');
  const cur = path.join(code, 'app');
  const old = path.join(code, 'app.old');
  fs.rmSync(old, { recursive: true, force: true });
  if (exists(app) && !isLink(app)) {
    // The old layout, or a downgrade's installer put a real folder back: a code/app from before that is stale.
    fs.rmSync(cur, { recursive: true, force: true });
    fs.renameSync(app, old);
  } else if (exists(cur)) fs.renameSync(cur, old);
  fs.renameSync(path.join(code, 'app.new'), cur);
  ensureLink(appDir);
  // The old layout's rollback copy, one build older than code/app.old now.
  fs.rmSync(path.join(appDir, 'app.old'), { recursive: true, force: true });
}

/** A code folder by its old name ('app' or 'app.old'), on either layout. */
export function linuxCodeFolder(appDir: string, which: 'app' | 'app.old' | 'app.failed'): string {
  return isLink(path.join(appDir, 'app')) ? path.join(linuxCodeDir(appDir), which) : path.join(appDir, which);
}

/**
 * app -> app.failed, app.old -> app, on either layout. Throws when there is no app.old.
 *
 * w6443's re-review: code from before w6434 (no machine/isMain.ts) cannot start behind the link, since its main-module
 * check compares argv[1] (the link path) with the real path, so the daemon would start and do nothing. A rollback of
 * the first update to this layout therefore puts the old layout back too: a real `<appDir>/app` folder, the new code
 * as `<appDir>/app.failed`, and no link. The next update moves it over again (swapInLinuxCode).
 */
export function swapBackLinuxCode(appDir: string) {
  const app = linuxCodeFolder(appDir, 'app');
  const old = linuxCodeFolder(appDir, 'app.old');
  const failed = linuxCodeFolder(appDir, 'app.failed');
  if (!fs.existsSync(old)) throw new Error(`there is no ${old} to put back`);
  const link = path.join(appDir, 'app');
  if (isLink(link) && !fs.existsSync(path.join(old, 'machine', 'isMain.ts'))) {
    const oldFailed = path.join(appDir, 'app.failed');
    fs.rmSync(oldFailed, { recursive: true, force: true });
    fs.rmSync(failed, { recursive: true, force: true });
    fs.unlinkSync(link);
    fs.renameSync(old, link);
    if (fs.existsSync(app)) fs.renameSync(app, oldFailed);
    return;
  }
  fs.rmSync(failed, { recursive: true, force: true });
  if (fs.existsSync(app)) fs.renameSync(app, failed);
  fs.renameSync(old, app);
}
