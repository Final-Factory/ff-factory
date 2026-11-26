// w5863, w5899: the path fence (docs/worker-fence.md, "The agents' PATH folders"). No npm package: linkJob-safe.
//
// Every agent the daemon starts, fenced or not, has the unity-slot shims folder first on its PATH (daemon.ts slotEnv):
// unity-slot, ff-pr, ff-leftovers, ffu-slot and the python shim. On macOS and Linux that folder was the Unity slots
// mailbox's `bin`, and both worker fences let workers write the mailbox (writeLock.ts `--rw <mailbox>`, workerFence.ts
// extraWritable): a fenced worker could replace `ff-pr` and have it run, unfenced, in the next agent outside the fence,
// with that agent's tokens. Windows moved its shims to `<root>/tools/shims` in w5838.
//
// "on" (w5899, the default) moves the shims to `<root>/tools-medium/shims` (enforcedShimDir), a folder both fences already
// keep read-only (writeLock.ts LOCKED_CHILDREN, workerFence.ts READ_ONLY_IN_ROOT: TOOLS_MEDIUM_CHILD), so no new fence
// rule is needed. A deny of `bin` inside the mailbox is not possible on Linux: Landlock only grants, and workers must keep
// making `req-*` files directly in the mailbox, so the mailbox cannot be granted child by child.
//
// Agent hosts outlive a daemon restart, each with the PATH it started with, so agents started before the move still run
// the old `bin` first, which a fenced worker can still write or make again. guardOldShimBin keeps it, the daemon's shims
// only, until they have ended, then removes it (w5872's review).
//
// "warn" (w5863's stage) leaves the shims in the mailbox and logs each write there the daemon did not make; "off" leaves
// them there unwatched: the recovery, `ops_worker machine_update path_fence off`.
//
// tools/node is not part of it off Windows: no agent runs it there (server/agentNode.ts agentNodePathDir is Windows only;
// server/lowIntegrity.test.ts pins that).
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_MEDIUM_CHILD } from '../server/claudeHome.ts';

export type PathFenceSetting = 'off' | 'warn' | 'on';

/** The mode for this daemon: unset is "on"; Windows is always "off" (its shims sit in `<root>/tools/shims`, w5838). */
export function pathFenceMode(setting: unknown, platform: NodeJS.Platform = process.platform): PathFenceSetting {
  if (platform === 'win32') return 'off';
  return setting === 'off' || setting === 'warn' ? setting : 'on';
}

/** Where the shims go once the path fence is on: a folder both fences keep read-only. */
export const enforcedShimDir = (root: string) => path.join(root, TOOLS_MEDIUM_CHILD, 'shims');

/** The shims folder for this mode: on (with a worker root) enforcedShimDir, else the mailbox's `bin`. */
export const shimDirFor = (mode: PathFenceSetting, mailbox: string, root: string | undefined) => (mode === 'on' && root ? enforcedShimDir(root) : path.join(mailbox, 'bin'));

/** The start line of the daemon's log. */
export function pathFenceLine(mode: PathFenceSetting, bin: string | undefined, root: string | undefined): string {
  if (mode === 'off') return `path fence: off; the unity-slot shims are in ${bin ?? 'the mailbox'}, which fenced workers can write, and writes there are not watched`;
  if (mode === 'on') return `path fence: on; the unity-slot shims are in ${bin}, first on every agent's PATH, which fenced workers cannot write. The recovery: ops_worker machine_update path_fence off`;
  return `path fence: warn only; nothing is refused, and each write to ${bin ?? 'the shims folder'} (first on every agent's PATH, fenced or not) that the daemon did not make is logged. Once on, the shims move to ${root ? enforcedShimDir(root) : '<root>/tools-medium/shims'}, which fenced workers cannot write`;
}

/**
 * Watch the shims folder and log each change the daemon did not make, at most one line per name per hour. Start it after
 * the daemon has written the shims: it writes them only at its start (daemon.ts, the Unity slots block). The folder's own
 * removal or replacement shows in its parent, the mailbox, which is watched for that one name (the mailbox itself is busy
 * with req-* files). Returns a stop function; a watch that cannot start is logged once.
 */
export function watchShimBin(bin: string, log: (l: string) => void, o: { now?: () => number } = {}): () => void {
  const now = o.now ?? Date.now;
  const said = new Map<string, number>();
  const ws: fs.FSWatcher[] = [];
  const say = (p: string) => {
    const t = now();
    if ((said.get(p) ?? -Infinity) > t - 3600_000) return;
    said.set(p, t);
    log(`path fence (warn): ${p} changed and the daemon did not write it. Every agent, unfenced ones too, runs the shims there first on its PATH; a fenced worker's write there is refused once the path fence is on (the shims move to <root>/tools-medium/shims)`);
  };
  const watch = (dir: string, only?: string): fs.FSWatcher | undefined => {
    try {
      const w = fs.watch(dir, { persistent: false }, (_ev, name) => {
        const n = typeof name === 'string' ? name : '';
        if (only !== undefined && n !== only) return;
        // The folder itself gone: inotify names it by its own name, which is not a child.
        const gone = only === undefined && (!n || (n === path.basename(dir) && !fs.existsSync(path.join(dir, n))));
        say(only !== undefined ? path.join(dir, only) : gone ? dir : path.join(dir, n));
        if (only !== undefined) rewatch();
      });
      w.on('error', (e) => log(`path fence (warn): the watch on ${dir} stopped (${(e as Error).message})`));
      ws.push(w);
      return w;
    } catch (e) {
      log(`path fence (warn): cannot watch ${dir} (${(e as Error).message}); writes there are not logged`);
      return undefined;
    }
  };
  // A bin removed and made again is a new folder: watch the new one (w5872's review). Its inode number can be the old
  // one's (ext4 reuses them), so every mailbox event for bin while it exists starts a fresh watch; they are rare.
  let binW: fs.FSWatcher | undefined;
  const rewatch = () => {
    if (!fs.existsSync(bin)) return;
    binW?.close();
    binW = watch(bin);
  };
  binW = watch(bin);
  watch(path.dirname(bin), path.basename(bin));
  return () => {
    for (const w of ws) w.close();
  };
}

