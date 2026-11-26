// A machine's ffu build slots as the portal shows them (w5912, lothsahn: "Does FFU have its own set of slots the same way?
// Can we show those on the portal?"). The daemon judges each slot with `ffu-slot list`'s own slotFree (machine/ffuSlots.ts
// slotsReport) and sends it in its stats; list_sandboxes and list_machines say it in text, and the page gets it without the
// `why` sentence, which its structured fields already carry (the page state is kept small, w5861/w5907).
import { ffuSummary } from '../shared/ffuSlots.ts';
import type { FfuSlotView, FfuSlotsReport, MachineStats } from '../shared/types.ts';

export { ffuSummary, slotState } from '../shared/ffuSlots.ts';

/** A holder's session as the portal knows it, for the text: its title and the requests it is on. */
export interface FfuHolder {
  title: string;
  requests: string[];
}

/** A machine's stats as the page gets them: each ffu slot without its `why` (the page reads none). */
export function pageStats(s: MachineStats): MachineStats {
  if (!s.ffuSlots) return s;
  return { ...s, ffuSlots: { ...s.ffuSlots, slots: s.ffuSlots.slots.map(({ why: _why, ...rest }) => rest) } };
}

export function pageAllStats(all: Record<string, MachineStats>): Record<string, MachineStats> {
  return Object.fromEntries(Object.entries(all).map(([id, s]) => [id, pageStats(s)]));
}

const GB = 1024 ** 3;

/** "12 min", "3 h", "2 d": how long ago `iso` was from `now`. */
export function ago(iso: string | undefined, now: number): string | undefined {
  const t = Date.parse(iso ?? '');
  if (!t) return undefined;
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 120 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

/** One slot for list_sandboxes and list_machines: holder, request, state, branch and commit, since when, target size, why. */
export function ffuSlotLine(machineId: string, s: FfuSlotView, holder: (id: string) => FfuHolder | undefined, now: number): string {
  const h = s.holder ? holder(s.holder) : undefined;
  const who = s.holder
    ? `held by ${s.holder}${h ? ` "${h.title}"${h.requests.length ? ` (${h.requests.join(', ')})` : ''}` : ''} [${s.holderIs ?? 'unknown'}]${s.stale ? ' STALE' : ''}`
    : 'FREE (released)';
  const used = ago(s.usedAt, now);
  const taken = s.holder ? ago(s.takenAt, now) : undefined;
  const size = s.targetBytes !== undefined ? `target ${(s.targetBytes / GB).toFixed(1)} GB${s.sizedAt ? ` (measured ${ago(s.sizedAt, now)} ago)` : ''}` : 'target not measured yet';
  return [
    `- ${machineId}/ffu ${s.id}: ${who}; branch ${s.branch ?? '(origin/main)'}${s.commit ? ` at ${s.commit}` : ''}`,
    `${taken ? `; held for ${taken}` : ''}${used ? `; used ${used} ago` : ''}; ${size}${s.why ? `; ${s.why}` : ''}`,
  ].join('');
}

/** A machine's ffu slots for list_sandboxes: a header line, then one line per slot. Empty when it reported none. */
export function ffuSlotLines(machineId: string, r: FfuSlotsReport | undefined, holder: (id: string) => FfuHolder | undefined, now = Date.now()): string[] {
  if (!r) return [];
  const as = ago(r.at, now);
  return [`ffu slots (${ffuSummary(r)}; ffu-slot list's judgement${as ? `, ${as} ago` : ''}; docs/ffu-sandboxes.md):`, ...(r.slots.length ? r.slots.map((s) => ffuSlotLine(machineId, s, holder, now)) : ['(none yet)'])];
}
