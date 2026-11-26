// CI jobs go first on a Windows CI-first machine (w6110). LothDesktop runs two of Final-Factory/ffu's self-hosted runners
// (ffu-lothdesktop-1 and -2: hashcheck, clippy and the test suite) beside FF Factory's agents and their cargo builds, test
// loops and players. On 2026-11-26 from 12:54 to 14:53 UTC one worker (w6066) ran CPU hogs of 64, 96, 16 and 48 busy loops
// on this 16-thread machine to load a failover test, and the runners' steps ran 10 to 25 times slower: a crosscheck step
// of 1-4 min took 56 min (13:14-14:10) and was cancelled at its timeout, clippy's build of 6.5 min took 50 min (13:29-14:19),
// a checkout 13 min. The runners run at Normal priority, and so did the hog: Windows shared the CPU by thread count, 96 to
// the job's handful.
//
// machine/ciFirst.ts does the same for biscuit on Linux (w5322) with systemd scopes and nice. Windows has neither; it has
// priority classes, and a process started by one at BelowNormal or Idle inherits it. So while a CI job runs, once a minute
// (WinCiFirst.tick), each agent host's processes (its claude, and the shells, builds and players claude starts) are found
// by walking down from the host's own process: the walk never enters the host itself (its heartbeat keeps its priority),
// another host, the daemon or a runner's tree, and it keeps a child only when its parent started before it (Windows reuses
// pids and never reparents an orphan, so a parent pid alone can name an unrelated process; leftovers.ts does the same).
// Editors the daemon starts are not under a host (Start-Process) and count as the rest (the pool's belowNormal setting,
// machine/sandboxes.ts, runs them BelowNormal where it is on); batch builds go to Idle (lowerBuild).
//
// daemon.json `winCiFirst` picks what it does (read at the daemon's start; `ops_worker machine_update win_ci_first`):
// - "warn" (unset): nothing is set. While a CI job runs the tick logs how many cores the machine, the jobs and each
//   agent's processes used over the last tick, and how many of the agents' tools' processes run above `priority`.
// - "enforce": while a CI job runs, those processes go to `priority` (Idle), and what they start inherits it. Only
//   an agent's tools are lowered (what its claude starts: shells, cargo, python): the host and its direct children
//   (claude) keep their priority, so the agent's loop, its heartbeat and the hang watch's CPU reading are not starved
//   (and Windows' balance-set manager still boosts a starved thread now and then). No Unity editor, or what one started,
//   is lowered. Nothing is lowered while a bench or a person's turn holds the machine, and what was lowered is raised
//   back then, so a timed run measures what it always did; it is raised back too once no CI job runs. Each lowered
//   process is kept with its old priority in <root>/tmp/ci-first-lowered.json, so a daemon started with "warn" or "off"
//   raises what is still running (and what it started since, still at the lowered priority) back: that is the recovery,
//   and it needs nobody at the machine.
// - "off": nothing is read or logged, beyond raising back what that record holds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunnerCensus } from './benchRunners.ts';
import type { Proc } from './unity.ts';
import { sameRoot as sameRootOn } from './leftovers.ts';

export interface WinCiFirstSettings {
  /** The os.setPriority value agents' processes go to (os.constants.priority: BELOW_NORMAL 10, LOW 19 is the idle class). */
  priority: number;
  /** While a CI job runs, the CPU is logged when the agents' processes used at least this many cores over a tick. */
  warnCores: number;
  /** ...at most once per this many ms (a job start or end is always logged). */
  warnEveryMs: number;
}

// Idle, not BelowNormal: LothDesktop's runners run their jobs at BelowNormal themselves (the daemon restarts a runner
// with Start-ScheduledTask, whose default task priority 7 is BelowNormal, and a job's processes inherit it; measured
// 2026-11-26 17:46Z, both workers at BelowNormal). BelowNormal would only put the agents' tools level with the jobs. Since
// w6163 machine/runnerPriority.ts raises LothDesktop's runners to Normal; Idle keeps the tools below the jobs either way.
export const LOTHDESKTOP_CI_FIRST: WinCiFirstSettings = {
  priority: os.constants.priority.PRIORITY_LOW,
  warnCores: 4,
  warnEveryMs: 5 * 60_000,
};

/** The Windows machines whose CI jobs go ahead of FF Factory's agents, by machine id. */
export const WIN_CI_FIRST: Record<string, WinCiFirstSettings> = { lothdesktop: LOTHDESKTOP_CI_FIRST };

export type WinProc = Proc;

export type WinCiFirstMode = 'off' | 'warn' | 'enforce';

/**
 * What enforcing lowered, by `pid@start`: the priority it had, when it was lowered, its host's pid, and when it was raised
 * back (kept one more raise, for what it started in the seconds before that, which the listing could not show yet).
 */
export type Lowered = Record<string, { prev: number; at: number; host?: number; raisedAt?: number }>;

export interface ProcFact {
  pid: number;
  startedAt?: number;
  cpuMs?: number;
}

