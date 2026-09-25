import type { SessionInfo } from '../shared/types.ts';
import { isUnused } from '../shared/labels.ts';

export { isUnused };

/**
 * Labels shared by several agents (a sandbox or a machine with a lead and helpers): a helper that finishes
 * must not leave the place labelled "unused" while another agent there still works (m5, 2026-09-24).
 * Pure; Agents.agentSetLabel and the 'ended' hook apply it. (The label's display rules are in shared/labels.ts.)
 */


/** Busy or with a live process: working there, as far as labels go. */
export type Place = { sessions: (Pick<SessionInfo, 'id' | 'title' | 'label' | 'labelAt' | 'status'> & { live: boolean })[] };

const BUSY = new Set(['running', 'starting', 'waiting_permission']);
const active = (s: Place['sessions'][number]) => s.live || BUSY.has(s.status);

/**
 * What an agent's set_label does: `set` the label (and remember it as the agent's own), or `keep` it:
 * "unused" while another agent there is active restores that agent's last label instead.
 */
export function labelDecision(place: Place, callerId: string, purpose: string, current: string): { set: string; remember: boolean; note?: string } {
  if (!isUnused(purpose)) return { set: purpose, remember: true };
  const others = place.sessions.filter((s) => s.id !== callerId && active(s));
  if (!others.length) return { set: purpose, remember: false };
  const restore = latestLabel(others) ?? current;
  const who = others.map((s) => `"${s.title}" (${s.id})`).join(', ');
  return { set: isUnused(restore) ? current : restore, remember: false, note: `Not set to "unused": ${who} still ${others.length > 1 ? 'work' : 'works'} here, so the label stays "${isUnused(restore) ? current : restore}".` };
}

/** After an agent there ended: the label to restore (the newest label of an agent still active there), if the place still shows the ended one's label or "unused". */
export function labelAfterEnd(place: Place, endedId: string, endedLabel: string | undefined, current: string): string | undefined {
  if (!isUnused(current) && current !== endedLabel) return undefined; // someone else relabelled it since
  const restore = latestLabel(place.sessions.filter((s) => s.id !== endedId && active(s)));
  return restore && restore !== current ? restore : undefined;
}

function latestLabel(ss: Place['sessions']): string | undefined {
  const withLabel = ss.filter((s) => s.label && !isUnused(s.label)).sort((a, b) => (b.labelAt ?? '').localeCompare(a.labelAt ?? ''));
  return withLabel[0]?.label;
}
