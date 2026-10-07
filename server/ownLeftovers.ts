import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { hasLocalWork, neverDelete, norm, removeRenamed, touchedSince, within, type CleanupGuard, type CleanupItem, type CleanupRun } from './cleanup.ts';

/**
 * FF Factory's own leftovers (w626, docs/self-recovery.md "FF Factory's own leftovers"): what its agents, scripts and
 * installs leave on a machine once nothing needs it, removed by the machine daemon's clean-up while free space is below
 * the soft threshold (and in every pass asked for), without asking anyone. On 2026-10-07 the m3 fell under its 50 GB
 * guard holding about 78 GB of these (old player slots in ~/nevergames/ff-players, an old agent worktree, Unity
 * editors no project used), and a worker asked people for a go instead of removing them (w596).
 *
 * - **Player slots** (the game repo's scripts/nightly/player_slots.py): a slot folder with no live lease and nothing
 *   changed inside for a day. The next launch fills it again (the folder's path, which the firewall rule names, stays
 *   valid: the script makes it again).
 * - **Agent worktrees**: a linked worktree of the machine's clone that is no sandbox, has nothing uncommitted,
 *   untracked or unpushed, and was not used for days. Git's own record is pruned after.
 * - **Unity editors**: an installed version that no sandbox's or the main clone's ProjectVersion.txt names (nor the
 *   clone's origin/develop or origin/master, nor a Unity project under the home folder opened within a month) and that
 *   no process runs.
 * - **Finished agents' temp folders** are the regular clean-up's `agent-temp` rule (server/cleanup.ts).
 *
 * Never: personal files (only these exact shapes are looked at), anything the clean-up's guard keeps (neverDelete:
 * protected paths, the daemon's folder, secrets, backups), a sandbox, a worktree with work that exists nowhere else.
 * What it cannot judge is listed for the log, never removed.
 */

export const OWN_LEFTOVER_DEFAULTS = {
  /** A slot goes once nothing in it changed for this long (a fill or a running player's lease refresh touches it). */
  slotUntouchedHours: 24,
  /** player_slots.py's DEFAULT_MAX_AGE_H: an older lease no longer holds its slot. */
  leaseMaxAgeHours: 12,
  /** A worktree goes once unused (its git state, top-level entries, Library, Temp, Logs) for this long. */
  worktreeUnusedDays: 2,
  /** A Unity project under the home folder opened within this many days keeps its editor version. */
  recentProjectDays: 30,
};

export type OwnLeftoverRule = 'player-slot' | 'old-worktree' | 'unity-editor' | 'leftover';

export interface OwnLeftoverItem extends CleanupItem {
  rule: OwnLeftoverRule;
  /** old-worktree: the clone it is a worktree of (its record is pruned after). */
  clone?: string;
}

