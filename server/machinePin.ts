/**
 * w2521: work that must run on one named computer, for a hardware reason (its display, its GPU, its OS), goes there or waits
 * for it, and never falls back to an idle or bigger one. lothsahn, 2026-10-29: "when a leg's brief or constraints, or a
 * timed_place argument, say it must run on a named machine ..., the placement queues it on that machine only. It never falls
 * back to an idle or big computer, and it says plainly that it is waiting on that machine."
 *
 * Three misses before it, each a LothLaptop-only leg (the only G-SYNC/VRR screen):
 *  - w2501 (2026-10-29 05:49Z): worker 9bdafcfe on BEAST asked timed_place twice, "needs LothLaptop's G-SYNC panel" in its
 *    what; timed_place had no way to name a machine, and w2055's "an idle computer of any class takes timed work" answered
 *    "here" on BEAST (timedAsk.ts decideTimedPlace).
 *  - w2499 (2026-10-29 02:48Z): its constraints said "Must run on LothLaptop ...; no other machine", but nothing read them:
 *    a pin was only queuedFor.needs, which it never had, so the w2046 room move (resumeMove.ts moveDecision) sent it to m3.
 *  - w2448 (2026-10-28 19:42Z): worker b9cd085e on biscuit put "Must run on LothLaptop ..." in same_machine, which means
 *    "this computer": biscuit answered "here".
 *
 * A pin is read from a request's own `machinePin` (timed_place's `machine`, set on the leg it files) or from its constraints'
 * words ("must run on X", "only on X", "X only", "needs X's ..."), naming a known computer. Ambiguous words name no pin.
 */
import type { WorkItem } from '../shared/types.ts';
import { placeId } from './placement.ts';

export interface MachinePin {
  /** The computers it may run on (machine ids, lower case); nearly always one. */
  ids: string[];
  /** Why, in words: the request's own constraint or timed_place's reason. */
  why: string;
}

const NAME = String.raw`([A-Za-z][\w-]*)`;
// "must run on LothLaptop", "has to run on lothlaptop", "needs to run on the M3", "run only on biscuit", "only on LothLaptop",
// "LothLaptop only", "on LothLaptop (lothlaptop) only", "needs LothLaptop's G-SYNC panel"
const PATTERNS = [
  new RegExp(String.raw`\b(?:must|has to|have to|needs? to|can only)\s+(?:be\s+)?(?:run|ran|placed|timed|measured)\s+(?:only\s+)?on\s+(?:the\s+)?${NAME}`, 'gi'),
  new RegExp(String.raw`\bonly\s+(?:run\s+)?on\s+(?:the\s+)?${NAME}`, 'gi'),
  new RegExp(String.raw`\bon\s+${NAME}(?:\s*\([^)]{0,40}\))?\s+only\b`, 'gi'),
  new RegExp(String.raw`\bneeds\s+${NAME}'s\b`, 'gi'),
];

/**
 * The known computers `text` says the work must run on, in the order named; [] when it names none. `known` is every machine id
 * (any case). Two different computers named as "must" pins is no pin: the words are not clear enough to queue on.
 */
export function pinFromText(text: string | undefined, known: readonly string[]): string[] {
  if (!text?.trim()) return [];
  const ids = new Set(known.map(placeId));
  const found: string[] = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const id = placeId(m[1]);
      if (ids.has(id) && !found.includes(id)) found.push(id);
    }
  }
  return found.length === 1 ? found : [];
}

/** A request's machine pin (w2521): its own `machinePin`, else its constraints' words. Undefined: it may run anywhere. */
export function machinePinOf(w: Pick<WorkItem, 'constraints' | 'machinePin'> | undefined, known: readonly string[]): MachinePin | undefined {
  if (!w) return undefined;
  if (w.machinePin?.ids.length) return { ids: w.machinePin.ids.map(placeId), why: w.machinePin.why };
  const ids = pinFromText(w.constraints, known);
  return ids.length ? { ids, why: `its constraints: "${w.constraints!.replace(/\s+/g, ' ').trim().slice(0, 200)}"` } : undefined;
}

/** The refusal for placing pinned work on `target` (w2521), else undefined. */
export function pinRefusal(id: string, pin: MachinePin | undefined, target: string): string | undefined {
  if (!pin || pin.ids.includes(placeId(target))) return undefined;
  const on = pin.ids.join(' or ');
  return `${id} must run on ${on} only (w2521: ${pin.why}), never on ${placeId(target)} or any other computer, however idle. Start it on ${on} when a sandbox there is free, or queue it for capacity with machines ["${pin.ids.join('", "')}"]: it then waits on ${on}, and starts there by itself.`;
}