export interface WinCiFirstDeps {
  settings?: WinCiFirstSettings;
  procs: () => Promise<WinProc[]>;
  /** The runners and their jobs in that listing. */
  census: (procs: WinProc[]) => RunnerCensus;
  /** The agent hosts running now: their session, the host process's pid and when the host said it started. */
  hosts: () => { session: string; pid: number; startedAt?: number }[];
  /** How old a process listing can be when it is answered (LIST_MAX_AGE_MS). */
  listMaxAgeMs?: number;
  priorityOf: (pid: number) => number | undefined;
  /** Start time and CPU so far of these processes (machine/unityReaper.ts inspectProcs); a process gone is left out. */
  facts: (pids: number[]) => Promise<ProcFact[]>;
  /** The whole machine's busy CPU so far, all cores (machineBusyMs). */
  machineBusyMs: () => number;
  /** The daemon's own pid. */
  self: number;
  /** daemon.json `winCiFirst`; unset is "warn". */
  mode?: WinCiFirstMode;
  /** A bench or a person's turn holds this machine now (machine/benchTurn.ts's holder). */
  held?: () => boolean;
  /** os.setPriority; false when it could not. Without it, or without `record`, nothing is lowered. */
  setPriority?: (pid: number, priority: number) => boolean;
  /** The record of what was lowered (<root>/tmp/ci-first-lowered.json). */
  record?: { read: () => Lowered; write: (l: Lowered) => void };
  /**
   * w6217: FF_SESSION_ID and FF_WORKER_ROOT of these processes, where Windows lets them be read (machine/leftovers.ts
   * readEnvs; a process that shows none is left out), and `ci` for one whose environment holds GITHUB_ACTIONS or
   * RUNNER_TRACKING_ID (a CI runner's or job's, whatever FF variables it also carries). Without it no orphaned tool is
   * looked for.
   */
  envOf?: (pids: number[]) => Promise<Map<number, { session?: string; root?: string; ci?: boolean }>>;
  /** This daemon's worker root (FF_WORKER_ROOT of its workers' processes): an orphan of another root's worker is not ours. */
  root?: string;
  now: () => number;
  log: (line: string) => void;
}

export interface WinCiFirstResult {
  jobs: number;
  /** Agents' tools' processes above the setting's priority (before this tick lowered any). */
  above: number;
  /** w6217: of `above`, agents' tools whose tree lost its link to the host (lowered with the rest when enforcing). */
  orphans?: number;
  /** Processes this tick lowered, and raised back. */
  lowered?: number;
  raised?: number;
  /** Cores over the last tick, while the same jobs ran and both ticks were read. */
  machineCores?: number;
  jobCores?: number;
  agentCores?: Record<string, number>;
  windowMs?: number;
}

/** Busy CPU ms of every core so far (os.cpus: user, nice, sys; idle left out; on Windows sys already holds irq). */
export function machineBusyMs(platform: NodeJS.Platform = process.platform): number {
  return os.cpus().reduce((a, c) => a + c.times.user + c.times.nice + c.times.sys + (platform === 'win32' ? 0 : c.times.irq), 0);
}

/** os.getPriority's Windows values (libuv maps the priority classes to these). */
export function priorityName(p: number | undefined): string {
  const P = os.constants.priority;
  if (p === undefined) return '?';
  if (p >= P.PRIORITY_LOW) return 'Idle';
  if (p >= P.PRIORITY_BELOW_NORMAL) return 'BelowNormal';
  if (p >= P.PRIORITY_NORMAL) return 'Normal';
  if (p >= P.PRIORITY_ABOVE_NORMAL) return 'AboveNormal';
  if (p >= P.PRIORITY_HIGH) return 'High';
  return 'Realtime';
}

/** w6217: what envSeen holds for a CI runner's or job's process. */
const CI_ENV = '\0ci';
/** w6217: ticks a failed environment read waits before it is tried again. */
export const ENV_RETRY_TICKS = 5;

const keyOf = (f: ProcFact) => `${f.pid}@${f.startedAt ?? ''}`;

/**
 * Whether a process's FF_WORKER_ROOT is this daemon's root (as machine/leftovers.ts sameRoot on Windows: no case, either
 * slash; either unknown counts as the same).
 */
export function sameRoot(theirs: string | undefined, mine: string | undefined): boolean {
  return sameRootOn(theirs, mine, 'win32');
}

/**
 * CPU ms used between two readings by these processes: one read both times counts its difference, one new since the first
 * reading (started after `since`) counts in full; one that ended in between is lost (the machine's total still has it).
 */
export function cpuBetween(before: Map<string, number>, after: ProcFact[], since: number): number {
  let d = 0;
  for (const f of after) {
    if (f.cpuMs === undefined) continue;
    const b = before.get(keyOf(f));
    if (b !== undefined) d += Math.max(0, f.cpuMs - b);
    else if (f.startedAt !== undefined && f.startedAt >= since) d += f.cpuMs;
  }
  return d;
}

/**
 * Each root's processes, walking down by parent pid: never into a pid in `stop` (other hosts, the daemon, runners), and a
 * child only when the parent started no later than it (1 s slack, as leftovers.ts); a pid without a start time is not
 * walked into. The roots themselves are left out.
 */
