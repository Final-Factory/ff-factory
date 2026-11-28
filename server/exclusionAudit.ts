// w6687: every machine exclusion or pin a request carries must cite a reason the server can check, and one tied to a hold
// goes when the hold does. lothsahn: "Yes, file it: machine exclusions must cite a live hold and expire with it". For over a
// day every built-player job was kept off BEAST by a line "No game player on BEAST (crash hold)" that the dispatcher copied
// from brief to brief and workers copied into request_pair (avoid: ["beast"]), while the one real crash hold
// (server/crashHolds.ts, 2026-11-26 18:39Z, after a planned reboot for w6168) was gone 16 minutes after it was set (w6685).
//
// This file only judges. Stage 1 (warn-only, lothsahn's lockout rule) logged what enforcing would drop and dropped nothing.
// Stage 2 (w6754) acts on it through config placement.exclusions (Orchestrators.auditExclusions): warn (the default) logs,
// enforce drops the avoid or needs entry and re-queues the request, off does nothing. A pin is only ever logged.
//
// The reasons it accepts, each read from live state, never from a brief's words:
//   - crash-hold: a live crash hold on that machine, of this request or of the request its pair run is for (a crash hold
//     stops only its own request's game players there, w3740; the w6697 review, 5);
//   - machine-hold: the machine is paused, drained, held by a build or a person's game, or offline now;
//   - config: a config placement rule names it (placement.avoid or placement.hold, by key, as config holds it);
//   - failed-leg: a leg of the pair run this one retries failed there, as the server saw it (WorkPair.failedOn, w2041);
//   - subject: the work is about that machine (a pin its title or brief names, or one its worker set with timed_place);
//   - capability: a fact about the machine the server can check against the work (a Mac for a run with a client, a machine
//     that takes no players or no timed runs, a pre-w5297 player on a Windows sandbox not measured at Medium integrity);
//   - person: a person's own words name it (a pin set with pin_words, the request's constraints or a person's note).
import { liveCrashHolds } from './crashHolds.ts';
import { holdReason, placeId, type Computer, type ExclusionMode, type PlacementPrefs } from './placement.ts';
import type { WorkItem } from '../shared/types.ts';

export type ExclusionReasonKind = 'crash-hold' | 'machine-hold' | 'config' | 'capability' | 'person' | 'failed-leg' | 'subject';

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
  /**
   * Config placement alone (w6754, the w6697 review, 4): a hold in `prefs` that config does not hold is a build's, a
   * person's game's, a drain's or a pause's, so it is a machine hold, not a config rule.
   */
  config?: PlacementPrefs;
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

const NEGATED = String.raw`\b(?:not|never|no|avoid|except|without|off)\b[^.;\n]{0,40}?`;

/** True when `text` names `machine` other than as one to keep off ("checks BEAST's firewall rule", not "not on BEAST"). */
function namesMachine(text: string | undefined, machine: string): boolean {
  if (!text) return false;
  const m = machine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rest = text.replace(new RegExp(`${NEGATED}\\b${m}\\b`, 'gi'), ' ');
  return new RegExp(`\\b${m}\\b`, 'i').test(rest);
}

/** The pin's own why when a worker set it naming the machine (timed_place machine, same_machine, what or brief: agents.ts timedPinFor). */
const WORKER_PIN = /^its (?:worker named \S+ \(timed_place machine\)|same_machine: |what: |brief: )/;

/**
 * w6754 (a): why a pin to `machine` holds because the work is about that machine, or undefined. w5581 checks BEAST's
 * firewall rule, w6342 reads LothLaptop's event logs, w4851 needs LothLaptop's 240 Hz screen: the dispatcher pinned each
 * and said so in words the audit cannot trust, but the request's own title or brief names the machine. A pin a worker set
 * with timed_place (b) names it too.
 */
