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
import { HostHealthMonitor } from '../server/hostHealth.ts';
import type { HelperAction, HelperResult } from '../server/privileged.ts';
import { DISK_CRITICAL_GB_DEFAULT, type HostHealth, type MachineGuardSettings, type Sandbox, type SessionInfo } from '../shared/types.ts';

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
}

/** Sessions that hold a sandbox (hostHealth.ts's BUSY plus an agent between turns, whose process still runs there). */
const HOLDS_SANDBOX = new Set(['starting', 'running', 'waiting_permission', 'idle']);
const EDITOR_HELD = new Set(['running', 'starting', 'blocked']);
/** A grow that failed is tried again after this long, not on every look. */
export const GROW_RETRY_MS = 30 * 60_000;

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

/** The guard on this machine: tick() on a timer, blockReason() before an agent or editor starts in a sandbox. */
export class MachineGuard {
  readonly monitor: HostHealthMonitor;
  readonly settings: MachineGuardSettings;
  private timer?: NodeJS.Timeout;
  private readonly fx: MachineGuardEffects;
  private readonly ports: MachineGuardPorts;
  /** The Dev Drive's maximum being grown to (w1918): new agents and editors wait meanwhile. */
  private growing?: number;
  /** The last grow that waited or failed, said once each (the portal hears it), and when a failed one is tried again. */
  private growNote?: string;
  private growRetryAt = 0;

  constructor(settings: MachineGuardSettings, sandboxRoot: string, fx: MachineGuardEffects, ports: MachineGuardPorts) {
    this.settings = settings;
    this.fx = fx;
    this.ports = ports;
    this.monitor = new HostHealthMonitor({
      cfg: machineGuardConfig(settings, sandboxRoot),
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
              return f && f.warnGB > 0 ? { warnFreeGB: f.warnGB, criticalFreeGB: Math.min(f.criticalGB > 0 ? f.criticalGB : DISK_CRITICAL_GB_DEFAULT, f.warnGB) } : undefined;
            },
          }
        : {}),
      ...(fx.now ? { now: () => fx.now!() } : {}),
      log: (line) => ports.log(line),
    });
  }

  /** Why a new agent or editor in a sandbox must wait (the drive is gone or growing, disk space is low), or undefined. */
  blockReason(kind: 'editor' | 'agent'): string | undefined {
    if (this.growing) return `the Dev Drive is being grown to ${this.growing} GB (detached for a minute or two, w1918); try again in a few minutes`;
    return this.monitor.blockReason(kind);
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
   * the drive when the setting changes and there's no active workers also seems fine"): only when no agent and no editor is
   * in a sandbox and the drive is there; new ones wait (blockReason) until it is back. Until then it is pending, and says why
   * once. ReFS cannot shrink, so a smaller maximum is not done here: making the drive again is a reinstall.
   */
  private async growIfIdle() {
    const p = this.pendingGrow();
    if (!p) return void (this.growNote = undefined);
    const now = this.fx.now?.() ?? Date.now();
    // Once per wanted size and outcome, not at every change of who is in the sandboxes.
    const say = (title: string, text: string) => {
      const key = `${title} ${p.wantGB}`;
      if (this.growNote === key) return;
      this.growNote = key;
      this.ports.log(`host guard: ${text}`);
      this.ports.report(title, text);
    };
    const agents = this.ports.sessions().filter((s) => s.sandboxId && HOLDS_SANDBOX.has(s.status));
    const editors = this.ports.sandboxes().filter((s) => EDITOR_HELD.has(s.unity.state));
    if (agents.length || editors.length) {
      const what = [agents.length ? `${agents.length} agent(s) (${agents.map((s) => s.sandboxId).join(', ')})` : '', editors.length ? `${editors.length} editor(s) (${editors.map((s) => s.id).join(', ')})` : ''].filter(Boolean).join(' and ');
      return say('Dev Drive: grow pending', `the Dev Drive grows from ${p.maxGB} to ${p.wantGB} GB once no agent or editor is in a sandbox; ${what} there now`);
    }
    if (this.monitor.status.sandboxRoot !== 'ok' || now < this.growRetryAt) return;
    this.growing = p.wantGB;
    this.ports.log(`host guard: growing the Dev Drive from ${p.maxGB} to ${p.wantGB} GB (ffsb-helper-grow); new agents and editors wait`);
    try {
      const r = await this.fx.runHelper('grow');
      if (r.ok) {
        this.growNote = undefined;
        this.growRetryAt = 0;
        this.ports.log(`host guard: ${r.detail}`);
        this.ports.report('Dev Drive: grown', r.detail);
      } else {
        this.growRetryAt = now + GROW_RETRY_MS;
        say('Dev Drive: grow failed', `growing the Dev Drive from ${p.maxGB} to ${p.wantGB} GB failed (${r.detail}); tried again in ${GROW_RETRY_MS / 60_000} min`);
      }
    } finally {
      this.growing = undefined;
    }
    await this.monitor.tick();
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
export async function realGuardEffects(): Promise<MachineGuardEffects> {
  const { runHelper } = await import('../server/privileged.ts');
  const { reapBrowsers } = await import('../server/reaper.ts');
  return {
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
