// A person playing Final Factory on a machine, in words (w1894, machine/personPlay.ts): the placement hold's reason (the
// Capacity block's "HELD (…)"), list_machines' "playing:" line and the machine page's row all say it the same way.
import type { PersonPlayReport } from './types.ts';

const hhmm = (iso: string) => iso.slice(11, 16) + 'Z';

/** "lothsahn is playing Final Factory there since 18:40Z" or, once the game closed, "… played …; its grace ends at 18:58Z". */
export function playGlance(p: PersonPlayReport): string {
  return p.until
    ? `${p.who} played Final Factory there until a moment ago (since ${hhmm(p.since)}); its ${p.graceMinutes}-minute grace ends at ${hhmm(p.until)}`
    : `${p.who} is playing Final Factory there since ${hhmm(p.since)}`;
}

/** The hold's reason: why nothing new goes there and until when (w1894). */
export function playHoldReason(p: PersonPlayReport): string {
  return `${playGlance(p)} (w1894: agents yield there until ${p.until ? hhmm(p.until) : `${p.graceMinutes} min after the game closes`})`;
}

/** list_machines' line: the hold and what the turn did (editors closed, players asked to quit, builds at idle priority). */
export function playLine(p: PersonPlayReport): string {
  const did = [`${p.editorsClosed} editor(s) closed`, `${p.playersAsked} player(s) asked to quit`, `${p.buildsLowered} build(s) at idle priority`].join(', ');
  return `${playHoldReason(p)}: no new work is placed there and its workers' shells run on; ${did}; game pid ${p.pids.join(', ') || 'none now'}`;
}

/** The hold entries of the machines where a person plays, to merge into config placement.hold (w1894). */
export function playHolds(machines: Iterable<{ id: string }>, playOf: (id: string) => PersonPlayReport | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of machines) {
    const p = playOf(m.id);
    if (p) out[m.id] = playHoldReason(p);
  }
  return out;
}
