// No CI job beside a timed run (w3112, docs/unity-lifecycle.md "The exclusive turn"). On m3 on 2026-11-04 w3108 timed FFU
// under exclusive ticket t00001116 while the Mac's GitHub Actions runners (~/actions-runner, ~/ffu-runner,
// ~/ffw/ffu-runners/ffu-m3-2) ran jobs from 15:35 to 16:09: the 1-minute load average reached 24.1 (median 6.05, about 2
// idle) beside single-threaded timings, and debug ffu-server processes the jobs left (ffu-peers-test) ran on afterwards.
//
// A Runner.Listener is the idle baseline: it only polls GitHub for a job. A running Runner.Worker is a job. So while a timed
// run holds this machine's lock, the daemon pauses every idle runner's listener (SIGSTOP), which then takes no job, and
// continues it (SIGCONT) when the turn ends; a listener with a job is paused once its job ends. A listener running a job is
// never paused: it renews the job's lock with GitHub, and a paused one would lose the job (the game repo's bench_queue.py
// wait_for_ci_quiet makes the timing wait for that job instead). A listener that took a job in the instant it was paused
// is continued at once. A process run from a runner's _work folder that no worker of that runner started is a job's
// leftover: it is ended (SIGTERM, never forced) during the turn. What was paused and ended is kept in
// <root>/tmp/bench.queue/runners.json, so a daemon restarted mid-turn or after it continues its paused listeners, and
// bench_queue.py reports it in the ticket's history. Windows has no SIGSTOP: its runners are waited out, not paused.
import fs from 'node:fs';
import path from 'node:path';
import { descendsFrom } from './benchTurn.ts';
import type { Proc } from './unity.ts';

const RUNNER_RE = /^"?(.+?)[\\/]bin[\\/]Runner\.(Listener|Worker)(?:\.exe)?"?(?:\s|$)/i;

const flat = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');

export interface RunnerCensus {
  listeners: { pid: number; root: string; busy: boolean }[];
  workers: { pid: number; root: string }[];
  leftovers: { pid: number; root: string; cmd: string }[];
}

/**
 * The GitHub Actions runners in a process listing: each listener (busy when a worker runs under it), each worker, and the
 * leftovers: processes run from a runner's _work folder that no worker started. A worker the timed run itself runs under
 * (`own`: the holder's pid, a CI job that took a ticket) counts as no job, and nothing of its own tree is a leftover.
 */
export function runnerCensus(procs: Proc[], own?: number): RunnerCensus {
  const listeners: RunnerCensus['listeners'] = [];
  const workers: RunnerCensus['workers'] = [];
  for (const p of procs) {
    const m = RUNNER_RE.exec(p.cmd);
    if (!m) continue;
    const root = flat(m[1]);
    if (m[2].toLowerCase() === 'listener') listeners.push({ pid: p.pid, root, busy: false });
    else if (!(own && descendsFrom(own, p.pid, procs))) workers.push({ pid: p.pid, root });
  }
  for (const l of listeners) l.busy = workers.some((w) => descendsFrom(w.pid, l.pid, procs));
  const roots = [...new Set([...listeners, ...workers].map((r) => r.root))].sort((a, b) => b.length - a.length);
  const leftovers: RunnerCensus['leftovers'] = [];
  for (const p of procs) {
    if (RUNNER_RE.test(p.cmd) || (own && (descendsFrom(p.pid, own, procs) || descendsFrom(own, p.pid, procs)))) continue;
    const cmd = flat(p.cmd).toLowerCase();
    const root = roots.find((r) => cmd.includes(`${r.toLowerCase()}/_work/`));
    if (root && !workers.some((w) => descendsFrom(p.pid, w.pid, procs))) leftovers.push({ pid: p.pid, root, cmd: p.cmd.slice(0, 200) });
  }
  return { listeners, workers, leftovers };
}

export interface RunnersState {
  /** The turn that paused them. */
  ticket?: string;
  paused: { pid: number; root: string; at: string }[];
  ended: { pid: number; root: string; args: string; at: string }[];
}

export interface BenchRunnersDeps {
  /** The timed run holding this machine's lock (its ticket and owner pid), or undefined. */
  holder(): { ticket: string; ownerPid?: number } | undefined;
  procs(): Promise<Proc[]>;
  /** Send a signal; answers why it could not be sent, nothing when sent. */
  signal(pid: number, sig: 'SIGSTOP' | 'SIGCONT' | 'SIGTERM'): string | void;
  read(): RunnersState | undefined;
  write(s: RunnersState): void;
  log(text: string): void;
  now(): number;
  platform: NodeJS.Platform;
}

export class BenchRunners {
  private readonly d: BenchRunnersDeps;
  private st: RunnersState;
  private ticking = false;
  private windowsSaid = false;

  constructor(d: BenchRunnersDeps) {
    this.d = d;
    const s = d.read();
    this.st = { ticket: s?.ticket, paused: Array.isArray(s?.paused) ? s.paused : [], ended: Array.isArray(s?.ended) ? s.ended : [] };
  }

