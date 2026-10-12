// The whole worker root on its Dev Drive (w1070, docs/worker-install.md "The Dev Drive"). lothsahn: "If using a dev drive,
// the entire folder structure should be under V: Then we won't need the folder symlinks or anything". A Windows install with a
// Dev Drive puts its root at <letter>:\ffw; the folder the person gave (the host folder, D:\work\ffw on LothDesktop) keeps only
// what has to be there before the drive is attached (HOST_FILES). w900 had put only the sandboxes and the Library seed on the
// drive, behind two junctions in a root on D:. An install of that kind is made again with `install --reinstall` (worker.ts
// reinstallOnDrive): lothsahn, "Instead of doing a move, can we just do a fresh reinstall on LothDesktop instead?"
import fs from 'node:fs';
import path from 'node:path';

/** The root's folder on the drive. */
export const DRIVE_ROOT_DIR = 'ffw';

/**
 * What stays in the host folder, and why each must:
 * - devdrive.vhdx: the drive itself (a file cannot hold the volume it is the file of);
 * - devdrive.json: its letter, read by the boot mount (ffsb-helper-mount, SYSTEM, 30 s after boot) and by start-daemon.ps1
 *   before the drive is attached;
 * - start-daemon.ps1 (and its log): the daemon task's action. The task starts at logon, which can come before the boot mount
 *   has attached the drive, and a task whose action is on a missing drive does not start at all; this waits for the drive
 *   and then runs <root>\daemon\run-daemon.ps1;
 * - moved.json: where the root is, for an update or a person given the folder the install went into;
 * - .reinstall: only while `install --reinstall` runs, what it carries from the old install to the new root.
 * The helper scripts the boot mount runs are not here: they live in %ProgramData%\ffsb-helpers (install-privileged-helpers.ps1).
 */
export const HOST_FILES = ['devdrive.vhdx', 'devdrive.json', 'start-daemon.ps1', 'start-daemon.log', 'moved.json', '.reinstall'];

/** One of the host folder's own entries. */
export const isHostFile = (name: string) => HOST_FILES.includes(name.toLowerCase());

/** The root's folder on a drive letter. */
export const driveRootOf = (letter: string) => `${letter.toUpperCase()}:\\${DRIVE_ROOT_DIR}`;

/** <host>\moved.json: { root } where the install is. */
export function readMoved(host: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(host, 'moved.json'), 'utf8')) as { root?: unknown };
    return typeof j.root === 'string' && j.root ? j.root : undefined;
  } catch {
    return undefined;
  }
}

/** Write <host>\moved.json. */
export function writeMoved(host: string, root: string) {
  fs.writeFileSync(path.join(host, 'moved.json'), JSON.stringify({ root, at: new Date().toISOString(), why: 'w1070: the worker root lives on its Dev Drive; this folder keeps only the drive and what starts before it is attached' }, null, 2) + '\n');
}

/** What `install --reinstall` carries from the old install into the new root (the rest is made again): the clone seeds the new one. */
export const REINSTALL_KEEPS = ['repo', 'nightly', 'tmp', 'scratch'];

// ---------------------------------------------------------------- paths that name the old places

/** [from, to] pairs, longest first: every stored path under `from` is put under `to`. */
export type PathMap = [string, string][];

const winNorm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/**
 * The pairs a reinstall applies to what it carries: the old root to the new one, and the old drive's own sandboxes and seed folders (w900's
 * V:\sandboxes, V:\seed) into the new root. Exported for tests.
 */
export function moveMap(oldRoot: string, newRoot: string, oldDrive?: { sandboxes: string; seed: string }): PathMap {
  const pairs: PathMap = [[oldRoot, newRoot]];
  const sep = /^[A-Za-z]:|^\\\\/.test(newRoot) ? '\\' : path.sep;
  if (oldDrive) pairs.push([oldDrive.sandboxes, `${newRoot}${sep}sandboxes`], [oldDrive.seed, `${newRoot}${sep}seed`]);
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

/**
 * A stored path put on the new place: a Windows path under a `from` (any case, either slash) gets the `to` instead, keeping
 * the rest as it was written; Git Bash's /d/work/ffw form too. Anything else is returned unchanged, and so is a path to one of
 * the HOST_FILES, which stay where they are (the VHDX, its state file). Exported for tests.
 */
export function rebasePath(value: string, map: PathMap): string {
  for (const [from, to] of map) {
    const f = winNorm(from);
    const v = value.replace(/\//g, '\\');
    if (v.toLowerCase() === f || v.toLowerCase().startsWith(f + '\\')) {
      const first = v.slice(f.length).replace(/^\\+/, '').split('\\')[0].toLowerCase();
      if (isHostFile(first)) return value;
      return to + value.slice(from.replace(/\\+$/, '').length);
    }
    const drive = /^([a-z]):\\(.*)$/.exec(f);
    if (drive) {
      const bash = `/${drive[1]}/${drive[2].replace(/\\/g, '/')}`;
      const low = value.toLowerCase();
      if (low === bash || low.startsWith(bash + '/')) {
        const t = /^([A-Za-z]):\\(.*)$/.exec(to);
        const toBash = t ? `/${t[1].toLowerCase()}/${t[2].replace(/\\/g, '/')}` : to;
        return toBash + value.slice(bash.length);
      }
    }
  }
  return value;
}

/**
 * Every place a text names (a scheduled task's XML, say) put on the new place: Windows paths in either slash and Git Bash's
 * /d/... form, any case. Exported for tests.
 */
export function rebaseText(text: string, map: PathMap): string {
  let out = text;
  for (const [from, to] of map) {
    const f = from.replace(/[\\/]+$/, '');
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(f);
    const t = /^([A-Za-z]):[\\/](.*)$/.exec(to);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const forms: [string, string][] = [[f.replace(/\//g, '\\'), to.replace(/\//g, '\\')], [f.replace(/\\/g, '/'), to.replace(/\\/g, '/')]];
    if (drive && t) forms.push([`/${drive[1]}/${drive[2].replace(/\\/g, '/')}`, `/${t[1].toLowerCase()}/${t[2].replace(/\\/g, '/')}`]);
    for (const [a, b] of forms) out = out.replace(new RegExp(`${esc(a)}(?=$|[\\\\/"'\\s;<&])`, 'gi'), () => b);
  }
  return out;
}

/** Every string in a parsed JSON value put on the new place. Exported for tests. */
export function rebaseJson<T>(v: T, map: PathMap): { value: T; changed: number } {
  let changed = 0;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const n = rebasePath(x, map);
      if (n !== x) changed++;
      return n;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return { value: walk(v) as T, changed };
}
