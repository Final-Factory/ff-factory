import fs from 'node:fs';
import path from 'node:path';
import { hostSoftFreeGB, type Config, type HostGuardConfig } from './config.ts';
import { CleanupRunner, describeCleanupItems, type CleanupRun, type PassOptions, type VolumeStat } from './cleanup.ts';
import { staleOutputSettings } from './staleOutput.ts';
import type { HelperAction, HelperResult } from './privileged.ts';
import type { DiskLevel, HostHealth, Sandbox, SessionInfo } from '../shared/types.ts';

/**
 * The host guard (docs/self-recovery.md): watches free disk space, the sandbox drive and memory, and acts so
 * that a full disk or a lost Dev Drive heals without anyone at the desk. The decisions are pure functions
 * (tested in hostHealth.test.ts); HostHealthMonitor runs them on a timer against injected effects. Two run it: the
 * portal, over its own data volume and its clean-up (no sandbox drive: it holds no sandboxes, w510), and a machine's
 * daemon, over that machine's sandbox drive (machine/hostGuard.ts; BEAST's Dev Drive, w466).
 */

const GB = 1024 ** 3;
const BUSY = new Set(['running', 'starting', 'waiting_permission']);
const EDITOR_UP = new Set(['running', 'starting', 'blocked']);

/** A volume's guard level, with hysteresis: a level clears only `hysteresisGB` above its threshold. */
export function diskLevel(freeGB: number | undefined, prev: DiskLevel, g: Pick<HostGuardConfig, 'warnFreeGB' | 'criticalFreeGB' | 'hysteresisGB'>): DiskLevel {
  if (freeGB === undefined) return prev;
  if (freeGB < g.criticalFreeGB || (prev === 'critical' && freeGB < g.criticalFreeGB + g.hysteresisGB)) return 'critical';
  if (freeGB < g.warnFreeGB || (prev !== 'ok' && freeGB < g.warnFreeGB + g.hysteresisGB)) return 'warn';
  return 'ok';
}

export const worstLevel = (levels: DiskLevel[]): DiskLevel => (levels.includes('critical') ? 'critical' : levels.includes('warn') ? 'warn' : 'ok');

/** Why a new editor or a new agent process is refused right now, or undefined. */
export function blockReason(
  h: Pick<HostHealth, 'sandboxRoot' | 'level' | 'disks' | 'detail'>,
  kind: 'editor' | 'agent',
  mem: { freeGB: number; minFreeRamGB: number },
): string | undefined {
  if (h.sandboxRoot !== 'ok') return `the sandbox drive is offline (${h.sandboxRoot}${h.detail ? `: ${h.detail}` : ''}); the app is reattaching it and resumes the work afterwards`;
  if (h.level !== 'ok') {
    const low = h.disks.filter((d) => d.level !== 'ok').map((d) => `${d.path} ${d.freeBytes === undefined ? '?' : (d.freeBytes / GB).toFixed(0)} GB free`);
    return `disk space is ${h.level === 'critical' ? 'critically ' : ''}low (${low.join(', ')}); new ${kind === 'editor' ? 'editors' : 'agent processes'} wait until space is freed`;
  }
  if (kind === 'editor' && mem.minFreeRamGB > 0 && mem.freeGB < mem.minFreeRamGB) {
    return `only ${mem.freeGB.toFixed(1)} GB of RAM is free and an editor needs about ${mem.minFreeRamGB} GB (limits.minFreeRamGB); stop an editor first`;
  }
  return undefined;
}

/** Wait before the n-th remount attempt (1-based): at once, then 2, 5, 10, 30 minutes. */
export function remountDelayMs(attempt: number): number {
  return [0, 0, 2, 5, 10, 30][Math.min(attempt, 5)] * 60_000;
}
export const MAX_REMOUNT_ATTEMPTS = 6;

/** The volume a path lives on ("C:\" or "/"), to watch each volume once. */
export const volumeOf = (p: string) => {
  const P = /^[a-zA-Z]:[\\/]|^\\\\/.test(p) ? path.win32 : path; // Windows paths on any OS (CI runs on Linux)
  return P.parse(P.resolve(p)).root.toUpperCase();
};

