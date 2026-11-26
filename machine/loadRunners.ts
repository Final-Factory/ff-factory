// CI runners take jobs only while their machine has room (w3305; Ben, 2026-11-06: "Keep LothDesktop's runners, but have
// them take ffu jobs only while the machine is under about 70% load"). LothDesktop runs two ffu runners
// (V:/ffw/ffu-runners/ffu-lothdesktop-1 and -2, label ffu-windows) beside up to 10 agents, 3 editors and lothsahn's own
// play. On 2026-11-06 its ffu `test (ffu-windows)` job took a median of 9.2 min and up to 20.3 min there against 4.5 min on
// BEAST's runners (gh api, 60 runs), its CPU read 60-100% through most of that day's placement lines, and the Windows
// multi-process tests that failed under load (w3271, ffu #329) failed on its runners.
//
// A job is offered to a runner only while its listener polls GitHub, so a listener that does not run takes no job and
// the job goes to another runner with the label (BEAST's). So while the machine's CPU stays high the daemon suspends
// every idle, settled listener of a gated runner (NtSuspendProcess on Windows, SIGSTOP elsewhere), and resumes it once
// the CPU has stayed low for a while: two thresholds and two windows, so it does not flap. It reuses the exclusive turn's
// checks (machine/benchRunners.ts, w3112, w3195): a listener with a worker (a job) is never touched and is suspended
// only after its job ends; a listener whose own log says it is taking a job, or has not been idle for SETTLE_MS, waits;
// and one whose log moved on to a job between the look and the suspend is resumed at once. Nothing is ended, and nothing
// on GitHub (labels, registration) changes. What is suspended is kept in <root>/tmp/ci-load-gate.json, so a daemon
// restarted while they are suspended resumes them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holdsJob, listenerLog, runnerCensus, type ListenerLog, type RunnerCensus } from './benchRunners.ts';
import type { Proc } from './unity.ts';
import type { RunnerHoldReport } from '../shared/runnerHold.ts';

export interface LoadGateSettings {
  /** Suspend once the mean CPU over pauseOverMs is at or over this (percent, all cores). */
  pauseAtPct: number;
  /** Resume once the mean CPU over resumeOverMs is under this. */
  resumeBelowPct: number;
  pauseOverMs: number;
  resumeOverMs: number;
  /** The runners gated: their root folder's last part matches. */
  runners: RegExp;
}

/**
 * The machines whose runners are gated, by daemon id. Only LothDesktop (w3305; BEAST's runners stay as they are). The
 * thresholds start at Ben's "about 70%"; a pause needs a minute's mean over it (a compile spike of a few seconds is not
 * load), a resume two minutes under 55%.
 */
export const LOTHDESKTOP_GATE: LoadGateSettings = { pauseAtPct: 70, resumeBelowPct: 55, pauseOverMs: 60_000, resumeOverMs: 120_000, runners: /^ffu-/i };

/**
 * On again since w3305's second pass (2026-11-07). The first live run (04:49-05:26Z) was turned off for three lost
 * LothDesktop jobs, but the runners' own _diag logs show the gate did not take them. Two were the runner's 30-second
 * listener-to-worker hand-off running out ("Job request message sending ... been cancelled, kill running worker", with a
 * Runner.Worker that wrote no log), which those logs show 17 times on 2026-11-03..06, before any gate existed. The third
 * was a failed test step whose listener renewed its job lock every minute to the end, so it was never suspended. Load is
 * what makes those hand-offs run out, and keeping load off the runners is the gate's job. No gate set for a machine:
 * the daemon resumes every listener a gate left suspended.
 */
export const LOAD_GATES: Record<string, LoadGateSettings> = { lothdesktop: LOTHDESKTOP_GATE };

/**
 * w5916: a person's hold on this machine (config placement.hold, or a drain set by hold_machine), as the portal last said
 * it. While it is on, every runner but an operations runner (isOpsRunner) drains: a listener with a job keeps it and is
 * suspended once the job ends, an idle settled one at once. `confirmedAt` is the portal's last word on it: past
 * HOLD_LAPSE_MS without one (the portal gone for good) the hold lapses here, so no runner stays off for ever.
 */
export interface RunnerHold {
  why: string;
  since: string;
  confirmedAt: string;
}

export interface LoadGateState {
  /** The CPU gate (w3305) is closed. */
  closed: boolean;
  /** When the gate last closed or opened. */
  since?: string;
  /** Suspended listeners. Written before each suspend (w5916), so a daemon that dies mid-suspend still resumes it. */
  suspended: { pid: number; root: string; at: string }[];
  hold?: RunnerHold;
  /** w5916: runners whose listener ended while held (a Dev Drive grow ends every process on the drive): started on the lift. */
  startOnLift?: string[];
}

