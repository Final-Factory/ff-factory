// Unity slots (w469, Lothsahn on 2026-10-05: "Can we just account for every unity editor process that's running?" and
// "Can we make batch builds count towards unity editors?"; docs/unity-lifecycle.md, "Unity slots"). A machine's editor
// limit (max_unity) counts every top-level Unity process actually running there, whoever started it: sandbox editors,
// -batchmode builds and test runs, a second editor for a peer run, the owner's own editor, editors started by scripts.
// AssetImportWorkers, bcl.exe, the ILPP runner and built game players are not editors and do not count.
//
// Launches other than `unity start` take slots through a file mailbox in SLOTS_DIR, which the daemon arbitrates: a
// client (this file's CLI, `unity-slot`, or the game repo's scripts/unity_slot.py) writes req-<id>.json and touches it
// while it waits or holds; the daemon answers grant-<id>.json or deny-<id>.json. A request takes all its slots at once
// or none. Waiting requests from holders (a sandbox whose editor runs, a run that already holds slots) go first, then
// new requesters by priority (frantic, urgent, high, normal, low; w4620, renamed from release in w4710), oldest first within one priority. Process counting is the backstop: Unity started outside the gate counts all the same,
// so nothing more is granted while the machine is over its limit. Nothing here kills a Unity process; the orphaned and hung
// batch builds that would hold a slot for hours are ended by machine/unityReaper.ts (w791).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Proc, UnityPlatform } from './unity.ts';
import { heldNotStarted, unitySlotsLine } from '../shared/fleet.ts';
import { benchLockPath, benchQueueDir, benchTicketFor, heldTicket, HELD_WAIT_CAP_MS, RpcBenchTicket, type BenchMode, type TicketLike } from './benchQueue.ts';
import { asWorkPriority, priorityRank, raiseOne, type PairRaise, type UnitySlotsReport, type WorkPriority } from '../shared/types.ts';
import { benchLockDir, foreignTimedHold } from './benchLock.ts';
import { editorBenchSession } from './benchRaise.ts';
import { personHoldReason } from './personPlay.ts';
import { batchUnityLogFile } from './sharedCaches.ts';
import { beeAccessDenied, compilerServerAdvice, compilerServers, logFileArg, logTail } from './compilerServer.ts';
import { rpcAvailable, rpcCall, RpcRefused, RpcUnavailable, type Caller } from './daemonRpc.ts';

/**
 * The pointer a worker-root install (w513, scripts/worker/worker.ts) leaves for scripts outside the daemon: its mailbox
 * is under the root, not in the home folder. The same file on both OSes, beside the Mac's player-slots.json.
 */
export const slotsPointer = (home = os.homedir()) => path.join(home, '.config', 'finalfactory', 'unity-slots.json');

/**
 * Where the mailbox is: FF_UNITY_SLOTS (the daemon sets it for its agents and everything it starts), else a worker
 * root's own (`$FF_WORKER_ROOT/unity-slots`, w5377) when it exists, else the folder the worker-root pointer names, else
 * the home folder's, the same on every machine whatever the daemon's app_dir, so scripts find it with no config. A
 * pointer naming a folder that is gone (an uninstalled root) is ignored.
 */
export function slotsDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.FF_UNITY_SLOTS) return env.FF_UNITY_SLOTS;
  const inRoot = env.FF_WORKER_ROOT ? path.join(env.FF_WORKER_ROOT, 'unity-slots') : undefined;
  if (inRoot && fs.existsSync(inRoot)) return inRoot;
  const p = readJson<{ dir?: unknown }>(slotsPointer(home));
  if (p && typeof p.dir === 'string' && p.dir && fs.existsSync(p.dir)) return p.dir;
  return path.join(home, '.ff-factory', 'unity-slots');
}

/**
 * RAM in use at which no new Unity launch is granted (the queue waits). The placement's busy line (server/placement.ts
 * RAM_BUSY_PCT, 85): one more editor takes 8-12 GB, a Burst build's bcl.exe 4-10 GB more (LothDesktop, 2026-10-05: 63 of
 * 64 GB with 3 builds), so above 85% of 64 GB the next launch would page.
 */
export const UNITY_RAM_PCT = 85;

/** A waiter or holder whose file was not touched for this long is gone (its heartbeat is every 15 s). */
export const STALE_MS = 90_000;

/** A request that holds slots while it waits for more is refused after this long, so its slots stop stalling everyone. */
export const HOLDER_WAIT_MS = 30 * 60_000;

/** The arbiter rewrites arbiter.json every few seconds; older than this, a client counts it as gone. */
export const ARBITER_FRESH_MS = 60_000;
/** w5324: how long the count must stay over the limit before the orchestrator is told. */
export const OVER_NOTICE_MS = 15_000;
/** w5324: how long a preemption the editor skipped (busy) waits before it is asked again. */
export const PREEMPT_RETRY_MS = 60_000;

/**
 * w5746: the run's environment with UNITY_MCP_STATUS_DIR set to FF_UNITY_MCP_EDITOR_STATUS_DIR (daemon.ts slotEnv), so a
 * Unity editor it starts writes its bridge status where its worker may write and the daemon reads it (machine/unityMcp.ts
 * workerEditorStatusDir), not in the worker's own synced folder in the daemon's folder, which the fences keep read-only (the
 * editor's heartbeat failed there silently and the worker's Unity MCP server found no editor, measured on m5 in w5693).
 * Unset (an older daemon, an install with no root): unchanged.
 */
export function editorStatusEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dir = env.FF_UNITY_MCP_EDITOR_STATUS_DIR;
  if (!dir) return env;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // the daemon makes it at its start; the editor makes it too (Directory.CreateDirectory)
  }
  return { ...env, UNITY_MCP_STATUS_DIR: dir };
}

/**
 * w5961: on a Mac whose Seatbelt worker fence is on, the daemon gives sandbox agents FF_UNITY_EDITOR_HOME, `<root>/home`
 * (daemon.ts slotEnv), the home its own fenced editors get (machine/unity.ts macEditorFenceFor). A second editor a worker
 * opens under `unity-slot run` (a peer run's ParrelSync clone) inherits the worker's profile, and with the real home Unity
 * is refused its window layout in ~/Library/Preferences/Unity/Editor-5.x and stops on a hidden "Moving file failed" modal
 * with no MCP bridge (measured on m5 in w5806: log ends at `[LAYOUT] About to save layout` + `Curl error 23`, 10+ minutes;
 * HOME alone did not help, Foundation's home follows CFFIXED_USER_HOME). So an interactive Unity editor run gets HOME and
 * CFFIXED_USER_HOME at that folder (it loaded in 10.6 s and its bridge came up so). Only the editor binary itself, and never
 * a `-batchmode` run: a script keeps the person's home for git and the rest, and a batch run under a moved home with no
 * licensing client already running starts its own there and quits unlicensed (machine/unity.ts licensingClientRunning).
 */
export function editorHomeEnv(rest: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const home = env.FF_UNITY_EDITOR_HOME;
  const [cmd = '', ...args] = rest;
  if (!home || platform !== 'darwin' || !isUnityBinary({ cmd, name: '' }, 'darwin') || args.some((a) => /^-batchmode$/i.test(a))) return env;
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch {
    // the daemon's fenced editor start makes it too
  }
  return { ...env, HOME: home, CFFIXED_USER_HOME: home };
}

/** w5324: the pid Unity wrote to a project's Library/EditorInstance.json at boot ({"process_id": n, ...}), or undefined. */
export function editorInstancePid(projectPath: string): number | undefined {
  const pid = readJson<{ process_id?: unknown }>(path.join(projectPath, 'Library', 'EditorInstance.json'))?.process_id;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// ---------------------------------------------------------------- which processes are Unity editors

export type UnityKind = 'interactive' | 'batch';

/** A top-level Unity editor process. */
export interface UnityProcess {
  pid: number;
  ppid: number;
  kind: UnityKind;
  /** Its -projectPath, as written. */
  project?: string;
  /** w5324: of a process counted outside the gate, the program that started it (its parent's name), for the notice. */
  parent?: string;
}

/** The arguments of a Windows command line: quoted ("a b") or bare, with \" inside quotes. */
export function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && cmd[i + 1] === '"') {
      cur += '"';
      any = true;
      i++;
    } else if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(c) && !quoted) {
      if (any) out.push(cur);
      cur = '';
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

const MAC_EDITOR = '/Unity.app/Contents/MacOS/Unity';
const LINUX_EDITOR = '/Editor/Unity';
/** The tail of the editor binary's path: Unity.app's on a Mac, <version>/Editor/Unity on Linux. */
const editorTail = (platform: UnityPlatform) => (platform === 'linux' ? LINUX_EDITOR : MAC_EDITOR);

/**
 * Unity Hub's own helper, not an editor (w3848): on Windows `"C:\Program Files\Unity Hub\resources\unity.exe" serve`,
 * named Unity.exe, which runs as long as the Hub does and filled LothLaptop's only Unity slot. Known by its program under
 * the Hub's resources folder (`\Unity Hub\resources\` on Windows, `Unity Hub.app/Contents/Resources/` on a Mac) or by
 * a first argument `serve`, which no editor takes.
 */
export function isUnityHubHelper(cmd: string, platform: UnityPlatform): boolean {
  if (platform === 'win32') {
    const [exe = '', first = ''] = splitArgs(cmd);
    return /[\\/]unity hub[\\/]resources[\\/]/i.test(exe) || first.toLowerCase() === 'serve';
  }
  return /\/Unity Hub\.app\/Contents\/Resources\//i.test(cmd);
}

/**
 * Whether a process is the Unity editor binary itself (not a script that names it in its arguments): on Windows its
 * image name, else the program of its command line; on a Mac (and Linux) a command line that starts with the path of
 * Unity.app's binary (<version>/Editor/Unity) (a path may hold spaces, so the part before it may not hold " /" or
 * " -", which a program's arguments would).
 */
export function isUnityBinary(p: Pick<Proc, 'cmd' | 'name'>, platform: UnityPlatform): boolean {
  if (isUnityHubHelper(p.cmd, platform)) return false;
  if (platform === 'win32') {
    if (p.name) return /^unity\.exe$/i.test(p.name);
    return /^unity\.exe$/i.test(path.win32.basename(splitArgs(p.cmd)[0] ?? ''));
  }
  const tail = editorTail(platform);
  const at = p.cmd.indexOf(tail);
  if (at < 0 || !p.cmd.startsWith('/')) return false;
  const after = p.cmd[at + tail.length];
  if (after !== undefined && !/\s/.test(after)) return false;
  const before = p.cmd.slice(0, at);
  return !before.includes(' /') && !before.includes(' -');
}

/** The arguments after the program (a Mac's and Linux's ps join them with spaces, so they are split on whitespace there). */
function argsOf(cmd: string, platform: UnityPlatform): string[] {
  if (platform === 'win32') return splitArgs(cmd).slice(1);
  const tail = editorTail(platform);
  const at = cmd.indexOf(tail);
  return cmd.slice(at + tail.length).trim().split(/\s+/).filter(Boolean);
}

/** The value after a flag (case-insensitive); on a Mac a -projectPath with spaces runs to the next flag. */
function flagValue(args: string[], flag: string, platform: UnityPlatform): string | undefined {
  const i = args.findIndex((a) => a.toLowerCase() === flag.toLowerCase());
  if (i < 0 || i + 1 >= args.length) return undefined;
  if (platform === 'win32') return args[i + 1];
  const parts: string[] = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j++) parts.push(args[j]);
  return parts.join(' ') || undefined;
}

/**
 * The top-level Unity editors among `procs`: the Unity binary, not an AssetImportWorker (`-name AssetImportWorkerN`,
 * started by an editor with -parentPid) and not any other Unity started by a Unity. Batch: started with -batchmode
 * (builds, test runs, command-line tools); interactive otherwise.
 */
export function unityProcesses(procs: Proc[], platform: UnityPlatform): UnityProcess[] {
  const unity = procs.filter((p) => isUnityBinary(p, platform));
  const unityPids = new Set(unity.map((p) => p.pid));
  const out: UnityProcess[] = [];
  for (const p of unity) {
    const args = argsOf(p.cmd, platform);
    const lower = args.map((a) => a.toLowerCase());
    const name = flagValue(args, '-name', platform) ?? '';
    if (/^assetimportworker/i.test(name) || lower.includes('-parentpid') || unityPids.has(p.ppid)) continue;
    out.push({ pid: p.pid, ppid: p.ppid, kind: lower.includes('-batchmode') ? 'batch' : 'interactive', project: flagValue(args, '-projectPath', platform) });
  }
  return out;
}

