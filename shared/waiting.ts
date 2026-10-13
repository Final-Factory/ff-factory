// The requests that wait on a person (w1228), for the Dispatcher page's "Waiting on input" tab: what each one is, what is
// asked, whose move it is, how long it has waited, and FF Factory's read of it. A pure function over the ledger and the
// live states (shared/workState.ts), so the sidebar, the phone's bell and the tab all count the same items.
import type { WorkItem } from './types.ts';
import type { WorkLive } from './workState.ts';

/** What is asked: approve or decline an intake request, answer a question, or check something (a worker's permission or report). */
export type WaitingAsk = 'approve' | 'answer' | 'check';

export interface WaitingItem {
  w: WorkItem;
  live: WorkLive;
  ask: WaitingAsk;
  /** It is the viewer's move (a reviewer's approval, their own question, a design question for them, a person named as them). */
  mine: boolean;
  /** Who it waits on, in words ("a reviewer", "Ben"). */
  on: string[];
  /** When it began to wait (ISO); the request's last change when nothing says better. */
  since: string;
  /** What is asked, in one plain sentence. */
  text: string;
  /** FF Factory's recommendation, only where its own triage gives one. */
  recommendation?: string;
}

export interface WaitingViewer {
  userId: string;
  displayName: string;
  /** Whether the viewer is one of the intake's reviewers (IntakeSummary.reviewerIds). */
  reviewer: boolean;
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The request kinds whose triage is a reason to approve. A needs-human request gets no recommendation: it is the person's call. */
const APPROVE_CLASS: Partial<Record<NonNullable<WorkItem['triage']>['class'], string>> = {
  'obvious-bug': 'an obvious bug',
  person: 'asked by a person',
  regression: 'a nightly regression',
  'ffbox-desync': 'an FFBox desync PR',
};

/** FF Factory's recommendation for a pending intake request: a possible repeat first, else its triage class; nothing when it is the person's call. */
export function intakeRecommendation(w: WorkItem): string | undefined {
  const repeat = w.overlaps[0];
  if (repeat) return `Check first: it may repeat ${repeat.ref} “${clip(repeat.title, 60)}” (${repeat.why}).`;
  const cls = w.triage?.class;
  if (cls && APPROVE_CLASS[cls]) return `Approve (${APPROVE_CLASS[cls]}): ${w.triage!.reason}`;
  return undefined;
}

function describe(w: WorkItem, live: WorkLive): { ask: WaitingAsk; text: string; since: string; recommendation?: string } {
  if (w.approval?.state === 'pending') {
    return {
      ask: 'approve',
      text: `Nothing is worked on this ${w.source ? 'report' : 'request'} until it is approved${w.approval.why ? ` (not approved automatically: ${w.approval.why})` : ''}.`,
      since: w.createdAt,
      recommendation: intakeRecommendation(w),
    };
  }
  if (w.question) return { ask: 'answer', text: `The dispatcher asks: ${w.question.text}`, since: w.question.at };
  if (w.flag) return { ask: 'answer', text: `A design question: ${w.flag.text}`, since: w.flag.at };
  return { ask: 'check', text: live.why, since: w.updatedAt };
}

/** Whose move it is, for a request in the live state "waiting". */
function isMyMove(w: WorkItem, live: WorkLive, ask: WaitingAsk, me: WaitingViewer): boolean {
  if (ask === 'approve') return me.reviewer;
  if (w.question) return same(w.requestedBy.userId, me.userId);
  if (w.flag) return w.flag.for.some((r) => same(r.userId, me.userId));
  const on = (live.waitsOn ?? []).map((n) => n.toLowerCase());
  if (on.length) return on.includes(me.displayName.toLowerCase());
  return w.requesters.some((r) => same(r.userId, me.userId));
}

/**
 * Every open request whose live state is "waiting" (Waiting on input), the viewer's own moves first, then the rest;
 * within each part the one that has waited longest first.
 */
export function waitingItems(work: readonly WorkItem[], live: ReadonlyMap<string, WorkLive>, me: WaitingViewer): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const w of work) {
    const l = live.get(w.id);
    if (l?.state !== 'waiting') continue;
    const d = describe(w, l);
    out.push({ w, live: l, ...d, mine: isMyMove(w, l, d.ask, me), on: l.waitsOn ?? [] });
  }
  return out.sort((a, b) => Number(b.mine) - Number(a.mine) || a.since.localeCompare(b.since));
}

/** How stale a wait is: past a day it is "old", past three days "stale". */
export function waitAge(since: string, now: number): 'fresh' | 'old' | 'stale' {
  const age = now - Date.parse(since);
  return age > 3 * 86_400_000 ? 'stale' : age > 86_400_000 ? 'old' : 'fresh';
}

/**
 * The decisions that wait on the viewer and need no live state to find: an intake approval (a reviewer's), the dispatcher's
 * question to them, a design question for them. The sidebar's "Needs you" list and the phone's bell count these (cheap
 * field reads on every state push); the tab adds the waits only a live state shows (a worker's declared wait, its report).
 */
export function decisionsOnMe(work: readonly WorkItem[], me: WaitingViewer): { count: number; since: string } {
  let count = 0;
  let since = '';
  for (const w of work) {
    let at: string | undefined;
    if (w.approval?.state === 'pending') at = me.reviewer ? w.createdAt : undefined;
    else if (w.question) at = same(w.requestedBy.userId, me.userId) ? w.question.at : undefined;
    else if (w.flag) at = w.flag.for.some((r) => same(r.userId, me.userId)) ? w.flag.at : undefined;
    if (!at) continue;
    count++;
    if (!since || at < since) since = at;
  }
  return { count, since };
}
