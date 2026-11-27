/**
 * w6290: the re-check of an ffu slot's cargo target that a clean-up pass kept over ffuSlotTargetCapGB because a build or a test
 * ran from it (server/installLeftovers.ts keptSlot: "an ffu slot's cargo target kept: a running process uses it ..."). The pass
 * keeps the whole target then, rightly: a rustc reads the deps it links and a test executable's siblings are files no unit graph
 * sees in use (w6240: biscuit slot4 lost 62 of 257 test binaries to a sweep beside a test run). The next pass is an hour away, and
 * LothDesktop's slots build most of the day, so a target kept at 03:16 could sit at 17 to 21 GB until a pass met it idle
 * (2026-11-26/27, cleanup-log.jsonl: slot4 kept at 15:48 and 16:52, swept 15.6 GB at 17:59).
 *
 * So every `ffuBusyRetryMinutes` until the next pass is due, the slots a pass kept busy are planned again, by the same rule
 * (planInstallLeftovers scope 'ffu-busy-retry'): still busy, the rule keeps them again (plan.held) and they stay watched; idle,
 * the rule plans what a pass would take there and then (the stale units, the incremental cache over the cap), which is logged
 * (mode warn: "would remove", nothing removed) or removed (mode on, through runCleanup with the pass's busyNow re-check right
 * before each rename). Nothing here widens what a pass takes: it only runs the same judgement sooner.
 */
import path from 'node:path';
import type { CleanupItem, CleanupRun } from '../server/cleanup.ts';
import type { StalePlan } from '../server/staleOutput.ts';

export type FfuBusyRetryMode = 'off' | 'warn' | 'on';

/** The prefix keptSlot (server/installLeftovers.ts) gives a slot target it kept whole. */
const KEPT = "an ffu slot's cargo target kept:";
const BUSY = /a running process (uses|names) it|its worker runs a build|a program runs from it|a process works in it|cannot be ruled out|written .* ago.*within the settle time/i;

/** The slots (slot1, ...) whose target the plan's held list says was kept whole because something ran in or from it. */
export function busySlotsOf(held: StalePlan['held'], root: string | undefined): string[] {
  if (!root || !held) return [];
  const base = path.resolve(root, 'ffu-sandboxes').toLowerCase();
  const out = new Set<string>();
  for (const h of held) {
    if (!h.why.startsWith(KEPT) || !BUSY.test(h.why)) continue;
    const p = path.resolve(h.path);
    if (path.basename(p).toLowerCase() !== 'target') continue;
    const slot = path.dirname(p);
    if (path.dirname(slot).toLowerCase() !== base || !/^slot\d+$/i.test(path.basename(slot))) continue;
    out.add(path.basename(slot).toLowerCase());
  }
  return [...out];
}

