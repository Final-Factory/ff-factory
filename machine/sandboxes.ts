// Machine sandboxes (docs/machines.md, "Machine sandboxes"): the daemon's pool of git worktrees of its machine's main
// clone, each on its own branch in the configured sandbox root, with its own Library (seeded warm) and at most one
// Unity editor. The portal keeps the labels and agents; this keeps the folders, git and the editors, and reports every
// change as a snapshot. State survives daemon restarts in <app_dir>/sandboxes.json.
import fs from 'node:fs';
import path from 'node:path';
import { branchProblem, pickEditorLog, pruneEditorLogs, slugify, withBaseRepoLock } from '../server/sandboxes.ts';
import { switchBranch } from '../server/switchBranch.ts';
import { restoreCommittedBytes } from '../server/committedBytes.ts';
import { saveWork, type SaveResult } from '../server/saveWork.ts';
import { readGitStatus } from '../server/gitStatus.ts';
import { diskLevel } from '../server/hostHealth.ts';
import { bridgeUpSince } from '../server/unityHang.ts';
import { copyTree, lowerPriority, removeTree, run, type RunResult } from '../server/proc.ts';
import { LIBRARY_CACHES, staleUnityLibraries } from '../server/cleanup.ts';
import { TRIM_DEFAULTS, projectOpen, trimLibraryCaches, type TrimPolicy, type TrimResult } from '../server/cacheTrim.ts';
import { checkArray, readJsonDurable, writeJsonDurable } from '../server/durable.ts';
import { armScriptReimport } from './scriptReimport.ts';
import { MacUnity, MacUnityWatch, realDeps, type Proc, type UnityDeps, type UnityLocation } from './unity.ts';
import type { DaemonSandbox } from '../server/machineProtocol.ts';
import type { BenchTicket } from './benchQueue.ts';
import type { IdleCloseResult } from './liveIdle.ts';
import { isPersonTicket } from './personPlay.ts';
import type { DiskLevel, GitStatus, MachineSandboxIdleClosed, MachineSandboxUnity, SandboxPoolSettings, SandboxStatus } from '../shared/types.ts';

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GB = 1024 ** 3;
/**
 * A sandbox nobody has used for this many days gets its Library cloned from the seed again (w1576, docs/sandbox-disk.md option E):
 * its own Library had grown to 17-21 GB on LothDesktop (measured 2026-10-19), a fresh clone of the seed costs the drive almost
 * nothing, and the next editor start imports what changed since the seed.
 */
export const RESEED_IDLE_DAYS = 3;
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

/**
 * A sandbox whose editor a timed run's turn closed (w1829, machine/benchTurn.ts), kept in sandboxes.json so a daemon restart
 * still reopens it. Marked before the save and quit is sent, so a restart in the middle of one does not lose it; it goes
 * when the editor runs again (a pid not among `pids`), whoever started it.
 */
export interface MachineSandboxBenchClosed {
  at: string;
  by: string;
  /** The bench ticket whose turn closed it: another ticket's turn (or none) reopens it. */
  ticket: string;
  /** The editor processes it was closed in: one still running is not "open again". */
  pids: number[];
  saved?: string[];
  /** When its start was asked for after the turn (the mark stays until the editor runs, so a start not made is tried again). */
  reopenAt?: string;
}

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
  /** Its editor was closed because its Live view sat idle (w1746); kept across daemon restarts so the next turn reopens it. */
  idleClosed?: MachineSandboxIdleClosed;
  /** Its editor was closed for another worker's timed run (w1829, machine/benchTurn.ts); kept so a restart reopens it. */
  benchClosed?: MachineSandboxBenchClosed;
  /** What its next worker message hears about that close, once the editor starts again (w1829). */
  benchNote?: string;
}

/** The editor side of one sandbox: its MacUnity and hang/crash watch (a fake in tests). */
export interface SandboxEditor {
  unity: Pick<MacUnity, 'start' | 'stop' | 'status' | 'editors' | 'logFile'>;
  watch?: Pick<MacUnityWatch, 'tick' | 'expectExit' | 'describe'>;
}

