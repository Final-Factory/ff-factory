// Machine sandboxes (docs/machines.md, "Machine sandboxes"): the daemon's pool of git worktrees of its machine's main
// clone, each on its own branch in the configured sandbox root, with its own Library (seeded warm) and at most one
// Unity editor. The portal keeps the labels and agents; this keeps the folders, git and the editors, and reports every
// change as a snapshot. State survives daemon restarts in <app_dir>/sandboxes.json.
import fs from 'node:fs';
import path from 'node:path';
import { branchProblem, pickEditorLog, pruneEditorLogs, slugify, withBaseRepoLock } from '../server/sandboxes.ts';
import { switchBranch } from '../server/switchBranch.ts';
import { saveWork, type SaveResult } from '../server/saveWork.ts';
import { readGitStatus } from '../server/gitStatus.ts';
import { diskLevel } from '../server/hostHealth.ts';
import { bridgeInfo } from '../server/unityHang.ts';
import { copyTree, lowerPriority, removeTree, run, type RunResult } from '../server/proc.ts';
import { checkArray, readJsonDurable, writeJsonDurable } from '../server/durable.ts';
import { armScriptReimport } from './scriptReimport.ts';
import { MacUnity, MacUnityWatch, realDeps, type Proc, type UnityDeps, type UnityLocation } from './unity.ts';
import type { DaemonSandbox } from '../server/machineProtocol.ts';
import type { DiskLevel, GitStatus, MachineSandboxUnity, SandboxPoolSettings, SandboxStatus } from '../shared/types.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GB = 1024 ** 3;
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

/** A sandbox as sandboxes.json keeps it; the editor's state is found again at every look. */
interface Rec {
  id: string;
  branch: string;
  base: string;
  path: string;
  createdAt: string;
  status: SandboxStatus;
  statusDetail?: string;
  logPath?: string;
}

/** The editor side of one sandbox: its MacUnity and hang/crash watch (a fake in tests). */
export interface SandboxEditor {
  unity: Pick<MacUnity, 'start' | 'stop' | 'status' | 'editors' | 'logFile'>;
  watch?: Pick<MacUnityWatch, 'tick' | 'expectExit' | 'describe'>;
}

