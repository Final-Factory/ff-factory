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
//
// No Runner.Worker is not idle (w3195). With a CI queue a listener takes its next job in the second its last one ends:
// it acknowledges the job message, acquires the job and only then starts the worker. On biscuit on 2026-11-06 under w3153's
// exclusive ticket t00003111, ffu-biscuit-3's listener logged "Acknowledging runner request '1a5b1101-…'" at 15:06:11Z,
// was paused before its acquirejob call came back, and logged nothing more until 15:25:27Z, when GitHub answered
// "already acquired": the job (127943935420) had failed at 15:16 with "lost communication with the server". So a
// listener is paused only when its own log (<runner>/_diag/Runner_*.log, written as it goes) says it is idle and has been
// for SETTLE_MS, and is continued at once when that log moved on to a job between the look and the pause.
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

/** A listener idle this long after its last job ended has not just been handed the next one (biscuit: within 1 s). */
export const SETTLE_MS = 10_000;
/** Past GitHub's 10-minute job lock a job the listener never started a worker for is gone: it no longer holds one. */
export const STALE_JOB_MS = 12 * 60_000;

const DIAG_LINE = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)Z [A-Z]+ +\w+\] (.*)$/;
const JOB_MARK = /^(Acknowledging runner request '|Job request .* received\.|WRITE LINE: .*: Running job: )/;
const IDLE_MARK = /^(WRITE LINE: .*: Job .* completed with result: |WRITE LINE: .*: Listening for Jobs|Skipping message Job\.)/;

export interface ListenerLog {
  /** The listener's last word on jobs: it has one in hand (acknowledged, received, running), or it is listening. */
  state: 'job' | 'idle' | 'unknown';
  /** When it said so (ms), and the line, to tell a later word from it. */
  at?: number;
  line?: string;
}

/** What the tail of a listener's Runner_*.log says about jobs: the newest job or idle line decides. */
export function listenerLog(tail: string | undefined): ListenerLog {
  if (tail === undefined) return { state: 'unknown' };
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = DIAG_LINE.exec(lines[i].trimEnd());
    if (!m) continue;
    const state = JOB_MARK.test(m[2]) ? 'job' : IDLE_MARK.test(m[2]) ? 'idle' : undefined;
    if (state) return { state, at: Date.parse(`${m[1].replace(' ', 'T')}Z`), line: lines[i].trimEnd() };
  }
  return { state: 'idle' }; // a tail with no job line: it has listened for longer than the tail holds
}

/** Why a workerless listener may not be paused now, or nothing when it may (it is idle and settled). */
export function holdsJob(log: ListenerLog, now: number): string | void {
  if (log.state === 'unknown') return 'its _diag log could not be read, so a job it was just handed cannot be ruled out';
  if (log.at === undefined) return;
  if (log.state === 'job' && now - log.at < STALE_JOB_MS) return `its log says it was handed a job at ${new Date(log.at).toISOString()} and has no worker yet`;
  if (log.state === 'idle' && now - log.at < SETTLE_MS) return 'its last job ended moments ago, when a queued one is handed over';
}

/** The last 64 KB of the newest <root>/_diag/Runner_*.log (the listener's own log), or undefined when there is none. */
export function readListenerLog(root: string): string | undefined {
  try {
    const dir = path.join(root, '_diag');
    const name = fs.readdirSync(dir).filter((f) => /^Runner_.*\.log$/.test(f)).sort().at(-1);
    if (!name) return undefined;
    const fd = fs.openSync(path.join(dir, name), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
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
  /** The tail of a runner's listener log (readListenerLog), undefined when it cannot be read. */
  diag(root: string): string | undefined;
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
  /** Listeners already said to be held this turn, and why (one line per reason, not one every 5 s). */
  private heldSaid = new Map<number, string>();

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
      this.heldSaid.clear();
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
    const stopped: (RunnerCensus['listeners'][number] & { log: ListenerLog })[] = [];
    for (const l of c.listeners) {
      if (pausedPids.has(l.pid) || l.busy) continue;
      // w3195: no worker yet is not idle: a listener handed its next job starts the worker only once it has acquired it
      const log = listenerLog(this.d.diag(l.root));
      const why = holdsJob(log, this.d.now());
      if (why) {
        if (this.heldSaid.get(l.pid) !== why) this.d.log(`bench runners: runner ${l.root} (listener pid ${l.pid}) not paused yet: ${why}`);
        this.heldSaid.set(l.pid, why);
        continue;
      }
      this.heldSaid.delete(l.pid);
      const err = this.d.signal(l.pid, 'SIGSTOP');
      if (err) {
        this.d.log(`bench runners: runner ${l.root} (listener pid ${l.pid}) could not be paused: ${err}`);
        continue;
      }
      stopped.push({ ...l, log });
    }
    if (stopped.length) {
      // A listener that took a job in the instant it was paused would hold that job's lock unrenewed: continue it.
      procs = await this.d.procs();
      c = runnerCensus(procs, h.ownerPid);
      for (const l of stopped) {
        // a stopped listener writes no more: a job line its log gained since the look was written before the pause
        const after = listenerLog(this.d.diag(l.root));
        const handed = after.state !== 'idle' || after.line !== l.log.line;
        if (c.listeners.find((x) => x.pid === l.pid)?.busy || handed) {
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
