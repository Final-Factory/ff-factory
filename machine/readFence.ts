// The worker read fence's daemon-side helpers (w5546; docs/worker-fence.md "Reads"). No npm package: linkJob-safe.
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_ONLY_CHILDREN } from '../server/claudeHome.ts';

/**
 * The read fence's mode on this machine (w5546 lockout review, lothsahn's rule: "warn-only first, enforce only after measured
 * zero failures, keep a recovery route that needs no person"), set live by the portal's `daemon_control` `read-fence-off`,
 * `read-fence-warn` or `read-fence-on` and kept across restarts and updates in a file in the daemon's folder, which workers can
 * neither read nor write:
 * - `off` (the default, and what a missing or unreadable file means): runs get no read rules and on Windows the closed paths'
 *   No-Read-Up labels are taken off again, so a revert or a switch leaves no label behind;
 * - `warn`: the same for runs, but the daemon probes the fence at start and at each switch, in a child of its own under the
 *   read rules, and logs what it would refuse that workers need and what it would leave open that it must close;
 * - `on`: runs get the read rules (Windows: the labels), with the same probe; a probe that finds a path workers need refused
 *   leaves runs without read rules until the next probe passes, so a wrong rule degrades to warn, never to a lockout.
 */
export type ReadFenceMode = 'off' | 'warn' | 'on';
export const READ_FENCE_MODES: readonly ReadFenceMode[] = ['off', 'warn', 'on'];
export const readFenceModeFile = (appDir: string) => path.join(appDir, 'read-fence');

export function readFenceMode(appDir: string): ReadFenceMode {
  try {
    const m = fs.readFileSync(readFenceModeFile(appDir), 'utf8').trim();
    return m === 'warn' || m === 'on' ? m : 'off';
  } catch {
    return 'off';
  }
}

/**
 * Why `on` is refused on this OS, or undefined (lockout re-review B4 of #1193). Linux: Landlock gives the daemon's `app`
 * folder back by inode when a run starts, and a self-update swaps `app` by rename (scripts/worker/linkJob.ts), so every run
 * going at an update would lose git's credential helper, the gh shim, ff-pr and unity-slot until it ends, and no switch can
 * lift Landlock from a running process. `warn` still probes there.
 */
export function readFenceOnRefusal(platform: string = process.platform): string | undefined {
  return platform === 'linux'
    ? 'read-fence-on is refused on Linux for now: a self-update swaps the daemon code folder by rename, and Landlock would leave every run already going without git push, gh, ff-pr and unity-slot until it ends (lockout re-review B4 of #1193, docs/worker-fence.md). Use read-fence-warn.'
    : undefined;
}

export function writeReadFenceMode(appDir: string, mode: ReadFenceMode): void {
  if (mode === 'off') fs.rmSync(readFenceModeFile(appDir), { force: true });
  else fs.writeFileSync(readFenceModeFile(appDir), `${mode}\n`);
}

/**
 * Every secrets folder the fence closes (B3 of the lockout review): `<root>/secrets`, and the folder that really holds the
 * machine credential when that is elsewhere: a Dev Drive install keeps it in the host folder beside the daemon's
 * (scripts/worker/worker.ts layoutOf `secrets: a('secrets')`; LothDesktop: D:\work\ffw\secrets for root V:\ffw). Only a
 * folder named `secrets`, so an odd tokenFile never closes a person's folder.
 */
export function secretsDirs(root: string, tokenFile?: string): string[] {
  const out = [path.join(path.resolve(root), 'secrets')];
  const d = tokenFile ? path.dirname(path.resolve(tokenFile)) : undefined;
  if (d && path.basename(d).toLowerCase() === 'secrets' && !out.some((o) => o.toLowerCase() === d.toLowerCase())) out.push(d);
  return out;
}

/**
 * The root children only the daemon reads, closed to workers' reads like the secrets (w5639): `<root>/steam` (w5551), which
 * holds steamcmd and its cached Steam login, the upload config, the daemon's ffbox clone and uploads.json. The daemon runs
 * steamcmd and the uploads itself, unfenced (machine/steamUpload.ts), so the fence never stands in their way.
 */
export function daemonOnlyDirs(root: string): string[] {
  return DAEMON_ONLY_CHILDREN.map((c) => path.join(path.resolve(root), c));
}