/** Built game players (FinalFactory.exe, FinalFactory.app, a Linux build's FinalFactory.x86_64): not editors, reported beside them. */
export function gamePlayers(procs: Proc[], platform: UnityPlatform): Proc[] {
  if (platform === 'win32') return procs.filter((p) => /^final ?factory.*\.exe$/i.test(p.name ?? path.win32.basename(splitArgs(p.cmd)[0] ?? '')));
  if (platform === 'linux') return procs.filter((p) => /\/final ?factory[^/]*\.x86_64(\s|$)/i.test(p.cmd) && p.cmd.startsWith('/'));
  return procs.filter((p) => /\/final ?factory[^/]*\.app\/Contents\/MacOS\//i.test(p.cmd) && p.cmd.startsWith('/'));
}

const pathKey = (p: string, platform: UnityPlatform) => (platform === 'win32' ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : p.replace(/\/+$/, ''));

// ---------------------------------------------------------------- the decision

/** A request for slots, as its file says and the arbiter found it. */
export interface SlotRequest {
  id: string;
  /** Who asks: "sandbox:<id>" or "pid:<pid>". A holder's requests share its priority. */
  holder: string;
  count: number;
  /** The process that waits and holds (its Unity processes are found under it). */
  pid: number;
  label: string;
  /** Project folders its Unity processes open, for ones started where they are not its children (a detached launch). */
  projects?: string[];
  /** The agent session that ran it (RequestFile.session): the ledger shows its request Blocked while it waits (w1949). */
  session?: string;
  createdAt: number;
  /** When it was granted; undefined while it waits. */
  grantedAt?: number;
  /** Refused or revoked: it reserves nothing (its Unity processes still count). */
  denied?: string;
}

/** A place the daemon knows: a sandbox ("sandbox:<id>"; no main-clone place since w536), and whether its editor is up. */
export interface Place {
  holder: string;
  path: string;
  /** Its editor is starting or running: a slot even before the process shows. */
  editorUp?: boolean;
  /**
   * Its editor was stopped a moment ago (a worker stopping it to build its own project in batch mode): its requests keep
   * a holder's priority for a while, though it holds no slot now.
   */
  priority?: boolean;
  /**
   * w5324: the session its editor's work runs as (`editor:<sandbox>`, machine/benchRaise.ts editorSessions): the highest
   * priority of the workers placed there and their requests, by which a waiter of a higher priority may take its slot.
   */
  session?: string;
  /**
   * w5324: the pid in its project's Library/EditorInstance.json (Unity writes it at boot): a Unity process whose command
   * line has no -projectPath readable (a Windows process listing can give an empty one) is still this place's editor,
   * not one "started outside the slot gate" (LothDesktop, 2026-11-23 19:30Z: "4 of 3 ... interactive pid 47084").
   */
  editorPid?: number;
}

export interface AssessInput {
  platform: UnityPlatform;
  procs: Proc[];
  requests: SlotRequest[];
  places: Place[];
  /** max_unity; undefined: no limit here (counted only). */
  limit?: number;
  now: number;
  ramPct?: number;
  ramLimitPct?: number;
  holderWaitMs?: number;
  /**
   * A waiting request's priority by its session (w4620; lothsahn: "The factory should be using strict priority queues"),
   * read live each look (readSlotPriorities). Absent: everyone counts as low, so the order stays first come first served.
   */
  priorityOf?(session?: string): WorkPriority;
  /** w5324: the requests (wNNN) a session works for, to name who holds the slots a waiter needs. */
  requestsOf?(session?: string): string[];
  /** w5341: a session's pair-run mark (priorities.json `pair`, server/pairRaise.ts): a raised waiting leg, or a held side. */
  pairOf?(session?: string): PairRaise | undefined;
}

/** w5324: an idle editor of a strictly lower priority whose slot the head of the queue may take (closed cleanly first). */
export interface Preempt {
  /** The place: "sandbox:<id>". */
  holder: string;
  priority: WorkPriority;
  requests: string[];
  /** The waiting request it would be closed for, and that one's priority. */
  for: string;
  forPriority: WorkPriority;
}

export interface Assessment {
  limit?: number;
  /** Slots in use: each place, holder and outside process counted once (a reservation or its processes, the larger). */
  used: number;
  /** w1962: of `used`, the sandbox editors whose start is queued in the bench queue or booting (no Unity process yet). */
  starting: number;
  free: number;
  unity: UnityProcess[];
  interactive: number;
  batch: number;
  /** Unity processes no sandbox or slot holder accounts for (a person's own editor among them): started outside the gate. */
  outside: UnityProcess[];
  players: number;
  overLimit: boolean;
  ramBlocked: boolean;
  /** Slots each holder uses now. */
  holders: Map<string, number>;
  grant: string[];
  deny: { id: string; why: string }[];
  waiting: { id: string; position: number; why: string }[];
  /** w4620: the priority each request waiting at this look was ordered by (granted ones included). */
  priorities: Map<string, WorkPriority>;
  /** w4620: a request granted or at the head ahead of an older waiting one of a lower priority (`id` ahead of `over`). */
  jumps: { id: string; priority: WorkPriority; over: string; overPriority: WorkPriority }[];
  /**
   * w5324 (lothsahn: "High priority work should also preempt lower priority work as well, cleanly, of course"): when the
   * head of the queue does not fit, the running editors of strictly lower priority whose closing would let it in,
   * lowest priority first, enough for its count (none when not enough such editors exist). Only an editor holding its
   * slot alone (no granted run on its place) is named; a batch build or test run under a request is never one.
   */
  preempt: Preempt[];
  /** w5324: who holds the slots in use, for the waiting reason: "sandbox:slot2 (w5293, normal)". */
  heldBy: string[];
}

/**
 * Each worker session's priority as the daemon's priorities.json says (machine/benchLock.ts writeBenchPriorities), read
 * now: `level` (frantic, which the portal sends as `release`) over `priority`, since the portal sends a frantic session as
 * urgent with level release for old readers. A session with no mark, and a missing or unreadable file, count as low (w4620: runs filed without a request
 * priority count as low); `root` is the worker root.
 */
export function readSlotPriorities(root: string | undefined): (session?: string) => WorkPriority {
  const sessions = root ? readJson<{ sessions?: Record<string, { priority?: unknown; level?: unknown }> }>(path.join(benchQueueDir(benchLockDir(root)), 'priorities.json'))?.sessions : undefined;
  return (session) => {
    const m = session && sessions && typeof sessions === 'object' ? sessions[session] : undefined;
    const p = m?.level ?? m?.priority;
    return asWorkPriority(p) ?? 'low'; // w4710: the wire's `release` level is frantic
  };
}

/** w5324: readSlotPriorities and each session's requests (wNNN), from one read of priorities.json. */
export function readSlotWork(root: string | undefined): { priorityOf: (session?: string) => WorkPriority; requestsOf: (session?: string) => string[]; pairOf: (session?: string) => PairRaise | undefined } {
  const sessions = root ? readJson<{ sessions?: Record<string, { priority?: unknown; level?: unknown; requests?: unknown; pair?: unknown }> }>(path.join(benchQueueDir(benchLockDir(root)), 'priorities.json'))?.sessions : undefined;
  const mark = (session?: string) => (session && sessions && typeof sessions === 'object' ? sessions[session] : undefined);
  return {
    priorityOf: (session) => {
      const m = mark(session);
      return asWorkPriority(m?.level ?? m?.priority) ?? 'low';
    },
    requestsOf: (session) => {
      const r = mark(session)?.requests;
      return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string').slice(0, 6) : [];
    },
    pairOf: (session) => asPairRaise(mark(session)?.pair),
  };
}

/** w5341: a priorities.json `pair` mark, checked (an unreadable one is none). */
export function asPairRaise(x: unknown): PairRaise | undefined {
  const p = x as Partial<PairRaise> | undefined;
  if (!p || typeof p !== 'object' || (p.half !== 'waiting' && p.half !== 'held')) return undefined;
  const from = asWorkPriority(p.from);
  if (!from || typeof p.work !== 'string' || typeof p.since !== 'string') return undefined;
  return { half: p.half, from, work: p.work, since: p.since, others: Array.isArray(p.others) ? p.others.filter((m): m is string => typeof m === 'string').slice(0, 4) : [] };
}

/** w5341: the waiting reason's words for a raised pair leg. */
export const pairRaiseText = (r: PairRaise, to: WorkPriority) =>
  `raised one level (${r.from} → ${to}): pair half-held, ${r.work}'s other side holds a slot on ${r.others.join(', ') || 'another machine'} (w5341)`;

/**
 * w5341: whether a held pair side (`victim`) is kept from a waiter's preemption one level up: against every waiter but
 * a raised leg of an older pair (its start first, then its request id). So two half-held pairs that each hold the side
 * the other needs never take each other's sides in turn (each would lose its own held side, its raise with it, and swap),
 * and never wait on each other for good: the older one takes the younger one's idle held side, and finishes first.
 */
export function heldSideKept(victim: PairRaise | undefined, waiter: PairRaise | undefined): boolean {
  if (victim?.half !== 'held') return false;
  if (waiter?.half !== 'waiting' || waiter.work === victim.work) return true;
  const a = Date.parse(waiter.since), b = Date.parse(victim.since);
  const older = a < b || (a === b && waiter.work.localeCompare(victim.work) < 0);
  return !older;
}

/** The nearest ancestor of `pid` (itself excluded) that is in `wanted`, through the parent chain. */
function ancestorIn(ppid: number, byPid: Map<number, Proc>, wanted: Set<number>): number | undefined {
  const seen = new Set<number>();
  for (let p = ppid, i = 0; p > 0 && i < 64 && !seen.has(p); i++) {
    if (wanted.has(p)) return p;
    seen.add(p);
    p = byPid.get(p)?.ppid ?? 0;
  }
  return undefined;
}

/**
 * Count every Unity editor and decide which waiting requests get their slots now. Pure: the arbiter writes the files.
 *
 * Counting: each top-level Unity process belongs to the request whose process started it (its nearest requesting
 * ancestor, or a project the request named), else to the sandbox whose project it has open, else to
 * nobody (outside, 1 each). A request's process counts its granted slots or its Unity processes, whichever is larger;
 * a sandbox its running editor or its processes; so Unity started outside the gate always counts.
 *
 * Deciding: a request takes all its slots at once or none. Requests from holders (a holder using any slot now) go
 * first, then new requesters; oldest first in each. The first that does not fit stops the queue (no one passes it, so a
 * peer run needing 2 is not starved by single builds). Refused at once: more than the limit; a holder asking for more
 * than the limit leaves it; a holder that waited holderWaitMs while holding. When every slot in use is held by a
 * waiting holder, nothing will ever free one: a later request that fits goes first, and if none fits, the newest
 * waiting holder is refused so the others can finish (no two runs each hold part of what they need and wait forever).
 */
export function assess(input: AssessInput): Assessment {
  const { platform, limit, now } = input;
  const unity = unityProcesses(input.procs, platform);
  const byPid = new Map(input.procs.map((p) => [p.pid, p]));
  const reqs = input.requests;
  const buckets = new Map<string, { holder: string; reserved: number; procs: number }>();
  const bucket = (key: string, holder: string) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { holder, reserved: 0, procs: 0 }));
    return b;
  };
  for (const r of reqs) {
    const b = bucket(`p:${r.pid}`, r.holder);
    if (r.grantedAt !== undefined && !r.denied) b.reserved += r.count;
  }
  for (const pl of input.places) {
    const b = bucket(`e:${pathKey(pl.path, platform)}`, pl.holder);
    if (pl.editorUp) b.reserved = Math.max(b.reserved, 1);
  }
  const reqPids = new Set(reqs.map((r) => r.pid));
  const byEditorPid = new Map<number, ReturnType<typeof bucket>>();
  for (const pl of input.places) if (pl.editorPid) byEditorPid.set(pl.editorPid, bucket(`e:${pathKey(pl.path, platform)}`, pl.holder));
  const outside: UnityProcess[] = [];
  for (const u of unity) {
    const anc = reqPids.has(u.pid) ? u.pid : ancestorIn(u.ppid, byPid, reqPids);
    const key = u.project ? pathKey(u.project, platform) : undefined;
    const named = anc === undefined && key ? reqs.find((r) => r.projects?.some((p) => pathKey(p, platform) === key)) : undefined;
    if (anc !== undefined || named) {
      buckets.get(`p:${anc ?? named!.pid}`)!.procs++;
      continue;
    }
    const pl = (key ? buckets.get(`e:${key}`) : undefined) ?? (key ? undefined : byEditorPid.get(u.pid));
    // w4775: a batch Unity in a sandbox's project while that sandbox's granted run has none counted yet is that run's (its
    // parent chain broke, as a build's second Unity under `env` can on Windows): counted on the place too, one process read
    // as two ("editors 4 of 3: 1 interactive, 2 batch, 1 granted not started yet" on lothdesktop at 11:29:55Z, 2026-11-19).
    const own = pl && u.kind === 'batch' ? reqs.find((r) => r.holder === pl.holder && r.grantedAt !== undefined && !r.denied && buckets.get(`p:${r.pid}`)!.procs < r.count) : undefined;
    if (own) buckets.get(`p:${own.pid}`)!.procs++;
    else if (pl) pl.procs++;
    else {
      const parent = byPid.get(u.ppid);
      const name = parent ? parent.name || path.basename(splitArgs(parent.cmd)[0] ?? '') : '';
      outside.push(name ? { ...u, parent: name.slice(0, 60) } : u);
    }
  }
  const holders = new Map<string, number>();
  const usedOf = new Map<string, number>();
  let used = outside.length;
  let starting = 0;
  for (const [key, b] of buckets) {
    const n = Math.max(b.reserved, b.procs);
    used += n;
    usedOf.set(key, n);
    if (key.startsWith('e:')) starting += n - b.procs;
    if (n) holders.set(b.holder, (holders.get(b.holder) ?? 0) + n);
  }
  // What a waiter keeps while it waits: what its own process holds, and its place's editor (its worker waits in a tool
  // call meanwhile). Another run of the same holder is not kept: it ends by itself.
  const placeKeys = input.places.map((pl) => ({ holder: pl.holder, key: `e:${pathKey(pl.path, platform)}` }));
  const keptKeys = (r: SlotRequest) => [`p:${r.pid}`, ...placeKeys.filter((x) => x.holder === r.holder).map((x) => x.key)].filter((k) => (usedOf.get(k) ?? 0) > 0);
  const kept = (r: SlotRequest) => keptKeys(r).reduce((n, k) => n + (usedOf.get(k) ?? 0), 0);
  let free = limit === undefined ? Infinity : limit - used;
  // Only where there is a limit: a machine without max_unity (a main-clone Mac, whose unified memory often runs high) is counted, never held up.
  const ramBlocked = limit !== undefined && input.ramPct !== undefined && input.ramPct >= (input.ramLimitPct ?? UNITY_RAM_PCT);
  const grant: string[] = [];
  const deny: { id: string; why: string }[] = [];
  const holding = (h: string) => holders.get(h) ?? 0;
  let waiting = reqs.filter((r) => r.grantedAt === undefined && !r.denied);
  // Refused at once: what can never fit, and a holder that held its slots while waiting too long.
  waiting = waiting.filter((r) => {
    const h = kept(r);
    let why: string | undefined;
    if (!Number.isInteger(r.count) || r.count < 1) why = `asks for ${r.count} slots; ask for 1 or more`;
    else if (limit !== undefined && r.count > limit) why = `needs ${r.count} Unity editors at once; this machine allows ${limit} (max_unity)`;
    else if (limit !== undefined && h > 0 && h + r.count > limit) why = `it holds ${h} (its own process${placeKeys.some((x) => x.holder === r.holder) ? ` or the editor of ${r.holder}` : ''}) and asks for ${r.count} more, more than the ${limit} this machine allows at once: release yours (stop the editor, end the other run) and ask for all ${h + r.count} at once`;
    else if (h > 0 && now - r.createdAt > (input.holderWaitMs ?? HOLDER_WAIT_MS)) why = `waited ${Math.round((now - r.createdAt) / 60_000)} min while holding ${h} slot(s); refused so the slots it holds stop stalling everyone: release them and ask again for all you need at once`;
    if (why) deny.push({ id: r.id, why });
    return !why;
  });
  const priority = new Set(input.places.filter((pl) => pl.priority).map((pl) => pl.holder));
  const first = (r: SlotRequest) => Number(holding(r.holder) > 0 || priority.has(r.holder));
  // w5324: strict priority first (frantic > urgent > high > normal > low), then holders, then first come first served.
  // Holders went first before (w4620), so a normal sandbox whose editor was up, or stopped a moment ago, went ahead of a
  // frantic newcomer (w5291 waited about 2 h on LothDesktop, 2026-11-23; lothsahn: "If w5291 is frantic priority, how
  // is it waiting for a slot?").
  const prios = new Map(waiting.map((r) => [r.id, (input.priorityOf?.(r.session) ?? 'low') as WorkPriority]));
  const rank = (r: SlotRequest) => priorityRank(prios.get(r.id));
  const order = (a: SlotRequest, b: SlotRequest) => rank(b) - rank(a) || first(b) - first(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  waiting.sort(order);
  const queue = [...waiting];
  const take = (r: SlotRequest) => {
    grant.push(r.id);
    free -= r.count;
    holders.set(r.holder, holding(r.holder) + r.count);
  };
  let rest: SlotRequest[] = [];
  for (const r of waiting) {
    if (!rest.length && !ramBlocked && r.count <= free) take(r);
    else rest.push(r);
  }
  // Every slot in use kept by a waiter: nothing frees one by itself.
  if (rest.length && limit !== undefined) {
    const blocked = new Set(rest.flatMap(keptKeys));
    const heldByWaiters = [...blocked].reduce((n, k) => n + (usedOf.get(k) ?? 0), 0);
    if (heldByWaiters > 0 && heldByWaiters >= limit - free) {
      const fits = rest.find((r) => r.count <= free);
      if (fits && !ramBlocked) {
        take(fits);
        rest = rest.filter((r) => r !== fits);
      } else if (!fits) {
        const newest = [...rest].filter((r) => kept(r) > 0).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
        if (newest) {
          const others = rest.filter((r) => r !== newest && kept(r) > 0).map((r) => `"${r.label}" (holds ${kept(r)}, wants ${r.count})`);
          deny.push({ id: newest.id, why: `would wait forever: every Unity slot here is held by runs that are themselves waiting for more (${others.join(', ') || 'none other'}; this one holds ${kept(newest)} and wants ${newest.count}). Refused the newest: release what you hold and ask again for all ${kept(newest) + newest.count} at once` });
          rest = rest.filter((r) => r !== newest);
        }
      }
    }
  }
  const head = rest[0];
  // w4620: whom priority put ahead of an older waiter (the oldest such one per request), for the log.
  const jumps: Assessment['jumps'] = [];
  for (const c of queue) {
    if (!grant.includes(c.id) && c !== head) continue;
    const over = queue
      .filter((o) => o !== c && !grant.includes(o.id) && !deny.some((x) => x.id === o.id) && o.createdAt < c.createdAt && rank(o) < rank(c))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
    if (over) jumps.push({ id: c.id, priority: prios.get(c.id)!, over: over.id, overPriority: prios.get(over.id)! });
  }
  // w5324: who holds the slots in use, and the lower-priority idle editors whose slots the head may take.
  const levelOf = (session?: string): WorkPriority => input.priorityOf?.(session) ?? 'low';
  const placeOf = new Map(input.places.map((pl) => [`e:${pathKey(pl.path, platform)}`, pl]));
  const heldBy: string[] = [];
  for (const [key, b] of buckets) {
    if (!usedOf.get(key)) continue;
    if (key.startsWith('e:')) {
      const pl = placeOf.get(key);
      const work = input.requestsOf?.(pl?.session) ?? [];
      const held = input.pairOf?.(pl?.session)?.half === 'held' ? ['a pair\'s held side'] : [];
      heldBy.push(`${b.holder} (${[work.length ? work.join(', ') : 'no request', levelOf(pl?.session), ...held].join(', ')})`);
    } else {
      const r = reqs.find((x) => `p:${x.pid}` === key && x.grantedAt !== undefined && !x.denied) ?? reqs.find((x) => `p:${x.pid}` === key);
      if (r) heldBy.push(`"${r.label}" (${r.holder}, ${levelOf(r.session)})`);
    }
  }
  for (const u of outside) heldBy.push(`${u.kind} pid ${u.pid} outside the gate`);
  const preempt: Preempt[] = [];
  if (head && limit !== undefined && !ramBlocked && head.count > free) {
    const want = prios.get(head.id) ?? 'low';
    const need = head.count - free;
    const headPair = input.pairOf?.(head.session);
    const victims = input.places
      .filter((pl) => pl.editorUp && pl.holder !== head.holder)
      // w5341: a held pair side counts one level up as a victim, but to an older pair's raised leg (heldSideKept)
      .map((pl) => ({ pl, key: `e:${pathKey(pl.path, platform)}`, level: heldSideKept(input.pairOf?.(pl.session), headPair) ? raiseOne(levelOf(pl.session)) : levelOf(pl.session) }))
      // Its editor runs (a process counted on it) and holds its slot alone: no granted run of its sandbox beside it.
      .filter((v) => buckets.get(v.key)?.procs === 1 && usedOf.get(v.key) === 1 && holding(v.pl.holder) === 1 && priorityRank(v.level) < priorityRank(want))
      .sort((a, b) => priorityRank(a.level) - priorityRank(b.level) || a.pl.holder.localeCompare(b.pl.holder));
    if (victims.length >= need) for (const v of victims.slice(0, need)) preempt.push({ holder: v.pl.holder, priority: v.level, requests: input.requestsOf?.(v.pl.session) ?? [], for: head.id, forPriority: want });
  }
  const takes = preempt.length ? `; takes the slot of ${preempt.map((x) => `${x.holder}'s editor (${x.priority})`).join(', ')} once idle (w5324)` : '';
  // w5341: a raised pair leg says so first in its reason (the ledger clips a reason at 120 characters), wherever it stands.
  const raised = (r: SlotRequest) => {
    const p = input.pairOf?.(r.session);
    return p?.half === 'waiting' ? `${pairRaiseText(p, prios.get(r.id) ?? raiseOne(p.from))}; ` : '';
  };
  const waitingOut = rest.map((r, i) => ({
    id: r.id,
    position: i + 1,
    why:
      raised(r) +
      (r === head
        ? ramBlocked && r.count <= free
          ? `RAM ${input.ramPct}% used; new Unity launches wait below ${input.ramLimitPct ?? UNITY_RAM_PCT}%`
          : `needs ${r.count}, ${Math.max(0, free)} free (${limit === undefined ? used : `${limit - Math.max(0, free) - (free < 0 ? free : 0)} of ${limit}`} in use)${heldBy.length ? `; held by ${heldBy.join(', ')}` : ''}${takes}`
        : `behind ${i} earlier request${i === 1 ? '' : 's'}`),
  }));
  // In use once this look's grants start: what the line and the next look say.
  const granted = grant.reduce((n, id) => n + (reqs.find((r) => r.id === id)?.count ?? 0), 0);
  return {
    limit,
    used: used + granted,
    starting,
    free: limit === undefined ? Infinity : limit - used - granted,
    unity,
    interactive: unity.filter((u) => u.kind === 'interactive').length,
    batch: unity.filter((u) => u.kind === 'batch').length,
    outside,
    players: gamePlayers(input.procs, platform).length,
    overLimit: limit !== undefined && used > limit,
    ramBlocked,
    holders,
    grant,
    deny,
    waiting: waitingOut,
    priorities: prios,
    jumps,
    preempt,
    heldBy,
  };
}

