// The host guard on a machine's daemon (w466, docs/portal-on-ffbox-host.md change 4, decided as D11): BEAST's sandbox
// Dev Drive watch, its remount through the ffsb-helper-mount task with retries (at once, then 2, 5, 10 and 30 minutes),
// then that machine's editors restarted and its interrupted agents resumed; the disk guard over the volumes that hold
// the drive, and the headless-browser reaper. They ran in the portal while it lived on BEAST; when it moves to its VM
// they stay with BEAST, in its daemon. The decisions are server/hostHealth.ts's HostHealthMonitor, unchanged: this
// gives it the daemon's pool, agents and link instead of the portal's. docs/self-recovery.md, "On BEAST's daemon".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, HostGuardConfig } from '../server/config.ts';
import { DEFAULT_CLEANUP } from '../server/config.ts';
import { DISK_RESUME_MARGIN_GB } from '../shared/blockers.ts';
import { HostHealthMonitor } from '../server/hostHealth.ts';
import type { HelperAction, HelperResult } from '../server/privileged.ts';
import { DISK_CRITICAL_GB_DEFAULT, type HostHealth, type MachineGuardSettings, type Sandbox, type SessionInfo } from '../shared/types.ts';
import { runnerCensus } from './benchRunners.ts';
import type { Proc } from './unity.ts';

export type { MachineGuardSettings };

/** What the guard does on the machine: the daemon's own effects (tests give fakes). */
export interface MachineGuardEffects {
  exists(p: string): boolean;
  statfs(p: string): Promise<{ free: number; total: number } | undefined>;
  /** A file's size in bytes (the VHDX's, w1070), undefined when it cannot be read. */
  fileBytes?(p: string): number | undefined;
  mem(): { free: number; total: number };
  runHelper(action: HelperAction): Promise<HelperResult>;
  reap?(maxAgeHours: number): Promise<string[]>;
  now?(): number;
  /** A JSON file (the Dev Drive's devdrive.json beside its VHDX, w1918), undefined when it cannot be read. */
  readJson?(p: string): unknown;
  /** The GitHub Actions runner listeners running here (root: the runner's folder; busy: a job runs on it), w3721. */
  runners?(): Promise<{ root: string; busy: boolean }[]>;
  /** Start a runner's listener again (its scheduled task, else its run.cmd); answers how, or throws (w3721). */
  restartRunner?(root: string): Promise<string>;
}

/** Sessions that hold a sandbox (hostHealth.ts's BUSY plus an agent between turns, whose process still runs there). */
const HOLDS_SANDBOX = new Set(['starting', 'running', 'waiting_permission', 'idle']);
const EDITOR_HELD = new Set(['running', 'starting', 'blocked']);
/** A grow that failed is tried again after this long, not on every look. */
export const GROW_RETRY_MS = 30 * 60_000;
/** w5906: a pending grow's reason is said again when what holds it changes, at most this often (logged; the portal's report less often). */
export const GROW_NOTE_LOG_MS = 2 * 60_000;
export const GROW_NOTE_REPORT_MS = 15 * 60_000;