/**
 * Up to three regular files directly inside `dir`, by name (w5639): what the Linux probe opens for a closed folder. Landlock
 * rights are inherited down the tree, so the READ_DIR every parent of a closed path keeps (to list names) reaches the closed
 * folder too: opening or listing the folder itself succeeds there, and only its files' contents are refused. Names only: the
 * daemon lists the folder (it is not fenced) and never opens a file.
 */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function filesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name)).sort().slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * What the fence probe opens: paths it must find refused, and paths workers need that it must find open. Existing ones only.
 * `linux` (default: this machine is Linux) swaps each closed folder for the files inside it (filesIn), since Landlock cannot
 * refuse a closed folder's own open; a closed folder with no files is then not probed.
 */
export function readFenceProbeTargets(o: { root: string; appDir: string; secrets: readonly string[]; tokenFile?: string; allowBack: readonly string[]; exists?: (p: string) => boolean; linux?: boolean }): { closed: string[]; open: string[] } {
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  const linux = o.linux ?? process.platform === 'linux';
  const closed = [
    ...o.secrets,
    ...daemonOnlyDirs(o.root),
    ...(o.tokenFile ? [path.resolve(o.tokenFile)] : []),
    path.join(o.root, 'root.json'),
    path.join(o.appDir, 'daemon.json'),
    path.join(o.appDir, 'gh-app', 'tokens.json'),
  ];
  const open = [...o.allowBack.map((a) => path.join(o.appDir, a)), path.join(o.appDir, 'app', 'machine', 'ghApp.ts')];
  const uniq = (l: string[]) => [...new Set(l)].filter(exists);
  const asProbed = linux ? closed.flatMap((p) => (exists(p) && isDir(p) ? filesIn(p) : [p])) : closed;
  return { closed: uniq(asProbed), open: uniq(open) };
}

/**
 * The probe child's program (run by node under the fence): opens each path read-only and closes it at once, never reading a
 * byte (lothsahn: "Probes only open the file and check whether access is refused"), and prints `<i> ok|refused|<code>`.
 */
export const READ_PROBE_SCRIPT =
  "const fs=require('fs');process.argv.slice(1).forEach((p,i)=>{try{fs.closeSync(fs.openSync(p,'r'));console.log(i+' ok')}catch(e){console.log(i+' '+(e.code==='EACCES'||e.code==='EPERM'?'refused':e.code||'error'))}})";

export interface ReadProbeVerdict {
  /** Paths workers need that the fence refused: a lockout if enforced. */
  wronglyRefused: string[];
  /** Paths the fence must close that it left open. */
  leftOpen: string[];
  /** Paths the probe could not judge (no answer, another error). */
  unknown: string[];
}

/** Judges the probe child's output against the targets. Exported for tests. */
export function judgeReadProbe(t: { closed: readonly string[]; open: readonly string[] }, stdout: string): ReadProbeVerdict {
  const all = [...t.closed, ...t.open];
  const ans = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+) (\S+)$/.exec(line.trim());
    if (m) ans.set(Number(m[1]), m[2]);
  }
  const v: ReadProbeVerdict = { wronglyRefused: [], leftOpen: [], unknown: [] };
  all.forEach((p, i) => {
    const a = ans.get(i);
    const shouldOpen = i >= t.closed.length;
    if (a === 'ok') {
      if (!shouldOpen) v.leftOpen.push(p);
    } else if (a === 'refused') {
      if (shouldOpen) v.wronglyRefused.push(p);
    } else v.unknown.push(`${p} (${a ?? 'no answer'})`);
  });
  return v;
}

/** One log line for a probe's verdict. */
export function sayReadProbe(mode: ReadFenceMode, os: string, v: ReadProbeVerdict, t: { closed: readonly string[]; open: readonly string[] }): string {
  const bad = [
    ...(v.wronglyRefused.length ? [`would refuse what workers need: ${v.wronglyRefused.join(', ')}`] : []),
    ...(v.leftOpen.length ? [`would leave open: ${v.leftOpen.join(', ')}`] : []),
    ...(v.unknown.length ? [`could not judge: ${v.unknown.join(', ')}`] : []),
  ];
  return `read fence (${mode}, ${os}) probe: ${t.closed.length - v.leftOpen.length}/${t.closed.length} closed paths refused, ${t.open.length - v.wronglyRefused.length}/${t.open.length} given-back paths open${bad.length ? `; ${bad.join('; ')}` : '; no failures'}`;
}

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
