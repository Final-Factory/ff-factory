/**
 * w5615: what the daemon does to an entry it has just moved into a folder the shared lock "on" keeps from workers (a cache
 * seed's new entry from mergeBack, a player the broker installed). Both are copied with a worker's rights into a folder
 * workers write (machine/workerCopy.ts, review w6212 B1), so the moved entry is still a worker's until this has run:
 *
 * - every OS: a worker could have swapped an entry of the stage for a link (a symlink or a junction to its own folder) or a
 *   hard link (one name in the seed, one where it writes) before the move. Every entry must be a plain folder or a file with
 *   one name; otherwise the whole entry is removed again. Checked before anything is labelled (review w6355 M1).
 * - Windows: the files a Low process made carry an explicit Low label of their own, which the Medium seed folder's label does
 *   not reach, so a worker could still write them. They are labelled Medium, all of them, by transcriptLabels.ts labelTree:
 *   never icacls /T, which follows a junction and would label its target. labelTree labels each folder before it reads its
 *   entries, so once a folder is Medium no worker can add a link to it; the check runs again after, for one made meanwhile.
 *
 * Left (docs/worker-root.md): a write handle a worker opened on a stage file before the move and keeps open. macOS: whether
 * Seatbelt's deny holds for a hard link a worker makes to a seed file from a folder it writes is a per-OS proof leg.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isLinkAt } from './workerCopy.ts';
import { isTrickName } from '../server/fsLink.ts';

export type LockExec = (cmd: string, args: string[], o?: { timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface LockInDeps {
  platform?: NodeJS.Platform;
  /** icacls on Windows; unused elsewhere. */
  exec: LockExec;
  removeTree: (p: string) => Promise<void>;
  log?: (l: string) => void;
}

/**
 * The first entry under `p` (itself included) that is not a plain folder or a one-name file, or undefined. A junction counts
 * as a link: its folder entry says so where lstat on Windows does not (machine/workerCopy.ts isLinkAt). So does a name ending
 * in a dot or a space, or a device name such as NUL (fsLink.ts isTrickName): labelTree skips one, so it would keep the
 * worker's own Low label (review w6452 M2). Exported for tests.
 */
export function firstUnplain(p: string): string | undefined {
  if (isLinkAt(p)) return p;
  const one = (q: string, link: boolean): string | undefined => {
    if (link || isTrickName(path.basename(q))) return q;
    const st = fs.lstatSync(q);
    if (st.isFile()) return st.nlink === 1 ? undefined : q;
    if (!st.isDirectory()) return q;
    for (const e of fs.readdirSync(q, { withFileTypes: true })) {
      const bad = one(path.join(q, e.name), e.isSymbolicLink());
      if (bad) return bad;
    }
    return undefined;
  };
  return one(p, false);
}

/** Locks `p` in place (see the header). True: it holds; false: it was removed (or could not be checked) and is said. */
export async function lockIn(p: string, d: LockInDeps): Promise<boolean> {
  const say = d.log ?? (() => {});
  try {
    let bad = firstUnplain(p);
    if (!bad && (d.platform ?? process.platform) === 'win32') {
      // Imported here: transcriptLabels.ts pulls in the server side, which the other OSes never need.
      const { icaclsOf, labelTree, setLabel } = await import('../server/transcriptLabels.ts');
      const icacls = icaclsOf(d.exec);
      const odd: string[] = [];
      const links = fs.lstatSync(p).isDirectory() ? await labelTree(p, 'medium', icacls, undefined, undefined, odd) : (await setLabel(p, 'medium', icacls), 0);
      bad = links ? `${p} (a link in it)` : odd.length ? odd[0] : firstUnplain(p);
    }
    if (!bad) return true;
    say(`shared lock: removed ${p} again: ${JSON.stringify(bad)} is a link, has a second name, or has a name ending in a dot or a space or a device name such as NUL (w5615, w6452)`);
  } catch (e) {
    say(`shared lock: removed ${p} again: could not lock it: ${(e as Error).message} (w5615)`);
  }
  try {
    // A file or a link goes by its own name (rd takes only a folder, and a junction it removes without its target).
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) {
      await d.removeTree(p);
      // rd /s /q answers 0 and leaves `x.`, `y ` and NUL in place, with all that is in them (measured on LothDesktop, w6452);
      // by its \\?\ path it removes them too, a junction in them without its target (measured).
      if (fs.lstatSync(p, { throwIfNoEntry: false }) && (d.platform ?? process.platform) === 'win32' && path.isAbsolute(p) && !p.startsWith('\\\\')) await d.removeTree(`\\\\?\\${path.resolve(p)}`);
    } else if (st) fs.rmSync(p, { force: true });
    if (fs.lstatSync(p, { throwIfNoEntry: false })) throw new Error('still there');
  } catch (e) {
    say(`shared lock: WARNING: could not remove ${p}: ${(e as Error).message}`);
  }
  return false;
}
