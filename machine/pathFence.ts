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

/**
 * w5899, w5872's review: the old shims folder (the mailbox's `bin`) while agents started before the move still run with
 * it first on their PATH. `waits` answers them (session ids); none: the folder goes at once. Otherwise `restore` writes the
 * daemon's shims there, and on every change seen there, and every `everyMs`, anything else in it goes and a shim changed
 * is written back (removed first, so a planted link is not written through); the folder itself, removed or replaced, is
 * made again. Once `waits` is empty the folder goes. A worker's write there still runs until it is put back: the guard
 * narrows the hole to a race for those agents only, and new agents never have the folder on their PATH. Returns a stop.
 */
export function guardOldShimBin(bin: string, o: { restore: () => void; waits: () => string[]; log: (l: string) => void; everyMs?: number; now?: () => number }): () => void {
  const now = o.now ?? Date.now;
  const drop = (why: string) => {
    try {
      if (!fs.existsSync(bin) && !isLink(bin)) return;
      fs.rmSync(bin, { recursive: !isLink(bin), force: true });
      o.log(`path fence: removed the old shims folder ${bin}: ${why}`);
    } catch (e) {
      o.log(`path fence: could not remove the old shims folder ${bin}: ${(e as Error).message}`);
    }
  };
  const first = o.waits();
  if (!first.length) {
    drop('no agent started before the move runs');
    return () => undefined;
  }
  o.log(`path fence: keeping the old shims folder ${bin} for ${first.length} agent${first.length === 1 ? '' : 's'} started before the move (${first.join(', ')}): their PATH still names it. Until they end it holds the daemon's shims only, and anything else written there is undone`);
  let snap = new Map<string, { data: Buffer; mode: number }>();
  try {
    o.restore();
    snap = new Map(fs.readdirSync(bin).map((n) => [n, { data: fs.readFileSync(path.join(bin, n)), mode: fs.statSync(path.join(bin, n)).mode & 0o7777 }]));
  } catch (e) {
    o.log(`path fence: could not write the old shims folder ${bin} (${(e as Error).message}); agents started before the move may not find unity-slot`);
  }
  const said = new Map<string, number>();
  const mend = (fromParent = false) => {
    const fixed: string[] = [];
    try {
      const st = lstat(bin);
      if (!st || !st.isDirectory()) {
        if (st) fs.rmSync(bin, { force: true });
        fs.mkdirSync(bin, { recursive: true, mode: 0o755 });
        fixed.push(bin);
      }
      for (const n of fs.readdirSync(bin)) {
        if (snap.has(n)) continue;
        fs.rmSync(path.join(bin, n), { recursive: !isLink(path.join(bin, n)), force: true });
        fixed.push(path.join(bin, n));
      }
      for (const [n, s] of snap) {
        const p = path.join(bin, n);
        const l = lstat(p);
        if (l?.isFile() && (l.mode & 0o7777) === s.mode && fs.readFileSync(p).equals(s.data)) continue;
        if (l) fs.rmSync(p, { recursive: l.isDirectory(), force: true });
        fs.writeFileSync(p, s.data, { mode: s.mode, flag: 'wx' });
        fs.chmodSync(p, s.mode);
        fixed.push(p);
      }
    } catch (e) {
      fixed.push(`${bin} (not mended: ${(e as Error).message})`);
    }
    const t = now();
    const fresh = fixed.filter((f) => (said.get(f) ?? -Infinity) <= t - 3600_000);
    for (const f of fresh) said.set(f, t);
    if (fresh.length) o.log(`path fence: undid a change the daemon did not make in the old shims folder, which agents started before the move still run first on their PATH: ${fresh.join(', ')}`);
    if (fromParent || !binW || fixed.includes(bin)) rewatch();
  };
  let binW: fs.FSWatcher | undefined;
  const watch = (dir: string, only?: string) => {
    try {
      const w = fs.watch(dir, { persistent: false }, (_ev, name) => {
        if (only !== undefined && name !== only) return;
        mend(only !== undefined);
      });
      w.on('error', () => undefined);
      return w;
    } catch {
      return undefined;
    }
  };
  // A bin made again is a new folder (the inode number can repeat on ext4): every mend watches it afresh.
  const rewatch = () => {
    binW?.close();
    binW = watch(bin);
  };
  const parentW = watch(path.dirname(bin), path.basename(bin));
  mend();
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    binW?.close();
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
const isLink = (p: string) => !!lstat(p)?.isSymbolicLink();
