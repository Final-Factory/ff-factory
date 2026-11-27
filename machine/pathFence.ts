// w5863, w5899: the path fence (docs/worker-fence.md, "The agents' PATH folders"). No npm package: linkJob-safe.
//
// Every agent the daemon starts, fenced or not, has the unity-slot shims folder first on its PATH (daemon.ts slotEnv):
// unity-slot, ff-pr, ff-leftovers, ffu-slot and the python shim. On macOS and Linux that folder was the Unity slots
// mailbox's `bin`, and both worker fences let workers write the mailbox (writeLock.ts `--rw <mailbox>`, workerFence.ts
// extraWritable): a fenced worker could replace `ff-pr` and have it run, unfenced, in the next agent outside the fence,
// with that agent's tokens. Windows moved its shims to `<root>/tools/shims` in w5838 and to `<root>/tools-medium/shims` in w6101.
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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_MEDIUM_CHILD } from '../server/claudeHome.ts';

export type PathFenceSetting = 'off' | 'warn' | 'on';

/** The mode for this daemon: unset is "on"; Windows is always "off" (its shims sit in `<root>/tools-medium/shims`, Medium, w5838 and w6101). */
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
    // w6080 F: a worker's chmod of <root>/tools-medium or of the quarantine (Landlock refuses none) stopped every
    // rename into it, and of the mailbox (bin's parent, which a rename out of needs write on) the same: each put back.
    // w6144 (w6103 note 3): before bin is looked at: in a mailbox (or root) at 000 the look itself fails, and bin was
    // never mended. Owner bits only are added; every agent runs as the daemon's user.
    ownFolderBits(path.dirname(path.dirname(o.quarantine)), 0o700);
    ownFolderBits(path.dirname(bin), 0o700);
    const st = lstat(bin);
    if (!st) return false;
    ownFolderMode(path.dirname(o.quarantine), 0o755);
    fs.mkdirSync(o.quarantine, { recursive: true, mode: 0o700 });
    ownFolderMode(o.quarantine, 0o700);
    const away = path.join(o.quarantine, `bin-${process.pid}-${now()}-${n++}`);
    for (let i = 0; ; i++) {
      // w6074 D: moving a folder to another parent needs write on the folder itself (its `..`), so a worker's chmod 555
      // of its folder at bin would stop the rename for good. The daemon owns it too: open it without following a link
      // and fchmod it first. A worker that chmods it back in between only buys a retry.
      if (lstat(bin)?.isDirectory()) ownFolderMode(bin, 0o700);
      try {
        // rename moves the entry itself (a link stays a link), never what it points to.
        fs.renameSync(bin, away);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return false;
        // Another file system: a link can still be unlinked (unlink never follows; a folder swapped in meanwhile fails it).
        if (code === 'EXDEV' && st.isSymbolicLink()) {
          fs.unlinkSync(bin);
          return true;
        }
        if ((code === 'EACCES' || code === 'EPERM') && i < 4) continue;
        throw e;
      }
    }
    // In the quarantine, which no worker can write: folders inside made writable first (a 555 one stops rmSync), then
    // removed. A failure leaves it there, harmless, and does not stop the link being made again.
    try {
      removeTree(away);
    } catch (e) {
      o.log(`path fence: could not remove ${away} from the quarantine: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
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
      // Keyed on the error's code, not its message: the message names a new quarantine path each time (w6074 P11).
      fixed = `${bin} (not mended: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name})`;
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

/**
 * A handle on a real folder at `p`, never through a link. A folder whose owner may not read it (a worker's chmod 000;
 * w6080 P13r) cannot be opened even by its owner: then, if it is a real folder, owner rwx is given back by path and it is
 * opened again, and refused if what opened is not what was looked at (a swap in between).
 */
function openOwnFolder(p: string): number | undefined {
  const c = fs.constants;
  const flags = c.O_RDONLY | (c.O_DIRECTORY ?? 0) | (c.O_NOFOLLOW ?? 0);
  try {
    return fs.openSync(p, flags);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EACCES') return undefined;
  }
  const st = lstat(p);
  if (!st?.isDirectory()) return undefined;
  try {
    // w6144 (w6103 note 2): a link swapped in at p after the lstat above must not have its target chmodded. On macOS,
    // where Seatbelt refuses a worker's own chmod (a won race would be a gain), `chmod -h` (fchmodat with
    // AT_SYMLINK_NOFOLLOW) sets a link's own mode, never its target's. Node has no route: its lchmodSync opens the path
    // for writing (EISDIR on a folder), and no open of a folder at 000 succeeds, O_EVTONLY and O_SYMLINK included
    // (measured on m5). Only this rare case spawns. Linux has no lchmod for a folder, and there Landlock lets the worker
    // chmod the target itself anyway, so a path chmod gives it nothing it lacks.
    const m = ((st.mode & 0o7777) | 0o700).toString(8);
    if (process.platform === 'darwin') {
      const r = spawnSync('/bin/chmod', ['-h', m, '--', p], { stdio: 'ignore', timeout: 10_000 });
      if (r.status !== 0) return undefined;
    } else fs.chmodSync(p, parseInt(m, 8));
    const fd = fs.openSync(p, flags);
    const now = fs.fstatSync(fd);
    if (now.ino === st.ino && now.dev === st.dev) return fd;
    fs.closeSync(fd);
  } catch {
    // Left as it is; the next look tries again.
  }
  return undefined;
}

/** Set a real folder's mode (`set` gives the whole mode, else `bits` are added to it), never through a link. */
function ownFolder(p: string, mode: number, set: boolean): boolean {
  const fd = openOwnFolder(p);
  if (fd === undefined) return false;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isDirectory()) return false;
    const want = set ? mode : (st.mode & 0o7777) | mode;
    if ((st.mode & 0o7777) !== want) fs.fchmodSync(fd, want);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Set a folder's mode through a handle that never follows a link (no chmod through a path a worker can swap). */
export const ownFolderMode = (p: string, mode: number) => ownFolder(p, mode, true);

/** Give a folder at least `bits` (its other bits kept), the same way. */
export const ownFolderBits = (p: string, bits: number) => ownFolder(p, bits, false);

/** Remove a tree only the daemon can write (the quarantine): every real folder in it made 0700 first, links never followed. */
function removeTree(p: string) {
  const walk = (q: string) => {
    if (!lstat(q)?.isDirectory()) return;
    fs.chmodSync(q, 0o700);
    for (const n of fs.readdirSync(q)) walk(path.join(q, n));
  };
  walk(p);
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * w6074 E: Landlock has no right for a file's mode, so a fenced worker can chmod what is in `<root>/tools-medium/shims`
 * though it cannot write there: `chmod 000 ff-pr` takes ff-pr from every agent, `chmod 500` on the folder makes the
 * daemon's next writeShims fail (and it would fall back to warn). Before the daemon writes the shims: the folder 0755,
 * each file in it readable and writable by its owner again. No worker can make a link there, so a plain chmod is safe.
 */
export function readyShimDir(dir: string): void {
  // w6080 G: and its parent, <root>/tools-medium: a chmod 000 there (or 555 before the shims folder exists, a first
  // deploy) made writeShims fail too.
  ownFolderMode(path.dirname(dir), 0o755);
  if (!lstat(dir)) return;
  ownFolderMode(dir, 0o755);
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = lstat(p);
    if (st?.isFile() && (st.mode & 0o600) !== 0o600) fs.chmodSync(p, (st.mode & 0o7777) | 0o600);
  }
}

/**
 * w6074 E: then, while the daemon runs, the modes it wrote there are put back on every change seen in the folder (a
 * chmod is one) and every `everyMs`, the folder's included; logged once per name an hour. Returns a stop.
 */
export function guardShimModes(dir: string, o: { log: (l: string) => void; everyMs?: number; now?: () => number }): ShimModeGuard {
  const now = o.now ?? Date.now;
  const want = new Map<string, number>();
  /** The modes the daemon gave: read from the folder just after it wrote the shims there. */
  const learnModes = () => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // Not there (the daemon could not write it, w6080): the folders' modes are still guarded.
    }
    want.clear();
    for (const n of names) {
      const st = lstat(path.join(dir, n));
      if (st?.isFile()) want.set(n, st.mode & 0o7777);
    }
  };
  learnModes();
  const said = new Map<string, number>();
  const mend = () => {
    const fixed: string[] = [];
    try {
      // w6080 G: <root>/tools-medium as well: a chmod 000 there takes the shims from every agent.
      for (const f of [path.dirname(dir), dir]) {
        const d = lstat(f);
        if (d?.isDirectory() && (d.mode & 0o7777) !== 0o755 && ownFolderMode(f, 0o755)) fixed.push(f);
      }
      for (const [n, m] of want) {
        const p = path.join(dir, n);
        const st = lstat(p);
        if (!st?.isFile() || (st.mode & 0o7777) === m) continue;
        fs.chmodSync(p, m);
        fixed.push(p);
      }
    } catch (e) {
      fixed.push(`${dir} (not mended: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name})`);
    }
    const t = now();
    const fresh = fixed.filter((f) => (said.get(f) ?? -Infinity) <= t - 3600_000);
    for (const f of fresh) said.set(f, t);
    if (fresh.length) o.log(`path fence: put back the mode the daemon gave in the shims folder: ${fresh.join(', ')}`);
  };
  const ws = new Map<string, fs.FSWatcher>();
  const watch = () => {
    for (const f of [dir, path.dirname(dir)]) {
      if (ws.has(f)) continue;
      try {
        const w = fs.watch(f, { persistent: false }, () => mend());
        w.on('error', () => undefined);
        ws.set(f, w);
      } catch {
        // Not there yet, or not readable: the timer still mends, and learn() watches it again.
      }
    }
  };
  watch();
  const timer = setInterval(mend, o.everyMs ?? 60_000);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    for (const w of ws.values()) w.close();
    ws.clear();
  };
  // w6144 (w6103 note 1): after a failed start write, the 60 s retry writes the shims later; the guard learns their
  // modes then (it had none to guard) and watches the folder if it could not before.
  return Object.assign(stop, {
    learn: () => {
      learnModes();
      watch();
    },
  });
}

/**
 * w6080 G, w6144: the daemon's shim write in <root>/tools-medium/shims failed at start (no fallback into the mailbox):
 * tried again every `everyMs` (a minute) until one succeeds; then `wrote()` (the mode guard learns the new shims).
 * Returns the timer.
 */
export function retryShimWrite(dir: string, o: { write: (dir: string) => void; wrote: () => void; log: (l: string) => void; everyMs?: number }): NodeJS.Timeout {
  const retry = setInterval(() => {
    try {
      readyShimDir(dir);
      o.write(dir);
    } catch {
      // Logged once at start; the next try comes.
      return;
    }
    clearInterval(retry);
    o.wrote();
    o.log(`path fence: wrote the shims in ${dir}`);
  }, o.everyMs ?? 60_000);
  retry.unref?.();
  return retry;
}

/** guardShimModes' answer: call it to stop; `learn()` after the daemon writes the shims again. */
export type ShimModeGuard = (() => void) & { learn: () => void };

/**
 * w6080 (off and warn): the shims go in the mailbox's `bin`; where `bin` is still the link guardOldShimBin made (to
 * <root>/tools-medium/shims, perhaps gone), take the link away first so they are written into a real folder there.
 */
export function unlinkShimBinLink(bin: string): boolean {
  if (!lstat(bin)?.isSymbolicLink()) return false;
  fs.unlinkSync(bin);
  return true;
}

const lstat = (p: string) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
};
