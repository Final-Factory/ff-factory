/**
 * Desyncs, crashes and hangs are urgent (lothsahn, 2026-11-19, w4810: "Desyncs and crashes and hangs should be urgent.
 * Update the rules"). Every request whose work is diagnosing or fixing one is filed urgent without anyone raising it by
 * hand: the intake (Discord bug threads, FFBox's crash and desync diagnoses and fix branches, the nightly lab's
 * regressions), FFBox dev requests and request_work. docs/intake.md, "Desyncs, crashes and hangs are urgent".
 *
 * Each source's structured signal decides first: a report id's kind (`...Z-desync-...`, `-crash-`, `-hang-`), FFBox's
 * board key (`desync:`, `crash:`, `hang:`), a desync event's group, the triage class FFBox's desync and crash routes
 * gave it, a nightly result's desync reports. Only a source without one falls back to a conservative word check on its
 * title and the start of its brief. A hitch, a stutter, a lag spike or a slow frame is not a hang. Urgent approves
 * nothing: a request that waits for a person's approval still waits for it; only its place in the queue moves.
 * Raising never lowers: a request asked for at frantic stays frantic.
 */
import { atLeast, type WorkPriority, type WorkSource, type WorkSourceKind, type WorkTriage } from '../shared/types.ts';

export type FailureKind = 'desync' | 'crash' | 'hang';

export interface Failure {
  kind: FailureKind;
  /** What showed it, in one line for the request's log ("its report 20261005T035612Z-crash-6102d405dc is a crash report"). */
  why: string;
}

/** A report id's kind (ffintake's ids: `20261005T035612Z-crash-6102d405dc`), optionally behind `report:` or `intake:`. */
const REPORT_ID = /^(?:(?:report|intake):)?\d{8}T\d{6}Z-(desync|crash|hang)-/i;
/** FFBox's coarse board signature. */
const SIGNATURE = /^(desync|crash|hang):/i;

/** The kind a report id or board key names, or undefined. */
export function kindOfKey(key: string | undefined): FailureKind | undefined {
  if (!key) return undefined;
  const m = REPORT_ID.exec(key.trim()) ?? SIGNATURE.exec(key.trim());
  return m ? (m[1].toLowerCase() as FailureKind) : undefined;
}

/**
 * The structured signal a request's source and triage carry, or undefined when they carry none. Never reads free text.
 */
export function structuredFailure(source: WorkSource | undefined, triage?: WorkTriage): Failure | undefined {
  for (const r of source?.reports ?? []) {
    const kind = kindOfKey(r);
    if (kind) return { kind, why: `its report ${r} is a ${kind} report` };
  }
  const keyKind = kindOfKey(source?.key);
  if (keyKind) return { kind: keyKind, why: `its FFBox board key ${source!.key} names a ${keyKind}` };
  if (source?.desyncGroup) return { kind: 'desync', why: `it is the work for desync event group ${source.desyncGroup}` };
  if (triage?.class === 'ffbox-desync') return { kind: 'desync', why: 'FFBox routed it as a desync diagnosis or fix' };
  if (triage?.class === 'ffbox-crash') {
    const kind: FailureKind = /\bhang\b/i.test(triage.reason) && !/\bcrash\b/i.test(triage.reason.replace(/crash or hang|crash-fix/gi, '')) ? 'hang' : 'crash';
    return { kind, why: `FFBox routed it as a ${kind} diagnosis or fix` };
  }
  return undefined;
}

/** Words that name a desync, a crash or a hang (a freeze where the game stops responding). */
const WORDS: readonly [FailureKind, RegExp][] = [
  ['desync', /\b(?:desync(?:s|ed|ing|hroni[sz]ed)?|out of sync|lockstep (?:fork|divergence))\b/i],
  ['crash', /\b(?:crash(?:es|ed|ing)?|ctd|segfault|access violation|game closes? (?:itself|by itself)|closes to (?:the )?desktop)\b/i],
  ['hang', /\b(?:hangs?|hanging|hung|freez(?:e|es|ing)|froze|frozen|(?:stops?|stopped) responding|not responding|soft[- ]?lock(?:s|ed)?)\b/i],
];
/** A performance hitch is not a hang (w4810): with one of these, a hang word alone files nothing urgent. */
const HITCH = /\b(?:hitch(?:es|ing|y)?|stutter(?:s|ing)?|lag(?:s|gy|ging)?|lag spikes?|frame (?:drops?|time|spikes?)|fps|slow(?:s|down|er|ness)?|performance|perf|spikes?)\b/i;
/** A request about the failure-priority rules themselves or a test of them names the words without being one. */
const META = /\b(?:urgent by default|priority of (?:every )?(?:desync|crash|hang))/i;

/** How much of a brief the word check reads: its opening, where a request says what it is (a long brief names everything). */
export const BRIEF_HEAD = 400;

/** The conservative word check, for a source with no structured signal: the title, then the brief's opening. */
export function wordFailure(title: string, brief = ''): Failure | undefined {
  const head = brief.slice(0, BRIEF_HEAD);
  // A hitch named anywhere in the title or the brief's opening makes its hang words a performance problem.
  const hitch = HITCH.test(title) || HITCH.test(head);
  for (const [where, text] of [['title', title], ['brief', head]] as const) {
    if (!text || META.test(text)) continue;
    for (const [kind, re] of WORDS) {
      const m = re.exec(text);
      if (!m) continue;
      if (kind === 'hang' && hitch) continue;
      return { kind, why: `its ${where} says "${m[0]}"` };
    }
  }
  return undefined;
}

/** The intake kinds with no structured failure signal of their own, where the word check applies (w4810). */
export const WORD_CHECKED: readonly WorkSourceKind[] = ['discord-bug', 'discord-request', 'ffbox-request', 'ffbox-dev'];

/** A request's failure kind: the structured signal, else the word check where its source has no structured one. */
export function failureOf(x: { title: string; brief?: string; source?: WorkSource; triage?: WorkTriage }): Failure | undefined {
  const s = structuredFailure(x.source, x.triage);
  if (s) return s;
  if (x.source && !WORD_CHECKED.includes(x.source.kind)) return undefined;
  return wordFailure(x.title, x.brief);
}

/** The priority to file at: urgent for a failure, the given one when it is already as high or higher, else the given or normal. */
export function failurePriority(given: WorkPriority | undefined, failure: Failure | undefined): WorkPriority {
  const p = given ?? 'normal';
  return failure && !atLeast(p, 'urgent') ? 'urgent' : p;
}

/** The log line of a raise. */
export const failureLine = (f: Failure, was: WorkPriority) => `priority ${was} → urgent: a ${f.kind} (${f.why}); desyncs, crashes and hangs are urgent (lothsahn, w4810). Urgent approves nothing.`;
