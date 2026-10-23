// What a worker leaves running after it stops (w1196, w1197). On 2026-10-13 biscuit ran its fans at 100% around the clock:
// two headless game players that workers had started were still up 27 h and 34 h after those workers stopped and their
// requests (w1072, w1025) closed, about 6 cores between them, with 17 Xvfb displays of earlier workers beside them.
// Nothing reaped them: the Unity slots listed them as "game players (not counted)", the batch reaper (unityReaper.ts)
// looks only at Unity, and the agent host's end (hostWatch.ts) takes only its own tree, which a detached player, an
// Xvfb started with setsid or anything reparented to init has left. Ben (w1197): "please update the fff harness to
// ensure everything is properly cleaned up so we arent wasting system resources on our machines after work is done".
//
// Who started a process: every process a worker starts inherits its environment, FF_SESSION_ID and FF_MACHINE_ID
// included (server/agents.ts), wherever it went since: a new session or process group, a detached launch, a parent that
// exited. So that is the owner, read from the process itself (Linux /proc/<pid>/environ, a Mac's `ps -E`, Windows the
// process's own environment block), not from its parent or its process group, which a detached player has left, and not
// from a job object, which only a native helper holding a handle across daemon restarts could keep. A game player started
// through the player slots (players/slotK-P) also names its session in its lease (player_slots.py, w1196); a program run
// from a worker's temp folder (<install>/tmp/ffa-<session>/...) names it in its path. On Windows a Git Bash program a
// worker's shell started (tail, sleep, a script's bash) shows no environment to the reader (measured on beast, w1575:
// the shell itself does, its msys children do not), so there one that names a single worker's temp folder among its
// arguments, in Windows or Git Bash form (`tail -f /f/ffw/tmp/ffa-<session>/run.log`), is that worker's, and ends only
// once its starter is gone too: 16 such tails held stopped workers' folders on LothDesktop for up to four days.
// A Unity AssetImportWorker whose editor is gone is an orphan like a slot-less player (two of slot2's ran a day on
// LothDesktop after its editor stopped, w1575); one under a running editor is spared with that editor's tree.
//
// When its owner is gone (the session's agent process is not running here), the daemon ends what it left, a grace after:
//   - DONE_GRACE_MS after the process stopped when no request waits for the session (its work is over);
//   - STOPPED_GRACE_MS after, when a request still waits for it (CI, a person, a pause): it comes back to its files, not
//     to a process left running unattended;
//   - and never before its pending wake_me check-in is due plus WAKE_GRACE_MS: a worker that set one is coming back to
//     look at a job (a soak run, a long test) and says so.
// A game player under a player slot that names no session (no environment, no lease) and whose starter is gone, whose
// slot nobody else holds and whose sandbox has no live worker, is an orphan: it ends ORPHAN_GRACE_MS after it was first
// seen so.
//
// Never touched: anything while its worker's process runs (between turns too); an interactive Unity editor, and what it
// started (the sandbox pool stops idle editors; a person's editor is never ours); a process that names the machine's main
// clone or the daemon's own folder (the agent hosts, which hostWatch.ts owns); a process carrying another machine's id or
// a session this machine never ran (the portal's own orchestrators where a daemon shares its host); a shared build server
// (VBCSCompiler, MSBuild nodes, bee) while it still uses CPU, since another worker's build may be using it; anything
// before the portal's welcome since the daemon started (until then who is live or waited for is not known). Every end is
// logged with what, why and whose, and told to the portal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../server/proc.ts';
import { factsProblem, judgePath, planFolders, renderFolders, withGitCheck, type CleanupFacts } from '../server/cleanupFolders.ts';
import { parsePsJson } from '../server/watchdog.ts';
import { driveLabel, inNeverGames, installDrive, onInstallDrive } from '../server/rootFence.ts';
import type { Proc, UnityPlatform } from './unity.ts';
import { gamePlayers, isUnityBinary, splitArgs, unityProcesses } from './unitySlots.ts';
import { inspectProcs, type ProcFacts } from './unityReaper.ts';

const MIN = 60_000;

/**
 * The limits. Where each comes from:
 * - DONE_GRACE_MS: a guess with a margin. The portal stops a worker whose requests are all closed at once (Agents.reapIdle,
 *   every 5 min); nothing comes back for what it left. Two looks a minute apart fit inside it.
 * - STOPPED_GRACE_MS: sourced. The session sweep empties a stopped worker's temp folder after the same 10 min
 *   (server/sessionSweep.ts graceMin): a resume within it finds both, after it neither.
 * - WAKE_GRACE_MS: a guess. A check-in that came due resumes the worker within a minute or two (server/wake.ts fires at its
 *   time; a held Claude pool queues it); 10 min more covers a slow start. Once resumed the worker is live again.
 * - ORPHAN_GRACE_MS: a guess, as STOPPED_GRACE_MS: an orphan has no owner to come back for it.
 * - LOOKS: a process ends only once two looks (a minute apart) have seen it, so one odd listing never ends it.
 * - SERVER_IDLE_CPU_MS: as unityReaper.ts did with its 2 s CPU_ADVANCE_MS (now CPU_BUSY_SHARE): a compiler server serving a build uses seconds of CPU a minute.
 * - TERM_WAIT_MS: a guess: a player or an Xvfb ends within a second of SIGTERM; what still runs 5 s later is killed.
 */
export const LEFTOVER = {
  DONE_GRACE_MS: 2 * MIN,
  STOPPED_GRACE_MS: 10 * MIN,
  WAKE_GRACE_MS: 10 * MIN,
  ORPHAN_GRACE_MS: 10 * MIN,
  LOOKS: 2,
  SERVER_IDLE_CPU_MS: 2_000,
  TERM_WAIT_MS: 5_000,
  LOOK_EVERY_MS: MIN,
} as const;

/** What a process is, for what may end it. */
export type LeftoverKind = 'player' | 'display' | 'unity-batch' | 'unity-worker' | 'editor' | 'server' | 'process';

/** The FF Factory variables of a process's environment that say who started it. */
export interface ProcEnv {
  session?: string;
  sandbox?: string;
  machine?: string;
}

/** One lease file of a player slot (scripts/nightly/player_slots.py `_lease`), with the slot it is in. */
export interface PlayerLease {
  /** The slot's folder name: "slot1-1", "slotnightly-0", "slot3". */
  slot: string;
  pid?: number;
  host?: string;
  /** The worker session that took it (FF_SESSION_ID; player_slots.py since w1196). */
  session?: string;
  /** The folder it was taken from (a sandbox's path) or its label. */
  sandbox?: string;
  /** Seconds since the epoch, as player_slots.py writes it. */
  time?: number;
}