export interface HostDeps {
  cfg: Config;
  statfs(p: string): Promise<VolumeStat | undefined>;
  exists(p: string): boolean;
  mem(): { free: number; total: number };
  sandboxes(): Sandbox[];
  sessions(): SessionInfo[];
  startEditor(id: string): Promise<void>;
  stopEditor(id: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** A system message to a session (resume, checkpoint request); starts its process if needed, past the gate. */
  tell(sessionId: string, text: string): void;
  /** A message to the orchestrator, and a push notification to the user. */
  report(title: string, body: string): void;
  runHelper(action: HelperAction): Promise<HelperResult>;
  /** The continuous clean-up (server/cleanup.ts): one pass, the biggest consumers, the log, the volumes it frees. */
  cleanup: {
    pass(low: boolean, opts: PassOptions): Promise<CleanupRun>;
    consumers(): Promise<{ path: string; bytes: number }[]>;
    stale?(): Promise<{ path: string; days: number }[]>;
    log(entry: object): void;
    /** The disk the clean-up keys off (home, data); hostDiskPaths are added. */
    diskPaths(): string[];
    /** Temp folders: reported apart, never counted as the disk (CleanupRunnerDeps.tempPaths, w566). */
    tempPaths?(): string[];
    /** When the stale-output rules last had their turn, kept on disk (server/cleanup.ts staleAtFile). */
    staleAt?: { load(): number | undefined; save(at: number): void };
  };
  /** Kill stale automation browsers (server/reaper.ts); one line per reaped tree. */
  reap?(maxAgeHours: number): Promise<string[]>;
  changed(h: HostHealth): void;
  /**
   * Whether this guard owns a sandbox drive (cfg.sandboxRoot) to watch and reattach (default yes: a machine's daemon,
   * machine/hostGuard.ts). The portal's own guard says no (w510): it holds no sandboxes, and watches its data volume.
   */
  watchDrive?(): boolean;
  now?(): number;
  log?(line: string): void;
}

interface Recovery {
  since: number;
  editors: string[];
  sessions: string[];
  attempts: number;
  nextTryAt: number;
  waitingForSpace?: boolean;
}

export class HostHealthMonitor {
  private readonly d: HostDeps;
  private health: HostHealth;
  private levels = new Map<string, DiskLevel>();
  private snapshot: { editors: string[]; sessions: string[] } = { editors: [], sessions: [] };
  private recovery?: Recovery;
  private helperBusy = false;
  private lastCleanupAt = 0;
  readonly cleaner: CleanupRunner;
  private criticalSince = 0;
  private lastReapAt = 0;
  private ticking = false;
  /** The drive was missing when this server started (a reboot or a power cut), not lost while it ran. */
  private bootMissing = false;

  constructor(deps: HostDeps) {
    this.d = deps;
    const m = deps.mem();
    // After a reboot the sandbox drive may not be attached yet: nothing may start on it before the guard has seen it.
    const drive = this.watchesDrive() && !deps.exists(deps.cfg.sandboxRoot) ? 'missing' : 'ok';
    this.health = { checkedAt: new Date(0).toISOString(), disks: [], level: 'ok', sandboxRoot: drive, memFreeBytes: m.free, memTotalBytes: m.total };
    this.bootMissing = drive === 'missing';
    this.cleaner = new CleanupRunner({
      settings: () => ({ everyMinutes: this.g().cleanup.everyMinutes, softFreeGB: hostSoftFreeGB(this.g()), staleOutput: staleOutputSettings(this.g().cleanup.staleOutput) }),
      diskPaths: () => [...deps.cleanup.diskPaths(), ...deps.cfg.hostDiskPaths],
      tempPaths: () => deps.cleanup.tempPaths?.() ?? [],
      statfs: (p) => deps.statfs(p),
      pass: (low, opts) => deps.cleanup.pass(low, opts),
      consumers: () => deps.cleanup.consumers(),
      stale: deps.cleanup.stale && (() => deps.cleanup.stale!()),
      log: (e) => deps.cleanup.log(e),
      staleAt: deps.cleanup.staleAt,
      done: (summary, notice) => {
        this.health.lastCleanup = summary;
        if (notice) this.d.report('Clean-up cannot free enough disk space', notice);
      },
      now: deps.now,
    });
  }

  private now() {
    return this.d.now ? this.d.now() : Date.now();
  }

  get status(): HostHealth {
    return this.health;
  }