/** w5916: a hold the portal has not repeated for this long lapses on the daemon (the portal re-sends it every few minutes). */
export const HOLD_LAPSE_MS = 12 * 3_600_000;
/**
 * w5916: GitHub removes a non-ephemeral self-hosted runner it has not seen connect for 14 days (changelog 2022-08-03,
 * docs "Removing self-hosted runners"), and a suspended listener does not connect. So a listener suspended this long is
 * resumed for RECONNECT_FOR_MS to reconnect (it may take a job then, and is suspended again once it ends): a hold of weeks
 * never costs a runner its registration.
 */
export const RECONNECT_AFTER_MS = 7 * 24 * 3_600_000;
export const RECONNECT_FOR_MS = 10 * 60_000;

export interface LoadGateDeps {
  settings: LoadGateSettings | undefined;
  procs(): Promise<Proc[]>;
  /** An uncached listing for the look after a suspend (procs may answer with the listing taken before it). */
  freshProcs?(): Promise<Proc[]>;
  /** The machine's CPU percent since the last call (cpuSampler). */
  cpu(): number;
  /** Suspend or resume a process; answers why it could not, nothing when done. */
  suspend(pid: number, resume: boolean): Promise<string | void>;
  diag(root: string): string | undefined;
  /** An operations runner (isOpsRunner, w3424): a hold never drains it (a deploy still lands on a held machine). */
  opsRunner?(root: string): boolean;
  /** Listener pids a timed run paused (machine/benchRunners.ts): left to it, and counted as taking no job. */
  othersPaused?(): Set<number>;
  /** Start a runner's listener again (Windows: its scheduled task or run.cmd, machine/hostGuard.ts runnerRestartScript). */
  start?(root: string): Promise<string>;
  read(): LoadGateState | undefined;
  write(s: LoadGateState): void;
  log(text: string): void;
  now(): number;
}

/** A job runs on that runner: a worker under its listener, or any worker run from its folder (one whose parent link is lost). */
const busy = (c: RunnerCensus, l: RunnerCensus['listeners'][number]) => l.busy || c.workers.some((w) => w.root.toLowerCase() === l.root.toLowerCase());