export interface OwnLeftoverPlan {
  items: OwnLeftoverItem[];
  /** Seen and kept, with why (unpushed work, a guard): for the log and the dashboard, never removed. */
  listed: { path: string; why: string }[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEFTOVER = /\.ffclean-\d+$/;

async function children(dir: string): Promise<fs.Dirent[]> {
  return fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
}

/**
 * A Windows command line with its 8.3 short names (C:\Users\RUNNER~1\...) written long, so it compares with the long
 * paths git reports: each path holding a `~` is resolved through its longest existing part. Elsewhere unchanged.
 */
export function expandShortNames(cmd: string): string {
  if (!cmd.includes('~')) return cmd;
  return cmd.replace(/[A-Za-z]:[\\/][^"'\s]*~[^"'\s]*/g, (t) => {
    const tail: string[] = [];
    let q = t;
    while (!fs.existsSync(q)) {
      const d = path.win32.dirname(q);
      if (d === q) return t;
      tail.unshift(path.win32.basename(q));
      q = d;
    }
    return path.win32.join(real(q), ...tail);
  });
}

/** Whether a command line names `p` or something inside it (not merely a longer name starting the same). */
export function mentions(cmd: string, p: string): boolean {
  const c = expandShortNames(cmd).replace(/\\/g, '/').toLowerCase();
  for (const n of new Set([norm(p), norm(real(p))])) {
    for (let i = c.indexOf(n); i >= 0; i = c.indexOf(n, i + 1)) if (i + n.length === c.length || /["'\s/]/.test(c[i + n.length])) return true;
  }
  return false;
}

const mtime = async (p: string) => (await fs.promises.lstat(p).catch(() => undefined))?.mtimeMs ?? 0;

// ---------------------------------------------------------------- player slots

/** One lease file of a slot (player_slots.py _lease): `time` in seconds since the epoch. */
export interface SlotLease {
  pid?: number;
  host?: string;
  time?: number;
}

/** Whether a lease still holds its slot, as player_slots.py's Pool._live judges it. */
export function leaseLive(lease: SlotLease, o: { host: string; now: number; maxAgeHours: number; alive: (pid: number) => boolean }): boolean {
  const t = Number(lease.time) * 1000;
  if (!Number.isFinite(t) || o.now - t > o.maxAgeHours * HOUR) return false;
  // A remote holder's pid means nothing here: only its age expires it.
  if (String(lease.host ?? '').toLowerCase() !== o.host.toLowerCase()) return true;
  return o.alive(Number(lease.pid));
}

/**
 * Every player slot root this machine may have, current or left by an older layout: the worker root's players/
 * (FF_PLAYER_SLOT_ROOT of its agents), the slot config the setup script writes, and player_slots.py's default_root()
 * candidates (~/nevergames/ff-players on a Mac; D:\work\ff-players, <D..J>:\ff-players, C:\ff-players on Windows).
 * Only the ones that exist.
 */
export function playerSlotRoots(o: { platform: string; home: string; workerRoot?: string; env?: NodeJS.ProcessEnv; read?: (p: string) => string; exists?: (p: string) => boolean }): string[] {
  const env = o.env ?? {};
  const read = o.read ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  const win = o.platform === 'win32';
  const J = win ? path.win32.join : path.posix.join;
  const out: string[] = [];
  if (o.workerRoot) out.push(J(o.workerRoot, 'players'));
  if (env.FF_PLAYER_SLOT_ROOT) out.push(env.FF_PLAYER_SLOT_ROOT);
  const config = win ? J(env.ProgramData || 'C:\\ProgramData', 'FinalFactory', 'player-slots.json') : J(o.home, '.config', 'finalfactory', 'player-slots.json');
  try {
    const raw = read(config);
    const root = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)?.root;
    if (typeof root === 'string' && root.trim()) out.push(root.trim());
  } catch {
    // no config
  }
  if (win) out.push('D:\\work\\ff-players', ...'DEFGHIJ'.split('').map((d) => `${d}:\\ff-players`), `${env.SystemDrive || 'C:'}\\ff-players`);
  else out.push(J(o.home, 'nevergames', 'ff-players'));
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = norm(p);
    if (seen.has(k) || !exists(p)) return false;
    seen.add(k);
    return true;
  });
}

/** The slots in `roots` that nobody holds and nothing touched for a day, and leftovers of a removal that failed. */
export async function planPlayerSlots(o: { roots: string[]; guard: CleanupGuard; host: string; alive: (pid: number) => boolean; now?: number; untouchedHours?: number; leaseMaxAgeHours?: number }): Promise<OwnLeftoverPlan> {
  const now = o.now ?? Date.now();
  const untouched = o.untouchedHours ?? OWN_LEFTOVER_DEFAULTS.slotUntouchedHours;
  const maxAgeHours = o.leaseMaxAgeHours ?? OWN_LEFTOVER_DEFAULTS.leaseMaxAgeHours;
  const plan: OwnLeftoverPlan = { items: [], listed: [] };
  for (const root of o.roots) {
    for (const e of await children(root)) {
      const p = path.join(root, e.name);
      if (LEFTOVER.test(e.name)) {
        if (!neverDelete(p, o.guard)) plan.items.push({ path: p, rule: 'leftover', why: 'left over from an interrupted removal' });
        continue;
      }
      if (!e.isDirectory() || !/^slot[\w-]*$/i.test(e.name)) continue;
      const inside = (await children(p)).map((c) => c.name);
      // Only a slot that holds something to free: its player copy or trash of an earlier fill.
      if (!inside.some((n) => n === 'player' || n.startsWith('trash-'))) continue;
      const leases: SlotLease[] = [];
      for (const l of await children(path.join(p, 'leases'))) {
        if (!l.name.endsWith('.json')) continue;
        try {
          leases.push(JSON.parse(await fs.promises.readFile(path.join(p, 'leases', l.name), 'utf8')));
        } catch {
          // unreadable: player_slots.py drops it too
        }
      }
      if (leases.some((l) => leaseLive(l, { host: o.host, now, maxAgeHours, alive: o.alive }))) continue;
      const no = neverDelete(p, o.guard);
      if (no) {
        plan.listed.push({ path: p, why: `a player slot nobody holds, kept: ${no}` });
        continue;
      }
      if (await touchedSince(p, now - untouched * HOUR)) continue;
      plan.items.push({ path: p, rule: 'player-slot', why: `a player slot nobody holds (no live lease), untouched for ${untouched} h; the next launch fills it again` });
    }
  }
  return plan;
}

// ---------------------------------------------------------------- agent worktrees

export interface WorktreeEntry {
  path: string;
  head?: string;
  /** refs/heads/<name>, absent when detached. */
  branch?: string;
  bare?: boolean;
  locked?: boolean;
  prunable?: boolean;
}

/** A Claude Code worktree: <repo or sandbox>/.claude/worktrees/<name>. */
const CLAUDE_WORKTREE = /\/\.claude\/worktrees\/[^/]+$/;

/** The real path (long names, links resolved), or the resolved one when it cannot be read. */
export function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** `git worktree list --porcelain`: the first entry is the main worktree (or the bare repository). */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) out.push((cur = { path: line.slice(9) }));
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7);
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return out;
}