  /** Why a new editor / agent process must wait, or undefined. */
  blockReason(kind: 'editor' | 'agent'): string | undefined {
    // Between two looks, a drive that is gone blocks at once (the next look starts the remount).
    const gone = this.health.sandboxRoot === 'ok' && this.watchesDrive() && !this.d.exists(this.d.cfg.sandboxRoot);
    const h = gone ? { ...this.health, sandboxRoot: 'missing' as const } : this.health;
    return blockReason(h, kind, { freeGB: this.d.mem().free / GB, minFreeRamGB: this.d.cfg.limits.minFreeRamGB });
  }

  /** This guard has a sandbox drive (HostDeps.watchDrive): a machine's daemon's does, the portal's does not (w510). */
  private ownsDrive() {
    return this.d.watchDrive?.() ?? true;
  }

  /** The guard runs (hostGuard.pollSeconds > 0) and owns a drive: only then is a missing drive reattached, so only then does it block. */
  private watchesDrive() {
    return this.d.cfg.hostGuard.pollSeconds > 0 && this.ownsDrive();
  }

  private g() {
    return this.d.cfg.hostGuard;
  }

  /** One look: measure, decide, act. Never throws; overlapping calls are dropped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.measure();
      await this.sandboxDrive();
      await this.diskGuard();
      await this.reapBrowsers();
      // The regular pass, and sooner below the soft threshold: before the warn level blocks new work. Not awaited:
      // a pass can walk big folders for minutes, and the guard must keep looking meanwhile.
      if (this.health.sandboxRoot === 'ok') void this.cleaner.tick().catch((e) => this.d.log?.(`clean-up failed: ${(e as Error).message}`));
      this.health.blocked = this.blockReason('agent');
      this.d.changed(this.health);
    } catch (e) {
      this.d.log?.(`host guard: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async measure() {
    const cfg = this.d.cfg;
    // The portal holds no sandboxes (w510): its data volume (state, transcripts, attachments) is what fills up there.
    const paths = [...new Map([this.ownsDrive() ? cfg.sandboxRoot : cfg.dataDir, ...cfg.hostDiskPaths].map((p) => [volumeOf(p), p])).values()];
    const disks: HostHealth['disks'] = [];
    for (const p of paths) {
      const st = this.d.exists(p) ? await this.d.statfs(p) : undefined;
      const level = diskLevel(st ? st.free / GB : undefined, this.levels.get(p) ?? 'ok', this.g());
      this.levels.set(p, level);
      disks.push({ path: p, freeBytes: st?.free, totalBytes: st?.total, level });
    }
    const m = this.d.mem();
    this.health = {
      ...this.health,
      checkedAt: new Date(this.now()).toISOString(),
      disks,
      level: worstLevel(disks.map((x) => x.level)),
      memFreeBytes: m.free,
      memTotalBytes: m.total,
    };
  }

  /** Free space on the volumes that hold the sandbox drive's VHDX (config hostDiskPaths), in GB. */
  private hostFreeGB(): number | undefined {
    const host = this.health.disks.filter((x) => this.d.cfg.hostDiskPaths.some((p) => volumeOf(p) === volumeOf(x.path)));
    const free = host.map((x) => x.freeBytes).filter((b): b is number => b !== undefined);
    return free.length ? Math.min(...free) / GB : undefined;
  }

  // ------------------------------------------------------------ the sandbox drive