const base = (root: string) => root.replace(/\/+$/, '').split('/').pop() ?? root;
const sameRoot = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export class LoadGate {
  private readonly d: LoadGateDeps;
  private st: LoadGateState;
  private ticking = false;
  private samples: { at: number; pct: number }[] = [];
  private heldSaid = new Map<number, string>();
  private report?: RunnerHoldReport;
  /** w5916: listeners resumed to reconnect to GitHub after a long suspension (pid: until when), left alone meanwhile. */
  private reconnect = new Map<number, number>();
  /** w5916: the hold was lifted (or lapsed) since the last look: what a resume then says. */
  private lifted = false;

  constructor(d: LoadGateDeps) {
    this.d = d;
    const s = d.read();
    const h = s?.hold;
    this.st = {
      closed: !!s?.closed,
      since: s?.since,
      suspended: Array.isArray(s?.suspended) ? s.suspended : [],
      ...(h && typeof h.why === 'string' && typeof h.since === 'string' && typeof h.confirmedAt === 'string' ? { hold: h } : {}),
      ...(Array.isArray(s?.startOnLift) && s.startOnLift.length ? { startOnLift: s.startOnLift.filter((r) => typeof r === 'string') } : {}),
    };
  }

  state(): LoadGateState {
    return this.st;
  }

  /** w5916: the hold's effect on the runners, or undefined when no hold is on (set by each look). */
  holdReport(): RunnerHoldReport | undefined {
    return this.st.hold ? this.report : undefined;
  }

  /**
   * w5916: the portal's word on this machine's hold: its reason, or undefined when there is none. Kept in the gate's file,
   * so a restarted daemon keeps the runners suspended until the portal says the hold is lifted.
   */
  async setHold(why: string | undefined): Promise<void> {
    const now = new Date(this.d.now()).toISOString();
    const was = this.st.hold;
    if (why) {
      this.st = { ...this.st, hold: { why: why.slice(0, 300), since: was?.since ?? now, confirmedAt: now } };
      if (!was) this.d.log(`ci hold: this machine is held (${why.slice(0, 200)}): each CI runner takes no new job; one running a job finishes it first (w5916)`);
      this.d.write(this.st);
    } else if (was) {
      this.st = { ...this.st, hold: undefined };
      this.lifted = true;
      this.d.log(`ci hold: the hold on this machine was lifted: its CI runners take jobs again (w5916)`);
      this.d.write(this.st);
    } else return;
    await this.tick();
  }

  /**
   * w5916: these runners' listeners ended while the hold is on (a Dev Drive grow): they are not started now, but when it
   * lifts. Answers false when no hold is on (the caller starts them itself).
   */
  deferStart(roots: string[]): boolean {
    if (!this.st.hold) return false;
    const list = [...(this.st.startOnLift ?? [])];
    for (const r of roots) if (!list.some((x) => sameRoot(x, r))) list.push(r);
    this.st = { ...this.st, startOnLift: list };
    this.d.log(`ci hold: ${roots.map(base).join(', ')} ended while held: started again when the hold lifts`);
    this.d.write(this.st);
    return true;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } catch (e) {
      this.d.log(`ci load gate: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** The mean of the samples over the last `ms`, or undefined while fewer than `ms` of samples are held. */
  private mean(ms: number): number | undefined {
    const now = this.d.now();
    const first = this.samples[0];
    if (!first || now - first.at < ms) return undefined;
    const xs = this.samples.filter((x) => now - x.at <= ms);
    return xs.length ? xs.reduce((a, x) => a + x.pct, 0) / xs.length : undefined;
  }

  private async step() {
    const g = this.d.settings;
    const now = this.d.now();
    const h = this.st.hold;
    if (h && now - Date.parse(h.confirmedAt) > HOLD_LAPSE_MS) {
      this.st = { ...this.st, hold: undefined };
      this.lifted = true;
      this.d.log(`ci hold: the portal has not repeated this machine's hold (${h.why.slice(0, 120)}) since ${h.confirmedAt}: it lapses here and the CI runners take jobs again (w5916, HOLD_LAPSE_MS)`);
      this.d.write(this.st);
    }
    let why = 'the hold on this machine was lifted';
    if (!g) {
      if (this.st.closed) {
        this.st = { ...this.st, closed: false };
        this.d.write(this.st);
      }
      if (!this.st.hold && !this.lifted) why = 'no load gate is set for this machine';
    } else {
      this.samples.push({ at: now, pct: this.d.cpu() });
      // A slack past the longest window: ticks land a little over 5 s apart, so trimming at the window itself left the
      // oldest sample always under resumeOverMs old and the gate never reopened (LothDesktop, 2026-11-07 09:08..10:03Z).
      const keep = Math.max(g.pauseOverMs, g.resumeOverMs) + 30_000;
      while (this.samples.length && now - this.samples[0].at > keep) this.samples.shift();
      const hi = this.mean(g.pauseOverMs);
      const lo = this.mean(g.resumeOverMs);
      if (!this.st.closed && hi !== undefined && hi >= g.pauseAtPct) {
        this.st = { ...this.st, closed: true, since: new Date(now).toISOString() };
        this.d.log(`ci load gate: CPU ${hi.toFixed(0)}% over the last ${g.pauseOverMs / 1000} s (at or over ${g.pauseAtPct}%): this machine's idle CI runners take no job until it stays under ${g.resumeBelowPct}% for ${g.resumeOverMs / 1000} s (w3305)`);
        this.d.write(this.st);
      } else if (this.st.closed && lo !== undefined && lo < g.resumeBelowPct) {
        this.st = { ...this.st, closed: false, since: new Date(now).toISOString() };
        this.d.write(this.st);
        why = `CPU ${lo.toFixed(0)}% over the last ${g.resumeOverMs / 1000} s (under ${g.resumeBelowPct}%)`;
      }
    }
    const held = !!this.st.hold;
    const cpuClosed = !!g && this.st.closed;
    // The hold drains every runner but an operations runner; the CPU gate only its own (w3305).
    const wants = (root: string) => (held && !this.d.opsRunner?.(root)) || (cpuClosed && !!g && g.runners.test(base(root)));
    const off = this.st.suspended.filter((p) => !wants(p.root));
    if (off.length) await this.resume(off, why);
    this.lifted = false;
    const stale = this.st.suspended.filter((p) => now - Date.parse(p.at) > RECONNECT_AFTER_MS);
    if (stale.length) {
      for (const p of stale) this.reconnect.set(p.pid, now + RECONNECT_FOR_MS);
      await this.resume(stale, `suspended over ${RECONNECT_AFTER_MS / 86_400_000} days: it reconnects to GitHub for ${RECONNECT_FOR_MS / 60_000} minutes, so GitHub never removes it (14 days offline; w5916)`);
    }
    for (const [pid, until] of this.reconnect) if (until <= now) this.reconnect.delete(pid);
    if (!held && this.st.startOnLift?.length) await this.startLifted();
    if (held || cpuClosed) await this.suspendIdle(wants);
    else this.report = undefined;
  }

  /** Resume these suspended listeners (each still a listener of its runner) and drop them from the list. */
  private async resume(list: LoadGateState['suspended'], why: string) {
    const procs = await this.d.procs();
    const listening = new Set(runnerCensus(procs).listeners.map((l) => `${l.pid} ${l.root}`));
    for (const p of list) {
      // the pid may be another program's after a reboot: only a listener of that runner is resumed
      if (!listening.has(`${p.pid} ${p.root}`)) continue;
      const err = await this.d.suspend(p.pid, true);
      this.d.log(`ci load gate: ${why}: runner ${p.root} (listener pid ${p.pid}) ${err ? `could not be resumed: ${err}` : 'resumed: it takes CI jobs again'}`);
    }
    const gone = new Set(list.map((p) => p.pid));
    this.st = { ...this.st, suspended: this.st.suspended.filter((p) => !gone.has(p.pid)) };
    this.heldSaid.clear();
    this.d.write(this.st);
  }

  /** w5916: start each runner that ended while held and has no listener now; one that cannot start is tried at the next look. */
  private async startLifted() {
    const up = runnerCensus(await this.d.procs()).listeners;
    const left: string[] = [];
    for (const root of this.st.startOnLift ?? []) {
      if (up.some((l) => sameRoot(l.root, root))) {
        this.d.log(`ci hold: runner ${root} is up again`);
        continue;
      }
      if (!this.d.start) {
        this.d.log(`ci hold: runner ${root} ended while held and this daemon cannot start a runner here: start it by its own service`);
        continue;
      }
      try {
        this.d.log(`ci hold: runner ${root}: started again after the hold (${await this.d.start(root)})`);
      } catch (e) {
        left.push(root);
        this.d.log(`ci hold: runner ${root} could not be started again: ${(e as Error).message.slice(0, 200)}; tried again at the next look`);
      }
    }
    this.st = { ...this.st, ...(left.length ? { startOnLift: left } : { startOnLift: undefined }) };
    this.d.write(this.st);
  }

  private async suspendIdle(wants: (root: string) => boolean) {
    let c = runnerCensus(await this.d.procs());
    const live = new Set(c.listeners.map((l) => `${l.pid} ${l.root}`));
    const kept = this.st.suspended.filter((p) => live.has(`${p.pid} ${p.root}`));
    let changed = kept.length !== this.st.suspended.length;
    this.st.suspended = kept;
    const done = new Set(kept.map((p) => p.pid));
    const others = this.d.othersPaused?.() ?? new Set<number>();
    const stopped: (RunnerCensus['listeners'][number] & { log: ListenerLog })[] = [];
    const waits: string[] = [];
    const hold = this.st.hold ? (root: string) => !this.d.opsRunner?.(root) : () => false;
    const at = () => new Date(this.d.now()).toISOString();
    const drop = (pid: number) => {
      this.st.suspended = this.st.suspended.filter((p) => p.pid !== pid);
      this.d.write(this.st);
    };
    for (const l of c.listeners) {
      if (done.has(l.pid) || others.has(l.pid) || !wants(l.root)) continue;
      if (this.reconnect.has(l.pid)) {
        if (hold(l.root)) waits.push(l.root);
        continue;
      }
      if (busy(c, l)) {
        if (hold(l.root)) waits.push(l.root);
        continue;
      }
      const log = listenerLog(this.d.diag(l.root));
      const why = holdsJob(log, this.d.now());
      if (why) {
        if (hold(l.root)) waits.push(l.root);
        if (this.heldSaid.get(l.pid) !== why) this.d.log(`ci load gate: runner ${l.root} (listener pid ${l.pid}) not suspended yet: ${why}`);
        this.heldSaid.set(l.pid, why);
        continue;
      }
      this.heldSaid.delete(l.pid);
      // w5916: written first, so a daemon that dies between the suspend and the write still resumes it on the lift
      // (resuming a listener that was never suspended does nothing).
      this.st.suspended.push({ pid: l.pid, root: l.root, at: at() });
      this.d.write(this.st);
      const err = await this.d.suspend(l.pid, false);
      if (err) {
        drop(l.pid);
        if (hold(l.root)) waits.push(l.root);
        if (this.heldSaid.get(l.pid) !== err) this.d.log(`ci load gate: runner ${l.root} (listener pid ${l.pid}) could not be suspended: ${err}`);
        this.heldSaid.set(l.pid, err);
        continue;
      }
      stopped.push({ ...l, log });
    }
    if (stopped.length) {
      // A listener that took a job in the instant it was suspended would hold that job unrenewed: resume it.
      c = runnerCensus(await (this.d.freshProcs ?? this.d.procs)());
      for (const l of stopped) {
        const after = listenerLog(this.d.diag(l.root));
        const seen = c.listeners.find((x) => x.pid === l.pid);
        if (!seen || busy(c, seen) || after.state !== 'idle' || after.line !== l.log.line) {
          await this.d.suspend(l.pid, true);
          drop(l.pid);
          if (hold(l.root)) waits.push(l.root);
          this.d.log(`ci load gate: runner ${l.root} (listener pid ${l.pid}) took a job as it was suspended: resumed; suspended once the job ends`);
          continue;
        }
        this.d.log(
          this.st.hold && hold(l.root)
            ? `ci hold: runner ${l.root} (listener pid ${l.pid}) suspended: it takes no CI job until the hold on this machine is lifted`
            : `ci load gate: runner ${l.root} (listener pid ${l.pid}) suspended: it takes no CI job while this machine is loaded`,
        );
        changed = true;
      }
    }
    if (changed) this.d.write(this.st);
    if (this.st.hold) {
      const mine = new Set(this.st.suspended.map((p) => p.pid));
      const stoppedRoots = c.listeners.filter((l) => hold(l.root) && (mine.has(l.pid) || others.has(l.pid))).map((l) => base(l.root));
      this.report = { why: this.st.hold.why, since: this.st.hold.since, stopped: [...new Set(stoppedRoots)].sort(), busy: [...new Set(waits.map(base))].sort(), startOnLift: (this.st.startOnLift ?? []).map(base) };
    } else this.report = undefined;
  }
}

