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
// This step is warn only (the lockout rule, w6110): nothing is set. The tick logs, while a CI job runs, how many cores
// the machine, the jobs and each agent's processes used over the last tick, and how many of the agents' processes run
// above `priority`, the evidence the enforcing step (a separate PR, with a daemon.json switch and an undo) rests on.
import os from 'node:os';
import type { RunnerCensus } from './benchRunners.ts';
import type { Proc } from './unity.ts';

export interface WinCiFirstSettings {
  /** The os.setPriority value agents' processes go to (os.constants.priority: BELOW_NORMAL 10, LOW 19 is the idle class). */
  priority: number;
  /** While a CI job runs, the CPU is logged when the agents' processes used at least this many cores over a tick. */
  warnCores: number;
  /** ...at most once per this many ms (a job start or end is always logged). */
  warnEveryMs: number;
}

export const LOTHDESKTOP_CI_FIRST: WinCiFirstSettings = {
  priority: os.constants.priority.PRIORITY_BELOW_NORMAL,
  warnCores: 4,
  warnEveryMs: 5 * 60_000,
};

/** The Windows machines whose CI jobs go ahead of FF Factory's agents, by machine id. */
export const WIN_CI_FIRST: Record<string, WinCiFirstSettings> = { lothdesktop: LOTHDESKTOP_CI_FIRST };

export type WinProc = Proc;

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
  /** The agent hosts running now: their session and the host process's pid. */
  hosts: () => { session: string; pid: number }[];
  priorityOf: (pid: number) => number | undefined;
  /** Start time and CPU so far of these processes (machine/unityReaper.ts inspectProcs); a process gone is left out. */
  facts: (pids: number[]) => Promise<ProcFact[]>;
  /** The whole machine's busy CPU so far, all cores (machineBusyMs). */
  machineBusyMs: () => number;
  /** The daemon's own pid. */
  self: number;
  now: () => number;
  log: (line: string) => void;
}

export interface WinCiFirstResult {
  jobs: number;
  /** Agents' processes above the setting's priority. */
  above: number;
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

const keyOf = (f: ProcFact) => `${f.pid}@${f.startedAt ?? ''}`;

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

export class WinCiFirst {
  private readonly d: WinCiFirstDeps;
  private jobKey = '';
  private last?: { at: number; since: number; busy: number; cpu: Map<string, number> };
  private warnedAt = 0;
  private listFailing = false;
  private factsFailing = false;
  private ticking = false;

  constructor(d: WinCiFirstDeps) {
    this.d = d;
  }

  get enabled(): boolean {
    return !!this.d.settings;
  }

  async tick(): Promise<WinCiFirstResult | undefined> {
    const s = this.d.settings;
    if (!s || this.ticking) return undefined;
    this.ticking = true;
    try {
      return await this.step(s);
    } finally {
      this.ticking = false;
    }
  }

  private async step(s: WinCiFirstSettings): Promise<WinCiFirstResult | undefined> {
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
    const census = this.d.census(procs);
    const key = census.workers
      .map((w) => w.pid)
      .sort((a, b) => a - b)
      .join(',');
    const changed = key !== this.jobKey;
    if (!census.workers.length) {
      if (changed) this.d.log('ci first: no CI job running now');
      this.jobKey = key;
      this.last = undefined;
      return { jobs: 0, above: 0 };
    }
    // A CI job runs. Its processes: each worker's tree by parent pid, never into an agent host or the daemon (an adopted
    // host's parent is the old daemon's pid, which a job's process can get again).
    const hosts = this.d.hosts();
    const roots = hosts.map((h) => h.pid);
    const notJob = new Set<number>([...roots, this.d.self]);
    const kids = new Map<number, number[]>();
    for (const p of procs) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
    const jobPids = new Set<number>();
    const queue = census.workers.map((w) => w.pid);
    while (queue.length) {
      const p = queue.shift()!;
      if (jobPids.has(p) || notJob.has(p)) continue;
      jobPids.add(p);
      queue.push(...(kids.get(p) ?? []));
    }
    const stop = new Set<number>([...roots, this.d.self, ...jobPids, ...census.listeners.map((l) => l.pid)]);
    // Everything that could be an agent's (by parent pid alone), read once for start times and CPU, then walked again by
    // start time.
    const loose = agentTrees(roots, procs, stop, new Map(procs.map((p) => [p.pid, 0])));
    const want = [...new Set([...roots, ...[...loose.values()].flat(), ...jobPids])];
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
      return { jobs: census.workers.length, above: 0 };
    }
    const now = this.d.now();
    const busy = this.d.machineBusyMs();
    const started = new Map(facts.filter((f) => f.startedAt !== undefined).map((f) => [f.pid, f.startedAt!]));
    const trees = agentTrees(roots, procs, stop, started);
    const byPid = new Map(facts.map((f) => [f.pid, f]));
    let above = 0;
    for (const pids of trees.values())
      for (const pid of pids) {
        const p = this.d.priorityOf(pid);
        if (p !== undefined && p < s.priority) above++;
      }
    const res: WinCiFirstResult = { jobs: census.workers.length, above };
    const jobFacts = [...jobPids].flatMap((p) => byPid.get(p) ?? []);
    const agentFacts = (root: number) => (trees.get(root) ?? []).flatMap((p) => byPid.get(p) ?? []);
    if (this.last && !changed && now > this.last.at) {
      const ms = now - this.last.at;
      res.windowMs = ms;
      res.machineCores = Math.max(0, busy - this.last.busy) / ms;
      res.jobCores = cpuBetween(this.last.cpu, jobFacts, this.last.since) / ms;
      res.agentCores = {};
      for (const h of hosts) res.agentCores[h.session] = cpuBetween(this.last.cpu, agentFacts(h.pid), this.last.since) / ms;
    }
    const cpu = new Map<string, number>();
    for (const f of [...jobFacts, ...roots.flatMap(agentFacts)]) if (f.cpuMs !== undefined) cpu.set(keyOf(f), f.cpuMs);
    // A process started after readAt is new to the next tick's window (counted in full there); readAt..now is in both.
    this.last = { at: now, since: readAt, busy, cpu };

    const sides = census.workers.map((w) => `${w.root.split('/').pop()} (worker ${w.pid} at ${priorityName(this.d.priorityOf(w.pid))})`).join(', ');
    const would = `${above} of their process(es) run above ${priorityName(s.priority)}, which enforcing would lower (warn only, w6110)`;
    if (changed) {
      this.d.log(`ci first: CI job(s) running: ${sides}; ${hosts.length} agent(s) beside them; ${would}`);
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
        `ci first: over the last ${Math.round(res.windowMs / 1000)} s the machine used ${(res.machineCores ?? 0).toFixed(1)} of ${os.availableParallelism()} cores: the CI job(s) on ${sides} ${(res.jobCores ?? 0).toFixed(1)}, FF Factory's agents ${agents.toFixed(1)} (${top}), the rest ${rest.toFixed(1)}; ${would}`,
      );
    }
    return res;
  }
}
