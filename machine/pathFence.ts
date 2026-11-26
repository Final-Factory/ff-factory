// w5863: the path fence (docs/worker-fence.md, "The agents' PATH folders"). No npm package: linkJob-safe.
//
// Every agent the daemon starts, fenced or not, has the unity-slot shims folder first on its PATH (daemon.ts slotEnv):
// unity-slot, ff-pr, ff-leftovers, ffu-slot and the python shim. On macOS and Linux that folder is the Unity slots
// mailbox's `bin`, and both worker fences let workers write the mailbox (writeLock.ts `--rw <mailbox>`, workerFence.ts
// extraWritable): a fenced worker could replace `ff-pr` and have it run, unfenced, in the next agent outside the fence,
// with that agent's tokens. Windows moved its shims to `<root>/tools/shims` in w5838.
//
// The fix moves the shims to `<root>/tools-medium/shims` (enforcedShimDir), a folder both fences already keep read-only
// (writeLock.ts LOCKED_CHILDREN, workerFence.ts READ_ONLY_IN_ROOT: TOOLS_MEDIUM_CHILD), so no new fence rule is needed.
// A deny of `bin` inside the mailbox is not possible on Linux: Landlock only grants, and workers must keep making
// `req-*` files directly in the mailbox, so the mailbox cannot be granted child by child.
//
// lothsahn's lockout rule: this first stage is warn-only. "warn" (the default) leaves the shims where they are and logs
// each write to their folder that the daemon did not make; "off" stops the watch (the recovery, `ops_worker machine_update
// path_fence off`). The move itself comes in a separate, later pull request.
//
// tools/node is not part of it off Windows: no agent runs it there (server/agentNode.ts agentNodePathDir is Windows only;
// server/lowIntegrity.test.ts pins that).
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_MEDIUM_CHILD } from '../server/claudeHome.ts';

export type PathFenceSetting = 'off' | 'warn';

/** The mode for this daemon: unset is "warn"; Windows is always "off" (its shims sit in `<root>/tools/shims`, w5838). */
export function pathFenceMode(setting: unknown, platform: NodeJS.Platform = process.platform): PathFenceSetting {
  if (platform === 'win32') return 'off';
  return setting === 'off' ? 'off' : 'warn';
}

/** Where the shims go once the path fence is on (the later pull request): a folder both fences keep read-only. */
export const enforcedShimDir = (root: string) => path.join(root, TOOLS_MEDIUM_CHILD, 'shims');

/** The start line of the daemon's log. */
export function pathFenceLine(mode: PathFenceSetting, bin: string | undefined, root: string | undefined): string {
  if (mode === 'off') return 'path fence: off; writes to the unity-slot shims folder are not watched';
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
  const watch = (dir: string, only?: string) => {
    try {
      const w = fs.watch(dir, { persistent: false }, (_ev, name) => {
        const n = typeof name === 'string' ? name : '';
        if (only !== undefined && n !== only) return;
        say(only !== undefined ? path.join(dir, only) : n ? path.join(dir, n) : dir);
      });
      w.on('error', (e) => log(`path fence (warn): the watch on ${dir} stopped (${(e as Error).message})`));
      ws.push(w);
    } catch (e) {
      log(`path fence (warn): cannot watch ${dir} (${(e as Error).message}); writes there are not logged`);
    }
  };
  watch(bin);
  watch(path.dirname(bin), path.basename(bin));
  return () => {
    for (const w of ws) w.close();
  };
}
