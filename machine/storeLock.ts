/**
 * The store lock (w5614, step 3 of stage 1 of w5544; docs/machines.md "Slot repos"): once every sandbox is a slot repo
 * (machine/slotRepo.ts), no worker needs to write the main clone (`<root>/repo`, the store), so the worker fences stop
 * letting them: Seatbelt on macOS and Landlock on Linux leave `repo` out of the write set (server/workerFence.ts fenceFor,
 * machine/writeLock.ts writeLockArgs), and on Windows its git folder is labelled Medium instead of Low (lowTargets), so a
 * Low worker reads it (the borrowed objects, LFS) and cannot write it. The daemon still writes it, at Medium and unfenced:
 * the fetch before a new sandbox, the kept branches and stash, the prune guard.
 *
 * daemon.json `storeLock` (set by `ops_worker machine_update store_lock`):
 * - unset or "off": nothing changes;
 * - "warn": nothing is refused; the daemon watches the store and logs each write it did not make itself (a worker's, or a
 *   person's own git in the clone), the writes the lock would refuse, plus what still keeps the lock off;
 * - "on": the lock applies, but only when nothing needs the store writable: every sandbox a slot repo, no worktree of the
 *   store left, the store at `<root>/repo`. Otherwise it stays off, says why, and warns as "warn" does. It is decided once
 *   per daemon process, like the fences it changes, and while it holds, new sandboxes are slot repos whatever slot_repos says.
 *
 * Way back: `store_lock off` (or `worker_fence off`) and the daemon's restart that the update makes; the next workers'
 * fences open `repo` again, and on Windows lowSetup labels its git folder Low again.
 */
import fs from 'node:fs';
import path from 'node:path';

export type StoreLockSetting = 'off' | 'warn' | 'on';

/** The root child that holds the store. */
export const STORE_CHILD = 'repo';

/** The store's git folder: `<repo>/.git` for a clone with a working tree, the folder itself for a bare one. */
export function storeGitFolder(repo: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const git = path.join(repo, '.git');
  if (exists(path.join(git, 'HEAD'))) return git;
  if (exists(path.join(repo, 'HEAD')) && exists(path.join(repo, 'objects'))) return repo;
  return undefined;
}

export interface StoreLockInput {
  setting?: string;
  root?: string;
  /** daemon.json repoPath: the store. */
  repoPath: string;
  /** Every sandbox folder the pool knows. */
  sandboxes: { id: string; path: string }[];
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  readDir?: (p: string) => string[];
  readFile?: (p: string) => string;
  isSlotRepo: (dir: string) => boolean;
}

export interface StoreLockDecision {
  setting: StoreLockSetting;
  /** The fences leave the store read-only to workers. */
  locked: boolean;
  /** The daemon watches the store and logs writes it did not make ("warn", or "on" held off). */
  watch: boolean;
  /** The store's git folder, when found. */
  gitDir?: string;
  /** What keeps "on" from applying (empty when it applies or is not asked for). */
  blockers: string[];
}

