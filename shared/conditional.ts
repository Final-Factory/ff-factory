// Conditional decisions (w830; docs/orchestrators.md, "Conditional decisions"): a person's "close w811 as a duplicate once
// #1314 merges", recorded by their orchestrator in a turn of theirs with their own words, and carried out by the server
// when the fact is met (server/blockerWatch.ts reads the pull requests; Orchestrators.carryOutConditional acts).
// Conditions are checked facts only: a pull request merged, a pull request closed, a request closed as done.
import { prRefOf } from './blockers.ts';
import { REPLY_MARK } from './replies.ts';
import type { ConditionalDecision, WorkItem } from './types.ts';

/** How long a decision waits for its fact by default, and at most (days). */
export const CONDITIONAL_DAYS = 14;
export const CONDITIONAL_MAX_DAYS = 60;
/** Pending decisions one request carries at most. */
export const CONDITIONAL_PER_REQUEST = 5;

/**
 * Where FF Factory's own note starts in a person's message (the calls a gate refused, offered back on their next message):
 * what follows is the harness's, never the person's words.
 */
export const HELD_MARK = '[FF Factory, not your person: held from earlier turns]';

/** What update_work's `when` takes: exactly one. */
export interface ConditionInput {
  pr_merged?: string;
  pr_closed?: string;
  request_done?: string;
}

/** The condition as stored; throws, saying what is wrong, for anything but one checked fact. */
export function parseCondition(c: ConditionInput, self: string): ConditionalDecision['when'] {
  const given = (['pr_merged', 'pr_closed', 'request_done'] as const).filter((k) => typeof c[k] === 'string' && c[k]!.trim());
  if (given.length !== 1) throw new Error('when: give exactly one of pr_merged, pr_closed or request_done (a checked fact; nothing else is a condition)');
  const kind = given[0];
  const v = c[kind]!.trim();
  if (kind === 'request_done') {
    const id = v.toLowerCase();
    if (!/^w\d+$/.test(id)) throw new Error(`when.request_done: "${v}" is not a request id (w123)`);
    if (id === self.toLowerCase()) throw new Error(`${self} cannot wait on itself`);
    return { kind, ref: id };
  }
  const ref = prRefOf(v);
  if (!ref) throw new Error(`when.${kind}: "${v}" is not a pull request: give "owner/repo#123" or its github.com link (a bare #1314 names no repo; the game is Final-Factory/FinalFactory, FF Factory is Final-Factory/ff-factory)`);
  return { kind, ref };
}

/** "PR Final-Factory/FinalFactory#1314 merges". */
export function conditionName(when: ConditionalDecision['when']): string {
  if (when.kind === 'request_done') return `${when.ref} closes as done`;
  return `PR ${when.ref} ${when.kind === 'pr_merged' ? 'merges' : 'closes (merged or not)'}`;
}

/** "close as done", "decline". */
export function actionName(a: ConditionalDecision['action']): string {
  return a === 'done' ? 'close as done' : a === 'cancelled' ? 'cancel' : a;
}

const utc = (iso: string) => `${iso.slice(5, 16).replace('T', ' ')} UTC`;

/** One line for a person and the ledger: "c1 on w811: decline when PR …#1314 merges (Lothsahn, 10-10 02:31 UTC: "…"; expires 10-24 02:31 UTC)". */
export function conditionalLine(w: Pick<WorkItem, 'id'>, d: ConditionalDecision): string {
  return `${d.id} on ${w.id}: ${actionName(d.action)} when ${conditionName(d.when)} (${d.by.displayName}, ${utc(d.at)}: "${d.words}"${d.note ? `; note: ${d.note}` : ''}; expires ${utc(d.expires)})`;
}

/** A pull request as the watch reads it; sha is the merge commit when it merged. */
export type ConditionalPr = { state: 'open' | 'merged' | 'closed'; text: string; sha?: string };

export interface ConditionalFacts {
  now: number;
  work: (id: string) => WorkItem | undefined;
  /** undefined: not read (yet), or it could not be read. */
  pr: (ref: string) => ConditionalPr | undefined;
}

/**
 * run: the fact is met, carry it out. drop: it can no longer be met (the PR closed unmerged, the request was declined or
 * cancelled) or it expired: never carried out, its person told. wait: not yet.
 */
export type ConditionalVerdict = { state: 'wait' | 'run' | 'drop'; why: string };

export function conditionalVerdict(d: ConditionalDecision, f: ConditionalFacts): ConditionalVerdict {
  const expired = (open: string): ConditionalVerdict => (f.now >= Date.parse(d.expires) ? { state: 'drop', why: `it expired at ${utc(d.expires)} unmet (${open})` } : { state: 'wait', why: open });
  if (d.when.kind === 'request_done') {
    let t = f.work(d.when.ref);
    for (let i = 0; i < 5 && t?.status === 'merged' && t.mergedInto; i++) t = f.work(t.mergedInto);
    const name = t && t.id !== d.when.ref ? `${d.when.ref} (merged into ${t.id})` : d.when.ref;
    if (!t) return { state: 'drop', why: `${d.when.ref} is not in the ledger` };
    if (t.status === 'done') return { state: 'run', why: `${name} closed as done` };
    if (t.status === 'rejected' || t.status === 'cancelled') return { state: 'drop', why: `${name} was ${t.status === 'rejected' ? 'declined' : 'cancelled'}, not done` };
    return expired(`${name} is ${t.status}`);
  }
  const p = f.pr(d.when.ref);
  if (p?.state === 'merged') return { state: 'run', why: `PR ${d.when.ref} merged${p.sha ? ` as ${p.sha.slice(0, 12)}` : ''}` };
  if (p?.state === 'closed') return d.when.kind === 'pr_closed' ? { state: 'run', why: `PR ${d.when.ref} was closed without merging` } : { state: 'drop', why: `PR ${d.when.ref} was closed without merging` };
  return expired(p ? `PR ${d.when.ref} is still open` : `PR ${d.when.ref} not read yet`);
}

const norm = (s: string) =>
  s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Whether `words` are a person's own, verbatim (case, quotes and spacing aside): found in one of their messages, before
 * FF Factory's own note in it (HELD_MARK), or the message they quoted in a reply (REPLY_MARK, w866). Outer quotes and end punctuation of `words` do not count.
 */
export function inPersonWords(words: string, messages: readonly string[]): boolean {
  const w = norm(words).replace(/^["'\s]+|["'\s.,;!]+$/g, '');
  if (w.length < 6) return false;
  return messages.some((m) => norm(m.split(HELD_MARK)[0].split(REPLY_MARK)[0]).includes(w));
}
