// The host guard on a machine's daemon (w466, docs/portal-on-ffbox-host.md change 4, decided as D11): BEAST's sandbox
// Dev Drive watch, its remount through the ffsb-helper-mount task with retries (at once, then 2, 5, 10 and 30 minutes),
// then that machine's editors restarted and its interrupted agents resumed; the disk guard over the volumes that hold
// the drive, and the headless-browser reaper. They ran in the portal while it lived on BEAST; when it moves to its VM
// they stay with BEAST, in its daemon. The decisions are server/hostHealth.ts's HostHealthMonitor, unchanged: this
// gives it the daemon's pool, agents and link instead of the portal's. docs/self-recovery.md, "On BEAST's daemon".
import fs from 'node:fs';
import os from 'node:os';
import type { Config, HostGuardConfig } from '../server/config.ts';
import { DEFAULT_CLEANUP } from '../server/config.ts';
import { HostHealthMonitor } from '../server/hostHealth.ts';
import type { HelperAction, HelperResult } from '../server/privileged.ts';
import type { HostHealth, MachineGuardSettings, Sandbox, SessionInfo } from '../shared/types.ts';

export type { MachineGuardSettings };

/** What the guard does on the machine: the daemon's own effects (tests give fakes). */
export interface MachineGuardEffects {
  exists(p: string): boolean;
  statfs(p: string): Promise<{ free: number; total: number } | undefined>;
  mem(): { free: number; total: number };
  runHelper(action: HelperAction): Promise<HelperResult>;
  reap?(maxAgeHours: number): Promise<string[]>;
  now?(): number;
}

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
    devDriveVhdx: '',
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

  constructor(settings: MachineGuardSettings, sandboxRoot: string, fx: MachineGuardEffects, ports: MachineGuardPorts) {
    this.settings = settings;
    this.monitor = new HostHealthMonitor({
      cfg: machineGuardConfig(settings, sandboxRoot),
      statfs: (p) => fx.statfs(p),
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
      ...(fx.now ? { now: () => fx.now!() } : {}),
      log: (line) => ports.log(line),
    });
  }

  /** Why a new agent or editor in a sandbox must wait (the drive is gone, disk space is low), or undefined. */
  blockReason(kind: 'editor' | 'agent'): string | undefined {
    return this.monitor.blockReason(kind);
  }

  get health(): HostHealth {
    return this.monitor.status;
  }

  tick(): Promise<void> {
    return this.monitor.tick();
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
    mem: () => ({ free: os.freemem(), total: os.totalmem() }),
    runHelper: (a) => runHelper(a),
    reap: (h) => reapBrowsers(h),
  };
}