export interface FfuBusyRetryDeps {
  /** The install folder (root.json's root); without one nothing is watched. */
  root: () => string | undefined;
  /** mode: off, warn or on; everyMinutes: the clean-up pass interval (a slot is watched until then); retryMinutes: the tick. */
  settings: () => { mode: FfuBusyRetryMode; staleMode: 'on' | 'dry-run' | 'off'; everyMinutes: number; retryMinutes: number };
  /** planInstallLeftovers with scope 'ffu-busy-retry' for these slots, fenced to the install folder. */
  plan: (slots: string[]) => Promise<StalePlan>;
  /** runCleanup(items, guard, busyNow). */
  remove: (items: CleanupItem[]) => Promise<CleanupRun>;
  /** What the plan's items measure, for the warn line (cleanup.ts sizePlan). */
  size: (items: CleanupItem[]) => Promise<{ path: string; bytes: number; rule: string; why: string }[]>;
  /** A clean-up pass is running: the tick waits for the next one (the pass judges the same slots itself). */
  passRunning: () => boolean;
  log: (line: string) => void;
  /** One entry for cleanup-log.jsonl and the portal's copy (portal_logs cleanup). */
  record: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

export class FfuBusyRetry {
  /** slot id -> watched until (ms). */
  private watch = new Map<string, number>();
  private ticking = false;
  private d: FfuBusyRetryDeps;
  constructor(d: FfuBusyRetryDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** The slots being watched now (tests, status). */
  watched(): string[] {
    return [...this.watch.keys()].sort();
  }

  /** A pass's (or a re-check's) plan: the slots it kept busy are watched until the next pass is due. */
  note(plan: Pick<StalePlan, 'held'> | undefined) {
    const s = this.d.settings();
    if (s.mode === 'off') return;
    const until = this.now() + Math.max(1, s.everyMinutes) * 60_000;
    for (const id of busySlotsOf(plan?.held, this.d.root())) this.watch.set(id, until);
  }

  private lastTick = 0;
  /** Called every minute (the daemon's timers): a re-check once retryMinutes passed since the last one. */
  async maybeTick() {
    const now = this.now();
    if (now - this.lastTick < Math.max(1, this.d.settings().retryMinutes) * 60_000) return undefined;
    this.lastTick = now;
    return this.tick();
  }

  /** One re-check of the watched slots. Answers what it did, for tests. */
  async tick(): Promise<{ slots: string[]; planned: number; removed: number } | undefined> {
    const s = this.d.settings();
    if (s.mode === 'off') {
      this.watch.clear();
      return undefined;
    }
    const now = this.now();
    for (const [id, until] of this.watch) if (until <= now) this.watch.delete(id);
    if (!this.watch.size || this.ticking || this.d.passRunning()) return undefined;
    const root = this.d.root();
    if (!root) return undefined;
    this.ticking = true;
    try {
      const slots = this.watched();
      const plan = await this.d.plan(slots);
      const stillBusy = new Set(busySlotsOf(plan.held, root));
      const slotOf = (p: string) => {
        const rel = path.relative(path.resolve(root, 'ffu-sandboxes'), path.resolve(p));
        const first = rel.split(/[\\/]/)[0]?.toLowerCase();
        return first && slots.includes(first) ? first : undefined;
      };
      const items = plan.items.filter((i) => !!slotOf(i.path));
      const acted = new Set(items.map((i) => slotOf(i.path)!));
      // A slot neither still busy nor with anything to take is done: the rule found it idle and within the cap.
      for (const id of slots) if (!stillBusy.has(id) && !acted.has(id)) this.watch.delete(id);
      if (!items.length) return { slots, planned: 0, removed: 0 };
      const enforce = s.mode === 'on' && s.staleMode === 'on';
      const at = new Date(now).toISOString();
      if (!enforce) {
        // Warn-only (docs/worker-fence.md): said once per busy spell, so the slot is no longer watched.
        for (const id of acted) this.watch.delete(id);
        const planned = await this.d.size(items);
        const bytes = planned.reduce((a, p) => a + p.bytes, 0);
        this.d.log(`clean-up: ffu busy re-check (w6290, warn-only): would remove ${items.length} item(s), ${(bytes / 1024 ** 3).toFixed(1)} GB in ${[...acted].join(', ')}: ${planned.slice(0, 4).map((p) => `${p.path} (${p.why.slice(0, 160)})`).join('; ')}`);
        this.d.record({ at, trigger: 'ffu-busy-retry', ffuBusyRetry: 'warn', removed: 0, freedBytes: 0, planned, plannedBytes: bytes });
        return { slots, planned: items.length, removed: 0 };
      }
      const run = await this.d.remove(items);
      // Removed and no longer kept: done. Still kept (written within the settle time, say): watched until the next pass.
      for (const id of acted) if (!stillBusy.has(id)) this.watch.delete(id);
      this.d.log(`clean-up: ffu busy re-check (w6290): ${run.removed.length} removed (${(run.bytes / 1024 ** 3).toFixed(1)} GB) in ${[...acted].join(', ')}${run.failed.length ? `, ${run.failed.length} kept: ${run.failed.slice(0, 4).map((f) => `${f.path} (${f.why.slice(0, 160)})`).join('; ')}` : ''}`);
      if (run.removed.length || run.failed.length) this.d.record({ at, trigger: 'ffu-busy-retry', ffuBusyRetry: 'on', removed: run.removed.length, freedBytes: run.bytes, removedAll: run.removed, failed: run.failed.length, failedAll: run.failed });
      return { slots, planned: items.length, removed: run.removed.length };
    } finally {
      this.ticking = false;
    }
  }
}