export interface LeftoverDeps {
  platform: UnityPlatform;
  /** This machine's id (FF_MACHINE_ID of its workers' processes). */
  machineId: string;
  procs(): Promise<Proc[]>;
  /** FF_SESSION_ID, FF_SANDBOX_ID and FF_MACHINE_ID of the given processes, where the machine lets them be read. */
  envOf(pids: number[]): Promise<Map<number, ProcEnv>>;
  inspect(pids: number[]): Promise<ProcFacts[]>;
  /** The session's agent process runs here (the daemon's entry, or its agent host still up). */
  sessionLive(id: string): boolean;
  /** A session this machine runs or ran (the daemon's entries, the portal's list in its welcome). */
  sessionKnown(id: string): boolean;
  /** A request still waits for the session (the portal's `resumable`, w1097). */
  resumable(id: string): boolean;
  /** When the session's pending wake_me check-in comes due (ms), as the portal last said. */
  wakeAt(id: string): number | undefined;
  /** The sandboxes with a live worker. */
  liveSandboxes(): Set<string>;
  /** The portal's welcome came since the daemon started. */
  ready(): boolean;
  /** The player slot roots (server/ownLeftovers.ts playerSlotRoots). */
  slotRoots(): string[];
  /** The workers' temp root, <install>/tmp. */
  tempRoot(): string | undefined;
  leases(): PlayerLease[];
  /** A process that names one of these is never touched: the main clone, the daemon's own folder. */
  protectedPaths(): string[];
  /** The sandboxes, for a killed batch Unity's stale Temp/UnityLockfile. */
  places(): { id: string; path: string }[];
  /** Never touched: the daemon and its parents. */
  self(): number[];
  host: string;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  exists(p: string): boolean;
  remove(p: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /** Something the orchestrators should hear: what was ended, why and whose. */
  onEvent(text: string): void;
  /** After an end: the Unity slots look again (a killed batch build frees one). */
  afterKill?(): Promise<unknown>;
  /**
   * w1894: a person's game is looked for here (machines.personPlay): a slot player with no lease and no worker in its
   * environment is then a person's (a game started by hand from a slot folder), not an orphan to end. Absent: off.
   */
  personPlay?(): boolean;
}

// ---------------------------------------------------------------- the pure decisions

/** init, a user's systemd, launchd: what orphans are reparented to, never a tree to spare. */
const INIT = /^\S*(\/|^)(systemd|init|launchd)(\s|$)/;
const DISPLAY = /^(xvfb|xvnc|xephyr|xdummy|x11vnc|xvfb-run|openbox|fluxbox|icewm|twm|xfwm4|metacity|matchbox-window-manager)$/i;
const SERVER = /VBCSCompiler|MSBuild(\.dll|\.exe)?["']?\s.*node(mode|reuse)|dotnet[^\n]*build-server|bee_backend/i;

const posix = (p: string) => p.replace(/\\/g, '/');
const key = (p: string, platform: UnityPlatform) => (platform === 'win32' ? posix(p).replace(/\/+$/, '').toLowerCase() : p.replace(/\/+$/, ''));

/** A path as a whole word of a command line: not a longer path that starts with it (~/FinalFactory-sandboxes for ~/FinalFactory). */
const names = (k: string) => new RegExp(`${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s/"'])`);

/** The program of a command line (Windows: its image name). */
export function programOf(p: Pick<Proc, 'cmd' | 'name'>, platform: UnityPlatform): string {
  if (platform === 'win32' && p.name) return p.name.replace(/\.exe$/i, '');
  const first = platform === 'win32' ? (splitArgs(p.cmd)[0] ?? '') : (p.cmd.trim().split(/\s+/)[0] ?? '');
  return path.posix.basename(posix(first)).replace(/\.exe$/i, '');
}

/** What a process is. `topBatch`: the pids of top-level batch-mode Unity processes (unitySlots.ts unityProcesses). */
export function kindOf(p: Proc, platform: UnityPlatform, topBatch: Set<number>): LeftoverKind {
  if (gamePlayers([p], platform).length) return 'player';
  if (isUnityBinary(p, platform)) return topBatch.has(p.pid) ? 'unity-batch' : 'editor';
  if (DISPLAY.test(programOf(p, platform))) return 'display';
  if (SERVER.test(p.cmd)) return 'server';
  return 'process';
}

/** The player slot (its folder name) a player runs from, or undefined when it is not under one of `roots`. */
export function slotOf(cmd: string, roots: string[], platform: UnityPlatform): string | undefined {
  const c = key(platform === 'win32' ? (splitArgs(cmd)[0] ?? cmd) : cmd, platform);
  for (const r of roots) {
    const k = key(r, platform) + '/';
    const at = c.indexOf(k);
    if (at < 0 || (at > 0 && !/["'\s]/.test(c[at - 1]))) continue;
    const slot = c.slice(at + k.length).split('/')[0];
    if (/^slot[\w-]*$/i.test(slot)) return slot;
  }
  return undefined;
}

/** The session whose temp folder (<tempRoot>/ffa-<session>/) a command line's program runs from. */
export function tempSessionOf(cmd: string, tempRoot: string | undefined, platform: UnityPlatform): string | undefined {
  if (!tempRoot) return undefined;
  const prog = key(platform === 'win32' ? (splitArgs(cmd)[0] ?? '') : (cmd.trim().split(/\s+/)[0] ?? ''), platform);
  const k = key(tempRoot, platform) + '/ffa-';
  if (!prog.startsWith(k)) return undefined;
  return /^([\w-]+)\//.exec(prog.slice(k.length))?.[1];
}

/**
 * The session whose temp folder a Windows command line names among its arguments (`<tempRoot>/ffa-<session>/...`, or Git
 * Bash's `/f/ffw/tmp/ffa-<session>/...`), when it names exactly one; undefined elsewhere. For the Git Bash programs whose
 * environment Windows does not show (the module header, w1575).
 */
export function tempSessionInArgs(cmd: string, tempRoot: string | undefined, platform: UnityPlatform): string | undefined {
  if (!tempRoot || platform !== 'win32') return undefined;
  const k = key(tempRoot, platform);
  const drive = /^([a-z]):\//.exec(k);
  const forms = [k, ...(drive ? [`/${drive[1]}/${k.slice(3)}`, `/cygdrive/${drive[1]}/${k.slice(3)}`] : [])];
  const c = posix(cmd).toLowerCase();
  const found = new Set<string>();
  for (const f of forms) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of c.matchAll(new RegExp(`(?:^|[\\s"'=:])${esc}/ffa-([\\w-]+)(?=[/\\s"']|$)`, 'g'))) found.add(m[1]!);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** The sandbox of a player slot: "slot3-1" -> "slot3" (the sandbox-pairs layout, w576); a pool slot has none. */
export const slotSandbox = (slot: string | undefined) => /^(slot\d+)-[01]$/i.exec(slot ?? '')?.[1];

/** The sandbox id of a lease's folder: <root>/sandboxes/<id>/... -> id. */
/**
 * The game players no worker started (w1894, machine/personPlay.ts): not one of the look's candidates (a worker's by its
 * environment, lease, temp folder or arguments, or a slot player with a lease), no FF_SESSION_ID in its environment (a
 * worker of another machine's), not the daemon, and no sandbox or worker temp folder in its command line (an agent's build,
 * a sandbox editor's Build And Run, whose environment is the editor's). What is left is a person's game: Steam's launch, or
 * one started by hand.
 */
export function personGames(procs: Proc[], cands: { p: Proc }[], env: Map<number, ProcEnv>, o: { platform: UnityPlatform; self: Set<number>; places: string[]; tempRoot?: string }): number[] {
  const taken = new Set(cands.map((c) => c.p.pid));
  const folders = [...o.places, ...(o.tempRoot ? [o.tempRoot] : [])].filter(Boolean).map((f) => names(key(f, o.platform)));
  return gamePlayers(procs, o.platform)
    .filter((p) => p.pid > 0 && !taken.has(p.pid) && !o.self.has(p.pid) && !env.get(p.pid)?.session)
    .filter((p) => {
      const c = o.platform === 'win32' ? posix(p.cmd).toLowerCase() : p.cmd;
      return !folders.some((re) => re.test(c));
    })
    .map((p) => p.pid);
}

export const leaseSandbox = (folder: string | undefined) => /[/\\]sandboxes[/\\]([^/\\]+)/.exec(folder ?? '')?.[1];

/** Whether a lease still holds its slot (player_slots.py Pool._live): a remote holder only by its age. */
export function leaseHeld(l: PlayerLease, o: { host: string; now: number; alive: (pid: number) => boolean; maxAgeHours?: number }): boolean {
  const t = Number(l.time) * 1000;
  if (!Number.isFinite(t) || o.now - t > (o.maxAgeHours ?? 12) * 60 * MIN) return false;
  if (String(l.host ?? '').toLowerCase() !== o.host.toLowerCase()) return true;
  return o.alive(Number(l.pid));
}

export interface SessionFacts {
  live: boolean;
  resumable: boolean;
  wakeAt?: number;
  /** When this daemon first saw the session not live (its first sight of it, when it never saw it live). */
  stoppedSince: number;
  now: number;
}

const mins = (ms: number) => `${Math.max(0, Math.round(ms / MIN))} min`;
const ago = (ms: number) => (ms >= 2 * 60 * MIN ? `${(ms / (60 * MIN)).toFixed(1)} h` : mins(ms));
const clock = (t: number) => new Date(t).toISOString().slice(11, 16) + ' UTC';

/**
 * Whether what a session left may end now: `until` is when it may, while it is kept. The worker's process running keeps
 * everything; a stopped one's leftovers end a grace after it stopped, and never before its pending check-in plus a grace.
 */
export function sessionVerdict(s: SessionFacts): { end: boolean; until?: number; why: string } {
  if (s.live) return { end: false, why: 'its worker is running' };
  const grace = s.resumable ? LEFTOVER.STOPPED_GRACE_MS : LEFTOVER.DONE_GRACE_MS;
  const after = s.stoppedSince + grace;
  const wake = s.wakeAt !== undefined ? s.wakeAt + LEFTOVER.WAKE_GRACE_MS : 0;
  const until = Math.max(after, wake);
  const state = `its worker stopped ${ago(s.now - s.stoppedSince)} ago`;
  if (s.now < until) {
    const why = wake > after ? `its check-in comes due at ${clock(s.wakeAt!)}` : s.resumable ? 'a request still waits for it' : 'its work is over';
    return { end: false, until, why: `${state}; ${why}: kept until ${clock(until)}` };
  }
  return { end: true, why: `${state}${s.resumable ? ' (a request still waits for it, with no check-in pending)' : ' and no request waits for it'}` };
}

export interface OrphanFacts {
  /** Its starter, when that still runs: "python3 (pid 12)". */
  parent?: string;
  /** A remote run's live lease holds its slot. */
  heldBy?: string;
  /** Its slot's sandbox has a live worker. */
  sandboxLive?: string;
  firstSeen: number;
  now: number;
}

/** A game player under a player slot that names no session: kept while anything may still own it. */
export function orphanVerdict(o: OrphanFacts): { end: boolean; until?: number; why: string } {
  if (o.parent) return { end: false, why: `no session named, but its starter ${o.parent} still runs` };
  if (o.heldBy) return { end: false, why: `no session named, but its slot is held by ${o.heldBy}` };
  if (o.sandboxLive) return { end: false, why: `no session named, and its sandbox ${o.sandboxLive} has a live worker that may own it` };
  const until = o.firstSeen + LEFTOVER.ORPHAN_GRACE_MS;
  if (o.now < until) return { end: false, until, why: `an orphan (no session, its starter gone, nobody holds its slot): ends at ${clock(until)}` };
  return { end: true, why: `an orphan: it names no session, its starter is gone and nobody holds its slot, seen so for ${ago(o.now - o.firstSeen)}` };
}

/** The parent that still owns a process (as unityReaper.ts ownerOf), or undefined when it is gone, init or reused. */
export function liveParent(p: Proc, procs: Proc[], facts: Map<number, ProcFacts>, platform: UnityPlatform): string | undefined {
  if (platform !== 'win32' && p.ppid <= 1) return undefined;
  const parent = procs.find((x) => x.pid === p.ppid);
  if (!parent) return undefined;
  if (platform !== 'win32' && /(^|\/)(systemd|init|launchd)(\s|$)/.test(parent.cmd)) return undefined;
  const born = facts.get(p.pid)?.startedAt;
  const parentBorn = facts.get(parent.pid)?.startedAt;
  if (born === undefined || parentBorn === undefined || parentBorn > born + 1_000) return undefined;
  return `${programOf(parent, platform) || 'process'} (pid ${parent.pid})`;
}

// ---------------------------------------------------------------- the reaper

/** One game player as list_sandboxes and the dashboard show it (shared/types.ts PlayerSeen). */
export interface PlayerLine {
  pid: number;
  slot?: string;
  session?: string;
  sandbox?: string;
  ageMin?: number;
  owner: 'live' | 'stopped' | 'orphan' | 'held';
  /** Minutes until it ends, while it is kept for now. */
  endsInMin?: number;
}

interface Candidate {
  p: Proc;
  kind: LeftoverKind;
  session?: string;
  sandbox?: string;
  via?: 'env' | 'lease' | 'path' | 'arg';
  slot?: string;
}

export interface Ended {
  session?: string;
  pids: number[];
  line: string;
}

export class LeftoverReaper {
  private readonly d: LeftoverDeps;
  /** When each session was first seen not live. */
  private readonly stopped = new Map<string, number>();
  /** Looks that saw a process (by pid and command line), and when it was first seen an orphan. */
  private readonly looks = new Map<string, { n: number; orphanSince?: number; cpuMs?: number }>();
  private busy?: Promise<Ended[]>;
  private lastLook = 0;
  private players: PlayerLine[] = [];
  /** w1894: the game players of the last look that no worker started (a person's: machine/personPlay.ts). */
  private persons: number[] = [];
  private others = 0;
  private lastAt?: number;

  constructor(d: LeftoverDeps) {
    this.d = d;
  }

  async tick(): Promise<void> {
    if (this.d.now() - this.lastLook < LEFTOVER.LOOK_EVERY_MS) return;
    await this.look().catch((e) => this.d.log(`leftovers: look failed: ${(e as Error).message}`));
  }

  look(): Promise<Ended[]> {
    this.busy ??= this.run().finally(() => (this.busy = undefined));
    return this.busy;
  }

  /** The game players of the last look, with their owner and age (list_sandboxes, the dashboard). */
  report(): { players: PlayerLine[]; others: number; persons: number[]; at?: string } {
    return { players: this.players, others: this.others, persons: this.persons, ...(this.lastAt ? { at: new Date(this.lastAt).toISOString() } : {}) };
  }

  private async run(): Promise<Ended[]> {
    const d = this.d;
    this.lastLook = d.now();
    const procs = await d.procs();
    const self = new Set(d.self());
    const prot = d.protectedPaths().filter(Boolean).map((p) => names(key(p, d.platform)));
    const roots = d.slotRoots();
    const top = unityProcesses(procs, d.platform);
    const topBatch = new Set(top.filter((u) => u.kind === 'batch').map((u) => u.pid));
    const topPids = new Set(top.map((u) => u.pid));
    // Interactive editors (and what they started) and processes that name a protected folder are spared, trees and all.
    const spared = new Set<number>();
    const spare = (pid: number) => {
      const q = [pid];
      while (q.length) {
        const x = q.pop()!;
        if (spared.has(x)) continue;
        spared.add(x);
        for (const c of procs) if (c.ppid === x && c.pid !== x) q.push(c.pid);
      }
    };
    for (const u of top) if (u.kind === 'interactive') spare(u.pid);
    // The daemon and its parents alone, never their trees (w1196, after the deploy): under systemd the daemon's parent is
    // `systemd --user`, under launchd pid 1, the very process every detached player and orphan is reparented to; sparing
    // its tree spared everything, and the deployed reaper on biscuit ended nothing. The daemon's own tree is spared by
    // the protected-path rule below (its command line names its folder).
    for (const pid of self) spared.add(pid);
    for (const p of procs) {
      const c = d.platform === 'win32' ? posix(p.cmd).toLowerCase() : p.cmd;
      if (!INIT.test(c) && prot.some((re) => re.test(c))) spare(p.pid);
    }
    const env = await d.envOf(procs.map((p) => p.pid).filter((pid) => pid > 0 && !spared.has(pid)));
    const leases = d.leases();
    const now = d.now();
    const personOn = !!d.personPlay?.();
    const cands: Candidate[] = [];
    for (const p of procs) {
      if (spared.has(p.pid) || p.pid <= 0) continue;
      let kind = kindOf(p, d.platform, topBatch);
      if (kind === 'editor') {
        // A top-level editor is never ours; a Unity an editor started (an AssetImportWorker) is judged as an orphan: kept
        // while its starter runs (a running editor's are spared with its tree above), ended once that is gone (w1575).
        if (topPids.has(p.pid)) continue;
        kind = 'unity-worker';
      }
      const e = env.get(p.pid);
      const slot = kind === 'player' ? slotOf(p.cmd, roots, d.platform) : undefined;
      let c: Candidate | undefined;
      if (e?.session) {
        // Ours: a process of this machine's workers, or of a session this machine runs or ran.
        const ours = e.machine ? e.machine.toLowerCase() === d.machineId.toLowerCase() : d.sessionKnown(e.session);
        if (!ours) continue;
        c = { p, kind, session: e.session, sandbox: e.sandbox, via: 'env', slot };
      } else {
        const lease = slot ? leases.find((l) => l.slot === slot && Number(l.pid) === p.pid && String(l.host ?? '').toLowerCase() === d.host.toLowerCase()) : undefined;
        const fromPath = tempSessionOf(p.cmd, d.tempRoot(), d.platform);
        const fromArg = fromPath || kind === 'unity-worker' ? undefined : tempSessionInArgs(p.cmd, d.tempRoot(), d.platform);
        if (lease?.session) c = { p, kind, session: lease.session, sandbox: leaseSandbox(lease.sandbox) ?? slotSandbox(slot), via: 'lease', slot };
        else if (fromPath) c = { p, kind, session: fromPath, via: 'path', slot };
        else if (fromArg) c = { p, kind, session: fromArg, via: 'arg', slot };
        else if (kind === 'unity-worker') c = { p, kind };
        else if (kind === 'player' && slot && !(personOn && !leases.some((l) => l.slot === slot && (Number(l.pid) === p.pid || String(l.host ?? '').toLowerCase() !== d.host.toLowerCase())))) c = { p, kind, slot, sandbox: leaseSandbox(lease?.sandbox) ?? slotSandbox(slot) };
      }
      if (c) cands.push(c);
    }
    // The session clocks: a session not live starts (or keeps) its clock; a live one clears it.
    const sessions = new Set(cands.map((c) => c.session).filter((s): s is string => !!s));
    for (const s of sessions) {
      if (d.sessionLive(s)) this.stopped.delete(s);
      else if (!this.stopped.has(s)) this.stopped.set(s, now);
    }
    for (const s of [...this.stopped.keys()]) if (!sessions.has(s) && d.sessionLive(s)) this.stopped.delete(s);
    const facts = new Map((await d.inspect(cands.map((c) => c.p.pid).concat(cands.map((c) => c.p.ppid))).catch(() => [] as ProcFacts[])).map((f) => [f.pid, f]));
    const ready = d.ready();
    const liveSb = d.liveSandboxes();
    const toEnd = new Map<string, { c: Candidate; why: string }[]>();
    // A process ends only once two looks have seen it, so one odd listing never ends anything.
    const players: PlayerLine[] = [];
    let others = 0;
    const seen = new Set<string>();
    for (const c of cands) {
      const born = facts.get(c.p.pid)?.startedAt;
      // By pid and command line: a start time read from ps's elapsed seconds moves by a second between looks.
      const id = `${c.p.pid}|${c.p.cmd}`;
      seen.add(id);
      const look = this.looks.get(id) ?? { n: 0 };
      this.looks.set(id, look);
      const age = born !== undefined ? now - born : undefined;
      let v: { end: boolean; until?: number; why: string };
      let owner: PlayerLine['owner'];
      if (c.session) {
        v = sessionVerdict({ live: d.sessionLive(c.session), resumable: d.resumable(c.session), wakeAt: d.wakeAt(c.session), stoppedSince: this.stopped.get(c.session) ?? now, now });
        owner = d.sessionLive(c.session) ? 'live' : 'stopped';
        // Named by an argument only: another worker's shell may be reading that folder, so it ends once its starter is gone too.
        const starter = c.via === 'arg' && v.end ? liveParent(c.p, procs, facts, d.platform) : undefined;
        if (starter) v = { end: false, why: `it names the temp folder of ${c.session}, but its starter ${starter} still runs` };
      } else {
        // A remote run's lease (lab.py acquires a peer's slot over ssh, the player has none of its own here). A local lease
        // of another pid is another player's: runs of one build share a slot, so it says nothing about this one.
        const held = leases.find((l) => l.slot === c.slot && String(l.host ?? '').toLowerCase() !== d.host.toLowerCase() && leaseHeld(l, { host: d.host, now, alive: () => true }));
        const sb = c.sandbox && liveSb.has(c.sandbox) ? c.sandbox : undefined;
        const parent = liveParent(c.p, procs, facts, d.platform);
        if (parent || held || sb) look.orphanSince = undefined;
        else look.orphanSince ??= now;
        v = orphanVerdict({ parent, heldBy: held ? `${held.host === d.host ? '' : `${held.host} `}pid ${held.pid}${held.session ? ` (session ${held.session})` : ''}` : undefined, sandboxLive: sb, firstSeen: look.orphanSince ?? now, now });
        owner = parent || held || sb ? 'held' : 'orphan';
      }
      // A shared build server ends only once it is idle: another worker's build may be compiling through it.
      const cpu = facts.get(c.p.pid)?.cpuMs;
      if (v.end && c.kind === 'server' && (look.cpuMs === undefined || cpu === undefined || cpu - look.cpuMs >= LEFTOVER.SERVER_IDLE_CPU_MS)) v = { end: false, why: `${v.why}; a shared build server still at work, ended once idle` };
      look.cpuMs = cpu;
      if (!ready && v.end) v = { end: false, why: `${v.why}; waiting for the portal's welcome before ending anything` };
      look.n++;
      if (c.kind === 'player') players.push({ pid: c.p.pid, ...(c.slot ? { slot: c.slot } : {}), ...(c.session ? { session: c.session } : {}), ...(c.sandbox ? { sandbox: c.sandbox } : {}), ...(age !== undefined ? { ageMin: Math.round(age / MIN) } : {}), owner, ...(v.until !== undefined ? { endsInMin: Math.max(0, Math.ceil((v.until - now) / MIN)) } : {}) });
      else if (owner === 'stopped') others++;
      if (!v.end || look.n < LEFTOVER.LOOKS || born === undefined) continue;
      const group = c.session ?? `orphan:${c.p.pid}`;
      if (!toEnd.has(group)) toEnd.set(group, []);
      toEnd.get(group)!.push({ c, why: v.why });
    }
    for (const id of [...this.looks.keys()]) if (!seen.has(id)) this.looks.delete(id);
    for (const s of [...this.stopped.keys()]) if (!sessions.has(s)) this.stopped.delete(s);
    this.players = players;
    this.others = others;
    this.persons = personOn ? personGames(procs, cands, env, { platform: d.platform, self, places: d.places().map((x) => x.path), tempRoot: d.tempRoot() }) : [];
    this.lastAt = now;
    const out: Ended[] = [];
    for (const [group, items] of toEnd) out.push(await this.end(group, items, procs));
    return out;
  }

  /** End one session's leftovers (or one orphan): SIGTERM, then SIGKILL what still runs; log and tell the portal. */
  private async end(group: string, items: { c: Candidate; why: string }[], procs: Proc[]): Promise<Ended> {
    const d = this.d;
    // Children before their parents, so a supervisor (xvfb-run, a script) does not start them again.
    const depth = (pid: number) => {
      let n = 0;
      const seen = new Set<number>();
      for (let x = procs.find((p) => p.pid === pid); x && !seen.has(x.pid); x = procs.find((p) => p.pid === x!.ppid)) {
        seen.add(x.pid);
        n++;
      }
      return n;
    };
    const order = [...items].sort((a, b) => depth(b.c.p.pid) - depth(a.c.p.pid));
    for (const { c } of order) d.kill(c.p.pid, 'SIGTERM');
    await d.sleep(LEFTOVER.TERM_WAIT_MS);
    const after = await d.procs().catch(() => [] as Proc[]);
    const left = order.filter(({ c }) => after.some((p) => p.pid === c.p.pid && p.cmd === c.p.cmd));
    for (const { c } of left) d.kill(c.p.pid, 'SIGKILL');
    // A killed batch build's stale lock, once no Unity has its project open (as unityReaper.ts does).
    const projects = new Set<string>();
    for (const { c } of order) {
      if (c.kind !== 'unity-batch') continue;
      const proj = unityProcesses([c.p], d.platform)[0]?.project;
      const place = proj && d.places().find((pl) => key(pl.path, d.platform) === key(proj, d.platform));
      if (place) projects.add(place.path);
    }
    if (projects.size) {
      const still = unityProcesses(await d.procs().catch(() => [] as Proc[]), d.platform);
      for (const proj of projects) {
        if (still.some((u) => u.project && key(u.project, d.platform) === key(proj, d.platform))) continue;
        const lock = (d.platform === 'win32' ? path.win32 : path.posix).join(proj, 'Temp', 'UnityLockfile');
        if (d.exists(lock)) d.remove(lock);
      }
    }
    const what = (c: Candidate) => `${c.kind === 'player' ? `game player${c.slot ? ` ${c.slot}` : ''}` : c.kind === 'display' ? programOf(c.p, d.platform) : c.kind === 'unity-batch' ? 'batch Unity' : c.kind === 'unity-worker' ? 'Unity import worker' : programOf(c.p, d.platform) || 'process'} pid ${c.p.pid}`;
    const first = order[0].c;
    const whose = first.session ? `worker ${first.session}${first.sandbox ? ` (sandbox ${first.sandbox})` : ''}` : 'no worker';
    const list = order.map(({ c }) => what(c));
    const text = `ended ${order.length} process(es) left by ${whose}: ${list.slice(0, 8).join(', ')}${list.length > 8 ? `, and ${list.length - 8} more` : ''}. Why: ${order[0].why}${left.length ? `; ${left.length} needed SIGKILL` : ''}.`;
    d.log(`leftovers: ${text} Command lines: ${order.map(({ c }) => `[${c.p.pid}] ${c.p.cmd.slice(0, 160)}`).join(' | ')}`);
    d.onEvent(text);
    await d.afterKill?.().catch(() => undefined);
    return { session: group.startsWith('orphan:') ? undefined : group, pids: order.map(({ c }) => c.p.pid), line: text };
  }
}

// ---------------------------------------------------------------- the real machine

const WANT = /^(FF_SESSION_ID|FF_SANDBOX_ID|FF_MACHINE_ID)=(.*)$/;

/** The FF variables of an environment's "NAME=value" entries. */
export function envFrom(entries: Iterable<string>): ProcEnv {
  const o: ProcEnv = {};
  for (const kv of entries) {
    const m = WANT.exec(kv);
    if (!m) continue;
    if (m[1] === 'FF_SESSION_ID') o.session = m[2];
    else if (m[1] === 'FF_SANDBOX_ID') o.sandbox = m[2];
    else o.machine = m[2];
  }
  return o;
}

/**
 * A Mac's `ps -E -ww -o pid=,command=` line: the command line, then the environment, space-separated, so a value is a
 * run of non-space characters and the last mention wins (an argument that says FF_SESSION_ID=... comes before the
 * environment).
 */
export function macEnvLine(line: string): { pid: number; env: ProcEnv } | undefined {
  const m = /^\s*(\d+)\s+(.*)$/.exec(line);
  if (!m) return undefined;
  const env: ProcEnv = {};
  for (const x of m[2].matchAll(/(?:^|\s)(FF_SESSION_ID|FF_SANDBOX_ID|FF_MACHINE_ID)=(\S+)/g)) Object.assign(env, envFrom([`${x[1]}=${x[2]}`]));
  return { pid: Number(m[1]), env };
}

/**
 * Windows: the environment block of other processes of this user, from their PEB (NtQueryInformationProcess, then
 * ReadProcessMemory of RTL_USER_PROCESS_PARAMETERS.Environment, x64 offsets 0x20, 0x80 and EnvironmentSize 0x3F0). A
 * 32-bit process, one of another user or one that refuses the read is skipped: nothing of it is ever ended for its owner.
 */
export const WIN_ENV_CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FFProcEnv {
  [StructLayout(LayoutKind.Sequential)]
  struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int l, out int r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr s, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool w);
  static long Read8(IntPtr h, long a) { byte[] b = new byte[8]; IntPtr n; if (!ReadProcessMemory(h, new IntPtr(a), b, new IntPtr(8), out n)) return 0; return BitConverter.ToInt64(b, 0); }
  public static string Block(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      bool wow;
      if (IsWow64Process(h, out wow) && wow) return null;
      PBI p = new PBI(); int r;
      if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(typeof(PBI)), out r) != 0) return null;
      long pp = Read8(h, p.Peb.ToInt64() + 0x20);
      if (pp == 0) return null;
      long env = Read8(h, pp + 0x80);
      if (env == 0) return null;
      long size = Read8(h, pp + 0x3F0);
      if (size <= 0 || size > (1 << 22)) size = 65536;
      for (; size >= 4096; size /= 2) {
        byte[] buf = new byte[size]; IntPtr n;
        if (ReadProcessMemory(h, new IntPtr(env), buf, new IntPtr(size), out n)) return Encoding.Unicode.GetString(buf, 0, (int)n.ToInt64());
      }
      return null;
    } finally { CloseHandle(h); }
  }
}`;

export function winEnvScript(pids: number[]): string {
  const list = pids.filter((p) => Number.isInteger(p) && p > 4).join(',');
  return [
    `Add-Type -TypeDefinition @'\n${WIN_ENV_CS}\n'@`,
    `$out = foreach ($id in @(${list || '0'})) { $b = $null; try { $b = [FFProcEnv]::Block([int]$id) } catch { }; if ($b -and $b.Contains('FF_SESSION_ID=')) { $m = @{}; foreach ($kv in $b.Split([char]0)) { if ($kv -match '^(FF_SESSION_ID|FF_SANDBOX_ID|FF_MACHINE_ID)=(.*)$') { $m[$matches[1]] = $matches[2] } }; [pscustomobject]@{ pid = [int]$id; session = $m['FF_SESSION_ID']; sandbox = $m['FF_SANDBOX_ID']; machine = $m['FF_MACHINE_ID'] } } }`,
    `@($out) | ConvertTo-Json -Compress`,
  ].join('\n');
}

/** The FF variables of each process, as this platform lets them be read. */
export async function readEnvs(platform: UnityPlatform, pids: number[]): Promise<Map<number, ProcEnv>> {
  const out = new Map<number, ProcEnv>();
  if (!pids.length) return out;
  if (platform === 'linux') {
    for (const pid of pids) {
      try {
        const e = envFrom(fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0'));
        if (e.session) out.set(pid, e);
      } catch {
        // gone, or another user's
      }
    }
    return out;
  }
  if (platform === 'darwin') {
    const want = new Set(pids);
    const r = await run('ps', ['-x', '-E', '-ww', '-o', 'pid=,command='], { timeoutMs: 30_000 });
    for (const line of r.stdout.split('\n')) {
      const x = macEnvLine(line);
      if (x && want.has(x.pid) && x.env.session) out.set(x.pid, x.env);
    }
    return out;
  }
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', winEnvScript(pids)], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`reading process environments failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`);
  for (const x of parsePsJson<{ pid: number; session?: string; sandbox?: string; machine?: string }>(r.stdout, 'the Windows process environments')) {
    if (x.session) out.set(Number(x.pid), { session: x.session, ...(x.sandbox ? { sandbox: x.sandbox } : {}), ...(x.machine ? { machine: x.machine } : {}) });
  }
  return out;
}

/** Every lease file under the slot roots. */
export function readLeases(roots: string[]): PlayerLease[] {
  const out: PlayerLease[] = [];
  for (const root of roots) {
    let slots: string[] = [];
    try {
      slots = fs.readdirSync(root).filter((n) => /^slot[\w-]*$/i.test(n));
    } catch {
      continue;
    }
    for (const slot of slots) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(root, slot, 'leases')).filter((n) => n.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const l = JSON.parse(fs.readFileSync(path.join(root, slot, 'leases', f), 'utf8'));
          out.push({ slot, pid: Number(l.pid), host: l.host, time: Number(l.time), ...(l.session ? { session: String(l.session) } : {}), ...(l.sandbox ? { sandbox: String(l.sandbox) } : {}) });
        } catch {
          // being written, or unreadable: player_slots.py drops it too
        }
      }
    }
  }
  return out;
}

/** The facts the reaper reads on the real machine (start times and CPU as unityReaper.ts reads them). */
export const realInspect = (platform: UnityPlatform) => (pids: number[]) => inspectProcs(platform, [...new Set(pids)].filter((p) => p > 0));

// ---------------------------------------------------------------- ff-leftovers: a worker's own teardown

const SHELL = /^(bash|sh|zsh|dash|fish|cmd|powershell|pwsh)$/i;

/**
 * What a worker started that still runs (the `ff-leftovers` command, w1197): the processes carrying its own session id,
 * not its own chain (this command, its shell, claude, the agent host), not the agent process itself, not what claude runs
 * for itself (its MCP servers: the non-shell children of that chain and of the agent) and not an interactive editor or
 * what it started. Background jobs (a shell claude keeps for a background task, or one reparented to init) are in it.
 *
 * The chain alone is not enough on Windows (w1219: three workers' `ff-leftovers end` ended their own claude.exe, exit
 * code 1): Git Bash's fork+exec leaves each MSYS program a Windows parent that has already exited, so the walk up from
 * this command stopped at the shim's sh.exe and claude, its shells and its MCP servers all looked like leftovers. So the
 * agent process is also found from the environment: the session's root, a process carrying the session whose live
 * parent (its agent host) does not. `callers`: more pids the chain is walked up from (the shim's MSYS parents, by their
 * Windows pids); `born`: start times, so a parent pid Windows reused for a newer process is no parent.
 */
export function ownLeftovers(session: string, procs: Proc[], env: Map<number, ProcEnv>, selfPid: number, platform: UnityPlatform, o: { callers?: number[]; born?: (pid: number) => number | undefined } = {}): Proc[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = new Set<number>();
  for (const from of [selfPid, ...(o.callers ?? [])]) {
    for (let x = byPid.get(from); x && !chain.has(x.pid); x = byPid.get(x.ppid)) chain.add(x.pid);
    chain.add(from);
  }
  const ours = (pid: number) => env.get(pid)?.session === session;
  for (const p of procs) {
    const parent = byPid.get(p.ppid);
    if (!ours(p.pid) || !parent || parent.pid === p.pid || ours(parent.pid)) continue;
    // Orphans are reparented to init, launchd or a user's systemd: that is no agent host.
    if (platform !== 'win32' && (p.ppid <= 1 || INIT.test(parent.cmd))) continue;
    const born = o.born?.(p.pid);
    const parentBorn = o.born?.(parent.pid);
    if (born !== undefined && parentBorn !== undefined && parentBorn > born + 2_000) continue;
    chain.add(p.pid);
  }
  const out = new Set<number>();
  const skip = new Set<number>();
  const sub = (root: number, into: Set<number>) => {
    const q = [root];
    while (q.length) {
      const x = q.pop()!;
      if (into.has(x) || chain.has(x)) continue;
      into.add(x);
      for (const c of procs) if (c.ppid === x && c.pid !== x) q.push(c.pid);
    }
  };
  // What the worker's own chain (claude, its host: the members carrying its session, not init or a terminal) runs that is
  // not a shell: its MCP servers.
  const own = new Set([...chain].filter(ours));
  for (const p of procs) if (own.has(p.ppid) && !chain.has(p.pid) && !SHELL.test(programOf(p, platform))) sub(p.pid, skip);
  // What this command's own shells run beside it (the shells from it up to the agent): a pipeline's `tail` or `while read`
  // subshell, never a background job. A pipeline element bash has forked and not yet exec'd still reads as a shell with
  // the session, so without this a loaded machine's `ff-leftovers end | tail` ended its own tail (w1758: CI's
  // "status=0 Terminated", the list lost with it).
  const command = new Set<number>();
  for (const from of [selfPid, ...(o.callers ?? [])]) {
    command.add(from);
    for (let x = byPid.get(byPid.get(from)?.ppid ?? -1); x && !command.has(x.pid) && SHELL.test(programOf(x, platform)); x = byPid.get(x.ppid)) command.add(x.pid);
  }
  for (const p of procs) if (command.has(p.ppid) && !chain.has(p.pid)) sub(p.pid, skip);
  for (const u of unityProcesses(procs, platform)) if (u.kind === 'interactive') sub(u.pid, skip);
  for (const p of procs) if (!chain.has(p.pid) && !skip.has(p.pid) && ours(p.pid)) out.add(p.pid);
  return procs.filter((p) => out.has(p.pid));
}

/** The Windows pids the shim found for its MSYS parents (FF_LEFTOVERS_CALLERS, space-separated). */
export const callerPids = (v: string | undefined) => (v ?? '').split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);

/** The facts the daemon wrote for `folders` and `check` (FF_CLEANUP_FACTS, set by the shim); undefined when missing or unreadable. */
export function readCleanupFacts(file: string | undefined): CleanupFacts | undefined {
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CleanupFacts;
  } catch {
    return undefined;
  }
}

/**
 * `ff-leftovers folders` and `ff-leftovers check <path>...` (w1379): a clean-up worker's deletes judged by the ledger. `folders`
 * lists every folder a clean-up could take under the install folder with its owner, KEEP or DELETE and why; `check` judges
 * given paths and exits 1 when any is to be kept. Whatever is not provably closed or ownerless is kept, and so is a folder
 * holding a git repo with uncommitted changes, commits on no remote or a stash (w1387), as the portal's own clean-up keeps it.
 */
export async function foldersMain(cmd: 'folders' | 'check', args: string[], e: NodeJS.ProcessEnv = process.env, now = Date.now(), out: (s: string) => void = (s) => void process.stdout.write(s)): Promise<number> {
  const facts = readCleanupFacts(e.FF_CLEANUP_FACTS);
  if (cmd === 'check') {
    if (!args.length) {
      out('usage: ff-leftovers check <path>...\n');
      return 2;
    }
    const bad = factsProblem(facts, now);
    let kept = 0;
    for (const a of args) {
      // w1755: on Windows a path off the install drive (C:) is not looked at, not even for its git state.
      const offDrive = !!facts?.root && (!onInstallDrive(a, facts.root) || !onInstallDrive(path.resolve(a), facts.root));
      // w1755: the game's data folders under AppData may be looked at, never deleted.
      const home = e.USERPROFILE || os.homedir();
      const neverGames = !!installDrive(facts?.root) && (inNeverGames(a, home) || inNeverGames(path.resolve(a), home));
      const r = bad
        ? { verdict: 'keep' as const, why: bad }
        : neverGames
          ? { verdict: 'keep' as const, why: "the game's data folder under AppData (Never Games): read-only, never deleted, moved or written by a clean-up (w1755)" }
        : offDrive
          ? { verdict: 'keep' as const, why: `not looked at: off this Windows computer's install drive ${driveLabel(facts!.root!)}; disk work never reads, measures or touches C: (w1755)` }
          : await withGitCheck(judgePath(path.resolve(a), facts!, now), facts!.root);
      if (r.verdict === 'keep') kept++;
      out(`${r.verdict === 'keep' ? 'KEEP  ' : 'DELETE'}  ${a}\n        ${r.why}\n`);
    }
    return kept ? 1 : 0;
  }
  const rows = factsProblem(facts, now) ? [] : await planFolders(facts!, { now });
  out(renderFolders(rows, facts, now));
  return factsProblem(facts, now) ? 1 : 0;
}

