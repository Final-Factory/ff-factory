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
export const LOAD_GATES: Record<string, LoadGateSettings> = {
  lothdesktop: { pauseAtPct: 70, resumeBelowPct: 55, pauseOverMs: 60_000, resumeOverMs: 120_000, runners: /^ffu-/i },
};

export interface LoadGateState {
  closed: boolean;
  /** When the gate last closed or opened. */
  since?: string;
  suspended: { pid: number; root: string; at: string }[];
}

export interface LoadGateDeps {
  settings: LoadGateSettings | undefined;
  procs(): Promise<Proc[]>;
  /** The machine's CPU percent since the last call (cpuSampler). */
  cpu(): number;
  /** Suspend or resume a process; answers why it could not, nothing when done. */
  suspend(pid: number, resume: boolean): Promise<string | void>;
  diag(root: string): string | undefined;
  read(): LoadGateState | undefined;
  write(s: LoadGateState): void;
  log(text: string): void;
  now(): number;
}

const base = (root: string) => root.replace(/\/+$/, '').split('/').pop() ?? root;

export class LoadGate {
  private readonly d: LoadGateDeps;
  private st: LoadGateState;
  private ticking = false;
  private samples: { at: number; pct: number }[] = [];
  private heldSaid = new Map<number, string>();

  constructor(d: LoadGateDeps) {
    this.d = d;
    const s = d.read();
    this.st = { closed: !!s?.closed, since: s?.since, suspended: Array.isArray(s?.suspended) ? s.suspended : [] };
  }

  state(): LoadGateState {
    return this.st;
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
    if (!g) {
      if (this.st.suspended.length) await this.resumeAll('no load gate is set for this machine');
      return;
    }
    this.samples.push({ at: now, pct: this.d.cpu() });
    const keep = Math.max(g.pauseOverMs, g.resumeOverMs);
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
      await this.resumeAll(`CPU ${lo.toFixed(0)}% over the last ${g.resumeOverMs / 1000} s (under ${g.resumeBelowPct}%)`);
      return;
    }
    if (this.st.closed) await this.suspendIdle(g);
  }

  private async resumeAll(why: string) {
    const procs = await this.d.procs();
    const listening = new Set(runnerCensus(procs).listeners.map((l) => `${l.pid} ${l.root}`));
    for (const p of this.st.suspended) {
      // the pid may be another program's after a reboot: only a listener of that runner is resumed
      if (!listening.has(`${p.pid} ${p.root}`)) continue;
      const err = await this.d.suspend(p.pid, true);
      this.d.log(`ci load gate: ${why}: runner ${p.root} (listener pid ${p.pid}) ${err ? `could not be resumed: ${err}` : 'resumed: it takes CI jobs again'}`);
    }
    this.st = { ...this.st, suspended: [] };
    this.heldSaid.clear();
    this.d.write(this.st);
  }

  private async suspendIdle(g: LoadGateSettings) {
    let c = runnerCensus(await this.d.procs());
    const live = new Set(c.listeners.map((l) => `${l.pid} ${l.root}`));
    const kept = this.st.suspended.filter((p) => live.has(`${p.pid} ${p.root}`));
    let changed = kept.length !== this.st.suspended.length;
    this.st.suspended = kept;
    const done = new Set(kept.map((p) => p.pid));
    const stopped: (RunnerCensus['listeners'][number] & { log: ListenerLog })[] = [];
    for (const l of c.listeners) {
      if (done.has(l.pid) || l.busy || !g.runners.test(base(l.root))) continue;
      const log = listenerLog(this.d.diag(l.root));
      const why = holdsJob(log, this.d.now());
      if (why) {
        if (this.heldSaid.get(l.pid) !== why) this.d.log(`ci load gate: runner ${l.root} (listener pid ${l.pid}) not suspended yet: ${why}`);
        this.heldSaid.set(l.pid, why);
        continue;
      }
      this.heldSaid.delete(l.pid);
      const err = await this.d.suspend(l.pid, false);
      if (err) {
        if (this.heldSaid.get(l.pid) !== err) this.d.log(`ci load gate: runner ${l.root} (listener pid ${l.pid}) could not be suspended: ${err}`);
        this.heldSaid.set(l.pid, err);
        continue;
      }
      stopped.push({ ...l, log });
    }
    if (stopped.length) {
      // A listener that took a job in the instant it was suspended would hold that job unrenewed: resume it.
      c = runnerCensus(await this.d.procs());
      const at = new Date(this.d.now()).toISOString();
      for (const l of stopped) {
        const after = listenerLog(this.d.diag(l.root));
        if (c.listeners.find((x) => x.pid === l.pid)?.busy || after.state !== 'idle' || after.line !== l.log.line) {
          await this.d.suspend(l.pid, true);
          this.d.log(`ci load gate: runner ${l.root} (listener pid ${l.pid}) took a job as it was suspended: resumed; suspended once the job ends`);
          continue;
        }
        this.st.suspended.push({ pid: l.pid, root: l.root, at });
        this.d.log(`ci load gate: runner ${l.root} (listener pid ${l.pid}) suspended: it takes no CI job while this machine is loaded`);
        changed = true;
      }
    }
    if (changed) this.d.write(this.st);
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
