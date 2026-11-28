// w6687: every machine exclusion or pin a request carries must cite a reason the server can check, and one tied to a hold
// goes when the hold does. lothsahn: "Yes, file it: machine exclusions must cite a live hold and expire with it". For over a
// day every built-player job was kept off BEAST by a line "No game player on BEAST (crash hold)" that the dispatcher copied
// from brief to brief and workers copied into request_pair (avoid: ["beast"]), while the one real crash hold
// (server/crashHolds.ts, 2026-11-26 18:39Z, after a planned reboot for w6168) was gone 16 minutes after it was set (w6685).
//
// This file only judges. Stage 1 (warn-only, lothsahn's lockout rule) logs what enforcing would drop and drops nothing
// (Orchestrators.auditExclusions); the enforce stage is a separate pull request.
//
// The reasons it accepts, each read from live state, never from a brief's words:
//   - crash-hold: a live crash hold on that machine (any open request's WorkItem.crashHolds, not cleared);
//   - machine-hold: the machine is paused, drained, held by a build or a person's game, or offline now;
//   - config: a config placement rule names it (placement.avoid or placement.hold, by key);
//   - capability: a fact about the machine the server can check against the work (a Mac for a run with a client, a machine
//     that takes no players or no timed runs, a pre-w5297 player on a Windows sandbox not measured at Medium integrity);
//   - person: a person's own words name it (a pin set with pin_words, the request's constraints or a person's note).
import { liveCrashHolds } from './crashHolds.ts';
import { holdReason, placeId, type Computer, type PlacementPrefs } from './placement.ts';
import type { WorkItem } from '../shared/types.ts';

export type ExclusionReasonKind = 'crash-hold' | 'machine-hold' | 'config' | 'capability' | 'person';

/** Where the exclusion lives on the request: request_pair's avoid, a machine pin, or decide_work queue's needs. */
export type ExclusionSource = 'pair.avoid' | 'machinePin' | 'queuedFor.needs';

/** One live crash hold, as the audit cites it: "w6168's crash hold on beast (18:39Z)". */
export interface LiveCrashHold {
  machine: string;
  request: string;
  at: string;
}

/** What the audit reads, all of it live (Agents wires it: Orchestrators deps exclusionFacts). */
export interface ExclusionFacts {
  /** Every live crash hold, from every open request (crashHolds.ts liveCrashHolds). */
  crashHolds: LiveCrashHold[];
  /** The placement settings in force (Agents.placement(): config plus pauses, drains, builds and play holds). */
  prefs: PlacementPrefs;
  /** The computers as placement sees them (Agents.places()). */
  computers: Computer[];
}

export interface ExclusionVerdict {
  source: ExclusionSource;
  machine: string;
  /** True when a checkable reason holds now. */
  keep: boolean;
  kind?: ExclusionReasonKind;
  /** The reason that holds ("w6168's crash hold on beast (18:39Z)"), or why none does. */
  reason: string;
}

/** The live crash holds of every open request (the only list a crash-hold reason may cite). */
export function liveCrashHoldList(work: Iterable<Pick<WorkItem, 'id' | 'status' | 'crashHolds'>>): LiveCrashHold[] {
  const out: LiveCrashHold[] = [];
  for (const w of work) {
    if (w.status === 'done' || w.status === 'rejected' || w.status === 'cancelled') continue;
    for (const h of liveCrashHolds(w)) out.push({ machine: placeId(h.machine), request: w.id, at: h.at });
  }
  return out;
}

const hhmm = (iso: string) => `${iso.slice(11, 16)}Z`;

/** A person's words that name `machine` as one to keep the work off ("not on beast", "avoid m5", "never BEAST"). */
function personSaysNot(text: string | undefined, machine: string): boolean {
  if (!text) return false;
  const m = machine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`\b(?:not|never|no|avoid|except|without|off)\b[^.;\n]{0,40}\b${m}\b`, 'i').test(text);
}

type Subject = Pick<WorkItem, 'id' | 'constraints' | 'notes' | 'needs' | 'pair'>;

/** The person's words on the request that name `machine` (its constraints, or a person's note), or undefined. */
function personWords(w: Subject, machine: string, parent?: Subject): string | undefined {
  for (const x of [w, parent]) {
    if (!x) continue;
    if (personSaysNot(x.constraints, machine)) return `${x.id}'s constraints name ${machine}`;
    const note = (x.notes ?? []).find((n) => personSaysNot(n.text, machine));
    if (note) return `${note.by}'s note on ${x.id} names ${machine}`;
  }
  return undefined;
}

/**
 * The checkable reason that keeps `machine` out of work `w` now, or undefined. Shared by every source: a hold of any kind, a
 * config rule, then the capability facts that apply to the work (a pair run's, or game work's).
 */