/** `ff-leftovers [list|end]`: what this worker's session started that still runs, and ending it. */
export async function leftoversMain(argv: string[], e: NodeJS.ProcessEnv = process.env): Promise<number> {
  const cmd = argv[0] ?? 'list';
  if (cmd === 'folders' || cmd === 'check') return foldersMain(cmd, argv.slice(1), e);
  const session = e.FF_SESSION_ID;
  const platform: UnityPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';
  if (!session || !['list', 'end'].includes(cmd)) {
    process.stdout.write(`usage: ff-leftovers [list|end|folders|check <path>...]\n  list: what this worker's session (FF_SESSION_ID) started that still runs: players, Xvfb, builds, servers, background jobs\n  end: end them (SIGTERM, then SIGKILL after 5 s), before DONE or a stop\n  folders: a clean-up's candidates under the install folder, each KEEP or DELETE by the ledger (a request not closed keeps its worker's folders)\n  check <path>...: the same verdict for paths you mean to delete; exit 1 if any is to be kept. Only paths in the install folder: on Windows never one on C: or another drive, apart from the game's AppData Never Games folders, which are always KEEP (w1755)\n${session ? '' : 'FF_SESSION_ID is not set: run it from a worker of FF Factory.\n'}`);
    return session ? 2 : 1;
  }
  const { realDeps } = await import('./unity.ts');
  const hands = realDeps(platform);
  const procs = await hands.procs();
  const env = await readEnvs(platform, procs.map((p) => p.pid));
  // The session's processes and their parents: start times, so a reused parent pid is told from the agent's host.
  const sessionPids = procs.filter((p) => env.get(p.pid)?.session === session).flatMap((p) => [p.pid, p.ppid]);
  const facts = new Map((await realInspect(platform)(sessionPids).catch(() => [] as ProcFacts[])).map((f) => [f.pid, f]));
  const mine = ownLeftovers(session, procs, env, process.pid, platform, { callers: callerPids(e.FF_LEFTOVERS_CALLERS), born: (pid) => facts.get(pid)?.startedAt });
  const topBatch = new Set(unityProcesses(procs, platform).filter((u) => u.kind === 'batch').map((u) => u.pid));
  const line = (p: Proc) => {
    const born = facts.get(p.pid)?.startedAt;
    const age = born === undefined ? '' : ` up ${ago(Date.now() - born)}`;
    return `  pid ${p.pid} ${kindOf(p, platform, topBatch)}${age}: ${p.cmd.slice(0, 160)}`;
  };
  if (!mine.length) {
    process.stdout.write(`Nothing your session (${session}) started is still running.\n`);
    return 0;
  }
  if (cmd === 'list') {
    process.stdout.write(`Still running from your session (${session}): ${mine.length}\n${mine.map(line).join('\n')}\n\`ff-leftovers end\` ends them; FF Factory ends them anyway a few minutes after your process stops.\n`);
    return 0;
  }
  for (const p of mine) hands.kill(p.pid, 'SIGTERM');
  await new Promise((r) => setTimeout(r, LEFTOVER.TERM_WAIT_MS));
  const after = await hands.procs();
  const left = mine.filter((p) => after.some((x) => x.pid === p.pid && x.cmd === p.cmd));
  for (const p of left) hands.kill(p.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  const still = (await hands.procs()).filter((x) => left.some((p) => p.pid === x.pid && p.cmd === x.cmd));
  process.stdout.write(`Ended ${mine.length - still.length} of ${mine.length} process(es) your session (${session}) started${left.length ? ` (${left.length} needed SIGKILL)` : ''}:\n${mine.map(line).join('\n')}\n${still.length ? `Still running: ${still.map((p) => p.pid).join(', ')}\n` : 'None is left.\n'}`);
  return still.length ? 1 : 0;
}

/**
 * The shim's part for Git Bash on Windows (w1219): MSYS's fork+exec leaves each MSYS program a Windows parent that has
 * exited, so the Windows chain of this command stops at the shim. Its MSYS parents (/proc/<pid>/ppid) are still known, and
 * their Windows pids (/proc/<pid>/winpid) go to node in FF_LEFTOVERS_CALLERS, so the shell that runs ff-leftovers, and
 * through it claude, is never taken for a leftover. Elsewhere /proc/<pid>/winpid does not exist and nothing is set.
 */
const MSYS_CALLERS = `if [ -r "/proc/$$/winpid" ]; then
  p=$$ n=0 w=
  while [ "$n" -lt 64 ] && [ "$p" -gt 1 ] && [ -r "/proc/$p/winpid" ] && read -r x < "/proc/$p/winpid"; do
    w="$w $x"
    read -r p < "/proc/$p/ppid" || break
    n=$((n + 1))
  done
  FF_LEFTOVERS_CALLERS=$w
  export FF_LEFTOVERS_CALLERS
fi
`;

/** Write the `ff-leftovers` command beside `unity-slot` (<bin>, first on the agents' PATH). */
export function installLeftoversShim(bin: string, node = process.execPath, nodeArgs = process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), script = import.meta.filename, factsFile?: string): void {
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const q = (s: string) => `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
  fs.mkdirSync(bin, { recursive: true });
  const sh = path.join(bin, 'ff-leftovers');
  fs.writeFileSync(`${sh}.tmp`, `#!/bin/sh\n# FF Factory: what this worker started that still runs (machine/leftovers.ts). Written by the machine daemon at start.\n${MSYS_CALLERS}${factsFile ? `FF_CLEANUP_FACTS=${q(fwd(factsFile))}\nexport FF_CLEANUP_FACTS\n` : ''}exec ${[fwd(node), ...nodeArgs, fwd(script)].map(q).join(' ')} "$@"\n`);
  fs.chmodSync(`${sh}.tmp`, 0o755);
  fs.renameSync(`${sh}.tmp`, sh);
  fs.writeFileSync(`${sh}.cmd`, `@echo off\r\nrem FF Factory: what this worker started that still runs (machine/leftovers.ts).\r\n${factsFile ? `set "FF_CLEANUP_FACTS=${factsFile}"\r\n` : ''}${[node, ...nodeArgs, script].map((s) => `"${s}"`).join(' ')} %*\r\n`);
}

// Run when started directly (the ff-leftovers shim).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  leftoversMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`ff-leftovers: ${(e as Error).message}\n`);
      process.exit(2);
    },
  );
}