export interface PoolDeps {
  git(args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RunResult>;
  copyTree(src: string, dst: string, signal?: AbortSignal, mode?: 'robocopy' | 'clone'): Promise<void>;
  /**
   * Bytes a Library copy writes up front: the source's size when it is a full copy (robocopy on Windows), undefined
   * when it block-clones (APFS `cp -c`, Copy-Item on a ReFS Dev Drive), where librarySeedGB stands (w628).
   */
  libraryCopyBytes?(src: string, mode?: 'robocopy' | 'clone'): Promise<number | undefined>;
  removeTree(dir: string): Promise<RunResult>;
  /** Free bytes on the volume holding `p`, or undefined when unknown. */
  freeBytes(p: string): Promise<number | undefined>;
  procs(): Promise<Proc[]>;
  editor(sb: { id: string; path: string }, logFile: string, report: (text: string, restarted: boolean) => void): SandboxEditor;
  /** The Unity MCP bridge of a project: up once it has a port. */
  bridgeUp(project: string): boolean;
  gitStatus(dir: string): Promise<GitStatus | undefined>;
  now(): number;
  /** Below-normal priority for an editor (pool setting belowNormal: a game the user plays on this computer wins). */
  lowerPriority?(pid: number): void;
}

export interface PoolOptions {
  repoPath: string;
  stateFile: string;
  settings?: SandboxPoolSettings | null;
  /** Per sandbox, from the daemon's own sessions: an agent mid-turn, and when one there last did anything (ms). */
  activity(id: string): { busy: boolean; lastActivityMs: number };
  /** Something changed: send the portal a snapshot. */
  onChange(): void;
  /** For the orchestrator: an editor restarted or given up on, the disk guard, an idle editor stopped. */
  onEvent(e: { text: string; sandbox?: string; restarted?: boolean; unity?: boolean; checkpoint?: boolean }): void;
  idleStopMinutes?: number;
  /** Why a sandbox editor may not start now (the machine's host guard, w466: the drive is gone, disk space is low), or undefined. */
  startGate?: () => string | undefined;
  /** Room a warm Library copy needs, in GB, on top of the warning threshold (a clone on APFS costs far less up front). */
  librarySeedGB?: number;
  /**
   * Whether an editor of this sandbox may start now, by the machine's Unity slots (w469, machine/unitySlots.ts: every
   * Unity process on the machine counts, and waiting launches go first): undefined yes, else why not. Unset: only the
   * pool's own editors count against max_unity, as before.
   */
  editorSlot?(id: string): Promise<string | undefined>;
  /** Every Unity editor of the machine, counted now, for `unity status`. */
  slotsStatus?(): Promise<string>;
}

/** Why `branch` cannot be a sandbox branch (the host's rules, plus git's), or undefined. Exported for tests. */
export async function sandboxBranchProblem(branch: string, git: PoolDeps['git']): Promise<string | undefined> {
  const p = branchProblem(branch);
  if (p) return p;
  if (branch.includes('@{')) return `branch "${branch}" is not a valid branch name`;
  const r = await git(['check-ref-format', '--branch', branch]);
  return r.code === 0 && r.stdout.trim() === branch ? undefined : `branch "${branch}" is not a valid branch name`;
}

/**
 * Whether `dir` is a folder the pool may delete: a direct child of `root` named `id`, and neither the main clone nor
 * inside it (either way round). Case-insensitive with either slash on Windows. Exported for tests.
 */
export function deletable(dir: string, id: string, root: string, repoPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const k = (p: string) => (platform === 'win32' ? P.resolve(p).toLowerCase() : P.resolve(p)).replace(/[\\/]+$/, '');
  const d = k(dir);
  const repo = k(repoPath);
  const sep = platform === 'win32' ? '\\' : '/';
  if (d === repo || d.startsWith(repo + sep) || repo.startsWith(d + sep)) return false;
  return k(P.dirname(P.resolve(dir))) === k(root) && P.basename(P.resolve(dir)) === id;
}

/**
 * The Library to seed a new sandbox from: the pool's librarySeed (a Library folder itself) when it has something in it,
 * else the main clone's, else a sandbox's whose editor is stopped, else any sandbox's. Exported for tests.
 */
export function librarySource(
  repoPath: string,
  sandboxes: { path: string; status: SandboxStatus; editorUp: boolean }[],
  hasLibrary: (dir: string) => boolean,
  seed?: string,
  seedHasFiles: (dir: string) => boolean = nonEmpty,
): string | undefined {
  if (seed && seedHasFiles(seed)) return seed;
  if (hasLibrary(repoPath)) return path.join(repoPath, 'Library');
  const ready = sandboxes.filter((s) => s.status === 'ready' && hasLibrary(s.path));
  const pick = ready.find((s) => !s.editorUp) ?? ready[0];
  return pick ? path.join(pick.path, 'Library') : undefined;
}

/** A Library folder with something in it (a clone that never opened Unity has none, or an empty one). */
export function hasLibrary(dir: string): boolean {
  return nonEmpty(path.join(dir, 'Library'));
}

function nonEmpty(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Whether two paths name the same folder: case-insensitive with either slash on Windows. Exported for tests. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const k = (p: string) => (platform === 'win32' ? P.resolve(p).toLowerCase() : P.resolve(p)).replace(/[\\/]+$/, '');
  return k(a) === k(b);
}

/** Live agents across a machine's sandboxes against the pool's total (maxAgents), as a refusal, or undefined. Exported for tests. */
export function totalAgentsRefusal(liveInSandboxes: number, settings: Pick<SandboxPoolSettings, 'maxAgents'> | undefined | null): string | undefined {
  const max = settings?.maxAgents;
  return max !== undefined && liveInSandboxes >= max ? `already ${liveInSandboxes} agents running in this machine's sandboxes (max_sandbox_agents ${max}); stop one first` : undefined;
}

/** Running editors to stop for being idle: up, no agent mid-turn there, nothing done there for `idleMinutes`. Exported for tests. */
export function idleSandboxEditors(sbs: { id: string; up: boolean; startedAt?: number }[], activity: PoolOptions['activity'], now: number, idleMinutes: number): string[] {
  if (idleMinutes <= 0) return [];
  return sbs
    .filter((s) => s.up)
    .filter((s) => {
      const a = activity(s.id);
      return !a.busy && now - Math.max(s.startedAt ?? 0, a.lastActivityMs) > idleMinutes * 60_000;
    })
    .map((s) => s.id);
}

/** Bytes of the files under `dir` (links not followed); undefined when it cannot be read. Exported for tests. */
export async function treeBytes(dir: string): Promise<number | undefined> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fs.promises.lstat(p).catch(() => undefined))?.size ?? 0;
    }
  };
  try {
    await walk(dir);
    return total;
  } catch {
    return undefined;
  }
}

/** The real machine: git in the main clone, robocopy/cp for the Library, the daemon's Unity code. */
export function realPoolDeps(platform: 'darwin' | 'win32' | 'linux', repoPath: string, where: UnityLocation = {}, log: (line: string) => void = () => undefined): PoolDeps {
  // One process listing serves every sandbox's watch in a look (a CIM query costs seconds on Windows).
  const base = realDeps(platform);
  let cached: { at: number; p: Promise<Proc[]> } | undefined;
  const procs = () => {
    if (!cached || Date.now() - cached.at > 5000) cached = { at: Date.now(), p: base.procs() };
    return cached.p;
  };
  const shared: UnityDeps = { ...base, procs };
  return {
    git: (args, opts = {}) => run('git', ['-C', repoPath, ...args], { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal, env: ENV }),
    copyTree: (src, dst, signal, mode) => copyTree(src, dst, { signal, mode }),
    libraryCopyBytes: async (src, mode) => (platform === 'win32' && mode !== 'clone' ? treeBytes(src) : undefined),
    removeTree,
    freeBytes: async (p) => {
      try {
        const st = await fs.promises.statfs(p);
        return st.bavail * st.bsize;
      } catch {
        return undefined;
      }
    },
    procs,
    editor: (sb, logFile, report) => {
      const unity = new MacUnity(sb.path, shared, undefined, platform, where, { logFile });
      return { unity, watch: new MacUnityWatch(unity, report, { log }) };
    },
    bridgeUp: (project) => !!bridgeInfo(project).port,
    gitStatus: readGitStatus,
    now: () => Date.now(),
    lowerPriority,
  };
}