/** "editors 4 of 3: 1 interactive, 3 batch" (the processes; slots held with no Unity yet are said apart, shared/fleet.ts). */
export function countsLine(a: Pick<Assessment, 'limit' | 'used' | 'interactive' | 'batch' | 'starting'>): string {
  return `editors ${a.used} of ${a.limit ?? 'no limit'}: ${a.interactive} interactive, ${a.batch} batch${heldNotStarted(a)}`;
}

// ---------------------------------------------------------------- the mailbox

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const reqFile = (dir: string, id: string) => path.join(dir, `req-${id}.json`);
export const grantFile = (dir: string, id: string) => path.join(dir, `grant-${id}.json`);
export const denyFile = (dir: string, id: string) => path.join(dir, `deny-${id}.json`);
export const arbiterFile = (dir: string) => path.join(dir, 'arbiter.json');
/** When this process started, in ms: of two daemons of one machine on one mailbox, the newer stays (w1918). */
const PROCESS_STARTED = Math.round(Date.now() - process.uptime() * 1000);

/** What a client writes. */
export interface RequestFile {
  v: 1;
  id: string;
  pid: number;
  holder: string;
  count: number;
  label: string;
  projects?: string[];
  /** The agent session that ran it (FF_SESSION_ID), so the reaper knows whose build it is (w1874). */
  session?: string;
  createdAt: string;
}

/** The run requests in a mailbox with the session each recorded (w1874: the reaper's owner rule). Reads only. */
export function runsIn(dir: string): { pid: number; session?: string }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { pid: number; session?: string }[] = [];
  for (const n of names) {
    const m = /^req-(.+)\.json$/.exec(n);
    if (!m || !ID.test(m[1])) continue;
    const f = readJson<RequestFile>(path.join(dir, n));
    if (f && Number.isInteger(f.pid) && f.pid > 0) out.push({ pid: f.pid, ...(typeof f.session === 'string' && f.session ? { session: f.session.slice(0, 64) } : {}) });
  }
  return out;
}

