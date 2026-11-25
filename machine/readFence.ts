// The worker read fence's daemon-side helpers (w5546; docs/worker-fence.md "Reads"). No npm package: linkJob-safe.
import fs from 'node:fs';
import path from 'node:path';

/**
 * The marker of the live off switch (daemon_control `read-fence-off`): while it is there, runs start with no read rules and
 * Windows keeps no No-Read-Up labels. In the daemon's folder, which workers can neither read nor write.
 */
export const readFenceOffFile = (appDir: string) => path.join(appDir, 'read-fence.off');

/** Whether the read fence is switched off on this machine. */
export const readFenceOff = (appDir: string) => fs.existsSync(readFenceOffFile(appDir));

/**
 * The given-back folders a daemon makes later than a run may start (lockout review of #1193): made before the fences are
 * set, so Landlock grants them (it skips a path that is not there) and on Windows they take their own read-back label
 * rather than inheriting the daemon folder's No-Read-Up when made later.
 */
export const READ_BACK_DIRS = ['logs', 'rpc', 'unity-mcp', 'unity-slots', 'gh-app/bin', 'gh-app/sessions'];

export function ensureReadBackDirs(appDir: string): void {
  for (const d of READ_BACK_DIRS) {
    try {
      fs.mkdirSync(path.join(appDir, d), { recursive: true, ...(d === 'gh-app/sessions' ? { mode: 0o700 } : {}) });
    } catch {
      // A folder that cannot be made is not given back; nothing else depends on it here.
    }
  }
}

/**
 * Writes a file that fenced workers read in place, keeping its inode and security descriptor (lockout review of #1193): a
 * write by rename makes a new file, which a Landlock grant (by inode) does not cover and which on Windows takes the daemon
 * folder's No-Read-Up label. The new bytes go over the old ones first and the file is cut to their length after, so a
 * reader sees the old or the new contents except for the instant of the write itself; readers of these files already treat
 * a file that does not parse as missing.
 */
export function writeInPlace(file: string, data: string): void {
  const b = Buffer.from(data);
  let fd: number;
  try {
    fd = fs.openSync(file, 'r+');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    fd = fs.openSync(file, 'w');
  }
  try {
    fs.writeSync(fd, b, 0, b.length, 0);
    fs.ftruncateSync(fd, b.length);
  } finally {
    fs.closeSync(fd);
  }
}