export class SandboxPool {
  private readonly o: PoolOptions;
  private readonly d: PoolDeps;
  private settings?: SandboxPoolSettings;
  private recs = new Map<string, Rec>();
  private readonly unityState = new Map<string, MachineSandboxUnity & { startedAt?: number }>();
  private readonly editors = new Map<string, SandboxEditor>();
  private readonly git = new Map<string, GitStatus | undefined>();
  private readonly provisioning = new Map<string, AbortController>();
  private readonly busy = new Set<string>();
  private disk: { level: DiskLevel; freeBytes?: number } = { level: 'ok' };
  /** When each sandbox's editor was last stopped with the tool (its launches keep a holder's priority a while, w469). */
  private readonly stoppedAt = new Map<string, number>();
  private lastGitAt = 0;
  private ticking = false;

  constructor(o: PoolOptions, d: PoolDeps) {
    this.o = o;
    this.d = d;
    this.settings = o.settings ?? undefined;
    this.load();
  }

  /** The pool settings (the portal's welcome, or daemon.json until then); null: this machine has no sandboxes. */
  configure(settings: SandboxPoolSettings | null | undefined) {
    this.settings = settings ?? undefined;
  }

  get configured() {
    return !!this.settings;
  }

  private load() {
    // A damaged file (a hard reset, BEAST's WHEA errors) falls back to its newest good version: read as empty, the pool
    // would forget its sandboxes, and the portal their labels and agents with them (w424).
    let rows: Rec[] | undefined;
    try {
      rows = readJsonDurable<Rec[]>(this.o.stateFile, { check: checkArray });
    } catch (e) {
      this.o.onEvent({ text: `could not read ${this.o.stateFile}: ${(e as Error).message}` });
    }
    for (const r of rows ?? []) {
      // A create or delete a daemon restart cut off: say so; delete_sandbox finishes it.
      if (r.status === 'creating' || r.status === 'deleting') Object.assign(r, { status: 'error', statusDetail: `interrupted while ${r.status} (the daemon restarted); delete it and create it again` });
      this.recs.set(r.id, r);
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.o.stateFile), { recursive: true });
      // Fsynced, then renamed into place, with the last good versions kept beside it (server/durable.ts).
      writeJsonDurable(this.o.stateFile, [...this.recs.values()], { indent: 2 });
    } catch (e) {
      this.o.onEvent({ text: `could not save ${this.o.stateFile}: ${(e as Error).message}` });
    }
  }

  private changed(r?: Rec, patch?: Partial<Rec>) {
    if (r && patch) Object.assign(r, patch);
    if (r && this.recs.get(r.id) !== r) return; // removed meanwhile
    this.save();
    this.o.onChange();
  }

  /** Every sandbox, for the portal (small: at most maxSandboxes). */
  list(): DaemonSandbox[] {
    return [...this.recs.values()].map((r) => {
      const u = this.unityState.get(r.id) ?? { state: 'stopped' as const };
      const { startedAt: _s, ...unity } = u;
      return { id: r.id, branch: r.branch, base: r.base, path: r.path, createdAt: r.createdAt, status: r.status, statusDetail: r.statusDetail, unity: { ...unity, logPath: unity.logPath ?? r.logPath }, git: this.git.get(r.id) };
    });
  }

  diskState() {
    return this.disk;
  }

  /** The path of a sandbox (the daemon's guard and image roots). */
  pathOf(id: string): string | undefined {
    return this.recs.get(id)?.path;
  }

  paths(): string[] {
    return [...this.recs.values()].map((r) => r.path);
  }

  /** The editor is known to be stopped or crashed (polled at least once): only then may its Temp and logs go (w459). */
  editorKnownStopped(id: string): boolean {
    const s = this.unityState.get(id)?.state;
    return s === 'stopped' || s === 'crashed';
  }

  /** Its editor was stopped with the tool within `ms`: a worker stopping it to build its own project keeps its turn. */
  stoppedWithin(id: string, ms: number): boolean {
    return this.d.now() - (this.stoppedAt.get(id) ?? -Infinity) < ms;
  }

  editorUp(id: string): boolean {
    const s = this.unityState.get(id)?.state;
    return s === 'starting' || s === 'running';
  }

  private require(id: string): Rec {
    const r = this.recs.get(id);
    if (!r) throw new Error(`no sandbox "${id}" on this machine (have: ${[...this.recs.keys()].join(', ') || 'none'})`);
    return r;
  }

  private need(): SandboxPoolSettings {
    if (!this.settings) throw new Error('this machine has no sandboxes: give add_machine a sandbox_root (and redeploy)');
    return this.settings;
  }

  /** Throws unless the sandbox volume keeps `diskWarnGB` + `extraGB` free. Unknown free space is not an error. */
  private async requireFreeSpace(extraGB: number, what: string) {
    const s = this.need();
    const free = await this.d.freeBytes(fs.existsSync(s.root) ? s.root : path.dirname(s.root));
    if (free === undefined) return;
    const need = s.diskWarnGB + extraGB;
    if (free < need * GB) throw new Error(`not enough disk for ${what}: ${(free / GB).toFixed(0)} GB free on ${s.root}, need ${need} GB (disk_warn_gb ${s.diskWarnGB}${extraGB ? ` + ${extraGB}` : ''}); delete a sandbox first`);
  }

  /** Validate and record the sandbox; the fetch, checkout and Library copy continue in the background. */
  async create(req: { id: string; branch: string; base: string; seedLibrary: boolean; startUnity: boolean }): Promise<DaemonSandbox> {
    const s = this.need();
    const id = slugify(req.id);
    if (!SLUG.test(id) || id !== req.id) throw new Error(`"${req.id}" is not a usable sandbox name (lower-case letters, digits and dashes)`);
    if (this.recs.has(id)) throw new Error(`sandbox "${id}" already exists on this machine`);
    if (this.recs.size >= s.maxSandboxes) throw new Error(`already ${this.recs.size} sandboxes on this machine (max_sandboxes ${s.maxSandboxes}); delete one first`);
    if (id === path.basename(this.o.repoPath).toLowerCase()) throw new Error(`"${id}" is the main clone's folder name: its Unity instance would collide with the main clone's`);
    if ((s.protectedPaths ?? []).some((p) => slugify(path.win32.basename(p)) === id || path.win32.basename(p).toLowerCase() === id)) throw new Error(`"${id}" is the folder name of a protected checkout: its Unity instance would collide with that editor's`);
    const dir = path.join(s.root, id);
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists on disk; delete it or pick another name`);
    if (!deletable(dir, id, s.root, this.o.repoPath)) throw new Error(`${dir} overlaps the main clone ${this.o.repoPath}; pick another sandbox_root`);
    const problem = await sandboxBranchProblem(req.branch, this.d.git);
    if (problem) throw new Error(problem);
    if (req.base.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(req.base)) throw new Error(`base "${req.base}" is not a usable ref`);
    if (this.disk.level !== 'ok') throw new Error(`disk space is ${this.disk.level} on ${s.root} (${((this.disk.freeBytes ?? 0) / GB).toFixed(0)} GB free); new sandboxes wait until space is freed`);
    if (this.recs.has(id)) throw new Error(`sandbox "${id}" already exists on this machine`); // raced another create
    const r: Rec = { id, branch: req.branch, base: req.base, path: dir, createdAt: new Date(this.d.now()).toISOString(), status: 'creating', statusDetail: 'queued' };
    this.recs.set(id, r);
    this.changed();
    const abort = new AbortController();
    this.provisioning.set(id, abort);
    this.busy.add(id);
    void this.provision(r, req.seedLibrary, req.startUnity, abort.signal).finally(() => {
      this.provisioning.delete(id);
      this.busy.delete(id);
    });
    return this.list().find((x) => x.id === id)!;
  }

  private async provision(r: Rec, seedLibrary: boolean, startUnity: boolean, signal: AbortSignal) {
    const step = (detail?: string) => {
      if (signal.aborted) throw new Error('cancelled');
      if (detail) this.changed(r, { statusDetail: detail });
    };
    const must = async (args: string[], timeoutMs: number) => {
      const res = await this.d.git(args, { timeoutMs, signal });
      if (res.code !== 0) throw new Error(`git ${args.filter((a) => !a.includes(path.sep) && !a.includes('/')).slice(0, 3).join(' ')} failed (${res.code}): ${tail(res.stderr || res.stdout)}`);
      return res;
    };
    try {
      fs.mkdirSync(this.need().root, { recursive: true });
      step('checking disk space');
      await this.requireFreeSpace(0, 'a new worktree');
      step('waiting for the main clone');
      await withBaseRepoLock(async () => {
        step('fetching origin');
        await must(['fetch', '--prune', 'origin'], 15 * 60_000);
        step(`creating worktree on ${r.branch}`);
        const local = await this.d.git(['rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}`], { signal });
        const remote = await this.d.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${r.branch}`], { signal });
        step();
        // --no-checkout keeps the lock short; the checkout below touches only this worktree.
        if (local.code === 0) await must(['worktree', 'add', '--no-checkout', r.path, r.branch], 10 * 60_000);
        else if (remote.code === 0) {
          await must(['worktree', 'add', '--no-checkout', '--track', '-b', r.branch, r.path, `origin/${r.branch}`], 10 * 60_000);
          r.base = `origin/${r.branch}`;
        } else await must(['worktree', 'add', '--no-checkout', '--no-track', '-b', r.branch, r.path, r.base], 10 * 60_000);
      });
      step(`checking out ${r.branch}`);
      const co = await this.d.git(['-C', r.path, 'reset', '--hard', '--quiet'], { timeoutMs: 60 * 60_000, signal });
      if (co.code !== 0) throw new Error(`checkout failed (${co.code}): ${tail(co.stderr || co.stdout)}`);
      if (seedLibrary && !fs.existsSync(path.join(r.path, 'Library'))) {
        const others = [...this.recs.values()].filter((x) => x.id !== r.id).map((x) => ({ path: x.path, status: x.status, editorUp: this.editorUp(x.id) }));
        const settings = this.need();
        const src = librarySource(this.o.repoPath, others, hasLibrary, settings.librarySeed);
        if (src) {
          // A full copy (robocopy onto NTFS) writes the whole Library, about 100 GB for a seed that has built players
          // for a while (w628): with the guard at 20 GB, the flat 30 GB allowance would let it fill the disk.
          step('measuring the Library to copy');
          const full = await this.d.libraryCopyBytes?.(src, settings.librarySeedCopy);
          const gb = Math.max(settings.librarySeedGB ?? this.o.librarySeedGB ?? 30, full === undefined ? 0 : Math.ceil(full / GB));
          step('checking disk space for the Library copy');
          await this.requireFreeSpace(gb, `the Library copy (~${gb} GB)`);
          step(`copying the warm Library from ${src} (a few minutes)`);
          await this.d.copyTree(src, path.join(r.path, 'Library'), signal, settings.librarySeedCopy);
          // The copy keeps the other project's script-to-class mappings: the first editor start reimports the scripts.
          const common = await this.d.git(['-C', r.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { signal });
          if (common.code !== 0) throw new Error(`could not find the repo's git folder (${common.code}): ${tail(common.stderr)}`);
          armScriptReimport(r.path, common.stdout.trim());
        }
      }
      step();
      this.git.set(r.id, await this.d.gitStatus(r.path));
      this.changed(r, { status: 'ready', statusDetail: undefined });
      if (startUnity) await this.unity(r.id, 'start').catch((e) => this.changed(r, { statusDetail: `ready, but Unity did not start: ${(e as Error).message}` }));
    } catch (e) {
      if (signal.aborted) return; // remove() owns it now
      this.changed(r, { status: 'error', statusDetail: (e as Error).message });
    }
  }

  /** Stop its editor, remove the Library, the worktree and the folder; the branch stays unless deleteBranch. */
  async remove(id: string, deleteBranch = false): Promise<string> {
    const r = this.require(id);
    if (r.status === 'deleting') throw new Error(`sandbox ${id} is already being deleted`);
    const s = this.need();
    if (!deletable(r.path, r.id, s.root, this.o.repoPath)) {
      this.changed(r, { status: 'error', statusDetail: `delete refused: ${r.path} is not a sandbox folder under ${s.root}` });
      throw new Error(`refusing to delete ${r.path}`);
    }
    const prov = this.provisioning.get(id);
    this.changed(r, { status: 'deleting', statusDetail: prov ? 'cancelling creation' : 'stopping' });
    if (prov) {
      prov.abort();
      for (let i = 0; i < 600 && this.busy.has(id); i++) await new Promise((res) => setTimeout(res, 100));
    }
    const problems: string[] = [];
    try {
      const ed = this.editors.get(id);
      if (ed && ed.unity.editors(await this.d.procs()).length) {
        this.changed(r, { statusDetail: 'stopping Unity' });
        ed.watch?.expectExit();
        await ed.unity.stop({ force: false }).catch((e) => problems.push(`Unity: ${(e as Error).message}`));
      }
      this.changed(r, { statusDetail: 'removing Library' });
      const lib = path.join(r.path, 'Library');
      if (fs.existsSync(lib)) {
        const res = await this.d.removeTree(lib);
        if (fs.existsSync(lib)) problems.push(`Library removal failed (${res.code}): ${tail(res.stderr || res.stdout)}`);
      }
      this.changed(r, { statusDetail: 'removing worktree' });
      await withBaseRepoLock(async () => {
        const res = await this.d.git(['worktree', 'remove', '--force', '--force', r.path], { timeoutMs: 30 * 60_000 });
        if (res.code !== 0 && fs.existsSync(r.path)) problems.push(`git worktree remove failed (${res.code}): ${tail(res.stderr)}`);
      });
      if (fs.existsSync(r.path)) {
        const res = await this.d.removeTree(r.path);
        if (fs.existsSync(r.path)) problems.push(`folder removal failed (${res.code}): ${tail(res.stderr || res.stdout)}`);
      }
      await withBaseRepoLock(() => this.d.git(['worktree', 'prune']));
    } catch (e) {
      problems.push((e as Error).message);
    }
    if (fs.existsSync(r.path)) {
      const detail = `delete incomplete: ${r.path} still exists (a process may hold files in it). ${problems.join('; ')}`.trim();
      this.changed(r, { status: 'error', statusDetail: detail });
      throw new Error(detail);
    }
    let note = '';
    if (deleteBranch) {
      const res = await withBaseRepoLock(() => this.d.git(['branch', '-D', r.branch]));
      note = res.code === 0 ? ` and branch ${r.branch}` : `; deleting branch ${r.branch} failed: ${tail(res.stderr)}`;
    }
    this.recs.delete(id);
    this.editors.delete(id);
    this.unityState.delete(id);
    this.git.delete(id);
    this.changed();
    return `Deleted sandbox ${id} (${r.path})${note}.${problems.length ? ` Warnings: ${problems.join('; ')}` : ''}`;
  }

  /**
   * Take a worktree that already exists into the pool, as it is (the host migration, docs/beast-machine.md): it must be
   * a direct child of the sandbox root named `id` and a worktree of the main clone. Nothing on disk changes; an editor
   * already running on it is found by the next look (and keeps running).
   */
  async adopt(req: { id: string; path: string; branch: string; base: string; createdAt: string; logPath?: string }): Promise<string> {
    const s = this.need();
    const id = req.id;
    if (!SLUG.test(id)) throw new Error(`"${id}" is not a usable sandbox name`);
    if (this.recs.has(id)) throw new Error(`sandbox "${id}" already exists on this machine`);
    if (this.recs.size >= s.maxSandboxes) throw new Error(`already ${this.recs.size} sandboxes on this machine (max_sandboxes ${s.maxSandboxes})`);
    if (!deletable(req.path, id, s.root, this.o.repoPath)) throw new Error(`${req.path} is not a folder named ${id} directly in the sandbox root ${s.root}`);
    if (!fs.existsSync(req.path)) throw new Error(`${req.path} does not exist`);
    const common = await this.d.git(['-C', req.path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.code !== 0) throw new Error(`${req.path} is not a git worktree: ${tail(common.stderr || common.stdout)}`);
    // Real paths: git names the folder as the file system resolves it (a symlinked temp folder on a Mac, a junction on Windows).
    const real = (p: string) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return p;
      }
    };
    // A worker root's clone is bare (w513): its git folder is the clone itself.
    const own = [path.join(this.o.repoPath, '.git'), this.o.repoPath].map(real);
    if (!own.some((p) => samePath(real(common.stdout.trim()), p))) throw new Error(`${req.path} is a worktree of ${common.stdout.trim()}, not of this machine's main clone ${this.o.repoPath}`);
    const head = await this.d.git(['-C', req.path, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : req.branch;
    if (this.recs.has(id)) throw new Error(`sandbox "${id}" already exists on this machine`); // raced another adopt
    const r: Rec = { id, branch, base: req.base, path: req.path, createdAt: req.createdAt, status: 'ready', logPath: req.logPath };
    this.recs.set(id, r);
    this.git.set(id, await this.d.gitStatus(r.path).catch(() => undefined));
    this.changed();
    void this.tick();
    return `Adopted sandbox ${id} (${r.path}, branch ${branch}).`;
  }

  /** Drop a sandbox from the pool without touching its folder, branch or editor (the migration back). */
  release(id: string): string {
    const r = this.require(id);
    if (this.busy.has(id) || r.status === 'creating' || r.status === 'deleting') throw new Error(`sandbox ${id} is ${r.status}; wait until it is done`);
    this.recs.delete(id);
    this.editors.delete(id);
    this.unityState.delete(id);
    this.git.delete(id);
    this.changed();
    return `Released sandbox ${id}; ${r.path} and its editor are left as they are.`;
  }

  /** The editor object of a sandbox for this log file, made anew when the log moves (a locked old log gets a fresh name). */
  private editorFor(r: Rec, logFile = r.logPath ?? path.join(r.path, 'Logs', 'sandbox-editor.log')): SandboxEditor {
    const had = this.editors.get(r.id);
    if (had && had.unity.logFile === logFile) return had;
    const ed = this.d.editor({ id: r.id, path: r.path }, logFile, (text, restarted) => this.o.onEvent({ text: `sandbox ${r.id}: ${text}`, sandbox: r.id, restarted, unity: true }));
    this.editors.set(r.id, ed);
    return ed;
  }

  private runningEditors() {
    return [...this.recs.keys()].filter((id) => this.editorUp(id));
  }

  /** status | start | stop | restart of a sandbox's editor. */
  async unity(id: string, action: 'status' | 'start' | 'stop' | 'restart', force = false): Promise<string> {
    const r = this.require(id);
    if (action === 'status') {
      const ed = this.editorFor(r);
      const u = this.unityState.get(id) ?? { state: 'stopped' };
      return [`sandbox ${id}: unity ${u.state}${u.detail ? ` (${u.detail})` : ''}`, await ed.unity.status(), ed.watch?.describe(), `log ${ed.unity.logFile}`, await this.o.slotsStatus?.()].filter(Boolean).join('\n');
    }
    if (r.status !== 'ready') throw new Error(`sandbox ${id} is ${r.status}${r.statusDetail ? ` (${r.statusDetail})` : ''}, not ready`);
    // A restart keeps the slot its editor had: it is not queued behind others (a hung editor must come back).
    const hadEditor = action === 'restart' && this.editorUp(id);
    const out: string[] = [];
    if (action === 'stop') this.stoppedAt.set(id, this.d.now());
    if (action === 'stop' || action === 'restart') {
      const ed = this.editorFor(r);
      ed.watch?.expectExit();
      out.push(await ed.unity.stop({ force }));
      this.unityState.set(id, { state: 'stopped', logPath: ed.unity.logFile });
      this.changed();
      if (action === 'stop') return out.join(' ');
    }
    const s = this.need();
    const gate = this.o.startGate?.();
    if (gate) throw new Error(`not started: ${gate}`);
    if (this.disk.level !== 'ok') throw new Error(`not started: disk space is ${this.disk.level} on ${s.root}; new editors wait until space is freed`);
    const current = this.editorFor(r);
    if (current.unity.editors(await this.d.procs()).length) return [...out, `Already running (${await current.unity.status()}).`].join(' ');
    if (!hadEditor) {
      if (this.o.editorSlot) {
        const why = await this.o.editorSlot(id);
        if (why) throw new Error(why);
      } else {
        const up = this.runningEditors().filter((x) => x !== id);
        if (up.length >= s.maxUnity) throw new Error(`already ${up.length} sandbox editors running on this machine (${up.join(', ')}; max_unity ${s.maxUnity}); stop one first`);
      }
    }
    const logsDir = path.join(r.path, 'Logs');
    const logFile = pickEditorLog(logsDir, new Date(this.d.now()));
    pruneEditorLogs(logsDir, logFile);
    const ed = this.editorFor(r, logFile);
    this.changed(r, { logPath: logFile });
    this.unityState.set(id, { state: 'starting', detail: 'launching', logPath: logFile, startedAt: this.d.now() });
    this.changed();
    try {
      out.push(await ed.unity.start());
    } catch (e) {
      this.unityState.set(id, { state: 'stopped', detail: `start failed: ${(e as Error).message}`, logPath: logFile });
      this.changed();
      throw e;
    }
    return out.join(' ');
  }

  /** The tail of a sandbox's editor log. */
  log(id: string, lines: number): string {
    const r = this.require(id);
    const p = this.unityState.get(id)?.logPath ?? r.logPath;
    if (!p || !fs.existsSync(p)) return '(no log yet)';
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const want = Math.min(size, Math.max(64 * 1024, lines * 400));
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      return buf.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Switch a sandbox's worktree to another branch (server/switchBranch.ts); refused while its editor runs. */
  async switch(id: string, branch: string, createFrom?: string): Promise<{ from: string; to: string; notes: string[] }> {
    const r = this.require(id);
    if (r.status !== 'ready') throw new Error(`sandbox ${id} is ${r.status}`);
    const problem = await sandboxBranchProblem(branch, this.d.git);
    if (problem) throw new Error(problem);
    if (this.editorUp(id)) throw new Error(`the editor of sandbox ${id} is running: stop it first (unity stop), switch, then start it again. A switch under a running editor stops Unity on "The open scene(s) have been modified externally".`);
    const res = await switchBranch({
      dir: r.path,
      branch,
      createFrom,
      lock: withBaseRepoLock,
      nameOf: (p) => [...this.recs.values()].find((x) => path.resolve(x.path).toLowerCase() === path.resolve(p).toLowerCase())?.id ?? (path.resolve(p).toLowerCase() === path.resolve(this.o.repoPath).toLowerCase() ? 'the main clone' : undefined),
    });
    this.git.set(id, await this.d.gitStatus(r.path));
    this.changed(r, { branch: res.to });
    return res;
  }

  /**
   * Commit and push a sandbox's uncommitted work on `branch` before the portal releases it (w656, server/saveWork.ts).
   * The editor may run: git reads the files, it does not rewrite them.
   */
  async saveWork(id: string, branch: string, message: string): Promise<SaveResult> {
    const r = this.require(id);
    if (r.status !== 'ready') throw new Error(`sandbox ${id} is ${r.status}`);
    const res = await saveWork({ dir: r.path, branch, message });
    this.git.set(id, await this.d.gitStatus(r.path));
    this.changed(r);
    return res;
  }

  /**
   * One look (the daemon's timer, every 30 s): each editor's state, its hang/crash watch, git status every few
   * minutes, the disk guard and the idle-editor stop. Never throws; overlapping calls are dropped.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.look();
    } catch (e) {
      this.o.onEvent({ text: `sandbox pool look failed: ${(e as Error).message}` });
    } finally {
      this.ticking = false;
    }
  }

  private async look() {
    const s = this.settings;
    let dirty = false;
    const procs = this.recs.size ? await this.d.procs() : [];
    const now = this.d.now();
    for (const r of this.recs.values()) {
      if (r.status !== 'ready') continue;
      const ed = this.editorFor(r);
      const pid = ed.unity.editors(procs)[0]?.pid;
      const prev = this.unityState.get(r.id) ?? { state: 'stopped' as const };
      let next: MachineSandboxUnity & { startedAt?: number };
      if (pid) next = { ...prev, pid, state: this.d.bridgeUp(r.path) ? 'running' : 'starting', detail: this.d.bridgeUp(r.path) ? 'MCP bridge up' : (prev.detail ?? 'loading'), startedAt: prev.startedAt ?? now };
      else next = { state: prev.state === 'crashed' ? 'crashed' : 'stopped', detail: prev.state === 'crashed' ? prev.detail : undefined, logPath: prev.logPath };
      if (JSON.stringify(next) !== JSON.stringify(prev)) {
        this.unityState.set(r.id, next);
        dirty = true;
      }
      // A new editor process (started here, restarted by its watch, or already running when adopted).
      if (pid && pid !== prev.pid && s?.belowNormal) this.d.lowerPriority?.(pid);
      // The watch restarts a hung or crashed editor (within its budget) and reports through onEvent.
      const verdict = await ed.watch?.tick();
      if (verdict === 'gave-up') {
        this.unityState.set(r.id, { ...(this.unityState.get(r.id) ?? { state: 'stopped' }), state: pid ? 'running' : 'crashed', detail: 'automatic restarts stopped; see the log' });
        dirty = true;
      }
    }
    if (now - this.lastGitAt > 2 * 60_000) {
      this.lastGitAt = now;
      for (const r of this.recs.values()) {
        if (r.status !== 'ready') continue;
        const g = await this.d.gitStatus(r.path).catch(() => undefined);
        if (JSON.stringify(g) !== JSON.stringify(this.git.get(r.id))) {
          this.git.set(r.id, g);
          dirty = true;
        }
      }
    }
    if (s) dirty = (await this.diskGuard(s)) || dirty;
    if (s) dirty = (await this.idleStop()) || dirty;
    if (dirty) this.o.onChange();
  }

  private async diskGuard(s: SandboxPoolSettings): Promise<boolean> {
    const free = await this.d.freeBytes(fs.existsSync(s.root) ? s.root : path.dirname(s.root));
    const was = this.disk.level;
    const level = diskLevel(free === undefined ? undefined : free / GB, was, { warnFreeGB: s.diskWarnGB, criticalFreeGB: s.diskCriticalGB, hysteresisGB: 5 });
    const changed = level !== was || (free !== undefined && Math.abs((this.disk.freeBytes ?? 0) - free) > GB);
    this.disk = { level, freeBytes: free };
    const gb = `${((free ?? 0) / GB).toFixed(0)} GB free on ${s.root}`;
    if (level !== was) {
      if (level === 'ok') this.o.onEvent({ text: `disk space is fine again (${gb}); sandboxes and sandbox editors can start again` });
      else if (level === 'warn') this.o.onEvent({ text: `disk space low: ${gb} (below disk_warn_gb ${s.diskWarnGB}); no new sandboxes or sandbox editors until space is freed` });
    }
    if (level === 'critical') {
      if (was !== 'critical') this.o.onEvent({ text: `disk space critical: ${gb} (below disk_critical_gb ${s.diskCriticalGB}); idle sandbox editors are stopped, and agents in sandboxes are asked to commit, push and end their turn`, checkpoint: true });
      for (const id of this.runningEditors().filter((x) => !this.o.activity(x).busy)) {
        await this.unity(id, 'stop').catch(() => undefined);
        this.o.onEvent({ text: `stopped the idle editor of sandbox ${id} (disk critical)`, sandbox: id });
      }
    }
    return changed;
  }

  private async idleStop(): Promise<boolean> {
    const minutes = this.o.idleStopMinutes ?? 120;
    const sbs = [...this.recs.values()].map((r) => ({ id: r.id, up: this.unityState.get(r.id)?.state === 'running', startedAt: this.unityState.get(r.id)?.startedAt }));
    const idle = idleSandboxEditors(sbs, this.o.activity, this.d.now(), minutes);
    for (const id of idle) {
      await this.unity(id, 'stop').catch(() => undefined);
      this.o.onEvent({ text: `stopped the editor of sandbox ${id}: no agent activity there for ${minutes} min`, sandbox: id });
    }
    return idle.length > 0;
  }
}

function tail(text: string) {
  return text.trim().split('\n').slice(-3).join(' | ');
}