/** What the arbiter writes for clients and people: the counts, the queue, the grants. */
export interface ArbiterFile {
  v: 1;
  pid: number;
  /** Which arbiter wrote it (one per UnitySlots): two writing one mailbox are told apart. */
  instance?: string;
  machine?: string;
  /** When the process that writes it started: of two daemons of one machine on one mailbox, the newer stays (w1918). */
  startedAt?: string;
  at: string;
  limit?: number;
  used: number;
  line: string;
  waiting: { id: string; label: string; count: number; holder: string; position: number; why: string; priority?: WorkPriority }[];
  granted: { id: string; label: string; count: number; holder: string }[];
}

/**
 * Write a file whole: a reader never sees half of it. On Windows a rename over a file another process has open for a
 * moment (a client reading arbiter.json, a virus scanner looking at a new file) fails with EPERM or EBUSY: retried for
 * up to half a second.
 */
function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        rm(tmp);
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const rm = (file: string) => fs.rmSync(file, { force: true });

// ---------------------------------------------------------------- the arbiter (the daemon, or `unity-slot serve`)

export interface ArbiterDeps {
  dir: string;
  platform: UnityPlatform;
  procs(): Promise<Proc[]>;
  /** Whether a process is alive. */
  alive(pid: number): boolean;
  now(): number;
  limit(): number | undefined;
  places(): Place[];
  ramPct(): number | undefined;
  ramLimitPct?: number;
  holderWaitMs?: number;
  staleMs?: number;
  /**
   * The worker root (the daemon's cfg.root): its daemon/bench.queue/priorities.json (w5545) says each session's priority, which
   * orders the queue (w4620). Absent: everyone counts as low.
   */
  root?: string;
  /** A session's priority; tests give it, else it is read from priorities.json at each look (readSlotPriorities). */
  priorityOf?(session?: string): WorkPriority;
  /** w5324: a session's requests (wNNN); tests give it, else read with the priorities (readSlotWork). */
  requestsOf?(session?: string): string[];
  /** w5341: a session's pair-run mark; tests give it, else read with the priorities (readSlotWork). */
  pairOf?(session?: string): PairRaise | undefined;
  /**
   * w5324: the pid of the editor a project has open, from its Library/EditorInstance.json (default: that file read at
   * each look); tests give it.
   */
  editorPid?(projectPath: string): number | undefined;
  /**
   * w5324: close a lower-priority sandbox's idle editor so a waiting request of a higher priority gets its slot: through
   * the editor (save, then quit), never a kill; skipped while it plays, compiles, imports, runs tests or builds a player,
   * or while its worker's Unity MCP calls hold the editor's ticket. The sandbox is marked so its editor starts again when
   * the request it yielded to is done. Absent: nothing is preempted (counted and named only).
   */
  preempt?(p: Preempt, why: string): Promise<{ closed: boolean; text: string }>;
  machine?: string;
  /** When this process started (default: from process.uptime()); tests give it. */
  startedAt?: number;
  /**
   * A newer live daemon of the same machine answers this mailbox (w1918: three daemons answered LothLaptop's after its
   * updates): this one should end, so one stays. Without it the other is only reported.
   */
  onNewerTwin?(pid: number): void;
  /** Something the orchestrator should hear of: over the limit and back, a refusal, a crashed holder's slots freed. */
  onEvent?(text: string): void;
  log?(line: string): void;
}

export class UnitySlots {
  private readonly d: ArbiterDeps;
  /** This arbiter's own mark in arbiter.json: another one writing the same mailbox is told apart by it. */
  private readonly instance = randomBytes(6).toString('hex');
  private yielded = false;
  /** Other arbiters already reported, by instance. */
  private readonly foreign = new Set<string>();
  private last?: { a: Assessment; reqs: SlotRequest[]; ramPct?: number; at: number };
  /** w4620: the priority jumps already logged ("<winner id>><overtaken id>"), so a poll does not repeat one. */
  private readonly jumpsLogged = new Set<string>();
  private overSince = 0;
  /** w5324: since when the count is over the limit, before it is told (a quitting editor counted outside for a few seconds). */
  private overSeen = 0;
  private ramSince = 0;
  private busy?: Promise<Assessment>;
  private closed = false;
  /** w5324: preemptions under way, by place, and when a skipped one may be asked again. */
  private readonly preempting = new Set<string>();
  private readonly preemptRetry = new Map<string, number>();

  constructor(d: ArbiterDeps) {
    this.d = d;
  }

  get dir() {
    return this.d.dir;
  }