export function exclusionReason(machine: string, w: Subject, facts: ExclusionFacts, parent?: Subject): { kind: ExclusionReasonKind; reason: string } | undefined {
  const id = placeId(machine);
  const crash = facts.crashHolds.find((h) => h.machine === id);
  if (crash) return { kind: 'crash-hold', reason: `${crash.request}'s crash hold on ${id} (${hhmm(crash.at)})` };
  const held = holdReason(id, facts.prefs);
  if (held) {
    const cfg = !/ is (?:paused|drained)\b/.test(held) && facts.prefs.hold?.[id] !== undefined;
    return cfg ? { kind: 'config', reason: `config placement.hold.${id}: ${held}` } : { kind: 'machine-hold', reason: held };
  }
  const avoid = facts.prefs.avoid?.[id];
  if (avoid !== undefined) return { kind: 'config', reason: `config placement.avoid.${id} (${avoid})` };
  const c = facts.computers.find((x) => placeId(x.id) === id);
  if (!c) return { kind: 'capability', reason: `${id} is no computer this portal has` };
  if (!c.online) return { kind: 'machine-hold', reason: `${id} is offline${c.offlineSince ? ` since ${hhmm(c.offlineSince)}` : ''}` };
  if (w.pair) {
    // w3697: a Mac never runs a multiplayer client; only a split run's host leg may go on one (w4468).
    if (c.platform === 'darwin' && !w.pair.split) return { kind: 'capability', reason: `${id} is a Mac, and a Mac runs no multiplayer client (w3697)` };
    if (c.noPlayers) return { kind: 'capability', reason: `${id} takes no game players (${c.noPlayers})` };
    if (w.pair.timed && c.noTimedRuns) return { kind: 'capability', reason: `${id} takes no timed runs (${c.noTimedRuns})` };
    if (w.pair.legacyData && c.platform !== 'darwin' && (c.platform !== 'win32' || c.agentIntegrity !== 'medium'))
      return { kind: 'capability', reason: `${id} has no sandbox agent measured at Medium integrity for a pre-w5297 player (w5965)` };
  }
  if (w.needs === 'game' && c.maxEditors === 0) return { kind: 'capability', reason: `${id} runs no editor` };
  const words = personWords(w, id, parent);
  if (words) return { kind: 'person', reason: words };
  return undefined;
}

const NONE = 'nothing live names it (no crash hold, machine hold or pause, config placement rule, capability or person\'s words)';

/**
 * Every machine exclusion and pin `w` carries, each with the reason that keeps it now or why none does (w6687). Only marks that
 * still steer placement are judged: a pair run's avoid before its legs start, a pin, and the needs of a Queued request.
 */
export function auditExclusions(w: WorkItem, facts: ExclusionFacts, parent?: WorkItem): ExclusionVerdict[] {
  const out: ExclusionVerdict[] = [];
  if (w.pair && !w.pair.started) {
    for (const m of w.pair.avoid ?? []) {
      const r = exclusionReason(m, w, facts, parent);
      const cited = w.pair.avoidWhy?.[placeId(m)];
      out.push(r ? { source: 'pair.avoid', machine: placeId(m), keep: true, ...r } : { source: 'pair.avoid', machine: placeId(m), keep: false, reason: `${NONE}${cited ? ` (it cited: "${cited}")` : ''}` });
    }
  }
  if (w.machinePin?.ids.length) {
    // A pin's own why says who set it: a person's words (pin_words, w2544) stand; the dispatcher's or a worker's note is
    // checked like an exclusion of every other computer, so it is judged by its own text alone and logged, never re-derived.
    const why = w.machinePin.why;
    const person = /^a person's words\b/.test(why) || /^its constraints\b/.test(why);
    for (const m of w.machinePin.ids)
      out.push(person ? { source: 'machinePin', machine: placeId(m), keep: true, kind: 'person', reason: why } : { source: 'machinePin', machine: placeId(m), keep: false, reason: `a pin with no person's words (${why.slice(0, 160)})` });
  }
  const needs = w.status === 'queued' ? w.queuedFor?.needs : undefined;
  if (needs?.length && !(w.pair && !w.pair.started)) {
    // decide_work queue's needs ("only on X/Y"): every online computer it leaves out must have its own reason.
    const named = new Set(needs.map(placeId));
    for (const c of facts.computers) {
      const id = placeId(c.id);
      if (named.has(id) || !c.online) continue;
      const r = exclusionReason(id, w, facts, parent);
      out.push(r ? { source: 'queuedFor.needs', machine: id, keep: true, ...r } : { source: 'queuedFor.needs', machine: id, keep: false, reason: `left out of its needs (${[...named].join(', ')}): ${NONE}` });
    }
  }
  return out;
}

/** The request log line for one verdict that enforcing would drop: "w6687 warn-only, nothing dropped: ...". */
export function warnLine(v: ExclusionVerdict, was?: ExclusionVerdict): string {
  const where = v.source === 'pair.avoid' ? 'its pair avoid' : v.source === 'machinePin' ? 'its pin' : 'its queue needs';
  const cleared = was?.keep && was.kind === 'crash-hold' ? `${was.reason} has cleared, so enforcing would re-queue it for ${v.machine}; ` : '';
  return `w6687 warn-only, nothing dropped: enforcing would drop ${v.machine} from ${where}: ${cleared}${v.reason}`;
}

/**
 * The crash-hold line the dispatcher's capacity block carries (list_sandboxes, system_status): read from the live list each
 * time, so a hold that cleared is gone from what the dispatcher reads (w6687: "No game player on BEAST (crash hold)" was
 * copied from brief to brief for over a day after the hold had cleared).
 */
export function crashHoldsLine(holds: readonly LiveCrashHold[]): string {
  const now = holds.length ? holds.map((h) => `${h.machine} for ${h.request} (since ${hhmm(h.at)})`).join('; ') : 'none';
  return `Crash holds now (w3740, the live list; they stop only that request's game players there): ${now}. A hold an earlier brief or report names is no hold unless it is listed here or as HELD above (w6687).`;
}
