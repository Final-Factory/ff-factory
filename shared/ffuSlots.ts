// A machine's ffu build slots in a word, for the page and list_sandboxes alike (w5912; server/ffuSlotsView.ts).
import type { FfuSlotView, FfuSlotsReport } from './types.ts';

/** A slot's state: free (released), held, or stale (held, but another worker may take it now: w5885). */
export function slotState(s: FfuSlotView): 'free' | 'held' | 'stale' {
  return !s.holder ? 'free' : s.stale ? 'stale' : 'held';
}

/** How many slots are held, and how many of those are stale. */
export function ffuSummary(r: FfuSlotsReport): string {
  const held = r.slots.filter((s) => s.holder).length;
  const stale = r.slots.filter((s) => s.stale).length;
  return `${held} of ${r.slots.length} held${stale ? `, ${stale} stale` : ''} (up to ${r.max})`;
}