  /** The requests in the mailbox; gone holders (dead process, no heartbeat) are removed with their files. */
  private readRequests(): SlotRequest[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.d.dir);
    } catch {
      return [];
    }
    const now = this.d.now();
    const stale = this.d.staleMs ?? STALE_MS;
    const out: SlotRequest[] = [];
    const live = new Set<string>();
    for (const n of names) {
      const m = /^req-(.+)\.json$/.exec(n);
      if (!m || !ID.test(m[1])) continue;
      const id = m[1];
      const file = path.join(this.d.dir, n);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const f = readJson<RequestFile>(file);
      if (!f || f.id !== id || !Number.isInteger(f.pid) || f.pid <= 0) {
        // Half-written by a client that crashed: gone once it is old.
        if (now - mtime > stale) rm(file);
        continue;
      }
      const grant = readJson<{ grantedAt: string }>(grantFile(this.d.dir, id));
      const deny = readJson<{ why: string }>(denyFile(this.d.dir, id));
      const label = String(f.label || `pid ${f.pid}`).slice(0, 120);
      const gone = !this.d.alive(f.pid) ? `its process ${f.pid} is gone` : now - mtime > stale ? `no heartbeat for ${Math.round((now - mtime) / 1000)} s` : undefined;
      if (gone) {
        for (const x of [file, grantFile(this.d.dir, id), denyFile(this.d.dir, id)]) rm(x);
        if (grant && !deny) {
          const text = `freed ${f.count} Unity slot(s) of "${label}" (${f.holder}): ${gone}`;
          this.d.log?.(`unity slots: ${text}`);
          this.d.onEvent?.(text);
        }
        continue;
      }
      live.add(id);
      out.push({
        id,
        holder: String(f.holder || `pid:${f.pid}`).slice(0, 80),
        count: Number(f.count),
        pid: f.pid,
        label,
        projects: Array.isArray(f.projects) ? f.projects.filter((p): p is string => typeof p === 'string').slice(0, 8) : undefined,
        ...(typeof f.session === 'string' && f.session ? { session: f.session.slice(0, 80) } : {}),
        createdAt: Date.parse(f.createdAt) || mtime,
        grantedAt: grant ? Date.parse(grant.grantedAt) || mtime : undefined,
        denied: deny?.why,
      });
    }
    // Answers whose request is gone (released): removed.
    for (const n of names) {
      const m = /^(grant|deny)-(.+)\.json$/.exec(n);
      if (m && !live.has(m[2])) rm(path.join(this.d.dir, n));
    }
    return out;
  }

  /**
   * Its daemon stopped (Daemon.shutdown): no more looks, and a look already waiting on the process list writes nothing
   * when it comes back. A stopped arbiter must not grant slots or freshen arbiter.json, and its folder may be going (a
   * test removes its temp folder right after: w1173, a look landing mid-rmSync failed the w615 voice test with ENOTEMPTY).
   */
  close() {
    this.closed = true;
  }

  /** One look: free gone holders, count, grant or refuse, and write arbiter.json. Overlapping calls share one look. */
  tick(): Promise<Assessment> {
    this.busy ??= this.look().finally(() => (this.busy = undefined));
    return this.busy;
  }

  private async look(): Promise<Assessment> {
    if (this.closed) throw new Error('the Unity slots arbiter is closed (its daemon stopped)');
    fs.mkdirSync(this.d.dir, { recursive: true });
    const reqs = this.readRequests();
    const procs = await this.d.procs();
    const now = this.d.now();
    const ramPct = this.d.ramPct();
    const a = assess({ platform: this.d.platform, procs, requests: reqs, places: this.places(), limit: this.d.limit(), now, ramPct, ramLimitPct: this.d.ramLimitPct, holderWaitMs: this.d.holderWaitMs, ...this.work() });
    if (this.closed) return a;
    this.preempt(a, reqs, now);
    const byId = new Map(reqs.map((r) => [r.id, r]));
    this.logJumps(a, byId);
    for (const id of a.grant) {
      writeAtomic(grantFile(this.d.dir, id), JSON.stringify({ id, grantedAt: new Date(now).toISOString() }));
      const r = byId.get(id)!;
      r.grantedAt = now;
      this.d.log?.(`unity slots: granted ${r.count} to "${r.label}" (${r.holder})`);
    }
    for (const x of a.deny) {
      writeAtomic(denyFile(this.d.dir, x.id), JSON.stringify({ id: x.id, why: x.why, at: new Date(now).toISOString() }));
      const r = byId.get(x.id)!;
      r.denied = x.why;
      const text = `refused "${r.label}" (${r.holder}, ${r.count} slot(s)): ${x.why}`;
      this.d.log?.(`unity slots: ${text}`);
      this.d.onEvent?.(text);
    }
    this.last = { a, reqs, ramPct, at: now };
    this.notices(a, now);
    // Another live arbiter on this mailbox (a second daemon on the same home folder, a test's daemon) grants past the
    // limit: the orchestrator hears of it once per arbiter, so it can be stopped.
    const cur = readJson<ArbiterFile>(arbiterFile(this.d.dir));
    const other = !!cur?.instance && cur.instance !== this.instance && now - Date.parse(cur.at) <= ARBITER_FRESH_MS && this.d.alive(cur.pid);
    if (other && this.d.onNewerTwin && this.d.machine && cur!.machine === this.d.machine && cur!.startedAt && Date.parse(cur!.startedAt) > this.started) {
      // The same machine's newer daemon (an update started it beside this one): it keeps the mailbox, this one ends.
      if (!this.yielded) {
        this.yielded = true;
        this.d.onNewerTwin(cur!.pid);
      }
      return a;
    }
    if (other && !this.foreign.has(cur!.instance!)) {
      this.foreign.add(cur!.instance!);
      this.d.onEvent?.(`another process (pid ${cur!.pid}${cur!.machine ? `, machine "${cur!.machine}"` : ''}${cur!.startedAt ? `, started ${cur!.startedAt}` : ''}) is answering this machine's Unity slots mailbox ${this.d.dir} too, so launches may be granted past the limit. Stop it: a second daemon on the same home folder, or a test's daemon left running.`);
    }
    try {
      writeAtomic(arbiterFile(this.d.dir), JSON.stringify(this.arbiterFile(), null, 1));
    } catch (e) {
      // The next look writes it again; clients count it as gone only after a minute without one.
      this.d.log?.(`unity slots: could not write ${arbiterFile(this.d.dir)}: ${(e as Error).message}`);
    }
    return a;
  }

  /** The daemon's places, each with its editor's pid from its project's EditorInstance.json (w5324). */
  private places(): Place[] {
    const pidOf = this.d.editorPid ?? editorInstancePid;
    return this.d.places().map((pl) => (pl.editorPid || !pl.path ? pl : { ...pl, editorPid: pidOf(pl.path) }));
  }

  /** Each session's priority and requests: the deps' (tests) or priorities.json read now. */
  private work(): Pick<AssessInput, 'priorityOf' | 'requestsOf' | 'pairOf'> {
    const read = this.d.priorityOf && this.d.requestsOf && this.d.pairOf ? undefined : readSlotWork(this.d.root);
    return { priorityOf: this.d.priorityOf ?? read!.priorityOf, requestsOf: this.d.requestsOf ?? read!.requestsOf, pairOf: this.d.pairOf ?? read!.pairOf };
  }

  /**
   * w5324: ask the daemon to close each idle lower-priority editor this look names for the head of the queue, one close at
   * a time per sandbox, a skipped one again after PREEMPT_RETRY_MS. Not awaited: a close takes up to minutes (the save and
   * the quit); its sandbox's slot frees when its editor is gone, and the next look grants the waiter.
   */
  private preempt(a: Assessment, reqs: SlotRequest[], now: number) {
    const go = this.d.preempt;
    if (!go) return;
    for (const p of a.preempt) {
      if (this.preempting.has(p.holder) || (this.preemptRetry.get(p.holder) ?? 0) > now) continue;
      const r = reqs.find((x) => x.id === p.for);
      const work = r?.session ? (this.d.requestsOf ?? readSlotWork(this.d.root).requestsOf)(r.session) : [];
      const why = `"${r?.label ?? p.for}"${work.length ? ` (${work.join(', ')})` : ''}, ${p.forPriority}, waits for a Unity slot, and its editor is ${p.priority}${p.requests.length ? ` (${p.requests.join(', ')})` : ''}`;
      this.preempting.add(p.holder);
      this.d.log?.(`unity slots: closing the idle editor of ${p.holder} for ${why} (w5324)`);
      go(p, why)
        .then((res) => {
          this.d.log?.(`unity slots: ${p.holder}'s editor ${res.closed ? 'closed' : 'not closed'} for ${p.for}: ${res.text}`);
          if (res.closed) {
            this.preemptRetry.delete(p.holder);
            this.d.onEvent?.(`Editor of ${p.holder} closed cleanly for ${why} (w5324); it starts again when that run is done.`);
          } else this.preemptRetry.set(p.holder, this.d.now() + PREEMPT_RETRY_MS);
        })
        .catch((e) => {
          this.preemptRetry.set(p.holder, this.d.now() + PREEMPT_RETRY_MS);
          this.d.log?.(`unity slots: closing ${p.holder}'s editor for ${p.for} failed: ${(e as Error).message}`);
        })
        .finally(() => {
          this.preempting.delete(p.holder);
          if (!this.closed) void this.tick().catch(() => undefined);
        });
    }
  }

  /** w4620: one line per pair when priority puts a request ahead of an older waiting one (lothsahn: "Why is urgent work in a queue behind non urgent work?"). */
  private logJumps(a: Assessment, byId: Map<string, SlotRequest>) {
    const tag = (r: SlotRequest, p: WorkPriority) => `${r.label} (${(r.session ?? 'no session').slice(0, 8)}, ${p})`;
    for (const j of a.jumps) {
      const key = `${j.id}>${j.over}`;
      const [c, o] = [byId.get(j.id), byId.get(j.over)];
      if (this.jumpsLogged.has(key) || !c || !o) continue;
      this.jumpsLogged.add(key);
      this.d.log?.(`unity slot: ${tag(c, j.priority)} goes ahead of ${tag(o, j.overPriority)}, queued since ${new Date(o.createdAt).toISOString()}: strict priority (w4620)`);
    }
    for (const key of this.jumpsLogged) if (key.split('>').some((id) => !byId.has(id))) this.jumpsLogged.delete(key);
  }

  /** Tell the orchestrator once when the machine goes over its limit, and when it is back; and of a long wait on RAM. */
  private notices(a: Assessment, now: number) {
    const line = countsLine(a);
    // w5324: told only once it lasts OVER_NOTICE_MS: an editor that quits is counted outside the gate for a few seconds
    // (LothDesktop, 2026-11-23 17:52:48Z, "4 of 3", back within its limit 6 s later), which is no news.
    if (!a.overLimit) this.overSeen = 0;
    else this.overSeen ||= now;
    if (a.overLimit && !this.overSince && now - this.overSeen >= OVER_NOTICE_MS) {
      this.overSince = now;
      // The machine's own path rules: a Windows project path read on any host.
      const base = (p: string) => (this.d.platform === 'win32' ? path.win32 : path.posix).basename(p.replace(/[\\/]+$/, ''));
      const what = a.outside.map((u) => `${u.kind} ${u.project ? base(u.project) : `pid ${u.pid}`}${u.parent ? ` (started by ${u.parent})` : ''}`);
      this.d.onEvent?.(`Unity ${line} on this machine: over its limit. Nothing more is granted (unity start and queued launches wait) until it drops; nothing is stopped.${what.length ? ` Started outside the slot gate: ${what.join(', ')}.` : ''}`);
    } else if (!a.overLimit && this.overSince) {
      this.overSince = 0;
      this.d.onEvent?.(`Unity back within its limit on this machine: ${line}.`);
    }
    if (a.ramBlocked && a.waiting.length) {
      if (!this.ramSince) this.ramSince = now;
      else if (this.ramSince > 0 && now - this.ramSince > 10 * 60_000) {
        this.ramSince = -1; // told once per episode
        this.d.onEvent?.(`${a.waiting.length} Unity launch(es) have waited 10 min on RAM (${this.last?.ramPct}% used; they start below ${this.d.ramLimitPct ?? UNITY_RAM_PCT}%). ${line}.`);
      }
    } else this.ramSince = 0;
  }

  private get started(): number {
    return this.d.startedAt ?? PROCESS_STARTED;
  }

  private arbiterFile(): ArbiterFile {
    const l = this.last!;
    const byId = new Map(l.reqs.map((r) => [r.id, r]));
    return {
      v: 1,
      pid: process.pid,
      instance: this.instance,
      machine: this.d.machine,
      startedAt: new Date(this.started).toISOString(),
      at: new Date(l.at).toISOString(),
      limit: l.a.limit,
      used: l.a.used,
      line: this.line() ?? '',
      waiting: l.a.waiting.map((w) => {
        const r = byId.get(w.id)!;
        return { id: w.id, label: r.label, count: r.count, holder: r.holder, position: w.position, why: w.why, priority: l.a.priorities.get(w.id) };
      }),
      granted: l.reqs.filter((r) => r.grantedAt !== undefined && !r.denied).map((r) => ({ id: r.id, label: r.label, count: r.count, holder: r.holder })),
    };
  }

  /**
   * Whether an editor for `holder` (a sandbox's `unity start`) may start now, by the same rule as a queued request: as a
   * new request of one slot, behind everyone waiting before it. Undefined: yes; else why not. Fresh process list.
   */
  async startRefusal(holder: string): Promise<string | undefined> {
    const a0 = await this.tick();
    if (this.d.limit() === undefined) return undefined;
    const procs = await this.d.procs();
    // w5324: the requests read now, after the process list: a look that granted a run while that list was read is seen
    // (this.last was read before it, so the start and that run could both take the last slot). Nothing is awaited from
    // here to the answer, and the pool marks the slot taken as soon as it hears yes (sandboxes.ts takeSlot).
    const reqs = this.readRequests();
    // w4620: the start carries the editor's own bench session (editor:<sandbox>), so it queues at that sandbox's priority.
    const session = holder.startsWith('sandbox:') ? editorBenchSession(holder.slice('sandbox:'.length)) : undefined;
    const probe: SlotRequest = { id: '~editor', holder, count: 1, pid: -1, label: `editor of ${holder}`, ...(session ? { session } : {}), createdAt: this.d.now() + 1 };
    const a = assess({ platform: this.d.platform, procs, requests: [...reqs, probe], places: this.places(), limit: this.d.limit(), now: this.d.now(), ramPct: this.d.ramPct(), ramLimitPct: this.d.ramLimitPct, holderWaitMs: this.d.holderWaitMs, ...this.work() });
    if (a.grant.includes(probe.id)) return undefined;
    const why = a.deny.find((x) => x.id === probe.id)?.why ?? a.waiting.find((x) => x.id === probe.id)?.why ?? 'no free slot';
    // Those that wait ahead of it: by position, as priority may put it before some that were queued earlier.
    const mine = a.waiting.find((x) => x.id === probe.id);
    const ahead = mine ? mine.position - 1 : a.waiting.length;
    return `not started: ${why}; ${countsLine(a0)}${ahead ? `; ${ahead} launch(es) wait ahead of it` : ''}${this.holdersPart()}. Try again once one ends (wake_me), or stop an editor you no longer need`;
  }

  /** w5324: whether a request is in the mailbox at the last look and not refused (waiting or granted). */
  hasRequest(id: string): boolean {
    return !!this.last?.reqs.some((r) => r.id === id && !r.denied);
  }

  private holdersPart(): string {
    const g = this.report()?.granted ?? [];
    return g.length ? `; held by ${g.map((x) => `"${x.label}" (${x.count})`).join(', ')}` : '';
  }

  /**
   * The requests of a fresh look (granted, waiting and refused) and the Unity processes now running: what switch_branch
   * reads to refuse a switch under a batch build (w3626, machine/switchHolds.ts).
   */
  async holds(): Promise<{ reqs: SlotRequest[]; unity: UnityProcess[] }> {
    await this.tick();
    return { reqs: this.last?.reqs ?? [], unity: unityProcesses(await this.d.procs(), this.d.platform) };
  }

  /** The counts as one line (shared/fleet.ts unitySlotsLine), or undefined before the first look. */
  line(): string | undefined {
    const r = this.report();
    return r && unitySlotsLine(r);
  }

  /** For the portal (list_sandboxes, system_status, the dashboard), from the last look. */
  report(): UnitySlotsReport | undefined {
    const l = this.last;
    if (!l) return undefined;
    const iso = (t: number) => new Date(t).toISOString();
    const byId = new Map(l.reqs.map((r) => [r.id, r]));
    return {
      limit: l.a.limit,
      used: l.a.used,
      ...(l.a.starting ? { starting: l.a.starting } : {}),
      interactive: l.a.interactive,
      batch: l.a.batch,
      outside: l.a.outside.length,
      players: l.a.players,
      overLimit: l.a.overLimit,
      ramPct: l.ramPct,
      ramLimitPct: this.d.ramLimitPct ?? UNITY_RAM_PCT,
      waiting: l.a.waiting.map((w) => {
        const r = byId.get(w.id)!;
        return { label: r.label, count: r.count, holder: r.holder, since: iso(r.createdAt), why: `${w.why}; priority ${l.a.priorities.get(w.id) ?? 'low'}`, position: w.position, ...(r.session ? { session: r.session } : {}) };
      }),
      granted: l.reqs.filter((r) => r.grantedAt !== undefined && !r.denied).map((r) => ({ label: r.label, count: r.count, holder: r.holder, since: iso(r.grantedAt!) })),
      at: iso(l.at),
    };
  }

  /** Lines for `unity status`: the counts, then who holds and who waits. */
  describe(): string {
    const r = this.report();
    if (!r) return '';
    const lines = [`Unity on this machine: ${this.line()}`];
    for (const g of r.granted) lines.push(`  holds ${g.count}: "${g.label}" (${g.holder}) since ${g.since.slice(11, 16)} UTC`);
    for (const w of r.waiting) lines.push(`  waits for ${w.count}: "${w.label}" (${w.holder}) since ${w.since.slice(11, 16)} UTC: ${w.why}`);
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------- the client (`unity-slot`, and tests)

export interface ClientDeps {
  dir: string;
  pid: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Progress lines (stderr). */
  say(line: string): void;
  /** w5545: where requests go; the file mailbox in `dir` when not given (tests, `serve`, a machine without the daemon). */
  mailbox?: SlotMailbox;
}

export const realClientDeps = (dir = slotsDir(), env: NodeJS.ProcessEnv = process.env): ClientDeps => ({
  dir,
  pid: process.pid,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  say: (line) => process.stderr.write(`unity-slot: ${line}\n`),
  // w5545: an agent of FF Factory's daemon asks the daemon itself; a file it wrote in the old mailbox is ignored there.
  ...(rpcAvailable(env) ? { mailbox: rpcMailbox(env) } : {}),
});

/** The arbiter's file when it is fresh, else undefined (no FF Factory daemon here, or it is down). */
export function arbiterNow(dir: string, now: number): ArbiterFile | undefined {
  const f = readJson<ArbiterFile>(arbiterFile(dir));
  return f && now - Date.parse(f.at) <= ARBITER_FRESH_MS ? f : undefined;
}

/** Where a request is: granted, refused (why), still waiting, or gone (released, or dropped by the arbiter). */
export type SlotLook = { state: 'granted' } | { state: 'denied'; why: string } | { state: 'waiting' } | { state: 'gone' };

/**
 * How a client files and follows a request (w5545). The file mailbox (a folder of req/grant/deny files) is what the
 * daemon arbitrates; its agents reach it only through the daemon's calls (rpcMailbox), which write the request with the
 * caller's own session and sandbox. Every method may throw when the daemon cannot be reached.
 */
export interface SlotMailbox {
  /** For messages: the folder, or "FF Factory's daemon". */
  where: string;
  arbiter(now: number): Promise<ArbiterFile | undefined>;
  file(body: RequestFile): Promise<void>;
  touch(id: string, now: number): Promise<void>;
  look(id: string): Promise<SlotLook>;
  /** True when it was held. */
  release(id: string): Promise<boolean>;
}

/** Look up one request in a mailbox folder. */
export function lookIn(dir: string, id: string): SlotLook {
  const deny = readJson<{ why: string }>(denyFile(dir, id));
  if (deny) return { state: 'denied', why: deny.why };
  if (fs.existsSync(grantFile(dir, id))) return { state: 'granted' };
  return fs.existsSync(reqFile(dir, id)) ? { state: 'waiting' } : { state: 'gone' };
}

/** Remove one request and its answers from a mailbox folder; true when it was there. */
export function releaseIn(dir: string, id: string): boolean {
  const had = fs.existsSync(reqFile(dir, id));
  for (const f of [reqFile(dir, id), grantFile(dir, id), denyFile(dir, id)]) rm(f);
  return had;
}

/** The folder itself, as before w5545. */
export function fileMailbox(dir: string): SlotMailbox {
  return {
    where: dir,
    arbiter: async (now) => arbiterNow(dir, now),
    file: async (body) => writeAtomic(reqFile(dir, body.id), JSON.stringify(body)),
    touch: async (id, now) => {
      try {
        const t = new Date(now);
        fs.utimesSync(reqFile(dir, id), t, t);
      } catch {
        // released
      }
    },
    look: async (id) => lookIn(dir, id),
    release: async (id) => releaseIn(dir, id),
  };
}

/** w5545: the daemon's calls (machine/daemonRpc.ts). The daemon writes the request with the token's session and sandbox. */
export function rpcMailbox(env: NodeJS.ProcessEnv = process.env): SlotMailbox {
  return {
    where: "FF Factory's daemon",
    arbiter: async () => {
      try {
        return (await rpcCall<{ arbiter?: ArbiterFile }>('slots/status', {}, env)).arbiter;
      } catch (e) {
        if (e instanceof RpcUnavailable) return undefined;
        throw e;
      }
    },
    file: async (b) => {
      await rpcCall('slots/request', { id: b.id, pid: b.pid, count: b.count, label: b.label, ...(b.projects ? { projects: b.projects } : {}) }, env);
    },
    touch: async (id) => {
      await rpcCall('slots/touch', { id }, env).catch(() => undefined);
    },
    look: async (id) => (await rpcCall<{ look: SlotLook }>('slots/look', { id }, env)).look,
    release: async (id) => (await rpcCall<{ had?: boolean }>('slots/release', { id }, env).catch(() => ({ had: false }))).had === true,
  };
}

/**
 * The daemon's side of rpcMailbox (w5545): the requests a caller files go in the protected queue folder `dir` with the
 * caller's session and holder (`sandbox:<its sandbox>`, else `pid:<pid>`), whatever the body said, and only the session
 * that filed a request may touch, look at or release it.
 */
export function slotRpcHandlers(dir: string, o: { now?: () => number; filed?: () => void } = {}): Record<string, (c: Caller, b: Record<string, unknown>) => unknown> {
  const now = o.now ?? (() => Date.now());
  const own = (c: Caller, b: Record<string, unknown>) => {
    const id = String(b.id ?? '');
    if (!ID.test(id)) throw new RpcRefused(`not a slot id: "${id.slice(0, 80)}"`);
    const f = readJson<RequestFile>(reqFile(dir, id));
    if (f && f.session !== c.session) throw new RpcRefused(`slot request ${id} is another session's`, 403);
    return { id, f };
  };
  return {
    'slots/status': () => ({ arbiter: arbiterNow(dir, now()) }),
    'slots/request': (c, b) => {
      const { id, f } = own(c, b);
      const pid = Number(b.pid);
      const count = Number(b.count);
      if (!Number.isInteger(pid) || pid <= 0) throw new RpcRefused('pid: the asking process, a positive integer');
      if (!Number.isInteger(count) || count < 1 || count > 16) throw new RpcRefused('count: 1 to 16 slots');
      const projects = Array.isArray(b.projects) ? b.projects.filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 400)).slice(0, 8) : [];
      const body: RequestFile = {
        v: 1,
        id,
        pid,
        holder: c.sandbox ? `sandbox:${c.sandbox}` : `pid:${pid}`,
        count,
        label: String(b.label ?? `pid ${pid}`).slice(0, 120),
        ...(projects.length ? { projects } : {}),
        session: c.session,
        // A request filed again (the arbiter dropped it while its client was suspended) keeps its first time and place.
        createdAt: f?.createdAt ?? new Date(now()).toISOString(),
      };
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(reqFile(dir, id), JSON.stringify(body));
      o.filed?.();
      return { id, holder: body.holder };
    },
    'slots/touch': (c, b) => {
      const { id, f } = own(c, b);
      if (f) {
        const t = new Date(now());
        try {
          fs.utimesSync(reqFile(dir, id), t, t);
        } catch {
          // released meanwhile
        }
      }
      return { held: !!f };
    },
    'slots/look': (c, b) => {
      const { id, f } = own(c, b);
      return { look: f ? lookIn(dir, id) : ({ state: 'gone' } as SlotLook) };
    },
    'slots/release': (c, b) => {
      const { id, f } = own(c, b);
      return { had: f ? releaseIn(dir, id) : false };
    },
  };
}

