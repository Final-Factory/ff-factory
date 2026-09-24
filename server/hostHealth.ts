import fs from 'node:fs';
import path from 'node:path';
import type { Config, HostGuardConfig } from './config.ts';
import type { HelperAction, HelperResult } from './privileged.ts';
import type { DiskLevel, HostHealth, Sandbox, SessionInfo } from '../shared/types.ts';

/**
 * The host guard (docs/self-recovery.md): watches free disk space, the sandbox drive and memory, and acts so
 * that a full disk or a lost Dev Drive heals without anyone at the desk. The decisions are pure functions
 * (tested in hostHealth.test.ts); HostHealthMonitor runs them on a timer against injected effects.
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

/** Running editors whose sandbox has had no agent activity for `idleMinutes` and no agent mid-turn. */
export function idleEditors(sandboxes: Sandbox[], sessions: SessionInfo[], nowMs: number, idleMinutes: number): string[] {
  if (idleMinutes <= 0) return [];
  const out: string[] = [];
  for (const sb of sandboxes) {
    if (sb.unity.state !== 'running') continue;
    const mine = sessions.filter((s) => s.sandboxId === sb.id);
    if (mine.some((s) => BUSY.has(s.status))) continue;
    const last = Math.max(Date.parse(sb.unity.startedAt ?? '') || 0, ...mine.map((s) => Date.parse(s.lastActivityAt) || 0));
    if (nowMs - last > idleMinutes * 60_000) out.push(sb.id);
  }
  return out;
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
  statfs(p: string): Promise<{ free: number; total: number } | undefined>;
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
  cleanup(): Promise<{ removed: number }>;
  /** Kill stale automation browsers (server/reaper.ts); one line per reaped tree. */
  reap?(maxAgeHours: number): Promise<string[]>;
  changed(h: HostHealth): void;
  now?(): number;
  log?(line: string): void;
}

interface Recovery {
  since: number;
  /** When the remount helper reported the drive back (for the self-test's timings). */
  backAt?: number;
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
  /** Set while a helper detaches the drive on purpose (compaction): its absence is not an outage. */
  private maintenance = false;
  private lastCleanupAt = 0;
  private criticalSince = 0;
  private lastCompactAt = 0;
  private lastReapAt = 0;
  private ticking = false;

  constructor(deps: HostDeps) {
    this.d = deps;
    const m = deps.mem();
    this.health = { checkedAt: new Date(0).toISOString(), disks: [], level: 'ok', sandboxRoot: 'ok', memFreeBytes: m.free, memTotalBytes: m.total };
  }

  private now() {
    return this.d.now ? this.d.now() : Date.now();
  }

  get status(): HostHealth {
    return this.health;
  }

  /** Why a new editor / agent process must wait, or undefined. */
  blockReason(kind: 'editor' | 'agent'): string | undefined {
    return blockReason(this.health, kind, { freeGB: this.d.mem().free / GB, minFreeRamGB: this.d.cfg.limits.minFreeRamGB });
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
      await this.idleEditors();
      await this.reapBrowsers();
      await this.maybeCompact();
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
    const paths = [...new Map([cfg.sandboxRoot, ...cfg.hostDiskPaths].map((p) => [volumeOf(p), p])).values()];
    const disks: HostHealth['disks'] = [];
    for (const p of paths) {
      const st = this.d.exists(p) ? await this.d.statfs(p) : undefined;
      const level = diskLevel(st ? st.free / GB : undefined, this.levels.get(p) ?? 'ok', this.g());
      this.levels.set(p, level);
      disks.push({ path: p, freeBytes: st?.free, totalBytes: st?.total, level });
    }
    const m = this.d.mem();
    this.health = { ...this.health, checkedAt: new Date(this.now()).toISOString(), disks, level: worstLevel(disks.map((x) => x.level)), memFreeBytes: m.free, memTotalBytes: m.total };
  }

  /** Free space on the volumes that hold the sandbox drive's VHDX (config hostDiskPaths), in GB. */
  private hostFreeGB(): number | undefined {
    const host = this.health.disks.filter((x) => this.d.cfg.hostDiskPaths.some((p) => volumeOf(p) === volumeOf(x.path)));
    const free = host.map((x) => x.freeBytes).filter((b): b is number => b !== undefined);
    return free.length ? Math.min(...free) / GB : undefined;
  }

  // ------------------------------------------------------------ the sandbox drive

