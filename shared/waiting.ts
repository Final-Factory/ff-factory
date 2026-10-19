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
  /** Who it waits on, in words ("a reviewer", "Ben"): the person the live state names, never the requester (w1559). */
  on: string[];
  /** Who filed it (display names): secondary to `on`, since the request may wait on someone else (w1559). */
  requesters: string[];
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
    // A decision is listed whatever the request is doing meanwhile (w1356): a worker mid-turn on it makes its live state Working,
    // which workLive checks first, but the sidebar's Needs you counts the question, and its click has to find it here.
    if (!l || (l.state !== 'waiting' && !isDecision(w))) continue;
    const d = describe(w, l);
    out.push({ w, live: l, ...d, mine: isMyMove(w, l, d.ask, me), on: l.waitsOn ?? [], requesters: w.requesters.map((r) => r.displayName) });
  }
  return out.sort((a, b) => Number(b.mine) - Number(a.mine) || a.since.localeCompare(b.since));
}

/** The label of a wait's person: the people it waits on, or "someone else" when the live state names none. */
export const waitOnLabel = (i: Pick<WaitingItem, 'on'>) => i.on.join(', ') || 'someone else';

/**
 * The items in groups by the person they wait on (w1559, lothsahn: "they should show the name of the person they're waiting on"),
 * in order of first appearance, so a request lothsahn filed and Ben must answer is listed under Ben, not under lothsahn.
 */
export function groupByPerson(items: readonly WaitingItem[]): { who: string; items: WaitingItem[] }[] {
  const out: { who: string; items: WaitingItem[] }[] = [];
  for (const i of items) {
    const who = waitOnLabel(i);
    const g = out.find((x) => x.who.toLowerCase() === who.toLowerCase());
    if (g) g.items.push(i);
    else out.push({ who, items: [i] });
  }
  return out;
}

/** How stale a wait is: past a day it is "old", past three days "stale". */
export function waitAge(since: string, now: number): 'fresh' | 'old' | 'stale' {
  const age = now - Date.parse(since);
  return age > 3 * 86_400_000 ? 'stale' : age > 86_400_000 ? 'old' : 'fresh';
}

/** An approval, a question or a design question: something a person decides, whatever else the request is doing. */
const isDecision = (w: WorkItem) => w.approval?.state === 'pending' || !!w.question || !!w.flag;

export interface Decision {
  w: WorkItem;
  /** Approve or decline it, or answer it. */
  ask: 'approve' | 'answer';
  /** When it began to wait (ISO). */
  at: string;
  /** What is asked, in a line for the sidebar's Needs you list. */
  text: string;
}

/**
 * The decisions that wait on the viewer and need no live state to find: an intake approval (a reviewer's), the dispatcher's
 * question to them, a design question for them, oldest first. The sidebar's "Needs you" list (one item each, w1356) and the
 * phone's bell count these (cheap field reads on every state push). The tab shows every one as a card with its buttons
 * (waitingItems lists them whatever the request is doing), so a click on an item finds its card; it adds the waits only a
 * live state shows (a worker's declared wait, its report).
 */
export function decisionsOn(work: readonly WorkItem[], me: WaitingViewer): Decision[] {
  const out: Decision[] = [];
  for (const w of work) {
    if (w.approval?.state === 'pending') {
      if (me.reviewer) out.push({ w, ask: 'approve', at: w.createdAt, text: `Approve or decline ${w.id}` });
    } else if (w.question) {
      if (same(w.requestedBy.userId, me.userId)) out.push({ w, ask: 'answer', at: w.question.at, text: `Answer ${w.id}: ${clip(w.question.text, 90)}` });
    } else if (w.flag) {
      if (w.flag.for.some((r) => same(r.userId, me.userId))) out.push({ w, ask: 'answer', at: w.flag.at, text: `Answer ${w.id}: ${clip(w.flag.text, 90)}` });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** How many decisions wait on the viewer, and since when. */
export function decisionsOnMe(work: readonly WorkItem[], me: WaitingViewer): { count: number; since: string } {
  const d = decisionsOn(work, me);
  return { count: d.length, since: d[0]?.at ?? '' };
}