export interface PoolDeps {
  git(args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RunResult>;
  copyTree(src: string, dst: string, signal?: AbortSignal, mode?: 'robocopy' | 'clone', exclude?: string[]): Promise<void>;
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
  /**
   * The Unity MCP bridge of a project: up once it has a port and, given `since`, a status file written at or after it (the
   * editor that runs now, not one before it: server/unityHang.ts bridgeUpSince, w1829).
   */
  bridgeUp(project: string, since?: number): boolean;
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
  /**
   * Live agents in a sandbox now (the daemon's own sessions). With it, the pool trims a sandbox's Library caches the moment its last
   * live agent is gone (w898): status 'cleanup' while it runs, 'ready' after. Unset: no trim on release.
   */
  liveAgents?(id: string): number;
  /** The trim's limits (server/cacheTrim.ts TRIM_DEFAULTS), or false to switch it off. */
  trim?: Partial<TrimPolicy> | false;
  /**
   * Sandboxes whose Library caches stay warm (w1668: slot1 on a build computer, where urgent releases build): never
   * trimmed when released and never cloned from the seed again. lothsahn: "urgent builds always get scheduled in slot1 on
   * whatever machine they run in so that it uses caches as warm as possible". Measured on biscuit (Linux release build,
   * main): 81 s warm, 244 s once the caches the trim drops were gone (Burst 82 s again, the player 172 s against 39 s).
   */
  warm?: readonly string[];
  /** The trim itself (tests put a hung or failing one here). */
  trimmer?: typeof trimLibraryCaches;
  /**
   * What else leaves with the Library trim when a sandbox is released (w913): the build and capture output its last worker made
   * (server/installLeftovers.ts RELEASE_SETTINGS). Runs in the same 'cleanup' state, under the same timeout, only while no agent
   * is live there and no editor or build has the project open.
   */
  releaseSweep?(sandboxPath: string): Promise<{ files: number; bytes: number }>;
  /** A line for the daemon's log. */
  log?(line: string): void;
  /** Why a sandbox editor may not start now (the machine's host guard, w466: the drive is gone, disk space is low), or undefined. */
  startGate?: () => string | undefined;
  /** Room a warm Library copy needs, in GB, on top of the warning threshold (a clone on APFS costs far less up front). */
  librarySeedGB?: number;
  /** Days a sandbox lies unused before its Library is cloned from the seed again (w1576, RESEED_IDLE_DAYS); 0: never. */
  reseedIdleDays?: number;
  /**
   * Whether an editor of this sandbox may start now, by the machine's Unity slots (w469, machine/unitySlots.ts: every
   * Unity process on the machine counts, and waiting launches go first): undefined yes, else why not. Unset: only the
   * pool's own editors count against max_unity, as before.
   */
  editorSlot?(id: string): Promise<string | undefined>;
  /** Every Unity editor of the machine, counted now, for `unity status`. */
  slotsStatus?(): Promise<string>;
  /**
   * A shared ticket in the machine's bench queue for an editor (w1615, machine/benchQueue.ts): an editor never boots or
   * runs beside a timed bench leg. Taken after the Unity slot check and held for as long as the editor runs (w1860; a
   * running editor without one takes one). A ticket that is not granted at once queues the start, which the pool makes
   * itself at its turn. Unset, or { why }: the editor starts without one.
   */
  bootTicket?(sb: { id: string; path: string }): { ticket?: BenchTicket; why?: string };
}

/** How long `unity start` waits for a boot's bench ticket before it answers "queued" (python's start-up is under 1 s). */
export const BOOT_TICKET_ANSWER_MS = 5_000;
/** w1860: a running editor with no live bench ticket asks for one again after this long (a lost ticket, a failed take). */
export const EDITOR_TICKET_RETRY_MS = 60_000;

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

/** What `git lfs dedup` did in a worktree: the bytes it made clones of the LFS store, or why it did nothing. */
export type LfsDedup = { bytes: number } | { skipped: string };

/**
 * Re-create a worktree's Git LFS files as copy-on-write clones of the clone's LFS store (`git lfs dedup`, w1576). A checkout
 * smudges every LFS file into a full copy: 9.1 GB of each game worktree on lothdesktop, its proof videos, art and FMOD audio
 * (5,026 files; the dedup took 9 s there, measured 2026-10-19). git-lfs does nothing where the file system cannot clone (NTFS,
 * ext4) and refuses a worktree with any uncommitted or untracked change. Never throws.
 */
export async function lfsDedup(git: PoolDeps['git'], dir: string, signal?: AbortSignal): Promise<LfsDedup> {
  const res = await git(['-C', dir, 'lfs', 'dedup'], { timeoutMs: 10 * 60_000, signal }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
  if (res.code !== 0) return { skipped: tail(res.stderr || res.stdout) || `exit ${res.code}` };
  const m = /De-duplicated\s+size:\s*(\d+)\s*bytes/i.exec(res.stdout + res.stderr);
  return { bytes: m ? Number(m[1]) : 0 };
}

/** The log's words for an lfsDedup result. */
export const lfsDedupWords = (r: LfsDedup) => ('bytes' in r ? `LFS files shared with the store: ${(r.bytes / 1024 ** 3).toFixed(1)} GB` : `LFS dedup skipped (${r.skipped})`);

/** A Library folder with something in it (a clone that never opened Unity has none, or an empty one). */
export function hasLibrary(dir: string): boolean {
  return nonEmpty(path.join(dir, 'Library'));
}

const hasLibraryFiles = (dir: string) => nonEmpty(dir);

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
    copyTree: (src, dst, signal, mode, exclude) => copyTree(src, dst, { signal, mode, exclude }),
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
    bridgeUp: (project, since) => bridgeUpSince(project, since),
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
  /**
   * w1829: per sandbox, the editor process its bridge check is for and since when its bridge counts: its launch here, else
   * when a look first saw it (a restart by its watch); none for an editor already running at the pool's first look.
   */
  private readonly bridgeSince = new Map<string, { pid: number; since?: number }>();
  /** w1829: when launch() last started each sandbox's editor, until a look sees its process. */
  private readonly launchedAt = new Map<string, number>();
  /** A look has run (w1829: an editor seen at the first one was running before this daemon). */
  private looked = false;
  private readonly editors = new Map<string, SandboxEditor>();
  private readonly git = new Map<string, GitStatus | undefined>();
  private readonly provisioning = new Map<string, AbortController>();
  private readonly busy = new Set<string>();
  /** Sandboxes whose Library caches are being trimmed now (w898). */
  private readonly trimming = new Map<string, Promise<TrimResult>>();
  /** Per sandbox: whether it had a live agent at the last look, so the moment the last one goes is seen. */
  private readonly occupied = new Map<string, boolean>();
  /** w1615: editor starts queued in the bench queue; w1860: the tickets of editors booting or running (held while they run). */
  private readonly queuedBoots = new Map<string, BenchTicket>();
  private readonly bootTickets = new Map<string, { ticket: BenchTicket; at: number }>();
  /** w1860: when a running editor with no live ticket may ask for one again (after a failed take or a lost ticket). */
  private readonly ticketRetryAt = new Map<string, number>();
  /** Released sandboxes still to trim (the editor was up when the last agent left). */
  private readonly pendingTrim = new Set<string>();
  private disk: { level: DiskLevel; freeBytes?: number } = { level: 'ok' };
  /** When each sandbox's editor was last stopped with the tool (its launches keep a holder's priority a while, w469). */
  private readonly stoppedAt = new Map<string, number>();
  /** The pids of each editor closed idle (w1746): a look that still lists one is not a new start. */
  private readonly idleClosedPids = new Map<string, number[]>();
  private lastGitAt = 0;
  private lastReseedLookAt = 0;
  private reseeding = false;
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
      // A trim a restart cut off: the caches are intact or partly trimmed, both fine; the sandbox is free again.
      else if (r.status === 'cleanup') Object.assign(r, { status: 'ready', statusDetail: undefined });
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
      return { id: r.id, branch: r.branch, base: r.base, path: r.path, createdAt: r.createdAt, status: r.status, statusDetail: r.statusDetail, unity: { ...unity, logPath: unity.logPath ?? r.logPath }, git: this.git.get(r.id), ...(r.idleClosed ? { idleClosed: r.idleClosed } : {}) };
    });
  }

  /** The pids of a sandbox's editor processes now (w1746). */
  async editorPids(id: string): Promise<number[]> {
    return this.editorFor(this.require(id)).unity.editors(await this.d.procs()).map((e) => e.pid);
  }

  /** Whether its editor was closed idle (w1746), and how; undefined when not. */
  idleClosedOf(id: string): MachineSandboxIdleClosed | undefined {
    return this.recs.get(id)?.idleClosed;
  }

  /**
   * Close a sandbox's running editor because its Live view sat idle (w1746): `close` saves and quits it through the editor
   * (machine/liveIdle.ts idleCloseEditor). Closed: the sandbox is marked (list_sandboxes shows it, the next turn reopens
   * it). The crash watch is told first, so the quit is not taken for a crash and restarted.
   */
  async idleClose(id: string, minutes: number, close: () => Promise<IdleCloseResult>): Promise<IdleCloseResult> {
    const r = this.require(id);
    if (r.status !== 'ready') return { closed: false, saved: [], text: `skipped: the sandbox is ${r.status}` };
    if (this.unityState.get(id)?.state !== 'running' || this.queuedBoots.has(id)) return { closed: false, saved: [], text: 'skipped: its editor is not up and running' };
    const pids = await this.editorPids(id);
    const watch = this.editorFor(r).watch;
    watch?.expectExit(10 * 60_000);
    const res = await close();
    if (!res.closed) {
      if (!res.quitting) watch?.expectExit(0); // still in use: watched for hangs again (w1829)
      return res;
    }
    this.idleClosedPids.set(id, pids);
    this.stoppedAt.set(id, this.d.now());
    this.unityState.set(id, { state: 'stopped', detail: `closed: Live view idle ${minutes} min; reopens on resume`, logPath: this.unityState.get(id)?.logPath });
    this.changed(r, { idleClosed: { at: new Date(this.d.now()).toISOString(), minutes, ...(res.saved.length ? { saved: res.saved } : {}) } });
    return res;
  }

  /**
   * Close a sandbox's running editor for another worker's timed run (w1829, machine/benchTurn.ts): `close` saves and quits
   * it through the editor (machine/liveIdle.ts idleCloseEditor). Closed: the sandbox is marked, the panel and list_sandboxes
   * say why, and the turn's end starts it again. The crash watch is told first, so the quit is not restarted, and the mark
   * is written before the quit is sent: a daemon restart while it quits still reopens it.
   */
  async benchClose(id: string, by: string, ticket: string, detail: string, close: () => Promise<IdleCloseResult>): Promise<IdleCloseResult> {
    const r = this.require(id);
    if (r.status !== 'ready') return { closed: false, saved: [], text: `skipped: the sandbox is ${r.status}` };
    if (this.unityState.get(id)?.state !== 'running' || this.queuedBoots.has(id)) return { closed: false, saved: [], text: 'skipped: its editor is not up and running' };
    const pids = await this.editorPids(id);
    const watch = this.editorFor(r).watch;
    watch?.expectExit(10 * 60_000);
    const mark: MachineSandboxBenchClosed = { at: new Date(this.d.now()).toISOString(), by, ticket, pids };
    this.changed(r, { benchClosed: mark });
    let res: IdleCloseResult;
    try {
      res = await close();
    } catch (e) {
      res = { closed: false, saved: [], text: `skipped: ${(e as Error).message}` };
    }
    if (!res.closed) {
      // Still running: no close happened (a quit it took and is still on keeps its mark, and the editor's pid with it).
      if (!res.quitting) {
        watch?.expectExit(0);
        if (this.recs.get(id)?.benchClosed === mark) this.changed(r, { benchClosed: undefined });
      }
      return res;
    }
    this.stoppedAt.set(id, this.d.now());
    this.unityState.set(id, { state: 'stopped', detail, logPath: this.unityState.get(id)?.logPath });
    this.changed(r, { benchClosed: { ...mark, ...(res.saved.length ? { saved: res.saved } : {}) } });
    return res;
  }

  /** The sandboxes a timed run's turn closed that are not open again yet (w1829): when, by which ticket, and their start. */
  benchClosedList(): { id: string; at: number; ticket: string; reopenAt?: number; starting: boolean }[] {
    return [...this.recs.values()]
      .filter((r) => r.benchClosed)
      .map((r) => {
        const c = r.benchClosed!;
        const starting = this.queuedBoots.has(r.id) || this.bootTickets.has(r.id) || this.unityState.get(r.id)?.state === 'starting';
        return { id: r.id, at: Date.parse(c.at), ticket: c.ticket ?? '', ...(c.reopenAt ? { reopenAt: Date.parse(c.reopenAt) } : {}), starting };
      });
  }

  /**
   * The turn that closed it ended (w1829): start its editor again (a shared ticket: it comes back in the next shared turn,
   * or queues) and keep the note its worker's next message starts with. The mark stays until the editor runs (look()), so
   * a start refused or not made at its turn is asked for again. Throws when it cannot start.
   */
  async benchReopen(id: string): Promise<string> {
    const r = this.require(id);
    const c = r.benchClosed;
    if (!c) return 'not closed';
    const text = await this.unity(id, 'start');
    const first = !c.reopenAt;
    const saved = c.saved?.length ? ` It saved ${c.saved.join(', ')} first.` : '';
    this.changed(r, {
      benchClosed: { ...c, pids: [], reopenAt: new Date(this.d.now()).toISOString() },
      ...(first ? { benchNote: `[bench turn] Your sandbox's Unity editor was closed at ${c.at.slice(11, 16)}Z for ${c.by} (${isPersonTicket(c.ticket) ? 'w1894: while a person plays the game on this machine, the agents\' editors, players and builds yield to it' : "w1829: while another worker's exclusive bench ticket times a run, nothing else runs on this machine"}).${saved} Its assets were saved too: check git status. Anything in play mode then is gone. It is starting again now (${text.slice(0, 200)}); mcp__machine__unity status says when it is up.` } : {}),
    });
    return text;
  }

  /** Its editor was asked to start again after a turn and still does not run (w1829): the mark goes, its worker is told. */
  benchGiveUp(id: string, tries: number) {
    const r = this.recs.get(id);
    const c = r?.benchClosed;
    if (!r || !c) return;
    this.changed(r, { benchClosed: undefined, benchNote: `[bench turn] Your sandbox's Unity editor was closed at ${c.at.slice(11, 16)}Z for ${c.by} (w1829) and did not come back after ${tries} starts; FF Factory stopped trying. Start it with mcp__machine__unity start when you need it (its status and log say why it did not run).` });
    this.o.onEvent({ text: `sandbox ${id}: its editor, closed for ${c.by}, did not run again after ${tries} starts; left stopped (w1829)`, sandbox: id, unity: true });
  }

  /** The note about a timed run's close for the next message to a worker in this sandbox, once (w1829). */
  takeBenchNote(id: string | undefined): string | undefined {
    const r = id ? this.recs.get(id) : undefined;
    const n = r?.benchNote;
    if (r && n) this.changed(r, { benchNote: undefined });
    return n;
  }

  /** Its Live view ended while its editor was closed idle (w1746): nothing is to reopen for it any more. */
  forgetIdleClosed(id: string) {
    const r = this.recs.get(id);
    if (r) this.clearIdleClosed(r);
  }

  /** The editor of a sandbox closed idle starts again (w1746): the mark goes, whoever starts it. */
  private clearIdleClosed(r: Rec) {
    this.idleClosedPids.delete(r.id);
    if (r.idleClosed) this.changed(r, { idleClosed: undefined });
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
      step('sharing the LFS files with the clone (git lfs dedup)');
      this.o.log?.(`sandbox ${r.id}: ${lfsDedupWords(await lfsDedup(this.d.git, r.path, signal))}`);
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
          // The configured seed is cleaned on purpose and keeps its caches (a warm start); any other source (the main clone's, a sandbox's)
          // may carry the BuildCache and BurstCache it grew over days: those stay behind (w898, 4.8-12.7 GB each on lothdesktop).
          await this.d.copyTree(src, path.join(r.path, 'Library'), signal, settings.librarySeedCopy, src === settings.librarySeed ? undefined : LIBRARY_CACHES);
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
    this.endBoot(id);
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
    this.endBoot(id);
    this.changed();
    return `Released sandbox ${id}; ${r.path} and its editor are left as they are.`;
  }

  /**
   * Trim a sandbox's Library caches before it goes to the next worker (w898). The sandbox is 'cleanup' meanwhile: not free, no
   * agent and no editor start there (the daemon and the portal refuse a sandbox that is not 'ready'), and 'ready' again when the
   * trim ends, fails or `timeoutMs` passes (the timeout also stops the trim between two files). Skipped, saying why, while an agent
   * lives there or an editor or build has the project open. A second call while one runs returns that run.
   */
  trim(id: string, why = 'released'): Promise<TrimResult> {
    const r = this.recs.get(id);
    const none = (skipped: string): Promise<TrimResult> => Promise.resolve({ skipped, files: 0, removedBytes: 0, keptBytes: 0 });
    if (!r) return none('no such sandbox');
    const running = this.trimming.get(id);
    if (running) return running;
    if (this.o.trim === false) return none('trim is off');
    if (r.status !== 'ready') return none(`the sandbox is ${r.status}`);
    if (this.busy.has(id)) return none('the sandbox is busy');
    if ((this.o.liveAgents?.(id) ?? 0) > 0) return none('an agent is live there');
    if (this.editorUp(id)) return none('its editor is up');
    if (projectOpen(r.path)) return none('an editor or build has the project open');
    const policy = { ...TRIM_DEFAULTS, ...(this.o.trim || {}) };
    this.changed(r, { status: 'cleanup', statusDetail: `trimming the Library caches (${why})` });
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<TrimResult>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve({ stopped: `timed out after ${Math.round(policy.timeoutMs / 1000)} s`, files: 0, removedBytes: 0, keptBytes: 0 });
      }, policy.timeoutMs);
    });
    const run = (async (): Promise<TrimResult> => {
      let res: TrimResult;
      try {
        res = await Promise.race([
          (async () => {
            // A warm sandbox keeps its caches (w1668); its LFS dedup and build-output sweep still run.
            let t: TrimResult = this.o.warm?.includes(id) ? { files: 0, removedBytes: 0, keptBytes: 0 } : await (this.o.trimmer ?? trimLibraryCaches)(r.path, policy, { signal: ac.signal });
            if (t.skipped || t.stopped || ac.signal.aborted) return t;
            // The LFS files a branch switch or merge smudged into full copies since, shared again (w1576); a clean worktree only.
            if (!projectOpen(r.path)) t = { ...t, lfs: await lfsDedup(this.d.git, r.path, ac.signal) };
            if (ac.signal.aborted || !this.o.releaseSweep) return t;
            // The released sandbox's own build and capture output (w913); a failure here must not fail the trim.
            const swept = await this.o.releaseSweep(r.path).catch((e: Error) => {
              this.o.log?.(`sandbox ${id}: release sweep failed: ${e.message}`);
              return undefined;
            });
            return swept ? { ...t, swept } : t;
          })(),
          timedOut,
        ]);
      } catch (e) {
        res = { stopped: `failed: ${(e as Error).message}`, files: 0, removedBytes: 0, keptBytes: 0 };
      } finally {
        clearTimeout(timer);
        ac.abort(); // a trim that lost the race to the timeout stops at its next file
        this.trimming.delete(id);
        // Back to free, whatever happened: a failed or hung trim must not leave the sandbox stuck (w898).
        if (this.recs.get(id) === r && r.status === 'cleanup') this.changed(r, { status: 'ready', statusDetail: undefined });
      }
      const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
      const line = `sandbox ${id}: Library cache trim (${why}): removed ${res.files} files, ${gb(res.removedBytes)}, kept ${gb(res.keptBytes)}${res.lfs ? `; ${lfsDedupWords(res.lfs)}` : ''}${res.swept ? `; build and capture output: ${res.swept.files} entries, ${gb(res.swept.bytes)}` : ''}${res.stopped ? `; stopped early (${res.stopped}), handed back as it is` : ''}${res.skipped ? `; skipped (${res.skipped})` : ''}`;
      this.o.log?.(line);
      if (res.stopped) this.o.onEvent({ text: line, sandbox: id });
      return res;
    })();
    this.trimming.set(id, run);
    return run;
  }

  /**
   * Clone the Library of a sandbox nobody has used for reseedIdleDays from the seed again (w1576), one at a time, every 10 minutes
   * at most. Only where the copy is a block clone (the pool's librarySeedCopy 'clone', or a Mac's `cp -c`): a full copy would
   * spend the space it frees. Unused means no live agent, no editor or build with the project open, no agent activity, and no
   * change to Library's own entries, Temp, Logs or UserSettings (cleanup.ts staleUnityLibraries) for that many days. The sandbox is
   * 'cleanup' meanwhile, so nobody is handed it half done.
   */
  private async reseedIdle() {
    const days = this.o.reseedIdleDays ?? RESEED_IDLE_DAYS;
    const s = this.settings;
    const now = this.d.now();
    if (days <= 0 || !s?.librarySeed || !(s.librarySeedCopy === 'clone' || process.platform === 'darwin')) return;
    if (this.reseeding || now - this.lastReseedLookAt < 10 * 60_000) return;
    this.lastReseedLookAt = now;
    if (!hasLibraryFiles(s.librarySeed)) return;
    for (const r of this.recs.values()) {
      if (r.status !== 'ready' || this.busy.has(r.id) || this.trimming.has(r.id) || this.editorUp(r.id) || projectOpen(r.path)) continue;
      if ((this.o.liveAgents?.(r.id) ?? 0) > 0) continue;
      // The urgent release lane builds there (w1668, `warm`): its Library keeps the shaders every target compiled, which
      // the seed's does not (1.0.0.3: a Library that never built Mac and Linux cost about an hour more), however long it lies idle.
      if (this.o.warm?.includes(r.id)) continue;
      const a = this.o.activity(r.id);
      if (a.busy || now - a.lastActivityMs < days * 86_400_000) continue;
      const stale = await staleUnityLibraries([r.path], days, now, 0);
      if (!stale.length) continue;
      this.reseeding = true;
      void this.reseed(r, s.librarySeed, s.librarySeedCopy, stale[0].days).finally(() => (this.reseeding = false));
      return;
    }
  }

  private async reseed(r: Rec, seed: string, mode: SandboxPoolSettings['librarySeedCopy'], idleDays: number) {
    const lib = path.join(r.path, 'Library');
    this.busy.add(r.id);
    this.changed(r, { status: 'cleanup', statusDetail: `cloning the Library from the seed again (unused for ${idleDays} days)` });
    let line: string;
    try {
      const before = await treeBytes(lib);
      const res = await this.d.removeTree(lib);
      if (fs.existsSync(lib)) throw new Error(`the old Library would not go (${res.code}): ${tail(res.stderr || res.stdout)}`);
      await this.d.copyTree(seed, lib, undefined, mode);
      const common = await this.d.git(['-C', r.path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (common.code === 0) armScriptReimport(r.path, common.stdout.trim());
      line = `sandbox ${r.id}: unused for ${idleDays} days: its Library (${((before ?? 0) / GB).toFixed(1)} GB) cloned from the seed again`;
    } catch (e) {
      line = `sandbox ${r.id}: cloning the Library from the seed again failed: ${(e as Error).message}`;
      this.o.onEvent({ text: line, sandbox: r.id });
    } finally {
      this.busy.delete(r.id);
      if (r.status === 'cleanup') this.changed(r, { status: 'ready', statusDetail: undefined });
    }
    this.o.log?.(line);
  }

  /**
   * Trim each sandbox whose last live agent just went (a request closed, a wait for CI or a person, a stop, the idle reaper: every
   * way a worker leaves ends its session here), and each one still to trim once its editor is down. One look per tick; the trims
   * run on, not awaited.
   */
  private trimReleased() {
    if (!this.o.liveAgents || this.o.trim === false) return;
    for (const r of this.recs.values()) {
      const occupied = this.o.liveAgents(r.id) > 0;
      const was = this.occupied.get(r.id);
      this.occupied.set(r.id, occupied);
      if (occupied) {
        this.pendingTrim.delete(r.id);
        continue;
      }
      if (was === true) this.pendingTrim.add(r.id);
      if (!this.pendingTrim.has(r.id) || r.status !== 'ready') continue;
      void this.trim(r.id).then((res) => {
        // Waiting only for the editor or build to end: keep it for a later look. Any other answer is final.
        if (!res.skipped || !/editor|build/.test(res.skipped)) this.pendingTrim.delete(r.id);
      });
    }
    for (const id of [...this.pendingTrim]) if (!this.recs.has(id)) this.pendingTrim.delete(id);
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
    // A start queued in the bench queue (w1615) holds no slot: its turn checks the slots again, as the daemon's count does.
    return [...this.recs.keys()].filter((id) => this.editorUp(id) && !this.queuedBoots.has(id));
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
    // w1829: a stop asked for is the last word: a timed run's turn does not start this editor again after it.
    if (action === 'stop' && r.benchClosed) this.changed(r, { benchClosed: undefined });
    if (action === 'stop' || action === 'restart') {
      if (this.endBoot(id)) out.push('Its queued start is cancelled (w1615).');
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
    if (this.queuedBoots.has(id)) return [...out, `Already queued in the bench queue (w1615): ${this.unityState.get(id)?.detail ?? 'waiting'}.`].join(' ');
    if (!hadEditor) await this.checkSlot(id);
    // w1615: the Unity slot first (above), then a shared ticket in the bench queue, never the other way round.
    const boot = this.o.bootTicket?.(r);
    if (boot?.why) this.o.log?.(`sandbox ${id}: editor start without a bench ticket: ${boot.why}`);
    if (boot?.ticket) {
      const st = await boot.ticket.wait(BOOT_TICKET_ANSWER_MS);
      if (st.kind === 'waiting') {
        this.queueBoot(r, boot.ticket, hadEditor, st.line);
        return [...out, `Queued (w1615): this machine's bench queue has a timed run holding the lock or ahead of this start (${st.line}). The editor starts by itself at its turn, never beside a timed run; \`unity status\` shows its place. Do what needs no editor meanwhile, then wake_me in 10 minutes and look.`].join(' ');
      }
      if (st.kind === 'granted') this.bootTickets.set(id, { ticket: boot.ticket, at: this.d.now() });
      else {
        this.o.log?.(`sandbox ${id}: editor start without a bench ticket: ${st.line}`);
        boot.ticket.release();
      }
    }
    try {
      out.push(...(await this.launch(r)));
    } catch (e) {
      this.endBoot(id);
      throw e;
    }
    return out.join(' ');
  }

  /** Whether the machine's Unity slots let this sandbox's editor start now; throws why not. */
  private async checkSlot(id: string) {
    const s = this.need();
    if (this.o.editorSlot) {
      const why = await this.o.editorSlot(id);
      if (why) throw new Error(why);
    } else {
      const up = this.runningEditors().filter((x) => x !== id);
      if (up.length >= s.maxUnity) throw new Error(`already ${up.length} sandbox editors running on this machine (${up.join(', ')}; max_unity ${s.maxUnity}); stop one first`);
    }
  }

  /** Let go of a sandbox's queued start or boot ticket; true when a start was queued. */
  private endBoot(id: string): boolean {
    const q = this.queuedBoots.get(id);
    this.queuedBoots.delete(id);
    q?.release();
    this.bootTickets.get(id)?.ticket.release();
    this.bootTickets.delete(id);
    return !!q;
  }

  /** A start queued in the bench queue (w1615): made at its turn, after the gates are checked again (none is waited for). */
  private queueBoot(r: Rec, t: BenchTicket, hadEditor: boolean, line: string) {
    const id = r.id;
    this.queuedBoots.set(id, t);
    this.unityState.set(id, { state: 'starting', detail: `queued in the bench queue: ${line}`, startedAt: this.d.now() });
    this.changed();
    void (async () => {
      const st = await t.wait(Infinity, (l) => {
        if (this.queuedBoots.get(id) !== t) return;
        this.unityState.set(id, { ...(this.unityState.get(id) ?? { state: 'starting' }), state: 'starting', detail: `queued in the bench queue: ${l}` });
        this.changed();
      });
      if (this.queuedBoots.get(id) !== t) return; // stopped, restarted or released meanwhile: endBoot let it go
      this.queuedBoots.delete(id);
      if (st.kind === 'granted') this.bootTickets.set(id, { ticket: t, at: this.d.now() });
      else {
        this.o.log?.(`sandbox ${id}: queued editor start goes on without a bench ticket: ${st.line}`);
        t.release();
      }
      try {
        const rec = this.require(id);
        if (rec.status !== 'ready') throw new Error(`sandbox ${id} is ${rec.status}`);
        const gate = this.o.startGate?.();
        if (gate) throw new Error(gate);
        if (this.disk.level !== 'ok') throw new Error(`disk space is ${this.disk.level}`);
        if (this.editorFor(rec).unity.editors(await this.d.procs()).length) throw new Error('an editor already runs there');
        if (!hadEditor) await this.checkSlot(id);
        const said = await this.launch(rec);
        this.o.onEvent({ text: `sandbox ${id}: its queued editor start ran at its turn in the bench queue. ${said.join(' ')}`, sandbox: id, unity: true });
      } catch (e) {
        this.endBoot(id);
        this.unityState.set(id, { state: 'stopped', detail: `queued start not made: ${(e as Error).message}` });
        this.changed();
        this.o.onEvent({ text: `sandbox ${id}: its queued editor start was not made at its turn in the bench queue: ${(e as Error).message}. Start it again.`, sandbox: id, unity: true });
      }
    })();
  }

  /** Launch the editor (the gates are checked); the lines to say. */
  private async launch(r: Rec): Promise<string[]> {
    const id = r.id;
    const out: string[] = [];
    // A checkout written under core.autocrlf=true keeps CRLF copies of files a later .gitattributes rule made -text (a pull
    // rewrites only changed blobs): FMOD's mac bundle plists showed its "Repair FMOD Libraries" dialog at every start (w1275).
    try {
      const restored = await restoreCommittedBytes(r.path, (a) => this.d.git(['-C', r.path, ...a]));
      if (restored.length) out.push(`Put back the committed bytes of ${restored.length} file(s) checked out with CRLF.`);
    } catch (e) {
      this.o.onEvent({ text: `sandbox ${id}: could not check its -text files for CRLF copies: ${(e as Error).message}`, sandbox: id });
    }
    const logsDir = path.join(r.path, 'Logs');
    const logFile = pickEditorLog(logsDir, new Date(this.d.now()));
    pruneEditorLogs(logsDir, logFile);
    const ed = this.editorFor(r, logFile);
    this.changed(r, { logPath: logFile });
    this.clearIdleClosed(r);
    this.unityState.set(id, { state: 'starting', detail: 'launching', logPath: logFile, startedAt: this.d.now() });
    this.launchedAt.set(id, this.d.now());
    this.changed();
    try {
      out.push(await ed.unity.start());
    } catch (e) {
      this.launchedAt.delete(id);
      this.unityState.set(id, { state: 'stopped', detail: `start failed: ${(e as Error).message}`, logPath: logFile });
      this.changed();
      throw e;
    }
    return out;
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
  async switch(id: string, branch: string, createFrom?: string, env?: NodeJS.ProcessEnv): Promise<{ from: string; to: string; notes: string[] }> {
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
      env,
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
  async saveWork(id: string, branch: string, message: string, env?: NodeJS.ProcessEnv): Promise<SaveResult> {
    const r = this.require(id);
    if (r.status !== 'ready') throw new Error(`sandbox ${id} is ${r.status}`);
    const res = await saveWork({ dir: r.path, branch, message, env });
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
      this.trimReleased();
      await this.reseedIdle();
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
      // w1829: the bridge counts only once this editor's own bridge wrote its status (bridgeUpSince); a port file left by
      // an earlier editor marked a booting editor running 12 s into its 199 s first import, beside a timed run.
      let bs = pid ? this.bridgeSince.get(r.id) : undefined;
      if (pid && bs?.pid !== pid) {
        const launched = this.launchedAt.get(r.id);
        this.launchedAt.delete(r.id);
        bs = { pid, since: launched ?? (this.looked ? now : undefined) };
        this.bridgeSince.set(r.id, bs);
      }
      if (!pid) this.bridgeSince.delete(r.id);
      const up = !!pid && this.d.bridgeUp(r.path, bs?.since);
      // w1860 (lothsahn, 2026-10-23: "running editors and game players hold a shared ticket while they run"): an editor's
      // shared ticket is held for as long as it runs, no longer only while it boots (w1615), and goes once it is gone (a
      // boot gets 2 minutes to show its process).
      const boot = this.bootTickets.get(r.id);
      if (boot && !pid && now - boot.at > 2 * 60_000) {
        boot.ticket.release();
        this.bootTickets.delete(r.id);
      }
      // A running editor whose ticket was lost (revoked at the shared group's limit, its helper gone) or that never had one
      // (adopted, started by hand, or the queue was not reachable at its start) takes a new one; the editor runs on
      // meanwhile, and the w1829 turn closes it if a timed run is granted first.
      if (pid && !this.queuedBoots.has(r.id) && this.o.bootTicket) {
        const cur = this.bootTickets.get(r.id);
        if (cur && cur.ticket.state().kind === 'failed') {
          this.o.log?.(`sandbox ${r.id}: its running editor's bench ticket ended (${cur.ticket.state().line}); it takes a new one (w1860)`);
          cur.ticket.release();
          this.bootTickets.delete(r.id);
          this.ticketRetryAt.set(r.id, now + EDITOR_TICKET_RETRY_MS);
        } else if (!cur && now >= (this.ticketRetryAt.get(r.id) ?? 0)) {
          const t = this.o.bootTicket(r);
          if (t.ticket) this.bootTickets.set(r.id, { ticket: t.ticket, at: now });
          else {
            this.ticketRetryAt.set(r.id, now + EDITOR_TICKET_RETRY_MS);
            this.o.log?.(`sandbox ${r.id}: its running editor holds no bench ticket: ${t.why ?? 'none could be taken'}; asked again in ${EDITOR_TICKET_RETRY_MS / 60_000} min`);
          }
        }
      }
      if (!pid && this.queuedBoots.has(r.id)) continue; // its state says where it is in the queue
      // w1746: an editor closed idle that runs again (started by hand, or adopted) is no longer closed.
      if (pid && r.idleClosed && !this.idleClosedPids.get(r.id)?.includes(pid)) this.clearIdleClosed(r);
      // w1829: likewise an editor a timed run's turn closed (a later turn closes it again if it is still on).
      if (pid && r.benchClosed && !(r.benchClosed.pids ?? []).includes(pid)) this.changed(r, { benchClosed: undefined });
      let next: MachineSandboxUnity & { startedAt?: number };
      if (pid) next = { ...prev, pid, state: up ? 'running' : 'starting', detail: up ? 'MCP bridge up' : (prev.detail ?? 'loading'), startedAt: prev.startedAt ?? now };
      else next = { state: prev.state === 'crashed' ? 'crashed' : 'stopped', detail: prev.state === 'crashed' ? prev.detail : r.benchClosed ? (r.benchClosed.reopenAt ? `closed for ${r.benchClosed.by}, which ended; starting again` : `closed for ${r.benchClosed.by}; reopens when it ends`) : undefined, logPath: prev.logPath };
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
    this.looked = true;
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