  /** The listeners paused now, for the machine view and tests. */
  paused(): RunnersState['paused'] {
    return this.st.paused;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } catch (e) {
      this.d.log(`bench runners: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private save() {
    this.d.write(this.st);
  }

  private async step() {
    const h = this.d.holder();
    if (this.d.platform === 'win32') {
      if (h && !this.windowsSaid) {
        this.windowsSaid = true;
        this.d.log(`bench runners: ${h.ticket}: Windows has no SIGSTOP: this machine's CI runners are not paused for the turn (bench_queue.py waits out a running job)`);
      }
      if (!h) this.windowsSaid = false;
      return;
    }
    if (!h) {
      if (!this.st.paused.length && !this.st.ticket) return; // no turn, nothing paused: no listing taken
      const procs = await this.d.procs();
      const listening = new Set(runnerCensus(procs).listeners.map((l) => `${l.pid} ${l.root}`));
      for (const p of this.st.paused) {
        // the pid may be another program's after a reboot: only a listener of that runner is continued
        if (!listening.has(`${p.pid} ${p.root}`)) continue;
        const err = this.d.signal(p.pid, 'SIGCONT');
        this.d.log(`bench runners: ${this.st.ticket ?? 'the turn'} ended: runner ${p.root} (listener pid ${p.pid}) ${err ? `could not be continued: ${err}` : 'continued: it takes CI jobs again'}`);
      }
      this.st = { paused: [], ended: [] };
      this.save();
      return;
    }
    let changed = false;
    if (this.st.ticket !== h.ticket) {
      this.d.log(`bench runners: ${h.ticket} granted: pausing this machine's idle CI runners and ending CI leftovers until it ends (w3112)`);
      this.st = { ticket: h.ticket, paused: this.st.paused, ended: [] };
      changed = true;
    }
    let procs = await this.d.procs();
    let c = runnerCensus(procs, h.ownerPid);
    const live = new Set(c.listeners.map((l) => l.pid));
    const kept = this.st.paused.filter((p) => live.has(p.pid));
    if (kept.length !== this.st.paused.length) changed = true;
    this.st.paused = kept;
    const pausedPids = new Set(kept.map((p) => p.pid));
    const now = new Date(this.d.now()).toISOString();
    const stopped: RunnerCensus['listeners'] = [];
    for (const l of c.listeners) {
      if (pausedPids.has(l.pid) || l.busy) continue;
      const err = this.d.signal(l.pid, 'SIGSTOP');
      if (err) {
        this.d.log(`bench runners: runner ${l.root} (listener pid ${l.pid}) could not be paused: ${err}`);
        continue;
      }
      stopped.push(l);
    }
    if (stopped.length) {
      // A listener that took a job in the instant it was paused would hold that job's lock unrenewed: continue it.
      procs = await this.d.procs();
      c = runnerCensus(procs, h.ownerPid);
      for (const l of stopped) {
        if (c.listeners.find((x) => x.pid === l.pid)?.busy) {
          this.d.signal(l.pid, 'SIGCONT');
          this.d.log(`bench runners: runner ${l.root} (listener pid ${l.pid}) took a job as it was paused: continued; paused once the job ends`);
          continue;
        }
        this.st.paused.push({ pid: l.pid, root: l.root, at: now });
        this.d.log(`bench runners: runner ${l.root} (listener pid ${l.pid}) paused for ${h.ticket}: it takes no CI job until the turn ends`);
        changed = true;
      }
    }
    const busy = new Set(c.workers.map((w) => w.root));
    for (const x of c.leftovers) {
      if (busy.has(x.root) || this.st.ended.some((e) => e.pid === x.pid)) continue;
      const err = this.d.signal(x.pid, 'SIGTERM');
      this.d.log(`bench runners: CI leftover pid ${x.pid} of ${x.root} (${x.cmd.slice(0, 120)}): ${err ? `could not be ended: ${err}` : 'sent SIGTERM'}`);
      if (!err) {
        this.st.ended.push({ pid: x.pid, root: x.root, args: x.cmd, at: now });
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

/** <root>/tmp/bench.queue/runners.json: what the turn paused and ended (bench_queue.py RUNNERS_FILE reads it). */
export const runnersFile = (root: string) => path.join(root, 'tmp', 'bench.queue', 'runners.json');

export function readRunnersFile(root: string): RunnersState | undefined {
  try {
    return JSON.parse(fs.readFileSync(runnersFile(root), 'utf8')) as RunnersState;
  } catch {
    return undefined;
  }
}

/** Written whole (a reader never sees half a file); errors are logged, never thrown. */
export function writeRunnersFile(root: string, s: RunnersState, log: (t: string) => void = () => undefined) {
  const file = runnersFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`bench runners: could not write ${file}: ${(e as Error).message}`);
  }
}

/** process.kill, answering why a signal could not be sent. */
export function sendSignal(pid: number, sig: NodeJS.Signals): string | void {
  try {
    process.kill(pid, sig);
  } catch (e) {
    return (e as Error).message;
  }
}