/** What the guard sees of the daemon and asks of it. */
export interface MachineGuardPorts {
  /** The pool's sandboxes, as the host guard reads them (id, editor state). */
  sandboxes(): Sandbox[];
  /** The daemon's agents, those in sandboxes with sandboxId set to their sandbox. */
  sessions(): SessionInfo[];
  startEditor(id: string): Promise<void>;
  stopEditor(id: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** A system message to an agent of this machine (the resume after the drive is back). */
  tell(sessionId: string, text: string): void;
  /** To the portal: its orchestrator and a push, as the portal's own guard reports. Queued while the link is down. */
  report(title: string, body: string): void;
  changed(h: HostHealth): void;
  log(line: string): void;
  /**
   * The pool's disk guard (disk_warn_gb / disk_critical_gb, the portal's welcome) the sandbox volume is judged by (w1581,
   * lothsahn: "Let's reduce the buffer on v: drives to 25GB"): daemon.json's hostGuard.warnFreeGB, which an install
   * wrote from the pool's values and every update carried, then held a Dev Drive at a floor nobody could change.
   */
  poolFloor?(): { warnGB: number; criticalGB: number } | undefined;
  /**
   * w5906: why an agent between turns must still hold its sandbox through a grow (its pending check-in, a timed run of its
   * own), or undefined when nothing of it would lose work. Without stopIdle every idle agent holds, as before.
   */
  idleHold?(sessionId: string): string | undefined;
  /**
   * w5906: stop an idle agent's host through the daemon's own stop op (as a pause does), so a grow need not wait for the
   * portal's idle release; it resumes at its next message as any stopped worker does. Resolves true once its host is gone.
   */
  stopIdle?(sessionId: string): Promise<boolean>;
  /**
   * w5916: these runners' listeners ended in a grow while a person's hold is on (machine/loadRunners.ts): answers true when
   * the hold takes them, to start when it lifts; false (or absent) and the guard starts them again at once.
   */
  deferRunners?(roots: string[]): boolean;
}

/**
 * The config the host guard reads, made from the machine's settings: its sandbox root is the drive, the clean-up is
 * the daemon's own (its CleanupRunner, with the portal's machines.cleanup settings), not this guard's, and the idle
 * editor stop is its pool's (sandboxIdleStopMinutes). Exported for tests.
 */
export function machineGuardConfig(s: MachineGuardSettings, sandboxRoot: string): Config {
  const hostGuard: HostGuardConfig = {
    pollSeconds: s.pollSeconds,
    warnFreeGB: s.warnFreeGB,
    criticalFreeGB: s.criticalFreeGB,
    hysteresisGB: s.hysteresisGB,
    remountMinFreeGB: s.remountMinFreeGB,
    devDriveVhdx: s.devDriveVhdx ?? '',
    ...(s.devDriveMaxGB ? { devDriveMaxGB: s.devDriveMaxGB } : {}),
    reapBrowsersAfterHours: s.reapBrowsersAfterHours,
    reapEveryMinutes: s.reapEveryMinutes,
    cleanup: { ...DEFAULT_CLEANUP, everyMinutes: 0, softFreeGB: 0 },
  };
  return { sandboxRoot, hostDiskPaths: s.hostDiskPaths, hostGuard, limits: { minFreeRamGB: s.minFreeRamGB ?? 0 }, unity: { idleStopMinutes: 0 } } as unknown as Config;
}

const EMPTY_RUN = { removed: [], failed: [], bytes: 0 };

const flatLower = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** Two paths on one Windows drive letter. */
export const sameDrive = (a: string, b: string) => {
  const da = /^([a-z]):/i.exec(a)?.[1]?.toLowerCase();
  const db = /^([a-z]):/i.exec(b)?.[1]?.toLowerCase();
  return !!da && da === db;
};
const runnerName = (root: string) => flatLower(root).split('/').pop() ?? root;

/**
 * Start a runner's listener again, as a PowerShell script (w3721): the scheduled task whose action names the runner's
 * folder (LothDesktop starts ffu-lothdesktop-1 and -2 through tasks of those names, run in the person's own session), else
 * its run.cmd, hidden and detached. Prints how.
 */
export function runnerRestartScript(root: string): string {
  const win = root.replace(/\//g, '\\').replace(/\\+$/, '');
  // a whitelist, not a quote check (w6163's review): PowerShell ends a single-quoted string at U+2018..U+201B as well as at '
  if (!/^[a-z]:\\[A-Za-z0-9 _.\\-]+$/i.test(win)) throw new Error(`${root} is not a runner folder to start`);
  return [
    `$root = '${win}'`,
    `$re = [regex]::Escape($root) + '(?![\\w.-])'`,
    `$t = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { (($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' ') -match $re } | Select-Object -First 1`,
    `if ($t) { Start-ScheduledTask -InputObject $t; [Console]::Out.Write("scheduled task $($t.TaskName)") }`,
    `elseif (Test-Path -LiteralPath (Join-Path $root 'run.cmd')) { Start-Process -FilePath (Join-Path $root 'run.cmd') -WorkingDirectory $root -WindowStyle Hidden; [Console]::Out.Write('run.cmd') }`,
    `else { [Console]::Error.Write("no scheduled task and no run.cmd for $root"); exit 3 }`,
  ].join('\n');
}

/** The guard on this machine: tick() on a timer, blockReason() before an agent or editor starts in a sandbox. */
export class MachineGuard {
  readonly monitor: HostHealthMonitor;
  readonly settings: MachineGuardSettings;
  private timer?: NodeJS.Timeout;
  private readonly fx: MachineGuardEffects;
  private readonly ports: MachineGuardPorts;
  /** The Dev Drive's maximum being grown to (w1918): new agents and editors wait meanwhile. */
  private growing?: number;
  /**
   * The last grow that waited or failed: said at once for each wanted size and outcome, and again (rate-limited, w5906)
   * when what holds it changes, so the line never names agents that left long ago. And when a failed one is tried again.
   */
  private growNote?: { key: string; text: string; loggedAt: number; reportedAt: number; reported: string };
  private growRetryAt = 0;
  /** The config the monitor judges by: a grow raises its devDriveMaxGB, so the VHDX's room is the new maximum's (w1947). */
  private readonly cfg: Config;

  constructor(settings: MachineGuardSettings, sandboxRoot: string, fx: MachineGuardEffects, ports: MachineGuardPorts) {
    this.settings = settings;
    this.fx = fx;
    this.ports = ports;
    this.cfg = machineGuardConfig(settings, sandboxRoot);
    this.monitor = new HostHealthMonitor({
      cfg: this.cfg,
      statfs: (p) => fx.statfs(p),
      ...(fx.fileBytes ? { fileBytes: (p: string) => fx.fileBytes!(p) } : {}),
      exists: (p) => fx.exists(p),
      mem: () => fx.mem(),
      sandboxes: () => ports.sandboxes(),
      sessions: () => ports.sessions(),
      startEditor: (id) => ports.startEditor(id),
      stopEditor: (id) => ports.stopEditor(id),
      interrupt: (id) => ports.interrupt(id),
      tell: (id, text) => ports.tell(id, text),
      report: (title, body) => ports.report(title, body),
      runHelper: (a) => fx.runHelper(a),
      // The daemon's own clean-up runs alongside (Daemon.cleaner); this guard's never does.
      cleanup: { pass: async () => EMPTY_RUN, consumers: async () => [], log: () => undefined, diskPaths: () => [] },
      ...(fx.reap ? { reap: (h: number) => fx.reap!(h) } : {}),
      changed: (h) => ports.changed(h),
      ...(ports.poolFloor
        ? {
            sandboxFloor: () => {
              const f = ports.poolFloor!();
              // w5167: and the portal's disk gate's margin, so a level lifts at the very reading that clears a disk gate
              // (diskAboveLine): with the Dev Drive install's hysteresisGB 10, lothdesktop's guard still refused new agents
              // at 24 GB free (2026-11-23 03:49Z) after the gate had resumed them at 15 + 5 GB.
              return f && f.warnGB > 0 ? { warnFreeGB: f.warnGB, criticalFreeGB: Math.min(f.criticalGB > 0 ? f.criticalGB : DISK_CRITICAL_GB_DEFAULT, f.warnGB), hysteresisGB: DISK_RESUME_MARGIN_GB } : undefined;
            },
          }
        : {}),
      ...(fx.now ? { now: () => fx.now!() } : {}),
      log: (line) => ports.log(line),
    });
  }

  /** Why a new agent or editor in a sandbox must wait (the drive is gone or growing, disk space is low), or undefined. */
  blockReason(kind: 'editor' | 'agent', o: { diskCleanup?: boolean } = {}): string | undefined {
    if (this.growing) return `the Dev Drive is being grown to ${this.growing} GB (detached for a minute or two, w1918); try again in a few minutes`;
    return this.monitor.blockReason(kind, o);
  }

  get health(): HostHealth {
    return this.monitor.status;
  }

  async tick(): Promise<void> {
    // While it grows the drive is detached on purpose: the helper attaches it again, so no look (and no remount) meanwhile.
    if (this.growing) return;
    await this.monitor.tick();
    await this.growIfIdle();
  }

  /** The Dev Drive's wanted maximum (devdrive.json wantGB, which an update writes from dev_drive_max_gb) above its own, or undefined. */
  pendingGrow(): { wantGB: number; maxGB: number } | undefined {
    const vhdx = this.settings.devDriveVhdx;
    if (!vhdx || !this.fx.readJson) return undefined;
    const st = this.fx.readJson(path.join(path.dirname(vhdx), 'devdrive.json')) as { wantGB?: unknown; maxGB?: unknown } | undefined;
    const wantGB = Number(st?.wantGB);
    const maxGB = Number(st?.maxGB) || 0;
    return Number.isInteger(wantGB) && wantGB > maxGB ? { wantGB, maxGB } : undefined;
  }

  /**
   * Grow the Dev Drive to its wanted maximum through ffsb-helper-grow (w1918, lothsahn: "having the daemon drop and recreate
   * the drive when the setting changes and there's no active workers also seems fine"): only when nothing in a sandbox
   * would lose work and the drive is there; new ones wait (blockReason) until it is back. An agent mid-turn, waiting on a
   * permission, mid-tool, with a pending check-in or a timed run, or an editor up, holds it. An agent between turns with
   * none of those does not (w5906, lothsahn: "An agent host pid was blocking the grow"): once nothing else holds the grow,
   * its host is stopped through the daemon's stop op and the grow runs in the same look. Until then it is pending, and says
   * why, again whenever that changes. ReFS cannot shrink, so a smaller maximum is not done here: making the drive again is a
   * reinstall.
   */
  private async growIfIdle() {
    const p = this.pendingGrow();
    if (!p) return void (this.growNote = undefined);
    const now = this.fx.now?.() ?? Date.now();
    // At once for each wanted size and outcome; again when the reason changes, rate-limited (w5906: the one line named
    // slot2 and slot5 long after they had cleared).
    const say = (title: string, text: string) => {
      const key = `${title} ${p.wantGB}`;
      const n = this.growNote;
      if (n?.key !== key) {
        this.ports.log(`host guard: ${text}`);
        this.ports.report(title, text);
        this.growNote = { key, text, loggedAt: now, reportedAt: now, reported: text };
        return;
      }
      if (n.text !== text && now - n.loggedAt >= GROW_NOTE_LOG_MS) {
        this.ports.log(`host guard: ${text}`);
        Object.assign(n, { text, loggedAt: now });
      }
      if (n.reported !== text && now - n.reportedAt >= GROW_NOTE_REPORT_MS) {
        this.ports.report(title, text);
        Object.assign(n, { reported: text, reportedAt: now });
      }
    };
    const sessions = this.ports.sessions().filter((s) => s.sandboxId && HOLDS_SANDBOX.has(s.status));
    // An agent between turns that nothing of its own keeps (w5906); without the daemon's stop, every agent holds.
    const holdOf = (s: SessionInfo) => (s.status !== 'idle' ? s.status : s.activeTool ? `mid-tool, ${s.activeTool.name}` : this.ports.idleHold?.(s.id));
    const idle = this.ports.stopIdle ? sessions.filter((s) => !holdOf(s)) : [];
    const agents = sessions.filter((s) => !idle.includes(s));
    const editors = this.ports.sandboxes().filter((s) => EDITOR_HELD.has(s.unity.state));
    if (agents.length || editors.length) {
      const what = [agents.length ? `${agents.length} agent(s) (${agents.map((s) => `${s.sandboxId}: ${holdOf(s) ?? s.status}`).join(', ')})` : '', editors.length ? `${editors.length} editor(s) (${editors.map((s) => s.id).join(', ')})` : ''].filter(Boolean).join(' and ');
      return say('Dev Drive: grow pending', `the Dev Drive grows from ${p.maxGB} to ${p.wantGB} GB once no agent that would lose work and no editor is in a sandbox; ${what} there now`);
    }
    if (this.monitor.status.sandboxRoot !== 'ok' || now < this.growRetryAt) return;
    // w3721: the grow detaches the drive, which ends every process run from it, CI runners' listeners included (LothDesktop's
    // ffu-lothdesktop-1 and -2 live on V:, and the 2026-11-08 20:33Z grow left both offline: nothing starts them again). So
    // it waits for a job on such a runner to end, and starts every listener that was up again once the drive is back.
    const runners = (await this.fx.runners?.().catch(() => [])) ?? [];
    const onDrive = runners.filter((r) => sameDrive(r.root, this.cfg.sandboxRoot));
    const jobs = onDrive.filter((r) => r.busy);
    if (jobs.length) return say('Dev Drive: grow pending', `the Dev Drive grows from ${p.maxGB} to ${p.wantGB} GB once no CI job runs on a runner on the drive; ${jobs.length} runner(s) (${jobs.map((r) => runnerName(r.root)).join(', ')}) run one now`);
    // w5906: only now, with nothing else in the way, are the idle agents' hosts stopped; one still up waits for the next look.
    if (idle.length) {
      this.ports.log(`host guard: stopping ${idle.length} idle agent(s) (${idle.map((s) => `${s.id.slice(0, 8)} in ${s.sandboxId}`).join(', ')}) for the Dev Drive grow; each resumes at its next message`);
      const gone = await Promise.all(idle.map((s) => this.ports.stopIdle!(s.id).catch(() => false)));
      const up = idle.filter((_, i) => !gone[i]);
      if (up.length) return say('Dev Drive: grow pending', `the Dev Drive grows from ${p.maxGB} to ${p.wantGB} GB once the idle agent(s) it stopped have ended; ${up.length} (${up.map((s) => s.sandboxId).join(', ')}) still up`);
      // One that started a turn meanwhile holds it again.
      const back = this.ports.sessions().filter((s) => s.sandboxId && HOLDS_SANDBOX.has(s.status) && !idle.some((x) => x.id === s.id));
      if (back.length) return;
    }
    this.growing = p.wantGB;
    this.ports.log(`host guard: growing the Dev Drive from ${p.maxGB} to ${p.wantGB} GB (ffsb-helper-grow); new agents and editors wait`);
    try {
      const r = await this.fx.runHelper('grow');
      if (r.ok) {
        this.growNote = undefined;
        this.growRetryAt = 0;
        // daemon.json still says the old maximum until the next update writes it: judge the host's room by the new one now.
        this.cfg.hostGuard.devDriveMaxGB = p.wantGB;
        this.ports.log(`host guard: ${r.detail}`);
        this.ports.report('Dev Drive: grown', r.detail);
      } else {
        this.growRetryAt = now + GROW_RETRY_MS;
        say('Dev Drive: grow failed', `growing the Dev Drive from ${p.maxGB} to ${p.wantGB} GB failed (${r.detail}); tried again in ${GROW_RETRY_MS / 60_000} min`);
      }
    } finally {
      this.growing = undefined;
      if (onDrive.length) await this.restartRunners(onDrive.map((r) => r.root));
    }
    await this.monitor.tick();
  }

  /** Start again each runner listener of these folders that the grow ended (w3721), and say what came back. */
  private async restartRunners(roots: string[]) {
    const up = new Set(((await this.fx.runners?.().catch(() => [])) ?? []).map((r) => flatLower(r.root)));
    const gone = roots.filter((r) => !up.has(flatLower(r)));
    if (!gone.length) return;
    // w5916: a held machine's runners stay off: the hold starts them when it lifts.
    if (this.ports.deferRunners?.(gone)) {
      const text = `the grow ended ${gone.length} CI runner listener(s) on the drive (${gone.map(runnerName).join(', ')}); this machine is held, so they start again when the hold lifts`;
      this.ports.log(`host guard: ${text}`);
      this.ports.report('Dev Drive: CI runners wait for the hold', text);
      return;
    }
    if (!this.fx.restartRunner) return;
    const lines: string[] = [];
    let failed = 0;
    for (const root of gone) {
      try {
        lines.push(`${runnerName(root)}: started again (${await this.fx.restartRunner(root)})`);
      } catch (e) {
        failed++;
        lines.push(`${runnerName(root)}: could not start it again (${(e as Error).message.slice(0, 200)})`);
      }
    }
    const text = `the grow ended ${gone.length} CI runner listener(s) on the drive: ${lines.join('; ')}`;
    this.ports.log(`host guard: ${text}`);
    this.ports.report(failed ? 'Dev Drive: CI runners still down' : 'Dev Drive: CI runners started again', text);
  }

  start() {
    if (this.settings.pollSeconds <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.settings.pollSeconds * 1000);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 5000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The real effects on this machine (Windows: the privileged helpers and the reaper are Windows-only). */
export async function realGuardEffects(procs?: () => Promise<Proc[]>): Promise<MachineGuardEffects> {
  const { runHelper } = await import('../server/privileged.ts');
  const { reapBrowsers } = await import('../server/reaper.ts');
  const { run } = await import('../server/proc.ts');
  return {
    ...(procs && process.platform === 'win32'
      ? {
          runners: async () => {
            const c = runnerCensus(await procs());
            return c.listeners.map((l) => ({ root: l.root, busy: l.busy || c.workers.some((w) => w.root === l.root) }));
          },
          restartRunner: async (root: string) => {
            const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', runnerRestartScript(root)], { timeoutMs: 60_000 });
            if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
            return r.stdout.trim() || 'started';
          },
        }
      : {}),
    exists: (p) => fs.existsSync(p),
    statfs: async (p) => {
      try {
        const s = await fs.promises.statfs(p);
        return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
      } catch {
        return undefined;
      }
    },
    fileBytes: (p) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return undefined;
      }
    },
    mem: () => ({ free: os.freemem(), total: os.totalmem() }),
    // A grow detaches, expands and reattaches the drive: a few minutes on a busy disk.
    runHelper: (a) => runHelper(a, a === 'grow' ? 20 * 60_000 : undefined),
    reap: (h) => reapBrowsers(h),
    readJson: (p) => {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        return undefined;
      }
    },
  };
}
