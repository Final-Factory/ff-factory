// CI jobs go first on a Windows CI-first machine (w6110). LothDesktop runs two of Final-Factory/ffu's self-hosted runners
// (ffu-lothdesktop-1 and -2: hashcheck, clippy and the test suite) beside FF Factory's agents and their cargo builds, test
// loops and players. On 2026-11-26 from 12:54 to 14:53 UTC one worker (w6066) ran CPU hogs of 64, 96, 16 and 48 busy loops
// on this 16-thread machine to load a failover test, and the runners' steps ran 10 to 25 times slower: a crosscheck step
// of 1-4 min took 56 min (13:14-14:10) and was cancelled at its timeout, clippy's build 6.5 min took 50 min (13:29-14:19),
// a checkout 13 min. The runners run at Normal priority, and so did the hog: Windows shared the CPU by thread count, 96 to
// the job's handful.
//
// machine/ciFirst.ts does the same for biscuit on Linux (w5322) with systemd scopes and nice. Windows has neither; it has
// priority classes, and a process started by one at BelowNormal or Idle inherits it (CreateProcess, "Scheduling
// Priorities"). So once a minute (WinCiFirst.tick) every process under each agent host's own process (its claude, and the
// shells, builds and players claude starts) at a higher priority than `priority` is set to it: the host process itself
// stays at its own priority, so its heartbeat and the daemon's link keep answering, and the daemon is never touched. A
// runner's tree is never touched either (it is not under an agent host). Nothing is raised back.
//
// warn only first (the lockout rule, w6110): with `enforce` false nothing is set; the tick logs, while a CI job runs, how
// many cores the jobs and each agent's tree used over the last tick and how many of the agents' processes enforcing
// would lower, the evidence today's slow jobs lacked (the daemon's log showed only its own process listing failing).
import os from 'node:os';
import type { RunnerCensus } from './benchRunners.ts';
import { treeOf } from './personPlay.ts';
import type { Proc } from './unity.ts';

export interface WinCiFirstSettings {
  /** The os.setPriority value agents' processes go to (os.constants.priority: BELOW_NORMAL 10, LOW 19 is the idle class). */
  priority: number;
  /** false: warn only, nothing is set (w6110's first step). */
  enforce: boolean;
  /** While a CI job runs, the agents' CPU is logged when their trees used at least this many cores over a tick. */
  warnCores: number;
  /** ...at most once per this many ms (a job start or end is always logged). */
  warnEveryMs: number;
}

export const LOTHDESKTOP_CI_FIRST: WinCiFirstSettings = {
  priority: os.constants.priority.PRIORITY_BELOW_NORMAL,
  enforce: false,
  warnCores: 4,
  warnEveryMs: 5 * 60_000,
};

/** The Windows machines whose CI jobs go ahead of FF Factory's agents, by machine id. */
export const WIN_CI_FIRST: Record<string, WinCiFirstSettings> = { lothdesktop: LOTHDESKTOP_CI_FIRST };

export type WinProc = Proc;

export interface WinCiFirstDeps {
  settings?: WinCiFirstSettings;
  procs: () => Promise<WinProc[]>;
  /** The runners and their jobs in that listing. */
  census: (procs: WinProc[]) => RunnerCensus;
  /** The agent hosts running now: their session and the host process's pid. */
  hosts: () => { session: string; pid: number }[];
  priorityOf: (pid: number) => number | undefined;
  setPriority: (pid: number, priority: number) => boolean;
  /** CPU so far of these processes, by `pid@start` (machine/unityReaper.ts inspectProcs); undefined when unreadable. */
  cpu: (pids: number[]) => Promise<Map<string, number> | undefined>;
  now: () => number;
  log: (line: string) => void;
}

export interface WinCiFirstResult {
  jobs: number;
  /** Agents' processes at a higher priority than the setting's (before this tick's lowering). */
  above: number;
  lowered: number;
  /** Cores over the last tick, while a job ran and both ticks were read. */
  jobCores?: number;
  agentCores?: Record<string, number>;
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

/** Cores over [t0, t1] from two CPU readings keyed pid@start: only processes in both count (a new one has no baseline). */
export function coresBetween(before: Map<string, number>, after: Map<string, number>, keys: (k: string) => boolean, ms: number): number {
  if (ms <= 0) return 0;
  let d = 0;
  for (const [k, v] of after) {
    const b = before.get(k);
    if (b !== undefined && keys(k) && v >= b) d += v - b;
  }
  return d / ms;
}

export class WinCiFirst {
  private readonly d: WinCiFirstDeps;
  private jobKey = '';
  private last?: { at: number; cpu: Map<string, number> };
  private warnedAt = 0;
  private failing = false;