const same = (a: string, b: string) => {
  const r = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const x = r(a);
  const y = r(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** The setting as daemon.json has it; anything unknown is "off". */
export function storeLockSetting(v: unknown): StoreLockSetting {
  return v === 'warn' || v === 'on' ? v : 'off';
}

/**
 * Whether the store lock holds for this daemon process, and why not. Worktrees still registered in the store
 * (`<git>/worktrees/<name>/gitdir` naming a folder that is there) need it writable: their index, HEAD and refs live in it.
 */
export function decideStoreLock(i: StoreLockInput): StoreLockDecision {
  const setting = storeLockSetting(i.setting);
  if (setting === 'off') return { setting, locked: false, watch: false, blockers: [] };
  const exists = i.exists ?? fs.existsSync;
  const readDir = i.readDir ?? ((p: string) => fs.readdirSync(p));
  const readFile = i.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const blockers: string[] = [];
  const gitDir = storeGitFolder(i.repoPath, exists);
  if (!i.root) blockers.push('this install has no worker root');
  else if (!same(i.repoPath, path.join(i.root, STORE_CHILD))) blockers.push(`the main clone ${i.repoPath} is not ${path.join(i.root, STORE_CHILD)}, the folder the fences close`);
  if (!gitDir) blockers.push(`no git folder found at ${i.repoPath}`);
  const p = i.platform ?? process.platform;
  if (p !== 'win32' && p !== 'darwin' && p !== 'linux') blockers.push(`no fence on ${p}`);
  const worktrees: string[] = [];
  if (gitDir) {
    const wt = path.join(gitDir, 'worktrees');
    let names: string[] = [];
    try {
      names = exists(wt) ? readDir(wt) : [];
    } catch {
      names = [];
    }
    for (const n of names) {
      let target = '';
      try {
        target = readFile(path.join(wt, n, 'gitdir')).trim();
      } catch {
        continue;
      }
      // gitdir names `<worktree>/.git`; a worktree whose folder is gone is git's to prune, not a reason to stay open.
      if (target && exists(path.dirname(target))) worktrees.push(path.dirname(target));
    }
  }
  if (worktrees.length) blockers.push(`${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'} of the main clone still there (${worktrees.slice(0, 6).map((w) => path.basename(w)).join(', ')}${worktrees.length > 6 ? ', …' : ''}): with slot_repos all, idle ones become slot repos within minutes`);
  const notSlot = i.sandboxes.filter((s) => exists(s.path) && !i.isSlotRepo(s.path) && !worktrees.some((w) => same(w, s.path)));
  if (notSlot.length) blockers.push(`sandbox${notSlot.length === 1 ? '' : 'es'} ${notSlot.map((s) => s.id).join(', ')} not a slot repo`);
  if (setting === 'warn') return { setting, locked: false, watch: !!gitDir, ...(gitDir ? { gitDir } : {}), blockers };
  const locked = blockers.length === 0;
  return { setting, locked, watch: !locked && !!gitDir, ...(gitDir ? { gitDir } : {}), blockers };
}

/** The log line for a decision. */
export function storeLockLine(d: StoreLockDecision): string | undefined {
  if (d.setting === 'off') return undefined;
  if (d.locked) return `store lock: on; the main clone's ${d.gitDir ?? 'git folder'} is read-only to sandbox workers (w5614); new sandboxes are slot repos`;
  const why = d.blockers.length ? d.blockers.join('; ') : 'nothing keeps it off';
  if (d.setting === 'warn') return `store lock: warn only; nothing is refused, and writes to the main clone the daemon did not make are logged. With "on" it would ${d.blockers.length ? `stay off: ${why}` : 'apply now'}`;
  return `store lock: on asked, but held off (writes the daemon did not make are logged instead): ${why}`;
}

/**
 * The daemon's own git calls: a write to the store while one runs, or within GRACE_MS after, is taken as the daemon's.
 * Every git the sandbox pool runs is counted (PoolDeps.git), in the store or not: it is the warning's filter, not a fence.
 */
let running = 0;
let lastEnd = 0;
export const GRACE_MS = 5000;
export async function daemonGit<T>(p: Promise<T>): Promise<T> {
  running++;
  try {
    return await p;
  } finally {
    running--;
    lastEnd = Date.now();
  }
}
export const daemonGitBusy = (now = Date.now()) => running > 0 || now - lastEnd < GRACE_MS;

/** Store paths whose change is not a write the lock would refuse, or is too noisy to say: git's own lock and log files. */
export function ignoredStorePath(rel: string): boolean {
  const r = rel.replace(/\\/g, '/');
  return r === '' || r.endsWith('.lock') || r.startsWith('worktrees/') || r === 'FETCH_HEAD' || r.startsWith('logs/') || r === 'gc.log';
}

/**
 * Watch the store's git folder ("warn", or "on" held off) and log each write the daemon did not make itself, at most one line
 * per top-level path (refs, objects, config...) per hour. Returns a stop function; a watch that cannot start is logged once.
 */
export function watchStore(gitDir: string, log: (l: string) => void, o: { busy?: () => boolean; now?: () => number } = {}): () => void {
  const busy = o.busy ?? (() => daemonGitBusy());
  const now = o.now ?? Date.now;
  const said = new Map<string, number>();
  const ws: fs.FSWatcher[] = [];
  // Not one recursive watch of the whole folder (w5764's review): on Linux that is an inotify watch per folder, and the
  // LFS store (lfs/objects/xx/yy) alone can hold tens of thousands. The folder's own files (config, HEAD, packed-refs),
  // refs whole, and the top of objects, its pack and info folders, hooks and info: a new loose object shows as its folder.
  const spots: [string, boolean][] = [['', false], ['refs', true], ['objects', false], ['objects/pack', false], ['objects/info', false], ['hooks', false], ['info', false]];
  for (const [sub, recursive] of spots) {
    const dir = sub ? path.join(gitDir, sub) : gitDir;
    if (sub && !fs.existsSync(dir)) continue;
    try {
      const w = fs.watch(dir, { recursive, persistent: false }, (_ev, name) => {
        const rel = [sub, typeof name === 'string' ? name : ''].filter(Boolean).join('/');
        if (ignoredStorePath(rel) || busy()) return;
        const top = rel.replace(/\\/g, '/').split('/').slice(0, 2).join('/');
        const t = now();
        if ((said.get(top) ?? -Infinity) > t - 3600_000) return;
        said.set(top, t);
        log(`store lock (warn): ${path.join(gitDir, rel)} changed while the daemon ran no git; a worker's write there is refused once the store lock is on (a person's own git in the clone is not)`);
      });
      w.on('error', (e) => log(`store lock (warn): the watch on ${dir} stopped (${(e as Error).message})`));
      ws.push(w);
    } catch (e) {
      log(`store lock (warn): cannot watch ${dir} (${(e as Error).message}); writes there are not logged`);
    }
  }
  return () => {
    for (const w of ws) w.close();
  };
}
