/**
 * w6484: the daemon frees stale ffu slots by itself (lothsahn: "fix why auto-release still misses them"). Before this, w5885's
 * rule (machine/ffuSlots.ts slotFree) only marked such a slot free: the next worker's `take` or a hand-run `ffu-slot sweep`
 * freed it, and nothing ran either on a timer. So a slot whose holder finished or stopped stayed "held" on the page for hours
 * whenever no worker needed one (BEAST slot3 and slot4, m5 slot1 on 2026-11-27; BEAST slot3 on 2026-11-26, w6179), and a
 * person filed a request to free each by hand.
 *
 * Now every slot report the daemon reads (FFU_REPORT_MS, `ffu-slot list --json`) that names a stale slot (stale: free, and
 * held by another session) is acted on by the staleOutput setting `ffuSlotSweep`:
 *   on (the default since w6484's enforce step, after the warn-only #1500; lothsahn: "Turn it on everywhere: free stale
 *       slots by themselves."): run `ffu-slot sweep` as its own process (the same rule, lock and rescue a worker's sweep runs: unpushed work is saved
 *       on a rescue branch first, the target stays warm), and log what it printed;
 *   warn: log what a sweep would free, once per slot and holder, and free nothing;
 *   off: nothing.
 * Only holders that no longer run are freed (sweepSlots skips running ones when it has no session); a running holder's stale
 * slot is left to the next take. The sweep runs in a child process, so a failure is a log line and never stops the daemon; the portal's
 * machines.cleanup.staleOutput.ffuSlotSweep turns it off again with nobody at the machine.
 *
 * w6803: a report that names a rescue not on origin yet (unpushedRescues, due RESCUE_RETRY_MS after its last try) runs a
 * sweep too, which tries its push again; a rescue push that fails is logged as `ffu slots: auto sweep failed: rescue push
 * of ...`, the failure line the health and review checks read.
 */
import type { FfuSlotsReport } from '../shared/types.ts';

export type FfuSlotSweepMode = 'off' | 'warn' | 'on';

export interface FfuSlotAutoSweepDeps {
  mode: () => FfuSlotSweepMode;
  /** `ffu-slot sweep`, run as its own process: what it printed, and whether it exited 0. */
  sweep: () => Promise<{ ok: boolean; out: string }>;
  log: (s: string) => void;
}

/** The slots a sweep would free now: free by w5885's rule, and held by a session (a released slot needs nothing). */
export function staleSlotsOf(r: FfuSlotsReport | undefined): FfuSlotsReport['slots'] {
  // Review of #1500: only holders that no longer run (stopped or gone). A running holder's slot freed with no take behind it
  // would lose what that holder writes next to the next take's reset; a take frees and hands it over in one locked step.
  return (r?.slots ?? []).filter((s) => s.stale && s.free && !!s.holder && (s.holderIs === 'stopped' || s.holderIs === 'gone'));
}

export class FfuSlotAutoSweep {
  /** What warn mode said already (slot, holder), so a slot that stays stale is logged once, not every report. */
  private warned = new Set<string>();
  /** w6803: unpushed rescue branches warn mode named already. */
  private warnedRescues = new Set<string>();
  /** The last failure on mode on, so a sweep that keeps failing is logged once until it changes. */
  private lastFail = '';
  private running = false;

  private readonly d: FfuSlotAutoSweepDeps;

  constructor(d: FfuSlotAutoSweepDeps) {
    this.d = d;
  }

  /** Act on one slot report; the slots it freed (on), or would free (warn). Never throws. */
  async onReport(r: FfuSlotsReport | undefined): Promise<string[]> {
    const stale = staleSlotsOf(r);
    const keys = new Set(stale.map((s) => `${s.id}:${s.holder}`));
    for (const k of this.warned) if (!keys.has(k)) this.warned.delete(k);
    const mode = this.d.mode();
    // w6803: a rescue GitHub refused is tried again by a sweep, so one is due even when no slot is stale.
    const unpushed = r?.unpushedRescues ?? [];
    const due = unpushed.filter((x) => x.due);
    for (const b of this.warnedRescues) if (!unpushed.some((x) => x.branch === b)) this.warnedRescues.delete(b);
    if ((!stale.length && !due.length) || mode === 'off' || this.running) return [];
    if (mode === 'warn') {
      for (const x of due.filter((x) => !this.warnedRescues.has(x.branch))) {
        this.warnedRescues.add(x.branch);
        this.d.log(`ffu slots: auto sweep failed: rescue push of ${x.branch} (${x.holder}'s work from ${x.slot}) is not on origin, and warn-only (ffuSlotSweep warn) does not try it again${x.error ? `: ${x.error}` : ''}`);
      }
      const fresh = stale.filter((s) => !this.warned.has(`${s.id}:${s.holder}`));
      for (const s of fresh) {
        this.warned.add(`${s.id}:${s.holder}`);
        this.d.log(`ffu slots: auto sweep (warn-only, ffuSlotSweep warn): would free ${s.id}${s.branch ? ` on ${s.branch}` : ''}: ${s.why ?? 'stale'}`);
      }
      return stale.map((s) => s.id);
    }
    this.running = true;
    try {
      const { ok, out } = await this.d.sweep();
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('ffu-slot'));
      if (!ok) {
        const msg = (lines.join(' | ') || out.trim()).slice(0, 400);
        if (msg !== this.lastFail) this.d.log(`ffu slots: auto sweep failed: ${msg}`);
        this.lastFail = msg;
        return [];
      }
      this.lastFail = '';
      // w6803: a rescue push that failed is a failure line (the health and review checks read "auto sweep failed").
      for (const l of lines) {
        const failed = /^ffu-slot: rescue push failed: /.exec(l);
        this.d.log(failed ? `ffu slots: auto sweep failed: rescue push of ${l.slice(failed[0].length)}` : `ffu slots: auto sweep: ${l.replace(/^ffu-slot:\s*/, '')}`);
      }
      return [...new Set(lines.flatMap((l) => /^ffu-slot: freed (slot\d+):/.exec(l)?.[1] ?? []))];
    } catch (e) {
      this.d.log(`ffu slots: auto sweep failed: ${(e as Error).message}`);
      return [];
    } finally {
      this.running = false;
    }
  }
}