  private async sandboxDrive() {
    if (!this.watchesDrive()) {
      // No drive of its own (the portal), or the guard is off.
      this.recovery = undefined;
      this.health.sandboxRoot = 'ok';
      this.health.detail = undefined;
      return;
    }
    const root = this.d.cfg.sandboxRoot;
    const there = this.d.exists(root);
    if (there) {
      this.bootMissing = false;
      if (this.recovery) await this.recovered();
      this.health.sandboxRoot = 'ok';
      this.health.detail = undefined;
      // What to bring back if the drive goes: editors up, and agents mid-turn in sandboxes.
      this.snapshot = {
        editors: this.d.sandboxes().filter((s) => EDITOR_UP.has(s.unity.state)).map((s) => s.id),
        sessions: this.d.sessions().filter((s) => s.sandboxId && BUSY.has(s.status)).map((s) => s.id),
      };
      return;
    }
    if (!this.recovery) await this.lost();
    const r = this.recovery!;
    if (this.helperBusy || this.now() < r.nextTryAt || this.health.sandboxRoot === 'failed') return;
    const free = this.hostFreeGB();
    if (free !== undefined && free < this.g().remountMinFreeGB) {
      if (this.now() - this.lastCleanupAt > 10 * 60_000) void this.cleanup('critical');
      if (!r.waitingForSpace) this.d.report('Sandbox drive: waiting for disk space', `The host volume has ${free.toFixed(0)} GB free; reattaching the sandbox drive needs ${this.g().remountMinFreeGB} GB (hostGuard.remountMinFreeGB). Cleaning up what is safe; waiting for more.`);
      r.waitingForSpace = true;
      r.nextTryAt = this.now() + 5 * 60_000;
      this.health.detail = `waiting for ${this.g().remountMinFreeGB} GB free on the host volume (${free.toFixed(0)} GB now)`;
      return;
    }
    r.waitingForSpace = false;
    r.attempts++;
    this.health.sandboxRoot = 'remounting';
    this.health.detail = `attempt ${r.attempts} of ${MAX_REMOUNT_ATTEMPTS}`;
    this.helperBusy = true;
    const res = await this.d.runHelper('mount').finally(() => (this.helperBusy = false));
    if (res.ok && this.d.exists(root)) return this.recovered();
    if (r.attempts >= MAX_REMOUNT_ATTEMPTS) {
      this.health.sandboxRoot = 'failed';
      this.health.detail = res.detail;
      this.d.report('Sandbox drive: could not reattach it', `${MAX_REMOUNT_ATTEMPTS} attempts failed (last: ${res.detail}). Restarting this machine's daemon (machine_daemon restart) tries again; a reboot is the last resort.`);
      return;
    }
    r.nextTryAt = this.now() + remountDelayMs(r.attempts + 1);
    this.health.sandboxRoot = 'missing';
    this.health.detail = `attempt ${r.attempts} failed (${res.detail}); next in ${Math.round(remountDelayMs(r.attempts + 1) / 60_000)} min`;
  }

  private async lost() {
    const busyNow = this.d.sessions().filter((s) => s.sandboxId && BUSY.has(s.status)).map((s) => s.id);
    this.recovery = {
      since: this.now(),
      editors: [...this.snapshot.editors],
      sessions: [...new Set([...this.snapshot.sessions, ...busyNow])],
      attempts: 0,
      nextTryAt: this.now(),
    };
    this.health.sandboxRoot = 'missing';
    if (this.bootMissing) {
      this.bootMissing = false;
      this.d.report('Sandbox drive not attached at startup', `${this.d.cfg.sandboxRoot} was not there when the app started (a reboot or a power cut). Nothing starts on it until it is back; reattaching it automatically.`);
      return;
    }
    // Agents in sandboxes cannot work without their folders: stop their turns now; they are resumed later.
    for (const id of busyNow) await this.d.interrupt(id).catch(() => undefined);
    this.d.report(
      'Sandbox drive is gone',
      `${this.d.cfg.sandboxRoot} disappeared. ${this.recovery.editors.length} editor(s) and ${this.recovery.sessions.length} agent(s) were working there; their turns were stopped. Reattaching it automatically, then restarting those editors and resuming those agents.`,
    );
  }

  private async recovered() {
    const r = this.recovery!;
    this.recovery = undefined;
    this.health.sandboxRoot = 'ok';
    this.health.detail = undefined;
    const mins = Math.round((this.now() - r.since) / 60_000);
    this.d.report('Sandbox drive is back', `${this.d.cfg.sandboxRoot} is back after ${mins} min. Restarting ${r.editors.length} editor(s) one at a time, then resuming ${r.sessions.length} agent(s).`);
    const failed: string[] = [];
    for (const id of r.editors) {
      try {
        await this.d.startEditor(id);
      } catch (e) {
        failed.push(`${id}: ${(e as Error).message}`);
      }
    }
    for (const id of r.sessions) {
      try {
        this.d.tell(
          id,
          `The sandbox drive went offline at ${new Date(r.since).toLocaleTimeString()} and was reattached ${mins} min later; your turn was stopped. Your worktree is back. Check git status for half-written edits (a write may have been lost at the moment it vanished), re-pin your Unity instance if you use it (the editor is being restarted; unity action "status" says when it is up), and continue where you left off.`,
        );
      } catch (e) {
        failed.push(`${id}: ${(e as Error).message}`);
      }
    }
    if (failed.length) this.d.report('Sandbox drive: some work did not come back', failed.join('; '));
  }

  // ------------------------------------------------------------ disk space