/** Where guardOldShimBin moves what it takes out of the old shims folder: inside `<root>/tools-medium`, which workers cannot write. */
export const shimQuarantineDir = (root: string) => path.join(root, TOOLS_MEDIUM_CHILD, 'quarantine');

/**
 * w5899, w5872's and w6063's reviews: the old shims folder (the mailbox's `bin`) while agents started before the move
 * still run with it first on their PATH. `waits` answers them (session ids); none: the old folder goes at once.
 * Otherwise `bin` becomes one symbolic link to `target` (`<root>/tools-medium/shims`, which workers cannot write), so
 * those agents run the daemon's own shims and a write through the link is refused by the fence. Whatever is at `bin`
 * and is not that link (a folder, a planted file, a link elsewhere, there before the daemon started or made since) is
 * renamed into `quarantine` (a daemon-only folder) and removed there, never through a path a worker can swap (w6063
 * probe C deleted a folder outside the mailbox through a swapped `bin`); then the link is made again. On every change
 * to `bin` seen in the mailbox, and every `everyMs`. Once `waits` is empty the link goes the same way. A worker can still
 * swap the link for its own folder and win the moment before the guard undoes it: the hole is narrowed to a race for
 * those agents only, and new agents never have the folder on their PATH. Returns a stop.
 */
export function guardOldShimBin(bin: string, o: { target: string; quarantine: string; waits: () => string[]; log: (l: string) => void; everyMs?: number; now?: () => number }): () => void {
  const now = o.now ?? Date.now;
  let n = 0;
  /** Take whatever is at `bin` out of the mailbox: rename it into the quarantine, then remove it there. */
  const evict = (): boolean => {
    const st = lstat(bin);
    if (!st) return false;
    fs.mkdirSync(o.quarantine, { recursive: true, mode: 0o700 });
    const away = path.join(o.quarantine, `bin-${process.pid}-${now()}-${n++}`);
    try {
      // rename moves the entry itself (a link stays a link), never what it points to.
      fs.renameSync(bin, away);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      // Another file system: a link can still be unlinked (unlink never follows; a folder swapped in meanwhile fails it).
      if (code === 'EXDEV' && st.isSymbolicLink()) {
        fs.unlinkSync(bin);
        return true;
      }
      throw e;
    }
    fs.rmSync(away, { recursive: true, force: true });
    return true;
  };
  const drop = (why: string) => {
    try {
      if (evict()) o.log(`path fence: removed the old shims folder ${bin}: ${why}`);
    } catch (e) {
      o.log(`path fence: could not remove the old shims folder ${bin}: ${(e as Error).message}`);
    }
  };
  const first = o.waits();
  if (!first.length) {
    drop('no agent started before the move runs');
    return () => undefined;
  }
  o.log(`path fence: keeping the old shims folder ${bin} for ${first.length} agent${first.length === 1 ? '' : 's'} started before the move (${first.join(', ')}): their PATH still names it. Until they end it is a link to ${o.target}, and anything else put there is undone`);
  const said = new Map<string, number>();
  let started = false;
  const mend = () => {
    let fixed: string | undefined;
    try {
      const st = lstat(bin);
      if (st?.isSymbolicLink() && fs.readlinkSync(bin) === o.target) return;
      const had = evict();
      fs.symlinkSync(o.target, bin, 'dir');
      // The first mend replaces the daemon's own old folder (the line above says so); a change after that is a worker's.
      if (had && started) fixed = bin;
    } catch (e) {
      fixed = `${bin} (not mended: ${(e as Error).message})`;
    } finally {
      started = true;
    }
    if (!fixed) return;
    const t = now();
    if ((said.get(fixed) ?? -Infinity) > t - 3600_000) return;
    said.set(fixed, t);
    o.log(`path fence: undid a change the daemon did not make in the old shims folder, which agents started before the move still run first on their PATH: ${fixed}`);
  };
  let parentW: fs.FSWatcher | undefined;
  try {
    parentW = fs.watch(path.dirname(bin), { persistent: false }, (_ev, name) => {
      if (name === null || name === path.basename(bin)) mend();
    });
    parentW.on('error', () => undefined);
  } catch {
    parentW = undefined;
  }
  mend();
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    parentW?.close();
  };
  const timer = setInterval(() => {
    if (stopped) return;
    const left = o.waits();
    if (left.length) return mend();
    stop();
    drop('every agent started before the move has ended');
  }, o.everyMs ?? 60_000);
  timer.unref?.();
  return stop;
}

const lstat = (p: string) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
};