  private async sandboxDrive() {
    const root = this.d.cfg.sandboxRoot;
    const there = this.d.exists(root);
    if (there) {
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
    if (this.maintenance) return;
    if (!this.recovery) await this.lost();
    const r = this.recovery!;
    if (this.helperBusy || this.now() < r.nextTryAt || this.health.sandboxRoot === 'failed') return;
    const free = this.hostFreeGB();
    if (free !== undefined && free < this.g().remountMinFreeGB) {
      if (this.now() - this.lastCleanupAt > 10 * 60_000) await this.cleanup('the sandbox drive is offline and the host volume is nearly full');
      if (!r.waitingForSpace) this.d.report('Sandbox drive: waiting for disk space', `The host volume has ${free.toFixed(0)} GB free; reattaching the sandbox drive needs ${this.g().remountMinFreeGB} GB (hostGuard.remountMinFreeGB). Cleaned up what is safe; waiting for more.`);
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
    if (res.ok && this.d.exists(root)) {
      r.backAt = this.now();
      return this.recovered();
    }
    if (r.attempts >= MAX_REMOUNT_ATTEMPTS) {
      this.health.sandboxRoot = 'failed';
      this.health.detail = res.detail;
      this.d.report('Sandbox drive: could not reattach it', `${MAX_REMOUNT_ATTEMPTS} attempts failed (last: ${res.detail}). The orchestrator can retry with host_recovery "remount", or reboot as a last resort.`);
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
    this.lastRecovery = { since: r.since, backAt: r.backAt ?? this.now(), attempts: r.attempts };
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
          `The sandbox drive went offline at ${new Date(r.since).toLocaleTimeString()} and was reattached ${mins} min later; your turn was stopped. Your worktree is back. Check git status for half-written edits (a write may have been lost at the moment it vanished), re-pin your Unity instance if you use it (the editor is being restarted; wait_for_unity "ready"), and continue where you left off.`,
        );
      } catch (e) {
        failed.push(`${id}: ${(e as Error).message}`);
      }
    }
    if (failed.length) this.d.report('Sandbox drive: some work did not come back', failed.join('; '));
  }

  private lastRecovery?: { since: number; backAt: number; attempts: number };