export type GitRunner = (cwd: string, args: string[], timeoutMs?: number) => Promise<string>;

export const runGit: GitRunner = (cwd, args, timeoutMs = 60_000) =>
  new Promise((resolve, reject) =>
    execFile('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(String(out)))),
  );

/**
 * When a worktree was last used: the newest change to its git state (HEAD, index, reflog in its admin folder), its
 * top-level entries, and a Unity project's Library entries, Temp, Logs and UserSettings. Not a full walk: a worktree
 * with a Library holds hundreds of thousands of files, and an edit deep inside shows as uncommitted work anyway.
 */
export async function worktreeLastUsed(p: string): Promise<number> {
  const stamps = [p];
  for (const e of await children(p)) stamps.push(path.join(p, e.name));
  for (const d of ['Library', 'Temp', 'Logs', 'UserSettings']) for (const e of await children(path.join(p, d))) stamps.push(path.join(p, d, e.name));
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(await fs.promises.readFile(path.join(p, '.git'), 'utf8'))?.[1]?.trim();
    if (gitdir) {
      const admin = path.resolve(p, gitdir);
      stamps.push(...['HEAD', 'index', 'ORIG_HEAD', 'FETCH_HEAD', path.join('logs', 'HEAD')].map((n) => path.join(admin, n)));
    }
  } catch {
    // .git is a folder (not a linked worktree) or unreadable
  }
  let newest = 0;
  for (const s of stamps) newest = Math.max(newest, await mtime(s));
  return newest;
}

/**
 * Linked worktrees of `clones` that are leftovers: no sandbox (nor holding one), not locked, not inside a sandbox an
 * agent works in now, unused for `unusedDays`, and with nothing uncommitted, untracked or unpushed (git status and
 * commits no remote has). One with work of its own is listed, never removed. `relax`: kept folders a worktree may lie
 * in (the clone, the sandbox root: a Claude Code worktree in <sandbox>/.claude/worktrees).
 */