  constructor(d: WinCiFirstDeps) {
    this.d = d;
  }

  get enabled(): boolean {
    return !!this.d.settings;
  }

  async tick(): Promise<WinCiFirstResult | undefined> {
    const s = this.d.settings;
    if (!s) return undefined;
    let procs: WinProc[];
    try {
      procs = await this.d.procs();
      if (this.failing) this.d.log('ci first: the process listing answers again');
      this.failing = false;
    } catch (e) {
      // Under the load this is for, the listing itself can fail (2026-11-26 13:18-14:22Z): said once per streak.
      if (!this.failing) this.d.log(`ci first: could not list processes: ${(e as Error).message.slice(0, 200)}`);
      this.failing = true;
      this.last = undefined;
      return undefined;
    }
    const census = this.d.census(procs);
    const runnerPids = new Set(census.workers.flatMap((w) => treeOf(w.pid, procs)));
    for (const l of census.listeners) runnerPids.add(l.pid);
    // Each host's tree without the host itself (its heartbeat stays at its own priority) and without anything of a runner's.
    const trees = this.d.hosts().map((h) => ({ session: h.session, pids: treeOf(h.pid, procs).slice(1).filter((p) => !runnerPids.has(p) && p !== process.pid) }));
    let above = 0;
    let lowered = 0;
    for (const t of trees) {
      for (const pid of t.pids) {
        const p = this.d.priorityOf(pid);
        if (p === undefined || p >= s.priority) continue;
        above++;
        if (s.enforce && this.d.setPriority(pid, s.priority)) lowered++;
      }
    }
    if (lowered) this.d.log(`ci first: lowered ${lowered} of the agents' process(es) to ${priorityName(s.priority)}, so CI jobs here go first (w6110)`);

    const res: WinCiFirstResult = { jobs: census.workers.length, above, lowered };
    const now = this.d.now();
    const key = census.workers.map((w) => w.pid).sort((a, b) => a - b).join(',');
    const changed = key !== this.jobKey;
    if (!census.workers.length) {
      if (changed && this.jobKey) this.d.log('ci first: no CI job running now');
      this.jobKey = key;
      this.last = undefined;
      return res;
    }
    // A CI job runs: read the CPU of its trees and of the agents' trees, and compare with the last tick.
    const jobPids = [...runnerPids];
    const all = [...new Set([...jobPids, ...trees.flatMap((t) => t.pids)])];
    let cpu: Map<string, number> | undefined;
    try {
      cpu = await this.d.cpu(all);
    } catch {
      cpu = undefined;
    }
    const pidOf = (k: string) => Number(k.split('@')[0]);
    if (cpu && this.last && !changed) {
      const ms = now - this.last.at;
      const jobSet = new Set(jobPids);
      res.jobCores = coresBetween(this.last.cpu, cpu, (k) => jobSet.has(pidOf(k)), ms);
      res.agentCores = {};
      for (const t of trees) {
        const set = new Set(t.pids);
        res.agentCores[t.session] = coresBetween(this.last.cpu, cpu, (k) => set.has(pidOf(k)), ms);
      }
    }
    this.last = cpu ? { at: now, cpu } : undefined;
    const sides = census.workers.map((w) => `${w.root.split('/').pop()} (worker ${w.pid} at ${priorityName(this.d.priorityOf(w.pid))})`).join(', ');
    const what = s.enforce ? '' : `; ${above} of their process(es) run above ${priorityName(s.priority)}, which enforcing would lower (warn only, w6110)`;
    if (changed) {
      this.d.log(`ci first: CI job(s) running: ${sides}; ${trees.length} agent(s) beside them${what}`);
      this.warnedAt = 0;
    }
    this.jobKey = key;
    const agentTotal = res.agentCores ? Object.values(res.agentCores).reduce((a, b) => a + b, 0) : 0;
    if (res.agentCores && agentTotal >= s.warnCores && now - this.warnedAt >= s.warnEveryMs) {
      this.warnedAt = now;
      const top = Object.entries(res.agentCores)
        .filter(([, c]) => c >= 0.05)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([sess, c]) => `${sess} ${c.toFixed(1)}`)
        .join(', ');
      this.d.log(`ci first: beside the CI job(s) on ${sides}, FF Factory's agents used ${agentTotal.toFixed(1)} of ${os.availableParallelism()} cores over the last ${Math.round((now - (this.last?.at ?? now)) / 1000) || 60} s (${top}) and the jobs ${res.jobCores?.toFixed(1) ?? '?'}${what}`);
    }
    return res;
  }
}