  private async diskGuard() {
    const lvl = this.health.level;
    const prev = this.criticalSince ? 'critical' : undefined;
    if (lvl !== 'ok' && this.lastReported !== lvl) {
      const low = this.health.disks.filter((x) => x.level !== 'ok').map((x) => `${x.path}: ${((x.freeBytes ?? 0) / GB).toFixed(0)} GB free`).join(', ');
      this.d.report(
        lvl === 'critical' ? 'Disk space critical' : 'Disk space low',
        `${low}. ${lvl === 'critical' ? `Below ${this.g().criticalFreeGB} GB: agents are asked to checkpoint, idle editors stop, known-safe junk is removed.` : `Below ${this.g().warnFreeGB} GB: no new editors or agent processes until space is freed.`}`,
      );
    }
    if (lvl === 'ok' && this.lastReported && this.lastReported !== 'ok') this.d.report('Disk space is fine again', this.health.disks.map((x) => `${x.path}: ${((x.freeBytes ?? 0) / GB).toFixed(0)} GB free`).join(', '));
    this.lastReported = lvl;
    if (lvl !== 'critical') {
      this.criticalSince = 0;
      return;
    }
    const first = !prev;
    if (first) this.criticalSince = this.now();
    if (this.now() - this.lastCleanupAt > 10 * 60_000) void this.cleanup('critical');
    if (first) {
      for (const s of this.d.sessions().filter((x) => x.kind !== 'orchestrator' && !x.machineId && BUSY.has(x.status))) {
        try {
          this.d.tell(s.id, '[disk critical] Free disk space on this machine is critically low. Commit and push your work now (a WIP commit is fine) and end your turn; new work waits until space is freed. You will be told when to continue.');
        } catch {
          // it will see the gate on its next action
        }
      }
    }
    const busySandboxes = new Set(this.d.sessions().filter((s) => s.sandboxId && BUSY.has(s.status)).map((s) => s.sandboxId));
    for (const sb of this.d.sandboxes().filter((s) => s.unity.state === 'running' && !busySandboxes.has(s.id))) {
      await this.d.stopEditor(sb.id).catch(() => undefined);
      this.d.report('Stopped an idle editor (disk critical)', `${sb.id}: no agent was mid-turn there.`);
    }
  }
  private lastReported?: DiskLevel;

  /** A pass now (critical disk, waiting to remount, asked for), at most every 10 minutes unless asked. */
  private async cleanup(trigger: 'critical' | 'asked') {
    this.lastCleanupAt = this.now();
    await this.cleaner.run(trigger).catch((e) => this.d.log?.(`clean-up failed: ${(e as Error).message}`));
    await this.measure();
  }

  /** The orphan headless-browser reaper: at the first look after startup, then every reapEveryMinutes. */
  private async reapBrowsers() {
    const g = this.g();
    if (!this.d.reap || g.reapBrowsersAfterHours <= 0) return;
    if (this.lastReapAt && this.now() - this.lastReapAt < g.reapEveryMinutes * 60_000) return;
    this.lastReapAt = this.now();
    const lines = await this.d.reap(g.reapBrowsersAfterHours).catch((e) => [`reaper failed: ${(e as Error).message}`]);
    if (!lines.length) return;
    for (const l of lines) this.d.log?.(`reaper: ${l}`);
    this.health.lastReap = { at: new Date(this.now()).toISOString(), killed: lines.filter((l) => l.startsWith('killed')).length, lines: lines.slice(0, 10) };
    this.d.report('Reaped leftover headless browsers', lines.join('; '));
  }

  /** host_recovery "cleanup": a pass now, stale output included; `dryRun`: what it would remove, nothing removed (w459). */
  async cleanupNow(opts: { dryRun?: boolean } = {}): Promise<string> {
    if (opts.dryRun) {
      const s = await this.cleaner.run('asked', { dryRun: true });
      return s ? describeCleanupItems(s) : 'A clean-up pass is already running; try again in a few minutes.';
    }
    await this.cleanup('asked');
    const c = this.health.lastCleanup;
    if (!c) return 'Nothing removed (a pass is already running).';
    const low = c.belowSoft ? `\nStill below the soft threshold of ${c.softFreeGB} GB${c.consumers?.length ? `; biggest remaining: ${c.consumers.map((x) => `${x.path} ${(x.bytes / GB).toFixed(1)} GB`).join(', ')}` : ''}.` : '';
    return `${describeCleanupItems(c)}${low}`;
  }
}