/** The machine's CPU percent, all cores, since the previous call (the first call: since boot). */
export function cpuSampler(cpus: () => os.CpuInfo[] = os.cpus): () => number {
  const snap = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, all: a.all + c.times.idle + c.times.user + c.times.sys + c.times.irq + c.times.nice }), { idle: 0, all: 0 });
  let last = snap();
  return () => {
    const b = snap();
    const all = b.all - last.all;
    const pct = all > 0 ? 100 * (1 - (b.idle - last.idle) / all) : 0;
    last = b;
    return Math.max(0, Math.min(100, pct));
  };
}

/** NtSuspendProcess / NtResumeProcess of one process of this user's (no admin, no window), as a PowerShell script. */
export function winSuspendScript(pid: number, resume: boolean): string {
  if (!Number.isInteger(pid) || pid <= 4) throw new Error(`pid ${pid} is not a process to suspend`);
  return [
    `Add-Type -TypeDefinition @'`,
    `using System; using System.Runtime.InteropServices;`,
    `public static class FFSuspend {`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, int p);`,
    `  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);`,
    `  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);`,
    `  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);`,
    `  public static string Run(int pid, bool resume) {`,
    `    IntPtr h = OpenProcess(0x0800, false, pid);`,
    `    if (h == IntPtr.Zero) return "OpenProcess failed: error " + Marshal.GetLastWin32Error();`,
    `    try { int s = resume ? NtResumeProcess(h) : NtSuspendProcess(h); return s == 0 ? "" : "NTSTATUS 0x" + s.ToString("X8"); }`,
    `    finally { CloseHandle(h); }`,
    `  }`,
    `}`,
    `'@`,
    `[Console]::Out.Write([FFSuspend]::Run(${pid}, $${resume ? 'true' : 'false'}))`,
  ].join('\n');
}

export const loadGateFile = (root: string) => path.join(root, 'tmp', 'ci-load-gate.json');

export function readLoadGateFile(root: string): LoadGateState | undefined {
  try {
    return JSON.parse(fs.readFileSync(loadGateFile(root), 'utf8')) as LoadGateState;
  } catch {
    return undefined;
  }
}

export function writeLoadGateFile(root: string, s: LoadGateState, log: (t: string) => void = () => undefined) {
  const file = loadGateFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`ci load gate: could not write ${file}: ${(e as Error).message}`);
  }
}
