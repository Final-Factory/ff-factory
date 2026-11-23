import fs from 'node:fs';
import { execFile } from 'node:child_process';

/**
 * Mounts inside a folder clean-up removes (w5276). A worker on biscuit ran a desktop session with its runtime folder in
 * its own temp folder, so gvfsd-fuse and the document portal mounted FUSE file systems at `<temp>/w994/gs/gvfs` and
 * `<temp>/w994/gs/doc`. Their daemons died, the mounts stayed ("Transport endpoint is not connected"), and every pass
 * failed with EBUSY: a mount point cannot be removed while mounted. Before a delete, a dead FUSE mount of ours inside the
 * folder (its endpoint answers ENOTCONN) is lazily unmounted; any other mount inside refuses the folder whole, since a
 * recursive delete would walk into it and delete what it shows (the document portal shows a person's own files).
 * The caller's guard decides WHAT may go; this only clears what stops the delete. Linux only: elsewhere there is no
 * /proc/self/mountinfo and nothing is found.
 */

export interface Mount {
  point: string;
  fstype: string;
}

/** `/proc/self/mountinfo`'s octal escapes (`\040` for a space) decoded. */
function unescape(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

/** The mount points and file system types in a mountinfo text (proc(5): field 5 is the point, the first field after `-` the type). */
export function parseMountinfo(text: string): Mount[] {
  const out: Mount[] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(' ');
    const dash = f.indexOf('-');
    if (f.length < 7 || dash < 6 || dash + 1 >= f.length) continue;
    out.push({ point: unescape(f[4]), fstype: f[dash + 1] });
  }
  return out;
}

/** The mounts at or inside `dir`, deepest first (an inner mount comes off before the one it sits on). */
export function mountsUnder(dir: string, mounts: Mount[]): Mount[] {
  const d = dir.replace(/\/+$/, '');
  return mounts.filter((m) => m.point === d || m.point.startsWith(`${d}/`)).sort((a, b) => b.point.length - a.point.length);
}

/** The system calls, on one object so a test can stand in for them. */
export const mountOps = {
  async mountinfo(): Promise<string> {
    if (process.platform !== 'linux') return '';
    return fs.promises.readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
  },
  /** Whether a FUSE mount's daemon is gone: its root answers ENOTCONN. */
  async dead(point: string): Promise<boolean> {
    try {
      await fs.promises.stat(point);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOTCONN';
    }
  },
  /** Lazy unmount as the daemon's own user (fusermount refuses another user's mount; no sudo). */
  async unmount(point: string): Promise<void> {
    const run = (cmd: string) => new Promise<void>((res, rej) => execFile(cmd, ['-u', '-z', point], { timeout: 15_000 }, (e) => (e ? rej(e) : res())));
    await run('fusermount3').catch(() => run('fusermount'));
  },
};

/**
 * Clear the mounts inside `dir` before its delete: a dead FUSE mount is unmounted; anything else answers `live` (the
 * caller refuses the folder). `cleared` lists what came off.
 */
export async function clearDeadMounts(dir: string): Promise<{ cleared: string[]; live?: string }> {
  const inside = mountsUnder(dir, parseMountinfo(await mountOps.mountinfo()));
  const cleared: string[] = [];
  for (const m of inside) {
    if (!m.fstype.startsWith('fuse') || !(await mountOps.dead(m.point))) return { cleared, live: m.point };
    try {
      await mountOps.unmount(m.point);
      cleared.push(m.point);
    } catch {
      return { cleared, live: m.point };
    }
  }
  if (cleared.length) {
    const left = mountsUnder(dir, parseMountinfo(await mountOps.mountinfo()));
    if (left.length) return { cleared, live: left[0].point };
  }
  return { cleared };
}

/**
 * w5285: the FUSE mounts in a worker's OWN temp folder, live or dead, taken off (deepest first) by `ff-leftovers end`.
 * Only a desktop session the worker started there mounts anything in that folder (gvfsd-fuse at `<runtime>/gvfs`, the
 * document portal at `<runtime>/doc`, when its XDG_RUNTIME_DIR pointed inside), so a lazy unmount takes nothing from
 * anyone else, and it deletes nothing: what a mount shows is left where it really lives. A mount that is not FUSE is
 * only reported (`left`).
 */
export async function unmountOwnFuse(dir: string | undefined): Promise<{ cleared: string[]; left: Mount[] }> {
  if (!dir) return { cleared: [], left: [] };
  const cleared: string[] = [];
  for (const m of mountsUnder(dir, parseMountinfo(await mountOps.mountinfo()))) {
    if (!m.fstype.startsWith('fuse')) continue;
    try {
      await mountOps.unmount(m.point);
      cleared.push(m.point);
    } catch {
      // judged again below: still in the table means it stayed
    }
  }
  const left = mountsUnder(dir, parseMountinfo(await mountOps.mountinfo()));
  return { cleared: cleared.filter((p) => !left.some((m) => m.point === p)), left };
}

/** w5285: the mounts in a worker's own temp folder, as `ff-leftovers list` shows them. */
export async function mountsIn(dir: string | undefined): Promise<Mount[]> {
  return dir ? mountsUnder(dir, parseMountinfo(await mountOps.mountinfo())) : [];
}