  /**
   * The end-to-end recovery self-test (host_recovery "selftest"): with no editor up and no agent busy in a
   * sandbox, detach the sandbox drive through ffsb-helper-detach, as Windows did on 2026-09-24, and let the
   * guard's own recovery notice it, reattach it and bring the sandboxes back. Reports each step's timing.
   * `pollMs` / `timeoutMs` are for tests.
   */
  async selftest(opts: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<string> {
    const root = this.d.cfg.sandboxRoot;
    const poll = opts.pollMs ?? 1000;
    const timeout = opts.timeoutMs ?? 10 * 60_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const up = this.d.sandboxes().filter((s) => EDITOR_UP.has(s.unity.state)).map((s) => s.id);
    if (up.length) throw new Error(`editors are up (${up.join(', ')}): stop them first; the self-test takes the drive away`);
    const busy = this.d.sessions().filter((s) => s.sandboxId && BUSY.has(s.status)).map((s) => s.id);
    if (busy.length) throw new Error(`agents are mid-turn in sandboxes (${busy.join(', ')}): wait for them first`);
    if (!this.d.exists(root) || this.recovery || this.health.sandboxRoot !== 'ok') throw new Error(`the sandbox drive is not in a normal state (${this.health.sandboxRoot}); fix that first`);
    const ready = this.d.sandboxes().filter((s) => s.status === 'ready');
    const t0 = this.now();
    const lines: string[] = [];
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    this.lastRecovery = undefined;
    const det = await this.d.runHelper('detach');
    if (!det.ok) throw new Error(`ffsb-helper-detach failed: ${det.detail}`);
    lines.push(`detach helper: ${secs(this.now() - t0)} (${det.detail})`);
    let goneAt = 0;
    while (this.now() - t0 < timeout) {
      if (!goneAt && !this.d.exists(root)) goneAt = this.now();
      await this.tick();
      if (this.lastRecovery && this.d.exists(root)) break;
      await sleep(poll);
    }
    const rec = this.lastRecovery as { since: number; backAt: number; attempts: number } | undefined; // set by tick() above
    if (!rec) {
      return `SELF-TEST FAILED: ${root} was not back within ${secs(timeout)} (state ${this.health.sandboxRoot}${this.health.detail ? `: ${this.health.detail}` : ''}). ${lines.join('; ')}. host_recovery "remount" retries.`;
    }
    if (goneAt) lines.push(`${root} gone after ${secs(goneAt - t0)}`);
    lines.push(`noticed by the guard after ${secs(rec.since - (goneAt || t0))}`);
    lines.push(`reattached by ffsb-helper-mount ${secs(rec.backAt - rec.since)} later (${rec.attempts} attempt(s))`);
    const missing = ready.filter((s) => !this.d.exists(s.path)).map((s) => s.id);
    lines.push(missing.length ? `sandboxes NOT back: ${missing.join(', ')}` : `all ${ready.length} sandbox folder(s) back`);
    lines.push(`total ${secs(this.now() - t0)}`);
    return `${missing.length ? 'SELF-TEST FAILED' : 'Self-test passed'}: ${lines.join('; ')}.`;
  }

  /** The orchestrator's host_recovery "remount": try now, even after giving up. */
  remountNow(): string {
    if (this.d.exists(this.d.cfg.sandboxRoot)) return `${this.d.cfg.sandboxRoot} is there; nothing to do.`;
    if (!this.recovery) return 'The guard has not noticed the drive missing yet; it looks again within a minute.';
    this.recovery.attempts = 0;
    this.recovery.nextTryAt = 0;
    this.health.sandboxRoot = 'missing';
    void this.tick();
    return 'Reattaching now (progress in system_status and as [host] messages).';
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
    if (this.now() - this.lastCleanupAt > 10 * 60_000) await this.cleanup('disk space is critical');
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

  private async cleanup(why: string) {
    this.lastCleanupAt = this.now();
    const before = this.hostFreeGB();
    const r = await this.d.cleanup().catch(() => ({ removed: 0 }));
    await this.measure();
    const after = this.hostFreeGB();
    const freed = before !== undefined && after !== undefined ? Math.max(0, after - before) * GB : undefined;
    this.health.lastCleanup = { at: new Date(this.now()).toISOString(), removed: r.removed, freedBytes: freed };
    if (r.removed) this.d.report('Cleaned up known-safe junk', `${why}: removed ${r.removed} item(s)${freed !== undefined ? `, about ${(freed / GB).toFixed(1)} GB` : ''}.`);
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

  // ------------------------------------------------------------ editors and the VHDX

  private async idleEditors() {
    for (const id of idleEditors(this.d.sandboxes(), this.d.sessions(), this.now(), this.d.cfg.unity.idleStopMinutes)) {
      await this.d.stopEditor(id).catch(() => undefined);
      this.d.report('Stopped an idle editor', `${id}: no agent activity for ${this.d.cfg.unity.idleStopMinutes} min (unity.idleStopMinutes).`);
    }
  }

  /** At idle (no editor up, no agent busy), compact a VHDX that holds much more than its volume uses. */
  private async maybeCompact() {
    const g = this.g();
    if (!g.compactWhenReclaimGB || !g.devDriveVhdx || this.health.sandboxRoot !== 'ok' || this.helperBusy) return;
    if (this.now() - this.lastCompactAt < 24 * 3_600_000) return;
    if (this.d.sandboxes().some((s) => EDITOR_UP.has(s.unity.state)) || this.d.sessions().some((s) => s.kind !== 'orchestrator' && BUSY.has(s.status))) return;
    let fileBytes = 0;
    try {
      fileBytes = fs.statSync(g.devDriveVhdx).size;
    } catch {
      return;
    }
    const inside = this.health.disks.find((x) => volumeOf(x.path) === volumeOf(this.d.cfg.sandboxRoot));
    if (!inside?.totalBytes || inside.freeBytes === undefined) return;
    const reclaim = fileBytes - (inside.totalBytes - inside.freeBytes);
    if (reclaim < g.compactWhenReclaimGB * GB) return;
    this.lastCompactAt = this.now();
    await this.compact(`the VHDX holds ${(reclaim / GB).toFixed(0)} GB more than the volume uses`);
  }

  /** Retrim, detach, compact and reattach the Dev Drive (host_recovery "compact", or maybeCompact at idle). */
  async compact(why: string): Promise<HelperResult> {
    this.maintenance = true;
    this.helperBusy = true;
    try {
      const res = await this.d.runHelper('compact');
      this.d.report(res.ok ? 'Compacted the sandbox drive' : 'Compacting the sandbox drive failed', `${why}: ${res.detail}`);
      return res;
    } finally {
      this.maintenance = false;
      this.helperBusy = false;
    }
  }

  /** host_recovery "cleanup". */
  async cleanupNow(): Promise<string> {
    await this.cleanup('asked for');
    const c = this.health.lastCleanup;
    return c ? `Removed ${c.removed} item(s)${c.freedBytes !== undefined ? `, about ${(c.freedBytes / GB).toFixed(1)} GB` : ''}.` : 'Nothing removed.';
  }
}
