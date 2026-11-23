// CI jobs go first on a CI-first machine (w5322; lothsahn, 2026-11-23: "Also make check runs urgent priority on biscuit by
// the framework so they go first"). biscuit runs Final-Factory/ffu's self-hosted runners (label ffu-linux-biscuit: the
// `check` job, the GPU test suite, 19-33 min a run) beside FF Factory's agents, Unity editors and their cargo and Unity
// builds. Its runner units were written in w2896 (2026-11-02) with `Nice=10` and `CPUWeight=50` "so agents and the Unity
// editor get the CPU first": the opposite of what is wanted now.
//
// The runner units stay as they are (w5322's brief: changing the runner service is lothsahn's call). FF Factory lowers its
// own work below them instead. On Linux the daemon starts every agent host and editor in a systemd user scope of its own
// (`ffw-<kind>-...scope`, machine/linuxScope.ts), and everything a worker runs (cargo, unity-slot batches, players) runs
// inside its agent's scope. Where the user manager has the cpu controller on, siblings share the CPU by cgroup weight, and
// a scope at the default weight 100 beside a runner unit at 50 took twice its share; where it is off, nice decides, and
// processes at nice 0 beat a runner at nice 10. So once a minute (CiFirst.tick) every ffw-*.scope gets
// `systemctl --user set-property --runtime CPUWeight=<cpuWeight> IOWeight=<ioWeight>` (user level, no root, gone at the
// next boot) and every thread in it is lowered to nice <nice> (an unprivileged process may raise its own nice, never lower
// it: setpriority(2)). Threads are set one by one: on Linux setpriority(PRIO_PROCESS, pid) sets one thread, and threads
// already running (cargo's, rustc's) keep their own value. Nothing is raised back: without CAP_SYS_NICE an unprivileged
// process cannot, and a weight or nice only matters while something else wants the CPU, so with no CI job running the
// agents still get the whole machine. The daemon itself stays at its own priority, so the portal link keeps answering.
//
// When a CI job starts or ends the daemon logs what each side runs at (the job's worker nice and cgroup cpu.weight, FF
// Factory's scopes' cpu.weight and the lowest priority of their threads), the evidence that check goes first.
import fs from 'node:fs';
import os from 'node:os';
import type { RunnerCensus } from './benchRunners.ts';

export interface CiFirstSettings {
  /** The nice every thread of an FF Factory scope runs at (the runners' units: Nice=10). */
  nice: number;
  /** systemd CPUWeight of every FF Factory scope (the runners' units: CPUWeight=50; the default: 100). */
  cpuWeight: number;
  /** systemd IOWeight of every FF Factory scope (the default: 100; takes effect only where the io controller is on). */
  ioWeight: number;
}

/** biscuit's runners run at Nice=10, CPUWeight=50 (w2896): FF Factory's work goes 10:1 below them on both. */
export const BISCUIT_CI_FIRST: CiFirstSettings = { nice: 19, cpuWeight: 5, ioWeight: 10 };

/** The machines whose CI jobs go ahead of FF Factory's own work, by machine id. */
export const CI_FIRST: Record<string, CiFirstSettings> = { biscuit: BISCUIT_CI_FIRST };

/** A scope the daemon started (machine/linuxScope.ts scopeUnit). */
export const SCOPE_RE = /^ffw-(unity|agent)-.+\.scope$/;

export interface ScopeInfo {
  unit: string;
  /** Its cgroup path under /sys/fs/cgroup, e.g. /user.slice/user-1000.slice/user@1000.service/app.slice/ffw-agent-x.scope. */
  cgroup: string;
  cpuWeight?: number;
  ioWeight?: number;
}

export interface CiFirstDeps {
  settings?: CiFirstSettings;
  /** The daemon's scopes now (ffw-*.scope), with their cgroup and the weights systemd holds for them. */
  scopes: () => Promise<ScopeInfo[]>;
  setWeights: (unit: string, cpuWeight: number, ioWeight: number) => Promise<void>;
  /** The processes in a cgroup (its cgroup.procs). */
  pids: (cgroup: string) => number[];
  /** A process's threads (/proc/<pid>/task). */
  tasks: (pid: number) => number[];
  niceOf: (tid: number) => number | undefined;
  setNice: (tid: number, nice: number) => boolean;
  /** The runners and their jobs now. */
  census: () => Promise<RunnerCensus>;
  /** A process's cgroup cpu.weight as the kernel holds it ('-' when the cpu controller is off there). */
  cgroupWeightOf: (pid: number) => string;
  /** The same for a cgroup path. */
  cgroupWeight: (cgroup: string) => string;
  log: (line: string) => void;
}

/** What a tick did and saw (tests, the log). */
export interface CiFirstResult {
  scopes: number;
  weighted: string[];
  lowered: number;
  jobs: { pid: number; root: string }[];
}

export class CiFirst {
  private jobKey = '';

  private readonly d: CiFirstDeps;

  constructor(d: CiFirstDeps) {
    this.d = d;
  }