function pinSubject(w: Pick<WorkItem, 'id' | 'title' | 'brief'>, machine: string, why: string): string | undefined {
  if (WORKER_PIN.test(why)) return `its worker set the pin (${why.slice(0, 120)})`;
  if (namesMachine(w.title, machine)) return `${w.id}'s title names ${machine} as what the work is about`;
  if (namesMachine(w.brief, machine)) return `${w.id}'s brief names ${machine} as what the work is about`;
  return undefined;
}

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
  // w6754 (the w6697 review, 5): only this request's own hold, or that of the request its pair run is for.
  const crash = facts.crashHolds.find((h) => h.machine === id && (h.request === w.id || (!!w.pair?.for && h.request === w.pair.for)));
  if (crash) return { kind: 'crash-hold', reason: `${crash.request}'s crash hold on ${id} (${hhmm(crash.at)})` };
  const held = holdReason(id, facts.prefs);
  if (held) {
    const cfg = !/ is (?:paused|drained)\b/.test(held) && Object.keys(facts.config?.hold ?? {}).some((k) => placeId(k) === id);
    return cfg ? { kind: 'config', reason: `config placement.hold.${id}: ${held}` } : { kind: 'machine-hold', reason: held };
  }
  const avoid = facts.prefs.avoid?.[id];
  if (avoid !== undefined) return { kind: 'config', reason: `config placement.avoid.${id} (${avoid})` };
  const c = facts.computers.find((x) => placeId(x.id) === id);
  if (!c) return { kind: 'capability', reason: `${id} is no computer this portal has` };
  if (!c.online) return { kind: 'machine-hold', reason: `${id} is offline${c.offlineSince ? ` since ${hhmm(c.offlineSince)}` : ''}` };
  // A retry filed before w6754 has no failedOn: the cite the server itself wrote then stands for it (w6758, the w6756 review, 3).
  const legacy = w.pair?.retryOf && !w.pair.failedOn && w.pair.avoidWhy?.[id] === `an earlier leg of ${w.pair.retryOf} failed there (w2041)`;
  if (legacy) return { kind: 'failed-leg', reason: `a leg of ${w.pair!.retryOf} failed on ${id} (w2041, as the server cited it)` };
  if (w.pair?.failedOn?.map(placeId).includes(id)) return { kind: 'failed-leg', reason: `a leg of ${w.pair.retryOf ?? 'the run it retries'} failed on ${id} (w2041)` };
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
  const pinIds = (w.machinePin?.ids ?? []).map(placeId);
  if (w.machinePin && pinIds.length) {
    // A pin's own why says who set it: a person's words (pin_words, w2544) stand; so does a pin whose work is about that
    // machine (w6754 a, b). The dispatcher's other pins are logged, never dropped (only avoid and needs are enforced).
    const why = w.machinePin.why;
    const person = /^a person's words\b/.test(why) || /^its constraints\b/.test(why);
    for (const m of pinIds) {
      const subject = person ? undefined : pinSubject(w, m, why);
      out.push(person ? { source: 'machinePin', machine: m, keep: true, kind: 'person', reason: why } : subject ? { source: 'machinePin', machine: m, keep: true, kind: 'subject', reason: subject } : { source: 'machinePin', machine: m, keep: false, reason: `a pin with no person's words (${why.slice(0, 160)})` });
    }
  }
  const needs = w.status === 'queued' ? w.queuedFor?.needs : undefined;
  // w6754 (c): needs that only repeat the pin are judged as the pin, once, not once per computer they leave out.
  const echoesPin = !!needs?.length && pinIds.length > 0 && needs.every((n) => pinIds.includes(placeId(n)));
  if (needs?.length && !(w.pair && !w.pair.started) && !echoesPin) out.push(...needsUnreasoned(w, needs, facts, parent, true));
  return out;
}

/**
 * decide_work queue's needs ("only on X/Y", w6754): every computer the list leaves out, judged. With `all`, those that keep a
 * reason too; without, only those that do not (what decide_work queue refuses under enforce). An offline computer is kept
 * (a machine hold), so one that drops off and comes back is not a new verdict (w6754 e).
 */
export function needsUnreasoned(w: Subject, needs: readonly string[], facts: ExclusionFacts, parent?: Subject, all = false): ExclusionVerdict[] {
  const named = new Set(needs.map(placeId));
  const out: ExclusionVerdict[] = [];
  for (const c of facts.computers) {
    const id = placeId(c.id);
    if (named.has(id)) continue;
    const r = exclusionReason(id, w, facts, parent);
    if (r && all) out.push({ source: 'queuedFor.needs', machine: id, keep: true, ...r });
    else if (!r) out.push({ source: 'queuedFor.needs', machine: id, keep: false, reason: `left out of its needs (${[...named].join(', ')}): ${NONE}` });
  }
  return out;
}

/** w6754: config placement.exclusions as the audit reads it (the settings in force); unset is warn. */
export const exclusionMode = (facts: ExclusionFacts | undefined): ExclusionMode => facts?.prefs.exclusions ?? 'warn';

const whereOf = (v: Pick<ExclusionVerdict, 'source'>) => (v.source === 'pair.avoid' ? 'its pair avoid' : v.source === 'machinePin' ? 'its pin' : 'its queue needs');

/** The text a log line carries for one verdict, by machine and mark: how a restart finds it already logged (w6754 d). */
export const markText = (v: Pick<ExclusionVerdict, 'source' | 'machine'>) => `${v.machine} from ${whereOf(v)}`;

/**
 * The request log line for one verdict that cites no live reason: "w6687 warn-only, nothing dropped: ..." under warn (and for
 * a pin, which is never dropped), "w6754 enforced: dropped ..." when enforce dropped it.
 */
export function warnLine(v: ExclusionVerdict, was?: ExclusionVerdict, mode: ExclusionMode = 'warn', dropped = false): string {
  const cleared = was?.keep && was.kind === 'crash-hold' ? `${was.reason} has cleared, so ${dropped ? 'it is re-queued' : mode === 'enforce' ? 'it may go there' : 'enforcing would re-queue it'} for ${v.machine}; ` : '';
  if (dropped) return v.source === 'queuedFor.needs' ? `w6754 enforced: added ${v.machine} to its queue needs: ${cleared}${v.reason}` : `w6754 enforced: dropped ${markText(v)}: ${cleared}${v.reason}`;
  // Under enforce only a pin reaches here: pins are only ever logged (w6758, the w6756 review, 2).
  if (mode === 'enforce') return `w6754 enforce, pins are only logged, nothing dropped: ${markText(v)}: ${cleared}${v.reason}`;
  return `w6687 warn-only, nothing dropped: enforcing would drop ${markText(v)}: ${cleared}${v.reason}`;
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