export async function planWorktrees(o: {
  clones: string[];
  sandboxes: string[];
  busy: string[];
  relax: string[];
  guard: CleanupGuard;
  procs?: string[];
  now?: number;
  unusedDays?: number;
  git?: GitRunner;
  localWork?: (dir: string) => Promise<boolean>;
}): Promise<OwnLeftoverPlan & { prune: string[] }> {
  const now = o.now ?? Date.now();
  const days = o.unusedDays ?? OWN_LEFTOVER_DEFAULTS.worktreeUnusedDays;
  const git = o.git ?? runGit;
  const localWork = o.localWork ?? ((d: string) => hasLocalWork(d, 180_000));
  const plan: OwnLeftoverPlan & { prune: string[] } = { items: [], listed: [], prune: [] };
  const seen = new Set<string>();
  for (const clone of o.clones) {
    if (seen.has(norm(clone)) || !fs.existsSync(clone)) continue;
    seen.add(norm(clone));
    let list: WorktreeEntry[];
    try {
      list = parseWorktreeList(await git(clone, ['worktree', 'list', '--porcelain']));
    } catch {
      continue;
    }
    if (list.some((w) => w.prunable)) plan.prune.push(clone);
    for (const w of list.slice(1)) {
      const p = path.resolve(w.path);
      if (w.bare || w.prunable || w.locked || !fs.existsSync(p)) continue;
      // Git writes long paths; the pool's, a config's or os.tmpdir() may be another form of the same folder (an 8.3
      // short name on Windows, a symlink on a Mac): every comparison is between real paths.
      const rp = real(p);
      if (seen.has(norm(rp))) continue;
      seen.add(norm(rp));
      if (o.sandboxes.some((s) => within(real(s), rp))) continue; // a sandbox, or a folder holding one
      if (o.busy.some((b) => within(rp, real(b)))) continue; // inside a sandbox an agent works in now
      if (o.procs?.some((c) => mentions(c, p) || mentions(c, rp))) continue; // a process runs from it (an editor)
      // Inside the clone or the sandbox root only a Claude Code worktree (<x>/.claude/worktrees/<name>) is taken: a
      // sandbox the pool does not list (being made, forgotten) is never mistaken for a leftover.
      const relaxed = o.relax.filter((r) => r && within(rp, real(r)));
      if (relaxed.length && !CLAUDE_WORKTREE.test(norm(rp))) continue;
      // The guard in real paths too; the kept clone or sandbox root holding it no longer covers it (the shape rule above did).
      const guard = { home: real(o.guard.home), inUse: o.guard.inUse.filter(Boolean).map(real), keep: o.guard.keep.filter(Boolean).map(real).filter((k) => !relaxed.some((r) => norm(real(r)) === norm(k))) };
      const no = neverDelete(rp, guard, { claudeWorktrees: true });
      if (no) {
        plan.listed.push({ path: p, why: `a worktree of ${clone}, kept: ${no}` });
        continue;
      }
      if (now - (await worktreeLastUsed(p)) < days * DAY) continue;
      const branch = w.branch?.replace(/^refs\/heads\//, '') ?? 'detached';
      if (await localWork(p)) {
        plan.listed.push({ path: p, why: `an old worktree of ${clone} (${branch}) with uncommitted, untracked or unpushed work: kept for its owner` });
        continue;
      }
      plan.items.push({ path: p, rule: 'old-worktree', clone, why: `an agent worktree of ${clone} (${branch}), everything in it pushed, unused for over ${days} days` });
    }
  }
  return plan;
}

// ---------------------------------------------------------------- Unity editors

/** A Unity editor version as Unity Hub names its install folders: 6000.3.2f1, 2022.3.10f1. */
export const UNITY_VERSION = /^\d{4}\.\d+\.\d+[abfpx]\d+$/i;

export const projectVersionOf = (text: string) => /m_EditorVersion:\s*(\S+)/.exec(text)?.[1];

/**
 * The Unity versions this machine still needs: each project's ProjectSettings/ProjectVersion.txt (the sandboxes, the
 * main clone), each clone's HEAD, origin/develop and origin/master (a bare clone has no working copy; the next
 * version is kept too), and every Unity project up to three folders under `recentRoots` opened within `recentDays`
 * (a person's own project).
 */
export async function unityVersionsInUse(o: { projects: string[]; clones: string[]; recentRoots: string[]; recentDays?: number; now?: number; git?: GitRunner }): Promise<Set<string>> {
  const out = new Set<string>();
  const git = o.git ?? runGit;
  const add = (t: string | undefined) => {
    const v = t && projectVersionOf(t);
    if (v) out.add(v);
  };
  for (const p of o.projects) add(await fs.promises.readFile(path.join(p, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').catch(() => undefined));
  for (const c of o.clones) {
    if (!fs.existsSync(c)) continue;
    for (const ref of ['HEAD', 'origin/develop', 'origin/master']) add(await git(c, ['show', `${ref}:ProjectSettings/ProjectVersion.txt`], 15_000).catch(() => undefined));
  }
  const now = o.now ?? Date.now();
  const recent = (o.recentDays ?? OWN_LEFTOVER_DEFAULTS.recentProjectDays) * DAY;
  const skip = /^(\.|node_modules$|appdata$|library$|temp$|logs$|packages$|assets$)/i;
  const visit = async (dir: string, left: number) => {
    const pv = path.join(dir, 'ProjectSettings', 'ProjectVersion.txt');
    if (fs.existsSync(pv)) {
      let newest = Math.max(await mtime(path.join(dir, 'Library')), await mtime(path.join(dir, 'Temp')), await mtime(path.join(dir, 'Logs')), await mtime(path.join(dir, 'UserSettings')));
      for (const e of await children(path.join(dir, 'Library'))) newest = Math.max(newest, await mtime(path.join(dir, 'Library', e.name)));
      if (now - newest < recent) add(await fs.promises.readFile(pv, 'utf8').catch(() => undefined));
      return;
    }
    if (left <= 0) return;
    for (const e of await children(dir)) if (e.isDirectory() && !skip.test(e.name)) await visit(path.join(dir, e.name), left - 1);
  };
  for (const r of new Set(o.recentRoots)) await visit(r, 3);
  return out;
}

/** The version folder of an editor binary Unity Hub lists (<v>\Editor\Unity.exe, <v>/Unity.app/Contents/MacOS/Unity). */
export function editorFolderOf(bin: string): string | undefined {
  const parts = bin.replace(/\\/g, '/').split('/');
  const i = parts.findIndex((s) => UNITY_VERSION.test(s));
  return i > 0 ? bin.slice(0, parts.slice(0, i + 1).join('/').length) : undefined;
}

/**
 * Installed Unity editors (<dir>/<version> holding Editor/Unity.exe or Unity.app) that no version in `keep` names and
 * no process runs. With an empty `keep` (nothing could be read) it removes nothing. These folders are inside what the
 * regular clean-up never touches (Program Files, /Applications, a Unity install), so only this exact shape is taken:
 * a version folder directly in a known editor folder.
 */
export async function planUnityEditors(o: { editorDirs: string[]; keep: Set<string>; procs: string[]; guard: CleanupGuard }): Promise<OwnLeftoverPlan> {
  const plan: OwnLeftoverPlan = { items: [], listed: [] };
  if (!o.keep.size) return plan;
  const seen = new Set<string>();
  for (const dir of o.editorDirs) {
    if (!dir || seen.has(norm(dir))) continue;
    seen.add(norm(dir));
    for (const e of await children(dir)) {
      const p = path.join(dir, e.name);
      if (LEFTOVER.test(e.name) && UNITY_VERSION.test(e.name.replace(LEFTOVER, ''))) {
        plan.items.push({ path: p, rule: 'leftover', why: 'left over from an interrupted removal' });
        continue;
      }
      if (!e.isDirectory() || !UNITY_VERSION.test(e.name) || o.keep.has(e.name)) continue;
      if (!fs.existsSync(path.join(p, 'Editor', 'Unity.exe')) && !fs.existsSync(path.join(p, 'Unity.app'))) continue;
      const no = editorBlocked(p, o.guard, o.procs);
      if (no) {
        plan.listed.push({ path: p, why: `Unity ${e.name}, which nothing here needs, kept: ${no}` });
        continue;
      }
      plan.items.push({ path: p, rule: 'unity-editor', why: `Unity ${e.name}: no sandbox's or the main clone's ProjectVersion.txt names it (they use ${[...o.keep].sort().join(', ')}) and no process runs it` });
    }
  }
  return plan;
}

/** Why an editor folder must stay: a process runs from it, or it holds something kept or in use (the machine's unity_path). */
export function editorBlocked(p: string, g: CleanupGuard, procs: string[]): string | undefined {
  if (procs.some((c) => mentions(c, p))) return 'a process runs from it';
  for (const k of [...g.keep, ...g.inUse]) if (k && within(k, p)) return `holds ${k}`;
  if (norm(p).split('/').filter(Boolean).length < 3) return 'too close to a drive root';
  return undefined;
}

// ---------------------------------------------------------------- the whole selection, and removal

export interface OwnLeftoverInputs {
  platform: string;
  home: string;
  guard: CleanupGuard;
  /** Player slot roots (playerSlotRoots). */
  slotRoots: string[];
  host: string;
  alive: (pid: number) => boolean;
  /** The machine's clones whose worktrees are judged: its main clone, a worker root's repo. */
  clones: string[];
  /** Every sandbox's folder: never a leftover. */
  sandboxes: string[];
  /** Sandboxes an agent works in now: no worktree inside one is touched. */
  busy: string[];
  /** Kept folders a worktree may lie in (planWorktrees). */
  relax: string[];
  /** Folders of Unity versions (Unity Hub's, the machine's unity_editor_root, the parents of the editors the Hub lists). */
  editorDirs: string[];
  /** Command lines of the processes running now; undefined when they could not be listed: no worktree or editor is then judged. */
  procs?: string[];
  now?: number;
  git?: GitRunner;
  localWork?: (dir: string) => Promise<boolean>;
}

/** Everything this module would remove now, and what it saw and kept. Reads only. */
export async function planOwnLeftovers(i: OwnLeftoverInputs): Promise<OwnLeftoverPlan & { prune: string[] }> {
  const slots = await planPlayerSlots({ roots: i.slotRoots, guard: i.guard, host: i.host, alive: i.alive, now: i.now });
  if (!i.procs) return { ...slots, prune: [] };
  const trees = await planWorktrees({ clones: i.clones, sandboxes: i.sandboxes, busy: i.busy, relax: i.relax, guard: i.guard, procs: i.procs, now: i.now, git: i.git, localWork: i.localWork });
  const keep = await unityVersionsInUse({ projects: i.sandboxes, clones: i.clones, recentRoots: [i.home], now: i.now, git: i.git });
  const editors = await planUnityEditors({ editorDirs: i.editorDirs, keep, procs: i.procs, guard: i.guard });
  return {
    items: [...slots.items, ...trees.items, ...editors.items],
    listed: [...slots.listed, ...trees.listed, ...editors.listed],
    prune: trees.prune,
  };
}

/**
 * Remove a plan's items, each checked again first (`recheck`: the guard, a process started, the folder used since),
 * renamed, then deleted, as the regular clean-up does. Then each clone whose worktree went prunes its record.
 */
export async function runOwnLeftovers(plan: OwnLeftoverPlan & { prune?: string[] }, recheck: (it: OwnLeftoverItem) => Promise<string | undefined>, git: GitRunner = runGit): Promise<CleanupRun> {
  const out: CleanupRun = { removed: [], failed: [], bytes: 0 };
  const prune = new Set(plan.prune ?? []);
  for (const it of plan.items) {
    const no = await recheck(it);
    if (no) {
      out.failed.push({ path: it.path, why: `refused: ${no}` });
      continue;
    }
    if ((await removeRenamed(it, out)) && it.clone) prune.add(it.clone);
  }
  for (const c of prune) await git(c, ['worktree', 'prune']).catch(() => undefined);
  return out;
}

/** The recheck the daemon uses: an item's own rule again, right before it goes. */
export function ownRecheck(i: Pick<OwnLeftoverInputs, 'guard' | 'busy' | 'host' | 'alive'> & { procs: () => Promise<string[]>; clock?: () => number }) {
  return async (it: OwnLeftoverItem): Promise<string | undefined> => {
    const now = i.clock?.() ?? Date.now();
    if (it.rule === 'leftover') return undefined;
    if (it.rule === 'player-slot') {
      const again = await planPlayerSlots({ roots: [path.dirname(it.path)], guard: i.guard, host: i.host, alive: i.alive, now });
      return again.items.some((x) => norm(x.path) === norm(it.path)) ? undefined : 'held or used since it was planned';
    }
    const procs = await i.procs().catch(() => undefined);
    if (!procs) return 'the process list could not be read';
    if (it.rule === 'unity-editor') return editorBlocked(it.path, i.guard, procs);
    // old-worktree
    if (i.busy.some((b) => within(real(it.path), real(b)))) return 'an agent works in its sandbox now';
    if (procs.some((c) => mentions(c, it.path) || mentions(c, real(it.path)))) return 'a process runs from it';
    if (now - (await worktreeLastUsed(it.path)) < OWN_LEFTOVER_DEFAULTS.worktreeUnusedDays * DAY) return 'used since it was planned';
    return undefined;
  };
}