export interface Held {
  id?: string;
  count: number;
  /** Ungated: no arbiter here (a machine without FF Factory's daemon), or it stayed away. */
  ungated?: string;
  /** Touches the request while held; stop() releases. */
  stop(): void;
}

export class SlotRefused extends Error {}

/**
 * Ask for `count` slots and wait until they are granted. Without a fresh arbiter at the start the launch goes ungated at
 * once (said on stderr); one that goes away while waiting is waited for `arbiterGraceMs` (10 min), then ungated too.
 * Rejects with SlotRefused when refused, or on `timeoutMs`.
 */
export async function acquire(
  d: ClientDeps,
  opts: { count: number; label: string; holder?: string; projects?: string[]; session?: string; timeoutMs?: number; arbiterGraceMs?: number; heartbeatMs?: number; pollMs?: number },
): Promise<Held> {
  const box = d.mailbox ?? fileMailbox(d.dir);
  const none = (why: string): Held => ({ count: opts.count, ungated: why, stop: () => undefined });
  if (!(await box.arbiter(d.now()))) {
    const why = box === d.mailbox ? `no slot arbiter answers on this machine (${box.where}); running without a slot` : `no slot arbiter on this machine (FF Factory's daemon keeps ${arbiterFile(d.dir)} fresh); running without a slot`;
    d.say(why);
    return none(why);
  }
  const id = `${d.now().toString(36)}-${d.pid}-${randomBytes(3).toString('hex')}`;
  const body: RequestFile = { v: 1, id, pid: d.pid, holder: opts.holder || `pid:${d.pid}`, count: opts.count, label: opts.label.slice(0, 120), ...(opts.projects?.length ? { projects: opts.projects } : {}), ...(opts.session ? { session: opts.session } : {}), createdAt: new Date(d.now()).toISOString() };
  await box.file(body);
  const beat = setInterval(() => void box.touch(id, d.now()).catch(() => undefined), opts.heartbeatMs ?? 15_000);
  beat.unref?.(); // the wait loop, the command a run holds for, or the hold loop keeps the process up
  let released = false;
  const release = () => {
    clearInterval(beat);
    if (released) return;
    released = true;
    void box.release(id).catch(() => undefined);
  };
  const started = d.now();
  let lastSaid = '';
  let goneSince = 0;
  try {
    for (;;) {
      const look = await box.look(id).catch(() => ({ state: 'waiting' }) as SlotLook);
      if (look.state === 'denied') throw new SlotRefused(`refused: ${look.why}`);
      if (look.state === 'granted') {
        d.say(`granted ${opts.count} Unity slot(s) to "${opts.label}" (${id})`);
        return { id, count: opts.count, stop: release };
      }
      // The arbiter dropped the request while this still waits (it found the heartbeat silent: the process was suspended,
      // or the daemon came back after a gap): filed again under its first time, so it keeps its place. Without this the
      // client waited for a grant that could never come, silently (LothDesktop, 2026-10-07: a run waited 4 h).
      if (look.state === 'gone') {
        await box.file(body).catch(() => undefined);
        d.say(`the request for ${opts.count} Unity slot(s) was gone from the mailbox; asked again (${id})`);
      }
      const now = d.now();
      const arb = await box.arbiter(now).catch(() => undefined);
      if (!arb) {
        goneSince ||= now;
        if (now - goneSince > (opts.arbiterGraceMs ?? 10 * 60_000)) {
          const why = `the slot arbiter has been away for ${Math.round((now - goneSince) / 60_000)} min; running without a slot`;
          d.say(why);
          release();
          return none(why);
        }
      } else {
        goneSince = 0;
        const w = arb.waiting.find((x) => x.id === id);
        const said = w ? `waiting for ${opts.count} Unity slot(s): position ${w.position} of ${arb.waiting.length}, ${w.why}; ${arb.line}` : '';
        if (said && said !== lastSaid) d.say((lastSaid = said));
      }
      if (opts.timeoutMs !== undefined && now - started > opts.timeoutMs) throw new SlotRefused(`gave up after waiting ${Math.round((now - started) / 60_000)} min for ${opts.count} Unity slot(s)`);
      await d.sleep(opts.pollMs ?? 1000);
    }
  } catch (e) {
    release();
    throw e;
  }
}

// ---------------------------------------------------------------- the CLI

const USAGE = `unity-slot: take Unity slots on this machine before launching Unity (docs/unity-lifecycle.md, "Unity slots")

  unity-slot run [--count N] [--label TEXT] [--project PATH]... [--timeout MIN] [--bench shared|exclusive] -- <command> [args...]
      wait for N slots (default 1), then for a ticket in the machine's bench queue (w1615: shared, the default, for a
      build or batch compile; exclusive for a timed run), run the command, release both when it ends. A ticket revoked
      under it ends the command and exits 75 (run it again). A ticket it cannot take stops it before the command: exit 77
      when the machine takes no exclusive tickets (w1861: hand the timed run back), 69 when the queue's helper fails
      (w1860). FF_BENCH_TICKETS=off runs without one, and then it waits out another worker's timed run
      --detach [--log FILE]: the wait and the run go on in a process of their own, apart from this call, which prints
      the job id and returns (w4740: a background task killed at its 2 h limit while the run still queued for a slot).
      Output goes to FILE (default $TMPDIR/unity-slot-<id>.log)
  unity-slot wait <id>
      follow a detached run's log and exit with its command's exit code; run it again if it was cut off
  unity-slot acquire [--count N] [--label TEXT] [--project PATH]... [--ttl MIN] [--timeout MIN]
      wait for N slots and hold them in the background (prints the slot id) until release or the ttl (default 120)
  unity-slot release <id>
  unity-slot status
  unity-slot serve --limit N [--dir DIR] [--for MIN]
      an arbiter for a machine whose daemon has none (tests); ends after MIN minutes when given

  A peer run that needs N editors asks for N at once. Inside "run" the command's own launches pass straight through
  (FF_UNITY_SLOT_HELD). FF_UNITY_HOLDER names the holder (the daemon sets "sandbox:<id>" for its agents).`;

interface CliOpts {
  count: number;
  label?: string;
  projects: string[];
  timeoutMs?: number;
  ttlMs: number;
  limit?: number;
  dir?: string;
  forMs?: number;
  bench?: BenchMode;
  detach?: boolean;
  log?: string;
  rest: string[];
}