export function agentTrees(roots: number[], procs: Pick<Proc, 'pid' | 'ppid'>[], stop: Set<number>, started: Map<number, number>): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  for (const p of procs) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const seen = new Set<number>(roots);
  const out = new Map<number, number[]>();
  for (const root of roots) {
    const mine: number[] = [];
    const queue = [root];
    while (queue.length) {
      const parent = queue.shift()!;
      const ps = started.get(parent);
      for (const c of kids.get(parent) ?? []) {
        const cs = started.get(c);
        if (seen.has(c) || stop.has(c) || ps === undefined || cs === undefined || ps > cs + 1_000) continue;
        seen.add(c);
        mine.push(c);
        queue.push(c);
      }
    }
    out.set(root, mine);
  }
  return out;
}

export const loweredFile = (root: string) => path.join(root, 'tmp', 'ci-first-lowered.json');

/** The record of what enforcing lowered under this worker root ({} when there is none or it does not parse). */
export function readLowered(root: string): Lowered {
  try {
    const v = JSON.parse(fs.readFileSync(loweredFile(root), 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Lowered = {};
    for (const [k, l] of Object.entries(v as Record<string, unknown>)) {
      const r = l as { prev?: unknown; at?: unknown };
      const { host: h, raisedAt: ra } = l as { host?: unknown; raisedAt?: unknown };
      if (/^\d+@\d+$/.test(k) && typeof r?.prev === 'number' && typeof r?.at === 'number')
        out[k] = { prev: r.prev, at: r.at, ...(typeof h === 'number' ? { host: h } : {}), ...(typeof ra === 'number' ? { raisedAt: ra } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeLowered(root: string, l: Lowered) {
  const file = loweredFile(root);
  if (!Object.keys(l).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l));
  fs.renameSync(tmp, file);
}

const isUnity = (p: WinProc) => /^unity(\.exe)?$/i.test(p.name ?? '') || /(^|[\\/"])unity\.exe"?(\s|$)/i.test(p.cmd);
const imageOf = (p: WinProc | undefined) => p?.name || (p?.cmd ?? '?').trim().replace(/^"/, '').split(/["\s]/)[0].split(/[\\/]/).pop() || '?';
/** A process listing can be this old when it is answered (machine/sandboxes.ts realPoolDeps caches it for 5 s). */
export const LIST_MAX_AGE_MS = 5_000;
/** A raise that fails is tried again this many ticks, then dropped from the record with a line in the log. */
const RAISE_TRIES = 3;

export class WinCiFirst {
  private readonly d: WinCiFirstDeps;
  private jobKey = '';
  private last?: { at: number; since: number; busy: number; cpu: Map<string, number> };
  private warnedAt = 0;
  private listFailing = false;
  private factsFailing = false;
  private recordFailing = false;
  private ticking = false;
  /** A tick was asked for while one ran (a turn began or ended meanwhile): run once more when it ends. */
  private again = false;
  private heldSaid = false;
  private lowered: Lowered = {};
  private raiseFails = new Map<string, number>();
  /** Hosts with a tool at the lowered priority at the last enforcing tick beside a job. */
  private lowHosts = new Set<number>();
  /**
   * w6217: what each process's environment showed, by pid@start (it never changes): its FF_SESSION_ID ('' for none or
   * another root's), or CI_ENV for a runner's or a job's.
   */
  private envSeen = new Map<string, string>();
  private envFailing = false;
  /** w6217: ticks to skip the environment read after one failed (each read can hold a tick up to its 120 s timeout). */
  private envSkip = 0;
  /** w6217: orphaned tools already named in the log, by pid@start. */
  private orphansSaid = new Set<string>();

  constructor(d: WinCiFirstDeps) {
    this.d = d;
    try {
      this.lowered = d.record?.read() ?? {};
    } catch {
      this.lowered = {};
    }
  }

  get enabled(): boolean {
    return !!this.d.settings;
  }

  get mode(): WinCiFirstMode {
    return this.d.mode ?? 'warn';
  }

  /** What enforcing lowered and has not raised back yet. */
  loweredNow(): Lowered {
    return { ...this.lowered };
  }

  /**
   * Enforcing lowered some of this host's tools: their CPU then says little about whether its agent is hung (the hang
   * watch, machine/agentHost.ts watchProgress, keeps it and looks again).
   */
  toolsLowered(hostPid: number): boolean {
    return this.lowHosts.has(hostPid);
  }

  async tick(): Promise<WinCiFirstResult | undefined> {
    const s = this.d.settings;
    if (!s) return undefined;
    if (this.ticking) {
      this.again = true;
      return undefined;
    }
    this.ticking = true;
    try {
      let res = await this.step(s);
      while (this.again) {
        this.again = false;
        res = await this.step(s);
      }
      return res;
    } finally {
      this.ticking = false;
    }
  }

  private save(): boolean {
    try {
      this.d.record!.write(this.lowered);
      if (this.recordFailing) this.d.log('ci first: the record of lowered processes is written again');
      this.recordFailing = false;
      return true;
    } catch (e) {
      if (!this.recordFailing) this.d.log(`ci first: could not write the record of lowered processes: ${(e as Error).message.slice(0, 200)}`);
      this.recordFailing = true;
      return false;
    }
  }

  /**
   * Raise back each recorded process still running (the same pid and start time) to the priority it had, and what it
   * started since it was lowered that still runs at the lowered priority (it inherited it) to that same priority, whether
   * the recorded process still runs or not (Windows never gives an orphan a new parent). `cutoff`: a process started later
   * may not be the one the listing showed under that pid, and is left alone: so a raised entry is kept (raisedAt, the time
   * its raise was done) until a raise whose cutoff is past it has looked again, for what it started before raisedAt only
   * (after that the parent was back at its priority, and what it started then is not ours to raise).
   * What could not be raised stays recorded and is tried again, RAISE_TRIES ticks.
   */
  private async raise(procs: WinProc[], why: string, s: WinCiFirstSettings, cutoff: number): Promise<number> {
    const rec = Object.entries(this.lowered).map(([k, l]) => ({ k, pid: Number(k.split('@')[0]), start: Number(k.split('@')[1]), ...l }));
    if (!rec.length || !this.d.setPriority) return 0;
    const pids = [...new Set(rec.map((r) => r.pid))];
    const stop = new Set<number>([this.d.self, ...this.d.hosts().map((h) => h.pid)]);
    // by parent pid alone, from recorded pids that ended too (what they started runs on with their pid as its parent)
    const loose = agentTrees(pids, procs, stop, new Map([...procs.map((p) => p.pid), ...pids].map((p) => [p, 0])));
    const facts = await this.d.facts([...new Set([...pids, ...[...loose.values()].flat()])]);
    const byPid = new Map(facts.map((f) => [f.pid, f]));
    const started = new Map(facts.filter((f) => f.startedAt !== undefined).map((f) => [f.pid, f.startedAt!]));
    const kids = new Map<number, number[]>();
    for (const p of procs) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
    const recorded = new Set(rec.map((r) => r.k));
    const procOf = new Map(procs.map((p) => [p.pid, p]));
    const underUnity = (pid: number, top: number): boolean => {
      for (let p = procOf.get(pid), i = 0; p && p.pid !== top && i < 64; p = procOf.get(p.ppid), i++) if (isUnity(p)) return true;
      return false;
    };
    const done = new Set<number>();
    let n = 0;
    let failed = 0;
    let alive = 0;
    const keep: Lowered = {};
    // true: raised or nothing to raise; false: setPriority failed
    const up = (pid: number, to: number): boolean => {
      done.add(pid);
      if (this.d.priorityOf(pid) !== s.priority) return true;
      if (this.d.setPriority!(pid, to)) {
        n++;
        return true;
      }
      failed++;
      return false;
    };
    const entry = (r: (typeof rec)[number], raisedAt?: number) => ({ prev: r.prev, at: r.at, ...(r.host !== undefined ? { host: r.host } : {}), ...(raisedAt !== undefined ? { raisedAt } : {}) });
    const stamp: string[] = []; // raised here: raisedAt is the time the raise is done, set below
    for (const r of rec) {
      const now = byPid.get(r.pid)?.startedAt;
      const same = now === r.start;
      let failedHere = false;
      if (same) {
        alive++;
        if (r.raisedAt === undefined && !done.has(r.pid) && !up(r.pid, r.prev)) {
          failedHere = true;
          const tries = (this.raiseFails.get(r.k) ?? 0) + 1;
          this.raiseFails.set(r.k, tries);
          if (tries < RAISE_TRIES) keep[r.k] = entry(r);
          else this.d.log(`ci first: gave up raising process ${r.pid} back after ${tries} tries; it stays at ${priorityName(s.priority)} until it ends`);
        }
      }
      // raised now (or ended): looked at once more by a raise whose cutoff is past this one
      if (!failedHere && r.raisedAt === undefined) stamp.push(r.k);
      else if (!failedHere && cutoff <= r.raisedAt!) keep[r.k] = entry(r, r.raisedAt);
      const until = Math.min(cutoff, r.raisedAt ?? Infinity);
      // What it started since it was lowered: started after r.at and before its pid's new holder (when another has it).
      const firsts = (kids.get(r.pid) ?? []).filter((c) => {
        const cs = started.get(c);
        if (cs === undefined || done.has(c) || stop.has(c) || cs > until || cs + 1_000 < Math.max(r.at, r.start)) return false;
        return same || now === undefined || cs < now;
      });
      const below = agentTrees(firsts, procs, stop, started);
      for (const c of [...firsts, ...firsts.flatMap((x) => below.get(x) ?? [])]) {
        const f = byPid.get(c);
        if (done.has(c) || !f || recorded.has(keyOf(f)) || (f.startedAt ?? Infinity) > cutoff) continue;
        // A Unity editor or batch run, and what it started, is never ours (never lowered): the bench turn's lowerBuild puts
        // batch runs at Idle during a person's turn, and raising them here would undo that.
        if (underUnity(c, r.pid)) continue;
        up(c, r.prev);
      }
    }
    const raisedAt = this.d.now();
    for (const r of rec) if (stamp.includes(r.k)) keep[r.k] = entry(r, raisedAt);
    for (const k of [...this.raiseFails.keys()]) if (!keep[k] || keep[k].raisedAt !== undefined) this.raiseFails.delete(k);
    this.lowered = keep;
    this.save();
    const fresh = rec.filter((r) => r.raisedAt === undefined).length;
    if (n || failed || fresh)
      this.d.log(
        `ci first: raised ${n} process(es) back to the priority they had (${why}; ${fresh} were recorded as lowered, ${alive} of the recorded still run${failed ? `, ${failed} could not be raised` : ''})`,
      );
    return n;
  }

  /**
   * w6217: agents' tools that the walk from the hosts cannot reach, because a process between them and their host ended
   * before a tick saw it (Windows never gives an orphan a new parent). On 2026-11-26 from 21:54 UTC a `cargo test` under
   * a `bash /tmp/bugchecks.sh` whose starter had ended stayed at Normal beside two CI jobs for at least 9 minutes.
   * An orphan root is a listed process outside every known tree (`fence`: the agents', the jobs', hosts, the daemon, the
   * listeners) whose parent is gone or started after it. Each orphan tree is walked as the hosts' are; a process in it
   * whose environment holds FF_SESSION_ID of a host running now, under this daemon's root, is that host's tool, and so is
   * what is below it (a Git Bash shell shows no environment to the reader, the cargo it starts does). Never a tool:
   * - a Unity process, or what one started;
   * - a CI runner's or job's process (GITHUB_ACTIONS or RUNNER_TRACKING_ID in its environment: a job step's orphan carries
   *   the runner's environment, and so whatever FF_SESSION_ID a runner started from a worker's shell inherited), what it
   *   started, or what is above it;
   * - a process above a fenced one (a listener, a job, a host): the `cmd.exe /c run.cmd` an agent's shell left, which
   *   starts the listener again after a runner update, would hand it the lowered priority (w6222 review).
   * Each process's environment is read once (cached by pid@start); a failed read is tried again after ENV_RETRY_TICKS
   * ticks, and a tree with a member not read is left alone meanwhile.
   * Returns pid -> its host, and how many roots and processes the orphan trees held.
   */
  private async orphanTools(
    procs: WinProc[],
    fence: Set<number>,
    started: Map<number, number>,
    hosts: { session: string; pid: number }[],
  ): Promise<{ tools: Map<number, number>; roots: number; members: number }> {
    const out = new Map<number, number>();
    if (!this.d.envOf || !hosts.length) return { tools: out, roots: 0, members: 0 };
    const hostOf = new Map(hosts.map((h) => [h.session, h.pid]));
    const procOf = new Map(procs.map((p) => [p.pid, p]));
    const roots = procs
      .filter((p) => {
        const st = started.get(p.pid);
        if (p.pid <= 4 || p.pid === p.ppid || fence.has(p.pid) || st === undefined) return false;
        if (!procOf.has(p.ppid)) return true;
        const ps = started.get(p.ppid);
        return ps !== undefined && ps > st + 1_000;
      })
      .map((p) => p.pid);
    const trees = agentTrees(roots, procs, fence, started);
    const key = (pid: number) => `${pid}@${started.get(pid)}`;
    const members = roots.flatMap((r) => [r, ...(trees.get(r) ?? [])]);
    const unread = members.filter((pid) => !this.envSeen.has(key(pid)));
    if (unread.length && this.envSkip > 0) this.envSkip--;
    else if (unread.length) {
      try {
        const env = await this.d.envOf(unread);
        for (const pid of unread) {
          const e = env.get(pid);
          this.envSeen.set(key(pid), e?.ci ? CI_ENV : e?.session && sameRoot(e.root, this.d.root) ? e.session : '');
        }
        if (this.envFailing) this.d.log("ci first: the processes' environments read again");
        this.envFailing = false;
      } catch (e) {
        if (!this.envFailing) this.d.log(`ci first: could not read the processes' environments (tried again every ${ENV_RETRY_TICKS + 1} ticks): ${(e as Error).message.slice(0, 200)}`);
        this.envFailing = true;
        this.envSkip = ENV_RETRY_TICKS;
      }
    }
    // what is no longer listed is forgotten
    const live = new Set(procs.filter((p) => started.has(p.pid)).map((p) => key(p.pid)));
    for (const k of [...this.envSeen.keys()]) if (!live.has(k)) this.envSeen.delete(k);
    // A member with a fenced process (a listener, a job, a host) or a CI process below it is never a tool, nor is what is
    // above it in its tree.
    const memberSet = new Set(members);
    const blocked = new Set<number>();
    const block = (pid: number) => {
      for (let x: number | undefined = pid; x !== undefined && memberSet.has(x) && !blocked.has(x); x = procOf.get(x)?.ppid) blocked.add(x);
    };
    for (const p of procs) {
      const ps = started.get(p.ppid);
      const st = started.get(p.pid);
      if (fence.has(p.pid) && memberSet.has(p.ppid) && ps !== undefined && st !== undefined && ps <= st + 1_000) block(p.ppid);
    }
    for (const pid of members) if (this.envSeen.get(key(pid)) === CI_ENV) block(pid);
    for (const root of roots) {
      const tree = [root, ...(trees.get(root) ?? [])];
      if (tree.some((pid) => !this.envSeen.has(key(pid)))) continue;
      // each member after its parent (agentTrees walks breadth first): it is a host's when it or a process above it is
      const mark = new Map<number, number | 'no' | undefined>();
      for (const pid of tree) {
        const p = procOf.get(pid)!;
        const above = pid === root ? undefined : mark.get(p.ppid);
        if (above === 'no' || isUnity(p) || this.envSeen.get(key(pid)) === CI_ENV) {
          mark.set(pid, 'no');
          continue;
        }
        const own = hostOf.get(this.envSeen.get(key(pid)) || '\0');
        const host = own ?? above;
        mark.set(pid, host);
        if (host !== undefined && !blocked.has(pid)) out.set(pid, host);
      }
    }
    return { tools: out, roots: roots.length, members: members.length };
  }

  private async step(s: WinCiFirstSettings): Promise<WinCiFirstResult | undefined> {
    const asked = this.d.now();
    // A process started after this cannot be the one the listing showed under its pid (Windows reuses pids).
    const cutoff = asked - (this.d.listMaxAgeMs ?? LIST_MAX_AGE_MS) - 1_000;
    let procs: WinProc[];
    try {
      procs = await this.d.procs();
      if (this.listFailing) this.d.log('ci first: the process listing answers again');
      this.listFailing = false;
    } catch (e) {
      // Under the load this is for, the listing itself can fail (2026-11-26 13:00-14:30Z): said once per streak.
      if (!this.listFailing) this.d.log(`ci first: could not list processes: ${(e as Error).message.slice(0, 200)}`);
      this.listFailing = true;
      this.last = undefined;
      return undefined;
    }
    // Enforce only with a record to undo it from.
    const enforcing = this.mode === 'enforce' && !!this.d.setPriority && !!this.d.record;
    const isHeld = () => enforcing && (this.d.held?.() ?? false);
    const held = isHeld();
    if (enforcing && held !== this.heldSaid) {
      this.d.log(
        held
          ? "ci first: a bench or a person's turn holds this machine: what was lowered is raised back, and nothing is lowered until the turn ends"
          : "ci first: the turn holding this machine ended: the agents' tools go below CI jobs again",
      );
      this.heldSaid = held;
    }
    const census = this.d.census(procs);
    const raiseIf = async (why: string) => {
      if (!Object.keys(this.lowered).length) return 0;
      try {
        return await this.raise(procs, why, s, cutoff);
      } catch (e) {
        this.d.log(`ci first: could not raise the lowered processes back yet (${why}): ${(e as Error).message.slice(0, 200)}`);
        return 0;
      }
    };
    let raised = 0;
    if (!enforcing) raised = await raiseIf(`winCiFirst is ${this.mode}`);
    else if (held) raised = await raiseIf("a bench or a person's turn holds this machine");
    else if (!census.workers.length) raised = await raiseIf('no CI job runs now');
    // nothing lowered now beside a job (kept as it was while a read is slow or fails: the hang watch reads it meanwhile)
    if (!enforcing || held || !census.workers.length) this.lowHosts = new Set();
    if (this.mode === 'off') return { jobs: 0, above: 0, raised };

    const key = census.workers
      .map((w) => w.pid)
      .sort((a, b) => a - b)
      .join(',');
    const changed = key !== this.jobKey;
    if (!census.workers.length) {
      if (changed) this.d.log('ci first: no CI job running now');
      this.jobKey = key;
      this.last = undefined;
      return { jobs: 0, above: 0, raised };
    }
    // A CI job runs. Read the start time and CPU of everything that could be the jobs' or an agent's (by parent pid alone),
    // then walk both again by start time: a child only when its parent started no later than it.
    const hosts = this.d.hosts();
    const listeners = census.listeners.map((l) => l.pid);
    const workers = census.workers.map((w) => w.pid);
    const looseJob = agentTrees(workers, procs, new Set([this.d.self]), new Map(procs.map((p) => [p.pid, 0])));
    const looseAgents = agentTrees(
      hosts.map((h) => h.pid),
      procs,
      new Set([this.d.self, ...listeners, ...workers]),
      new Map(procs.map((p) => [p.pid, 0])),
    );
    const recordedPids = Object.keys(this.lowered).map((k) => Number(k.split('@')[0]));
    // w6217: with an environment reader, every listed process (an orphan is found by its start; above 64 pids the facts
    // read is one unfiltered query either way, machine/unityReaper.ts inspectProcs)
    const want = [
      ...new Set([...hosts.map((h) => h.pid), ...workers, ...[...looseJob.values(), ...looseAgents.values()].flat(), ...recordedPids, ...(this.d.envOf ? procs.map((p) => p.pid) : [])]),
    ];
    let facts: ProcFact[];
    const readAt = this.d.now();
    try {
      facts = await this.d.facts(want);
      if (this.factsFailing) this.d.log("ci first: the processes' start times and CPU read again");
      this.factsFailing = false;
    } catch (e) {
      if (!this.factsFailing) this.d.log(`ci first: could not read the processes' start times and CPU: ${(e as Error).message.slice(0, 200)}`);
      this.factsFailing = true;
      this.last = undefined;
      return { jobs: census.workers.length, above: 0, raised };
    }
    const now = this.d.now();
    const busy = this.d.machineBusyMs();
    const byPid = new Map(facts.map((f) => [f.pid, f]));
    const started = new Map(facts.filter((f) => f.startedAt !== undefined).map((f) => [f.pid, f.startedAt!]));
    // The jobs: each worker and what it started (an adopted host, whose old parent pid a job's process got again, started
    // before that process and is not walked into).
    // A host's pid that Windows gave to another process (one that started after the host said it did, or a runner's) is
    // no host: the job walk goes into it, and nothing below it is lowered as an agent's.
    const hostOk = (h: { pid: number; startedAt?: number }) => {
      const st = started.get(h.pid);
      return h.startedAt === undefined || st === undefined || st <= h.startedAt + 5_000;
    };
    const likely = hosts.filter(hostOk).map((h) => h.pid);
    const jobPids = new Set<number>([...workers, ...[...agentTrees(workers, procs, new Set([this.d.self, ...likely]), started).values()].flat()]);
    const real = hosts.filter((h) => hostOk(h) && !jobPids.has(h.pid) && !listeners.includes(h.pid));
    const roots = real.map((h) => h.pid);
    const stop = new Set<number>([...hosts.map((h) => h.pid), this.d.self, ...jobPids, ...listeners]);
    const trees = agentTrees(roots, procs, stop, started);
    const procOf = new Map(procs.map((p) => [p.pid, p]));
    // What enforcing lowers: an agent's tools (what its claude starts), not the host or its own direct children (claude
    // keeps its priority, so its loop and heartbeat are not starved), and no Unity editor or what one started (editors keep
    // the pool's own priority; batch builds go to Idle by lowerBuild already). An editor a lowered tool starts later
    // inherits the lowered priority, as it inherits the pool's belowNormal setting.
    const tools = new Map<number, number>(); // pid -> its host
    for (const [root, pids] of trees) {
      const unity = new Set<number>();
      for (const pid of pids) {
        const p = procOf.get(pid);
        if (unity.has(p?.ppid ?? -1) || (p && isUnity(p))) unity.add(pid);
        else if (p && p.ppid !== root) tools.set(pid, root);
      }
    }
    // w6217: orphaned tools (their starter gone) are found by their session's environment and go with the rest
    const orphanFind = await this.orphanTools(procs, new Set([...stop, ...roots, ...[...trees.values()].flat()]), started, real);
    const orphaned = orphanFind.tools;
    const orphanAbove = [...orphaned.keys()].filter((pid) => {
      const p = this.d.priorityOf(pid);
      return p !== undefined && p < s.priority;
    });
    for (const [pid, host] of orphaned) tools.set(pid, host);
    let above = 0;
    const loweredNow: { k: string; pid: number; prev: number }[] = [];
    let lowerFailed = 0;
    const low = new Set<number>(); // hosts with a tool at the lowered priority now
    const lowering = enforcing && !held && !isHeld(); // a turn that began during the read is honoured now
    const cands: { k: string; pid: number; prev: number; host: number }[] = [];
    for (const [pid, host] of tools) {
      const p = this.d.priorityOf(pid);
      if (p === s.priority && lowering) low.add(host);
      if (p === undefined || p >= s.priority) continue;
      above++;
      const f = byPid.get(pid);
      if (!lowering || f?.startedAt === undefined || f.startedAt > cutoff) continue;
      cands.push({ k: keyOf(f), pid, prev: p, host });
    }
    // No record, no undo after a restart: what is to be lowered is written first, and nothing is lowered if it cannot be.
    let unwritten = false;
    const wasFailing = this.recordFailing;
    if (cands.length) {
      const before = this.lowered;
      this.lowered = { ...before };
      for (const c of cands) {
        const was = before[c.k];
        this.lowered[c.k] = { prev: was?.prev ?? c.prev, at: was?.at ?? now, host: c.host };
      }
      if (!this.save()) {
        this.lowered = before;
        unwritten = true;
      } else {
        for (const c of cands) {
          if (this.d.setPriority!(c.pid, s.priority)) {
            loweredNow.push(c);
            low.add(c.host);
          } else {
            lowerFailed++;
            if (!before[c.k]) delete this.lowered[c.k];
            else this.lowered[c.k] = before[c.k];
          }
        }
        if (lowerFailed) this.save();
      }
    }
    if (enforcing) this.lowHosts = low;
    if (unwritten) {
      if (!wasFailing) this.d.log(`ci first: lowered none of ${cands.length} process(es), since the record of what would be lowered could not be written`);
    } else if (loweredNow.length || lowerFailed) {
      const names = loweredNow.map((l) => `${l.pid} ${imageOf(procOf.get(l.pid))}`);
      this.d.log(
        `ci first: lowered ${loweredNow.length} of the agents' tools' process(es) to ${priorityName(s.priority)} beside the CI job(s), so the jobs go first (w6110)${lowerFailed ? `; ${lowerFailed} could not be lowered` : ''}${names.length ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''}` : ''}`,
      );
    }
    // An entry whose process had ended by the listing (not in it, nor running now) and left nothing it started (no listed
    // process has its pid as parent) is done: what it started after the listing, it started before the listing.
    if (enforcing) {
      const parents = new Set(procs.map((p) => p.ppid));
      let pruned = false;
      for (const k of Object.keys(this.lowered)) {
        const [pid, st] = k.split('@').map(Number);
        if (byPid.get(pid)?.startedAt !== st && !procOf.has(pid) && !parents.has(pid)) {
          delete this.lowered[k];
          pruned = true;
        }
      }
      if (pruned) this.save();
    }
    const sessionOf = new Map(real.map((h) => [h.pid, h.session]));
    const newly = orphanAbove.filter((pid) => !this.orphansSaid.has(keyOf(byPid.get(pid)!)));
    const liveKeys = new Set(facts.map(keyOf));
    for (const k of [...this.orphansSaid]) if (!liveKeys.has(k)) this.orphansSaid.delete(k);
    for (const pid of newly) this.orphansSaid.add(keyOf(byPid.get(pid)!));
    if (newly.length) {
      const lowSet = new Set(loweredNow.map((l) => l.pid));
      const names = newly.map((pid) => `${pid} ${imageOf(procOf.get(pid))} (${sessionOf.get(orphaned.get(pid)!) ?? '?'})${lowSet.has(pid) ? ' lowered' : ''}`);
      const what = !enforcing ? 'enforcing would lower them (warn only)' : held ? "not lowered while a bench or a person's turn holds this machine" : 'lowered with the rest';
      this.d.log(
        `ci first: ${newly.length} more of the agents' tools' process(es) run above ${priorityName(s.priority)} beside the CI job(s) with the process that started them gone, found by their session's environment (w6217; ${orphanFind.roots} orphan tree(s) of ${orphanFind.members} process(es) looked at); ${what}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''}`,
      );
    }
    const res: WinCiFirstResult = { jobs: census.workers.length, above, orphans: orphanAbove.length, lowered: loweredNow.length, raised };
    const jobFacts = [...jobPids].flatMap((p) => byPid.get(p) ?? []);
    const agentFacts = (root: number) => (trees.get(root) ?? []).flatMap((p) => byPid.get(p) ?? []);
    if (this.last && !changed && now > this.last.at) {
      const ms = now - this.last.at;
      res.windowMs = ms;
      res.machineCores = Math.max(0, busy - this.last.busy) / ms;
      res.jobCores = cpuBetween(this.last.cpu, jobFacts, this.last.since) / ms;
      res.agentCores = {};
      for (const h of real) res.agentCores[h.session] = cpuBetween(this.last.cpu, agentFacts(h.pid), this.last.since) / ms;
    }
    const cpu = new Map<string, number>();
    for (const f of [...jobFacts, ...roots.flatMap(agentFacts)]) if (f.cpuMs !== undefined) cpu.set(keyOf(f), f.cpuMs);
    // A process started after readAt is new to the next tick's window (counted in full there); readAt..now is in both.
    this.last = { at: now, since: readAt, busy, cpu };

    const sides = census.workers.map((w) => `${w.root.split('/').pop()} (worker ${w.pid} at ${priorityName(this.d.priorityOf(w.pid))})`).join(', ');
    const would =
      this.mode === 'enforce'
        ? held
          ? `none of their tools lowered while a bench or a person's turn holds this machine`
          : `${Object.keys(this.lowered).length} of their tools' process(es) lowered to ${priorityName(s.priority)} so far`
        : `${above} of their tools' process(es) run above ${priorityName(s.priority)}, which enforcing would lower (warn only, w6110)`;
    const orphanNote = orphanAbove.length ? `; ${orphanAbove.length} of them with the process that started them gone (w6217)` : '';
    if (changed) {
      this.d.log(`ci first: CI job(s) running: ${sides}; ${real.length} agent(s) beside them; ${would}${orphanNote}`);
      this.warnedAt = 0;
    }
    this.jobKey = key;
    const agents = res.agentCores ? Object.values(res.agentCores).reduce((a, b) => a + b, 0) : 0;
    if (res.agentCores && res.windowMs && agents >= s.warnCores && now - this.warnedAt >= s.warnEveryMs) {
      this.warnedAt = now;
      const top = Object.entries(res.agentCores)
        .filter(([, c]) => c >= 0.05)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([sess, c]) => `${sess} ${c.toFixed(1)}`)
        .join(', ');
      const rest = Math.max(0, (res.machineCores ?? 0) - (res.jobCores ?? 0) - agents);
      this.d.log(
        `ci first: over the last ${Math.round(res.windowMs / 1000)} s the machine used ${(res.machineCores ?? 0).toFixed(1)} of ${os.availableParallelism()} cores: the CI job(s) on ${sides} ${(res.jobCores ?? 0).toFixed(1)}, FF Factory's agents ${agents.toFixed(1)} (${top}), the rest ${rest.toFixed(1)}; ${would}${orphanNote}`,
      );
    }
    return res;
  }
}
