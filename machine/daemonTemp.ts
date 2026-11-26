/**
 * w6000 (lothsahn, w5823: "under no circumstances should workers write outside of ffw"): the daemon's own temp folder.
 *
 * Node's os.tmpdir() reads TMPDIR (macOS, Linux) or TEMP and TMP (Windows) on every call, and a child process inherits
 * them. So the daemon points all three at `<root>/tmp/daemon` as it starts (applyDaemonTmpdir): every os.tmpdir() and
 * mkdtemp of the daemon and the portal code it runs (server/*), and every git, gh, ssh, python, PowerShell, player or
 * script it starts without an environment of its own, write inside the worker root and not in /tmp, /var/folders or
 * %LOCALAPPDATA%\Temp. Agents keep their own `ffa-<session>` folder (server/cleanup.ts sessionTempEnv), and sandbox Unity
 * editors keep what daemon.json `editorTmpdir` gives them (w5833: the system temp while it is off, sandboxEditorEnv).
 *
 * The lockout rule: warn-safe. A folder that cannot be made, a root too long for a Unix socket path under it
 * (DAEMON_TMPDIR_MAX), or daemon.json `daemonTmpdir: "off"` (`ops_worker machine_update daemon_tmpdir off`, the remote
 * recovery, read at the daemon's start) leaves the system temp folder in place and says why; nothing is ever refused for it.
 *
 * What reads or cleans the system temp folder itself (the clean-up's temp rules, the browser reaper, Git Bash's /tmp)
 * asks systemTempDir(): the folder os.tmpdir() named before the move, which FF_SYSTEM_TMPDIR carries to children.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The daemon's own temp folder under a worker root. */
export const daemonTempDir = (root: string) => path.join(root, 'tmp', 'daemon');

/**
 * The longest daemon temp folder on macOS and Linux: as sharedCaches.ts EDITOR_TMPDIR_MAX (w5833), since a player or a
 * .NET tool the daemon starts binds `<TMPDIR>/dotnet-diagnostic-<pid>-<start>-socket` (up to 51 more bytes) and Unix
 * socket paths stop at 104 bytes on macOS.
 */
export const DAEMON_TMPDIR_MAX = 50;

/** The variable that keeps the system temp folder for what reads it (and for children) once the daemon's moved. */
export const SYSTEM_TMPDIR_VAR = 'FF_SYSTEM_TMPDIR';

/** The system temp folder: the one os.tmpdir() named before applyDaemonTmpdir moved it, else os.tmpdir() now. */
export const systemTempDir = (env: NodeJS.ProcessEnv = process.env): string => env[SYSTEM_TMPDIR_VAR] || os.tmpdir();

/** The temp variables a platform's os.tmpdir() reads. */
export const tempVars = (platform: NodeJS.Platform): ('TMPDIR' | 'TEMP' | 'TMP')[] => (platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']);

export interface DaemonTmpdirResult {
  /** The folder TMPDIR, TEMP and TMP now name; undefined when they were left alone. */
  dir?: string;
  /** The line for the daemon's log: where temp files go now, or why they still go to the system temp folder. */
  line: string;
}

/**
 * Point the daemon's TMPDIR, TEMP and TMP at `<root>/tmp/daemon` (w6000), keeping the old temp folder in
 * FF_SYSTEM_TMPDIR. Never throws. `setting` is daemon.json `daemonTmpdir` (unset: on).
 */
export function applyDaemonTmpdir(
  env: NodeJS.ProcessEnv,
  root: string | undefined,
  setting: 'on' | 'off' | undefined,
  o: { platform?: NodeJS.Platform; mkdir?: (p: string) => void; tmpdir?: () => string } = {},
): DaemonTmpdirResult {
  const platform = o.platform ?? process.platform;
  const tmpdir = o.tmpdir ?? (() => os.tmpdir());
  if (!root) return { line: 'daemon temp (w6000): no worker root: temp files go to the system temp folder' };
  if (setting === 'off') return { line: `daemon temp (w6000): daemonTmpdir is off: temp files go to the system temp folder ${tmpdir()}` };
  const dir = daemonTempDir(root);
  if (platform !== 'win32' && dir.length > DAEMON_TMPDIR_MAX) return { line: `daemon temp (w6000): ${dir} is longer than ${DAEMON_TMPDIR_MAX} characters, too long for the Unix sockets made under it: temp files go to the system temp folder ${tmpdir()}` };
  try {
    (o.mkdir ?? ((p: string) => void fs.mkdirSync(p, { recursive: true })))(dir);
  } catch (e) {
    return { line: `daemon temp (w6000): could not make ${dir} (${(e as Error).message}): temp files go to the system temp folder ${tmpdir()}` };
  }
  // A daemon started by one that moved it (a self-update's re-exec) keeps the first system temp folder.
  env[SYSTEM_TMPDIR_VAR] ||= tmpdir();
  for (const k of ['TMPDIR', 'TEMP', 'TMP'] as const) env[k] = dir;
  return { dir, line: `daemon temp (w6000): TMPDIR, TEMP and TMP are ${dir} (the system temp folder was ${env[SYSTEM_TMPDIR_VAR]})` };
}

/**
 * A sandbox editor's temp variables when daemon.json `editorTmpdir` gives it none (w5833 off, or a root too long): the
 * system temp folder, as before the daemon's own moved (w6000), so that switch alone decides where an editor's temp goes.
 * Empty on Windows (editorTempEnv gives editors `<root>/tmp/unity` there) and when the daemon's temp was not moved.
 */
export function editorSystemTempEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform === 'win32' || !env[SYSTEM_TMPDIR_VAR]) return {};
  return { TMPDIR: env[SYSTEM_TMPDIR_VAR]! };
}