export function parseCli(argv: string[]): { cmd: string; o: CliOpts } {
  const [cmd = 'help', ...args] = argv;
  const o: CliOpts = { count: 1, projects: [], ttlMs: 120 * 60_000, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const num = (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${a} takes a number, not "${v}"`);
      return n;
    };
    if (a === '--') {
      o.rest = args.slice(i + 1);
      break;
    } else if (a === '--count' || a === '-n') o.count = num(val());
    else if (a === '--label') o.label = val();
    else if (a === '--project') o.projects.push(path.resolve(val()));
    else if (a === '--timeout') o.timeoutMs = num(val()) * 60_000;
    else if (a === '--ttl') o.ttlMs = num(val()) * 60_000;
    else if (a === '--limit') o.limit = num(val());
    else if (a === '--dir') o.dir = val();
    else if (a === '--for') o.forMs = num(val()) * 60_000;
    else if (a === '--detach') o.detach = true;
    else if (a === '--log') o.log = path.resolve(val());
    else if (a === '--bench') {
      const v = val();
      if (v !== 'shared' && v !== 'exclusive') throw new Error(`--bench takes shared or exclusive, not "${v}"`);
      o.bench = v;
    }
    else o.rest.push(a);
  }
  return { cmd, o };
}

/** A run whose bench ticket was revoked exits with this (bench_queue.py EXIT_PREEMPTED, EX_TEMPFAIL: run it again). */
export const EXIT_REVOKED = 75;
/** How long a revoked run's tree has to end on SIGTERM before it is stopped hard (bench_queue.py PREEMPT_GRACE_S). */
export const REVOKED_GRACE_MS = 20_000;
/** A run whose bench ticket could not be taken (its helper failed, no queue here) exits with this (EX_UNAVAILABLE, w1860). */
export const EXIT_NO_TICKET = 69;
/** A run refused an exclusive ticket on a machine that takes no timed runs (bench_queue.py EXIT_NO_TIMED_RUNS, w1861). */
export const EXIT_NO_TIMED_RUNS = 77;

/**
 * w4669: how `unity-slot run -- <command>` starts its command. Windows' CreateProcess runs only executables: a `.sh` given as
 * the command (the pair-run brief's `scripts/nightly/build_player.sh ...`, w4663 on LothDesktop) failed with `spawn EFTYPE`,
 * so on Windows a `.sh` (or a bare `bash`) goes through Git for Windows' bash, never WSL's System32\bash.exe (another Linux, without the
 * worker's Git, Unity or paths); a `.cmd` or `.bat` through cmd.exe as before. macOS and Linux start it as given (its shebang).
 */
export function commandToSpawn(rest: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): { cmd: string; args: string[]; shell: boolean } {
  const [cmd, ...args] = rest;
  if (platform !== 'win32') return { cmd, args, shell: false };
  if (/\.sh$/i.test(cmd)) return { cmd: gitBash(env, exists), args: [cmd, ...args], shell: false };
  // `bash <script>` as the brief writes it: PATH may find WSL's bash before Git's, so name Git's.
  if (/^bash(\.exe)?$/i.test(cmd)) return { cmd: gitBash(env, exists), args, shell: false };
  return { cmd, args, shell: /\.(cmd|bat)$/i.test(cmd) };
}

/** Git for Windows' bash.exe: the one Claude Code uses, the Git on PATH, the default install; else `bash` from PATH. */
export function gitBash(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string {
  const W = path.win32;
  const out: string[] = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) out.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const d of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    const base = W.basename(d).toLowerCase();
    if (base === 'cmd' || base === 'mingw64') out.push(W.join(d, '..', 'bin', 'bash.exe'));
    if (/\\(system32|windowsapps)$/i.test(W.normalize(d).replace(/\\+$/, ''))) continue; // WSL's launcher, not Git's
    out.push(W.join(d, 'bash.exe'));
  }
  for (const pf of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files']) if (pf) out.push(W.join(pf, 'Git', 'bin', 'bash.exe'));
  return out.find((p) => exists(p)) ?? 'bash';
}

/**
 * End a process and everything it started (w1860): SIGTERM to the tree, then a hard stop of what is left after `graceMs`
 * (the timer keeps this process up until then). The tree is listed before the signal, so a child its dying parent leaves
 * behind is still found. Windows: taskkill /T /F at once; a batch Unity has no window to ask, and a soft taskkill of a
 * wrapper that exits would leave its Unity orphaned where /T no longer finds it.
 */
export function stopTree(pid: number, platform: NodeJS.Platform, graceMs: number, sh: (cmd: string, args: string[]) => string = (c, a) => spawnSync(c, a, { encoding: 'utf8', windowsHide: true }).stdout ?? ''): void {
  if (platform === 'win32') {
    sh('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }
  const kids = new Map<number, number[]>();
  for (const line of sh('ps', ['-A', '-o', 'pid=,ppid=']).split('\n')) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (c && p) kids.set(p, [...(kids.get(p) ?? []), c]);
  }
  // w5397: under the worker fence the setuid `ps` is refused and prints nothing; `pgrep -P` (not setuid) still lists children.
  const childrenOf = (p: number) => (kids.size ? (kids.get(p) ?? []) : sh('pgrep', ['-P', String(p)]).split('\n').map(Number).filter((n) => n > 0));
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) for (const c of childrenOf(tree[i])) if (!tree.includes(c)) tree.push(c);
  const signal = (sig: NodeJS.Signals) => {
    for (const p of tree) {
      try {
        process.kill(p, sig);
      } catch {
        // gone already
      }
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), graceMs);
}

/** How often a run looks whether its caller is still there (w1874). */
export const CALLER_WATCH_MS = 2_000;

/** The parent pid as it is now: Linux reads it live (process.ppid is the one at start); elsewhere undefined. */
export function livePpid(): number | undefined {
  try {
    const st = fs.readFileSync('/proc/self/stat', 'utf8');
    const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process that ran `unity-slot run` (pid `caller`) is gone (w1874). On biscuit a worker ended the background
 * shell that ran a build script; the wrapper (pid 2460427) lived on under systemd, its hung Unity with it, holding a Unity
 * slot and the sandbox's Library with nobody to use the result. Linux: the parent changed (reparented to init or a
 * subreaper); a Mac or Windows: the caller's pid is no longer alive. A run started by init itself has nothing to watch.
 */
export function callerGone(caller: number, platform: NodeJS.Platform, readPpid: () => number | undefined = livePpid, alive: (pid: number) => boolean = isAlive): boolean {
  if (caller <= 1) return false;
  const now = platform === 'linux' ? readPpid() : undefined;
  return now !== undefined ? now !== caller : !alive(caller);
}

/** The label a run gets when none is given: the command, short. */
const labelOf = (o: CliOpts) => o.label ?? (o.rest.map((a) => path.basename(a)).join(' ').slice(0, 80) || 'unity-slot');

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { cmd, o } = parseCli(argv);
  const dir = o.dir ?? slotsDir(env);
  // w5545: --dir names a mailbox folder to use as is (tests, a hand-run `serve`); otherwise an agent asks the daemon.
  const d = o.dir ? { ...realClientDeps(dir, {}) } : realClientDeps(dir, env);
  const holder = env.FF_UNITY_HOLDER || undefined;
  const held = Number(env.FF_UNITY_SLOT_HELD) || 0;
  const job = env.FF_UNITY_SLOT_JOB && JOB_ID.test(env.FF_UNITY_SLOT_JOB) ? env.FF_UNITY_SLOT_JOB : undefined;
  if (cmd === 'run' && o.detach && !job) {
    if (!o.rest.length) throw new Error('run needs a command after --');
    return startDetached(argv, o, dir, env, d.say);
  }
  if (cmd === 'wait') return waitJob(dir, o.rest[0], d.sleep);
  if (cmd === 'run') {
    if (!o.rest.length) throw new Error('run needs a command after --');
    // w4740: a detached run (run --detach) says how it ended in its job's exit file, which `unity-slot wait` reads.
    const ended = (code: number) => {
      if (job) writeAtomic(jobExitFile(dir, job), JSON.stringify({ code, ended: new Date().toISOString() }));
      return code;
    };
    let h: Held | undefined;
    // w1615: no long wait under the bench lock. A run made by a process that holds it waits for a slot at most
    // HELD_WAIT_CAP_MS: an editor holding the last slot may belong to a worker that waits for that very lock.
    const lock = benchLockPath(undefined, env);
    const inside = heldTicket(lock, env, isAlive);
    let timeoutMs = o.timeoutMs;
    if (inside && held < o.count) {
      timeoutMs = Math.min(timeoutMs ?? Infinity, HELD_WAIT_CAP_MS);
      d.say(`this process holds the bench lock (${inside.ticket} ${inside.mode}): a Unity slot is waited for at most ${HELD_WAIT_CAP_MS / 1000} s under it (w1615). Take the slot before bench_lock instead.`);
    }
    // w1894: no new Unity run while a person plays the game on this machine (machine/personPlay.ts): it waits, before it
    // takes a slot or a ticket, until the hold's grace after the game closes. A run nested in one already going is left.
    if (!inside && held < o.count && env.FF_WORKER_ROOT) {
      let said = '';
      for (let why = personHoldReason(env.FF_WORKER_ROOT); why; why = personHoldReason(env.FF_WORKER_ROOT)) {
        if (why !== said) d.say(`waiting: no new Unity run starts while a person plays here (w1894): ${(said = why)}. Hand the work back to your orchestrator for another machine if it cannot wait.`);
        await d.sleep(30_000);
      }
    }
    if (held >= o.count) d.say(`inside a run that holds ${held} slot(s): no new slot`);
    else h = await acquire(d, { count: o.count, label: labelOf(o), holder, projects: o.projects, session: env.FF_SESSION_ID || undefined, timeoutMs });
    // Then the bench ticket (slot first, ticket second: the queue's deadlock rule). A nested run reuses its parent's.
    let ticket: TicketLike | undefined;
    let ticketName = inside?.ticket;
    if (!inside && held < o.count && env.FF_BENCH_TICKETS !== 'off') {
      const projectArg = o.rest.findIndex((a) => /^-projectpath$/i.test(a));
      const mode = o.bench ?? (env.FF_UNITY_SLOT_BENCH === 'exclusive' ? 'exclusive' : 'shared');
      // w5545: an agent's run takes its ticket through the daemon, which holds it under the agent's own session.
      const t: { ticket?: TicketLike; why?: string } = rpcAvailable(env)
        ? { ticket: await new RpcBenchTicket({ mode, what: `unity: ${labelOf(o)}`, env }).take() }
        : benchTicketFor({ mode, what: `unity: ${labelOf(o)}`, checkouts: [...o.projects, projectArg >= 0 ? o.rest[projectArg + 1] : undefined, env.FF_SANDBOX_PATH, process.cwd()], root: env.FF_WORKER_ROOT, env });
      let refused = t.why;
      if (!refused) {
        ticket = t.ticket;
        const s = await ticket!.wait(Infinity, (line) => d.say(`bench queue: ${line}`), d.sleep);
        if (s.kind === 'granted') ticketName = s.ticket;
        else {
          refused = s.line;
          ticket!.release();
          ticket = undefined;
        }
      }
      // w1860 (lothsahn: "builds or any compute intensive job needs a lock... If it's not possible to know if a job is
      // compute intensive, it needs a lock"): a run whose ticket the queue refused (an exclusive one on a machine that
      // takes no timed runs, w1861) or whose helper failed does not start without one. It used to run ticketless.
      if (refused) {
        h?.stop();
        const noTimed = /takes no timed runs/i.test(refused);
        d.say(
          `no ${mode} bench ticket, so the run does not start (w1860: every build, test run or timed run holds one): ${refused}. ` +
            (noTimed
              ? 'Hand the timed work back to your orchestrator for another machine.'
              : 'Run it again once the queue works here (`python scripts/bench/bench_queue.py status`); FF_BENCH_TICKETS=off runs it without a ticket, for a run outside FF Factory only.'),
        );
        return ended(noTimed ? EXIT_NO_TIMED_RUNS : EXIT_NO_TICKET);
      }
    }
    // w1860: a run with no ticket of its own (FF_BENCH_TICKETS=off; one that cannot be taken stops above) still never starts beside
    // another worker's timed run: it waits for that turn to end, as its ticket would have.
    if (!inside && !ticket && held < o.count && env.FF_WORKER_ROOT) {
      let said = '';
      for (let why = foreignTimedHold(env.FF_WORKER_ROOT, env.FF_SESSION_ID || undefined); why; why = foreignTimedHold(env.FF_WORKER_ROOT, env.FF_SESSION_ID || undefined)) {
        if (why !== said) d.say(`waiting for another worker's timed run to end before this run starts (w1860: no build or test run beside it): ${(said = why)}`);
        await d.sleep(15_000);
      }
    }
    // w5297: a batch Unity run that names no -logFile writes the person's own Editor.log; it gets one in the worker's temp folder.
    const logFile = batchUnityLogFile(o.rest, env, o.label ?? 'batch');
    if (logFile) d.say(`no -logFile given: Unity logs to ${logFile} (w5297: never the person's own Editor.log)`);
    const run = commandToSpawn(logFile ? [...o.rest, '-logFile', logFile] : o.rest, process.platform, env);
    const { FF_UNITY_SLOT_JOB: _job, ...childEnv } = editorHomeEnv(run.shell ? [] : [run.cmd, ...run.args], editorStatusEnv(env));
    const child = spawn(run.cmd, run.args, {
      stdio: 'inherit',
      shell: run.shell,
      env: { ...childEnv, FF_UNITY_SLOT_HELD: String(Math.max(held, o.count)), ...(h?.id ? { FF_UNITY_SLOT_ID: h.id } : {}), ...(ticketName ? { FF_BENCH_TICKET: ticketName } : {}) },
    });
    process.on('SIGINT', () => child.kill('SIGINT'));
    // w1874: the run dies with whatever started it. SIGTERM or SIGHUP (a task or terminal ended) ends the whole tree, hard
    // after a grace (a hung Unity ignores a polite signal), and a caller that vanished without a signal does the same:
    // otherwise the wrapper lives on under init with its Unity, holding a slot no one will free.
    let stopping = false;
    const stopRun = (why: string) => {
      if (stopping || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      stopping = true;
      stopTree(child.pid, process.platform, REVOKED_GRACE_MS);
      d.say(why);
    };
    // A caller that is gone took the read end of our stdout and stderr with it: a write there must not end this process
    // before its tree is stopped.
    for (const out of [process.stdout, process.stderr]) out.on('error', () => undefined);
    process.on('SIGTERM', () => stopRun('stopped (SIGTERM): ending the run and what it started (w1874)'));
    process.on('SIGHUP', () => stopRun('stopped (SIGHUP: its terminal or task ended): ending the run and what it started (w1874)'));
    // A detached run (w4740) left its caller on purpose: the session's leftovers sweep and SIGTERM end it instead.
    const caller = job ? 0 : process.ppid;
    const callerWatch = setInterval(() => {
      if (callerGone(caller, process.platform)) stopRun(`its caller (pid ${caller}) is gone, so nobody will use the result: ending the run and what it started (w1874)`);
    }, CALLER_WATCH_MS);
    // w1860: a ticket revoked under the run (the shared group's turn limit while an exclusive ticket waits, or an urgent
    // release) ends the run: its helper is a service owner and stops nothing itself, and a build that went on ran beside
    // the timed run granted next (the bench_queue.py `run` does the same: SIGTERM to the tree, then a hard stop).
    let revoked: string | undefined;
    const watch = ticket
      ? setInterval(() => {
          const s = ticket!.state();
          if (revoked || s.kind !== 'failed' || !/^revoked/.test(s.line) || child.exitCode !== null || !child.pid) return;
          revoked = s.line;
          d.say(`bench queue: ${s.line}`);
          d.say(`stopping the run (w1860): its bench ticket was revoked, so it may not go on beside the next turn. Run it again: it queues for a new ticket.`);
          stopTree(child.pid, process.platform, REVOKED_GRACE_MS);
        }, 2_000)
      : undefined;
    return new Promise<number>((resolve) => {
      child.on('error', (e) => {
        clearInterval(callerWatch);
        if (watch) clearInterval(watch);
        d.say(`could not start ${o.rest[0]}: ${e.message}`);
        h?.stop();
        ticket?.release();
        resolve(ended(127));
      });
      child.on('exit', (code, sig) => {
        clearInterval(callerWatch);
        if (watch) clearInterval(watch);
        h?.stop();
        ticket?.release();
        // w5347: a failed run on Windows names a Low-integrity compiler server, the known cause of CS2012 under Library/Bee.
        if (code !== 0 && !revoked && process.platform === 'win32') {
          const advice = compilerServerAdvice(beeAccessDenied(logTail(logFile ?? logFileArg(o.rest))), compilerServers());
          if (advice) d.say(advice);
        }
        resolve(ended(revoked ? EXIT_REVOKED : (code ?? (sig ? 128 : 1))));
      });
    });
  }
  if (cmd === 'acquire') {
    // The holder is a detached process of its own (it outlives this call and the agent's shell); it writes the request.
    const id = `${Date.now().toString(36)}-h-${randomBytes(3).toString('hex')}`;
    const args = [...process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), import.meta.filename, '__hold', id, String(o.count), labelOf(o), String(o.ttlMs), ...o.projects.flatMap((p) => ['--project', p])];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, FF_UNITY_SLOTS: dir } });
    child.unref();
    const answer = path.join(dir, `hold-${id}.json`);
    for (;;) {
      const a = readJson<{ ok: boolean; text: string; id?: string }>(answer);
      if (a) {
        rm(answer);
        if (!a.ok) throw new SlotRefused(a.text);
        process.stdout.write(`${a.id ?? ''}\n`);
        d.say(a.text);
        return 0;
      }
      if (o.timeoutMs !== undefined && Date.now() - Number(id.split('-')[0] ? parseInt(id.split('-')[0], 36) : 0) > o.timeoutMs + 5000) throw new SlotRefused('gave up waiting');
      await d.sleep(500);
    }
  }
  if (cmd === '__hold') {
    const [answerId, count, label, ttl] = o.rest;
    const answer = path.join(dir, `hold-${answerId}.json`);
    let h: Held;
    try {
      h = await acquire(d, { count: Number(count), label, holder, projects: o.projects });
    } catch (e) {
      writeAtomic(answer, JSON.stringify({ ok: false, text: (e as Error).message }));
      return 1;
    }
    writeAtomic(answer, JSON.stringify({ ok: true, id: h.id, text: h.ungated ?? `holding ${count} Unity slot(s) as ${h.id} for at most ${Math.round(Number(ttl) / 60_000)} min; unity-slot release ${h.id} when done` }));
    if (!h.id) return 0;
    const until = Date.now() + Number(ttl);
    const box = d.mailbox ?? fileMailbox(dir);
    for (;;) {
      if (Date.now() >= until) break;
      const look = await box.look(h.id).catch(() => ({ state: 'granted' }) as SlotLook);
      if (look.state === 'gone' || look.state === 'denied') break;
      await d.sleep(2000);
    }
    h.stop();
    return 0;
  }
  if (cmd === 'release') {
    const id = o.rest[0];
    if (!id || !ID.test(id)) throw new Error('release needs the slot id acquire printed');
    const had = await (d.mailbox ?? fileMailbox(dir)).release(id);
    d.say(had ? `released ${id}` : `${id} was not held`);
    return 0;
  }
  if (cmd === 'status') {
    const a = d.mailbox ? await d.mailbox.arbiter(Date.now()) : arbiterNow(dir, Date.now());
    if (!a) {
      process.stdout.write(d.mailbox ? `no slot arbiter answers on this machine (${d.mailbox.where})\n` : `no slot arbiter on this machine (${arbiterFile(dir)} missing or stale)\n`);
      return 0;
    }
    const lines = [`Unity on ${a.machine ?? 'this machine'}: ${a.line} (as of ${a.at})`];
    for (const g of a.granted) lines.push(`  holds ${g.count}: "${g.label}" (${g.holder}) [${g.id}]`);
    for (const w of a.waiting) lines.push(`  waits for ${w.count}: "${w.label}" (${w.holder}) [${w.id}]: ${w.why}`);
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
  if (cmd === 'serve') {
    if (o.limit === undefined) throw new Error('serve needs --limit N');
    const cur = readJson<ArbiterFile>(arbiterFile(dir));
    if (cur && Date.now() - Date.parse(cur.at) <= ARBITER_FRESH_MS && cur.pid !== process.pid && isAlive(cur.pid)) throw new Error(`an arbiter (pid ${cur.pid}) already serves ${dir}; give another --dir`);
    const { realDeps } = await import('./unity.ts');
    const platform: UnityPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';
    const procs = realDeps(platform).procs;
    const limit = o.limit;
    const slots = new UnitySlots({
      dir,
      platform,
      procs,
      alive: isAlive,
      now: () => Date.now(),
      limit: () => limit,
      places: () => [],
      ramPct: () => Math.round((100 * (os.totalmem() - os.freemem())) / os.totalmem()),
      log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
      onEvent: (text) => process.stdout.write(`${new Date().toISOString()} EVENT ${text}\n`),
    });
    d.say(`serving ${dir} with a limit of ${limit}`);
    const until = o.forMs === undefined ? Infinity : Date.now() + o.forMs;
    while (Date.now() < until) {
      const a = await slots.tick();
      process.stdout.write(`${new Date().toISOString()} ${slots.line()}${a.waiting.length ? ` | waiting: ${a.waiting.map((w) => w.id).join(', ')}` : ''}\n`);
      await d.sleep(3000);
    }
    return 0;
  }
  process.stdout.write(`${USAGE}\n`);
  return cmd === 'help' || cmd === '--help' ? 0 : 2;
}