  get enabled(): boolean {
    return !!this.d.settings;
  }

  async tick(): Promise<CiFirstResult | undefined> {
    const s = this.d.settings;
    if (!s) return undefined;
    let scopes: ScopeInfo[] = [];
    try {
      scopes = (await this.d.scopes()).filter((x) => SCOPE_RE.test(x.unit));
    } catch (e) {
      this.d.log(`ci first: could not list FF Factory's scopes: ${(e as Error).message}`);
    }
    const weighted: string[] = [];
    let lowered = 0;
    let threads = 0;
    let highest: number | undefined;
    for (const sc of scopes) {
      if (sc.cpuWeight !== s.cpuWeight || sc.ioWeight !== s.ioWeight) {
        try {
          await this.d.setWeights(sc.unit, s.cpuWeight, s.ioWeight);
          weighted.push(sc.unit);
        } catch (e) {
          this.d.log(`ci first: ${sc.unit}: could not set CPUWeight=${s.cpuWeight} IOWeight=${s.ioWeight}: ${(e as Error).message}`);
        }
      }
      for (const pid of this.d.pids(sc.cgroup)) {
        for (const tid of this.d.tasks(pid)) {
          let n = this.d.niceOf(tid);
          if (n === undefined) continue;
          if (n < s.nice && this.d.setNice(tid, s.nice)) (lowered++, (n = s.nice));
          threads++;
          if (highest === undefined || n < highest) highest = n;
        }
      }
    }
    if (weighted.length || lowered) {
      this.d.log(`ci first: lowered ${weighted.length} scope(s) to CPUWeight=${s.cpuWeight} IOWeight=${s.ioWeight}${weighted.length ? ` (${weighted.join(', ')})` : ''} and ${lowered} thread(s) to nice ${s.nice}, so CI jobs here go first`);
    }
    let jobs: CiFirstResult['jobs'] = [];
    try {
      jobs = (await this.d.census()).workers;
    } catch {
      jobs = [];
    }
    const key = jobs.map((j) => j.pid).sort((a, b) => a - b).join(',');
    if (key !== this.jobKey) {
      if (jobs.length) {
        const sides = jobs.map((j) => `${j.root.split('/').pop()} (worker ${j.pid}: nice ${this.d.niceOf(j.pid) ?? '?'}, cpu.weight ${this.d.cgroupWeightOf(j.pid)})`).join('; ');
        const ours = [...new Set(scopes.map((sc) => this.d.cgroupWeight(sc.cgroup)))].join('/') || 'none';
        this.d.log(`ci first: CI job(s) running: ${sides}; FF Factory's ${scopes.length} scope(s) at cpu.weight ${ours}, ${threads} thread(s), the highest at nice ${highest ?? '-'}`);
      } else if (this.jobKey) {
        this.d.log('ci first: no CI job running now');
      }
      this.jobKey = key;
    }
    return { scopes: scopes.length, weighted, lowered, jobs };
  }
}

/** `systemctl --user show -p Id,ControlGroup,CPUWeight,IOWeight a b ...`: one block per unit, blank lines between. */
export function parseScopeShow(out: string): ScopeInfo[] {
  const res: ScopeInfo[] = [];
  for (const block of out.split(/\r?\n\s*\r?\n/)) {
    const kv = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    const unit = kv.get('Id');
    const cgroup = kv.get('ControlGroup');
    if (!unit || !cgroup) continue;
    const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    res.push({ unit, cgroup, cpuWeight: num(kv.get('CPUWeight')), ioWeight: num(kv.get('IOWeight')) });
  }
  return res;
}

/** The unit names of `systemctl --user list-units --type=scope --plain --no-legend 'ffw-*'`. */
export function parseScopeList(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((u) => SCOPE_RE.test(u));
}

const readLines = (p: string): string[] => {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/** The real Linux reads: cgroup v2 files and /proc. */
export const linuxReads = {
  pids: (cgroup: string) => readLines(`/sys/fs/cgroup${cgroup}/cgroup.procs`).map(Number).filter((n) => n > 0),
  tasks: (pid: number) => {
    try {
      return fs.readdirSync(`/proc/${pid}/task`).map(Number).filter((n) => n > 0);
    } catch {
      return [];
    }
  },
  niceOf: (tid: number) => {
    try {
      return os.getPriority(tid);
    } catch {
      return undefined;
    }
  },
  setNice: (tid: number, nice: number) => {
    try {
      os.setPriority(tid, nice);
      return true;
    } catch {
      return false;
    }
  },
  cgroupWeight: (cgroup: string) => readLines(`/sys/fs/cgroup${cgroup}/cpu.weight`)[0] ?? '-',
  cgroupWeightOf: (pid: number) => {
    const line = readLines(`/proc/${pid}/cgroup`).find((l) => l.startsWith('0::'));
    return line ? (readLines(`/sys/fs/cgroup${line.slice(3)}/cpu.weight`)[0] ?? '-') : '-';
  },
};