/** A detached run's job id (w4740). */
export const JOB_ID = /^[0-9a-z]{6,12}-j-[0-9a-f]{6}$/;
const jobsDir = (dir: string) => path.join(dir, 'jobs');
export const jobFile = (dir: string, id: string) => path.join(jobsDir(dir), `job-${id}.json`);
export const jobExitFile = (dir: string, id: string) => path.join(jobsDir(dir), `job-${id}.exit.json`);

interface JobFile {
  id: string;
  pid: number;
  label: string;
  log: string;
  session?: string;
  started: string;
}

/**
 * w4740 (r290, w4488 on LothDesktop, 2026-11-17): a build started as `unity-slot run` in a background task queued 1 h 50 min
 * for a slot and was killed with its task at Claude Code's 2 h limit, 10 min into the build: the queue's time counts
 * toward the task's. `run --detach` runs the same `run` in a process of its own (its own session or process group, not the
 * task's), its output in a log, and returns at once with the job id; `unity-slot wait <id>`, in a background task, follows
 * the log and exits with the command's code, and is simply run again if that task is cut off. The job keeps the worker's
 * environment (FF_SESSION_ID), so the session's leftovers sweep still ends it when the worker is done (machine/leftovers.ts).
 */
function startDetached(argv: string[], o: CliOpts, dir: string, env: NodeJS.ProcessEnv, say: (l: string) => void): number {
  const id = `${Date.now().toString(36)}-j-${randomBytes(3).toString('hex')}`;
  const log = o.log ?? path.join(env.TMPDIR || env.TEMP || os.tmpdir(), `unity-slot-${id}.log`);
  fs.mkdirSync(jobsDir(dir), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // The same arguments without --detach (only before the command's --: the command's own are its own).
  const sep = argv.indexOf('--');
  const args = argv.filter((a, i) => !(a === '--detach' && (sep < 0 || i < sep)));
  const fd = fs.openSync(log, 'a');
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [...process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), import.meta.filename, ...args], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...env, FF_UNITY_SLOT_JOB: id, FF_UNITY_SLOTS: dir },
    });
    child.unref();
    pid = child.pid;
  } finally {
    fs.closeSync(fd);
  }
  if (!pid) throw new Error('run --detach: the job did not start');
  const f: JobFile = { id, pid, label: labelOf(o), log, ...(env.FF_SESSION_ID ? { session: env.FF_SESSION_ID } : {}), started: new Date().toISOString() };
  writeAtomic(jobFile(dir, id), JSON.stringify(f));
  process.stdout.write(`${id}\n`);
  say(`started as job ${id} (pid ${pid}), apart from this call: it waits for its slot and runs on its own, output in ${log}. Wait for it with \`unity-slot wait ${id}\` (a background task; run it again if that is cut off).`);
  return 0;
}

/** How much of a long log `unity-slot wait` shows first: the end of it, not a whole build log again on every re-run. */
const WAIT_TAIL_BYTES = 16 * 1024;

/** w4740: follow a detached run's log and return its command's exit code (1 when its job ended without one). */
async function waitJob(dir: string, id: string | undefined, sleep: (ms: number) => Promise<void>): Promise<number> {
  if (!id || !JOB_ID.test(id)) throw new Error('wait needs the job id run --detach printed');
  const f = readJson<JobFile>(jobFile(dir, id));
  if (!f) throw new Error(`no detached run ${id} here (${jobsDir(dir)})`);
  let pos = 0;
  try {
    const size = fs.statSync(f.log).size;
    if (size > WAIT_TAIL_BYTES) {
      pos = size - WAIT_TAIL_BYTES;
      process.stdout.write(`[unity-slot wait: the log's last ${WAIT_TAIL_BYTES / 1024} KB; all of it is in ${f.log}]\n`);
    }
  } catch {
    /* not written yet */
  }
  const follow = () => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(f.log, 'r');
      const buf = Buffer.alloc(64 * 1024);
      for (let n; (n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0; pos += n) process.stdout.write(buf.subarray(0, n));
    } catch {
      /* not written yet */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  for (let gone = 0; ; ) {
    follow();
    const exit = readJson<{ code: number }>(jobExitFile(dir, id));
    if (exit) {
      follow();
      process.stderr.write(`[unity-slot] job ${id} (${f.label}) ended: exit ${exit.code}\n`);
      return exit.code;
    }
    // Ended with no word (killed hard, the machine restarted): a second look first, the exit file may be on its way.
    if (!isAlive(f.pid) && ++gone >= 2) {
      process.stderr.write(`[unity-slot] job ${id} (${f.label}, pid ${f.pid}) is gone without an exit code: it was killed (the session's leftovers sweep, a restart). The end of its log is above.\n`);
      return 1;
    }
    await sleep(2000);
  }
}

/** Whether a process is alive (EPERM: it is, someone else's). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The `unity-slot` commands the daemon puts first on its agents' PATH (a sh script for Git Bash and macOS, a .cmd for
 * cmd and PowerShell), running this file with the daemon's own node.
 */
export function shimScripts(node: string, nodeArgs: string[], script: string): { sh: string; cmd: string } {
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const q = (s: string) => `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
  return {
    sh: `#!/bin/sh\n# FF Factory: Unity slots (docs/unity-lifecycle.md). Written by the machine daemon at start.\nexec ${[fwd(node), ...nodeArgs, fwd(script)].map(q).join(' ')} "$@"\n`,
    cmd: `@echo off\r\nrem FF Factory: Unity slots (docs/unity-lifecycle.md). Written by the machine daemon at start.\r\n${[node, ...nodeArgs, script].map((s) => `"${s}"`).join(' ')} %*\r\n`,
  };
}

/** Write the shims into <dir>/bin; returns that folder. */
export function installShims(dir: string, node = process.execPath, nodeArgs = process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), script = import.meta.filename): string {
  return writeShims(path.join(dir, 'bin'), node, nodeArgs, script);
}

/** Write the shims into `bin` itself (w5838: `<root>/tools/shims` on Windows, a folder Low workers cannot write); returns it. */
export function writeShims(bin: string, node = process.execPath, nodeArgs = process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), script = import.meta.filename): string {
  fs.mkdirSync(bin, { recursive: true });
  const s = shimScripts(node, nodeArgs, script);
  writeAtomic(path.join(bin, 'unity-slot'), s.sh);
  fs.chmodSync(path.join(bin, 'unity-slot'), 0o755);
  writeAtomic(path.join(bin, 'unity-slot.cmd'), s.cmd);
  return bin;
}

// Run when started directly (the shim, or node machine/unitySlots.ts ...).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`unity-slot: ${(e as Error).message}\n`);
      process.exit(e instanceof SlotRefused ? 3 : 2);
    },
  );
}
