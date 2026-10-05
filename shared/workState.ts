// What a request is really doing now (w418, asked by Lothsahn): Working, Waiting on input, Queued, Merged with a
// follow-up pending, or Stalled, derived live from its workers and its own fields. Shown by list_work and the
// Dispatcher page; it never changes a request. The stored status (and the cleanup's `stalled`, which still decides what
// it closes or stalls, server/ledgerSweep.ts) stays as it is (docs/orchestrators.md, "Ledger").
import type { SessionInfo, WorkItem } from './types.ts';

export type WorkLiveState = 'working' | 'waiting' | 'queued' | 'followup' | 'stalled';
export const WORK_LIVE_STATES: readonly WorkLiveState[] = ['working', 'waiting', 'queued', 'followup', 'stalled'];
export const WORK_LIVE_LABEL: Record<WorkLiveState, string> = {
  working: 'Working',
  waiting: 'Waiting on input',
  queued: 'Queued',
  followup: 'Merged, follow-up pending',
  stalled: 'Stalled',
};

export interface WorkLive {
  state: WorkLiveState;
  /** Why, in a few words: who works on it, what it waits for, why nothing is. */
  why: string;
  /** Waiting: who it waits on (display names, or "a reviewer"). */
  waitsOn?: string[];
}

export interface WorkLiveFacts {
  session: (id: string) => SessionInfo | undefined;
  /** Every request (open ones are enough): which request a worker linked to several serves is decided across them. */
  items: readonly WorkItem[];
  /** The server's send queue (w384): why a message to this worker waits for a free agent slot, if one does. */
  queuedSend?: (sessionId: string) => string | undefined;
  now: number;
}

/** WORK_OPEN's statuses, and stalled: spelled out, since the web build takes only type imports from shared/types.ts. */
const LIVE = new Set<WorkItem['status']>(['new', 'question', 'queued', 'active', 'stalled']);
const live = (w: WorkItem) => LIVE.has(w.status);
const BUSY = new Set<SessionInfo['status']>(['running', 'starting']);

/**
 * When `sessionId` was last given this request, and how: `sent` (started or messaged with its work_id) or `linked`
 * (decide_work link, to a worker already on it). A link from before w418 has no record: the request's creation stands in.
 */
function linkOf(w: WorkItem, sessionId: string): { at: number; how: 'sent' | 'linked' } {
  const r = w.links?.[sessionId];
  return r ? { at: Date.parse(r.at) || 0, how: r.how } : { at: Date.parse(w.createdAt) || 0, how: 'sent' };
}

/**
 * The requests a worker's current turn serves: the one it was last sent (a start or a message with its work_id), and
 * those linked to it since (decide_work link: small reports sharing one worker). A worker on several requests is working
 * on these only, not on the ones it moved on from.
 */
export function servedBy(sessionId: string, items: readonly WorkItem[]): Set<string> {
  const mine = items.filter((w) => live(w) && w.sessionIds.includes(sessionId)).map((w) => ({ w, l: linkOf(w, sessionId) }));
  const lastSent = Math.max(-1, ...mine.filter((x) => x.l.how === 'sent').map((x) => x.l.at));
  return new Set(mine.filter((x) => (x.l.how === 'sent' ? x.l.at === lastSent : x.l.at >= lastSent)).map((x) => x.w.id));
}

const NEEDS_PERSON =
  /\b(needs?|waiting (for|on)|blocked on) (your|a person'?s|a human'?s|the (user|owner|requester)'?s|human|their|his|her|ben'?s|lothsahn'?s) (decision|input|approval|answer|confirmation|go-?ahead|ok|call)\b|\b(please|can you|could you|should I) (decide|confirm|approve|choose|pick|tell me)\b|\bdecision needed\b|\bwhich (option|one) (do you|should)\b|\?\s*$/i;

/** Whether a worker's last report ends asking a person to decide (its tail, as the cleanup reads reports). */
export const asksAPerson = (report: string | undefined) => !!report && NEEDS_PERSON.test(report.trim().slice(-600));

/**
 * "PR #12 merged; still open: <why>", the cleanup's own line (server/ledgerSweep.ts), newest first. A line that says
 * another PR is open is out of date once no PR is (w74's "PR #1002 is open" after #1002 merged): it is passed over.
 */
function followUpReason(w: WorkItem): string | undefined {
  for (let i = w.log.length - 1; i >= 0; i--) {
    const m = /PR #\d+ merged; still open: (.+)$/.exec(w.log[i]);
    if (m && !/^PR #\d+ is open\b/.test(m[1])) return m[1];
  }
  return undefined;
}

const names = (rs: readonly { displayName: string }[]) => rs.map((r) => r.displayName);
const ago = (iso: string | undefined, now: number) => {
  const ms = now - (Date.parse(iso ?? '') || now);
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** The live state of one request, or undefined once it is closed. */
export function workLive(w: WorkItem, f: WorkLiveFacts, served?: (sessionId: string) => Set<string>): WorkLive | undefined {
  if (!live(w)) return undefined;
  const serves = served ?? ((sid: string) => servedBy(sid, f.items));
  const workers = w.sessionIds.map((id) => f.session(id)).filter((s): s is SessionInfo => !!s);
  const mine = workers.filter((s) => serves(s.id).has(w.id));
  const others = workers.filter((s) => !serves(s.id).has(w.id));

  // Working: one of its workers is mid-turn on it, or FFBox runs it.
  const busy = mine.filter((s) => BUSY.has(s.status));
  if (busy.length) {
    const tool = busy.find((s) => s.activeTool)?.activeTool;
    return { state: 'working', why: `${busy.map((s) => s.id).join(', ')} ${busy[0].status === 'starting' ? 'starting' : 'mid-turn'}${tool ? `, in ${tool.name} since ${ago(tool.since, f.now)}` : ''}` };
  }
  if (w.ffbox && (w.ffbox.state === 'sent' || w.ffbox.state === 'accepted')) return { state: 'working', why: `on FFBox${w.ffbox.conversation ? ` (conversation ${w.ffbox.conversation})` : ''}` };

  // Waiting on input: a person must approve, answer, decide or allow something.
  if (w.approval?.state === 'pending') return { state: 'waiting', why: 'an intake request waiting for a reviewer to approve or decline it', waitsOn: ['a reviewer'] };
  if (w.question) return { state: 'waiting', why: `the dispatcher's question: ${w.question.text}`, waitsOn: names([w.requestedBy]) };
  if (w.flag) return { state: 'waiting', why: `a design question: ${w.flag.text}`, waitsOn: names(w.flag.for) };
  const asking = mine.find((s) => s.status === 'waiting_permission');
  if (asking) {
    const p = asking.pendingPermissions[0];
    return { state: 'waiting', why: `${asking.id} waits for permission${p ? ` to use ${p.toolName}` : ''}`, waitsOn: names(asking.requestedBy ? [asking.requestedBy] : w.requesters) };
  }
  const decide = mine.find((s) => asksAPerson(s.lastResult));
  if (decide) return { state: 'waiting', why: `${decide.id} stopped asking for a decision`, waitsOn: names(w.requesters) };

  // Queued: not started yet, or held for a free agent slot.
  const held = mine.map((s) => ({ s, why: f.queuedSend?.(s.id) })).find((x) => x.why);
  if (held) return { state: 'queued', why: `a message to ${held.s.id} waits for a free agent slot (${held.why})` };
  if (w.status === 'new') return { state: 'queued', why: 'waiting for the dispatcher to decide it' };
  if (w.status === 'queued') return { state: 'queued', why: 'the dispatcher queued it for capacity' };

  // The cleanup stalled it: its own reason, which says more than anything derived here (w418: kept as it is).
  if (w.stalled) return { state: 'stalled', why: `${w.stalled.kind}: ${w.stalled.reason}` };

  // Merged, follow-up pending: its pull requests merged, none is open, and the request is still open.
  const prs = w.prs ?? [];
  if (prs.some((p) => p.state === 'merged') && !prs.some((p) => p.state === 'open')) {
    return { state: 'followup', why: followUpReason(w) ?? 'merged; the cleanup has not said yet what is left' };
  }

  // Stalled: nothing works on it and nothing waits on a person.
  const open = prs.find((p) => p.state === 'open');
  const pr = open ? `; PR #${open.number} is open` : '';
  if (open && !mine.length) return { state: 'stalled', why: `PR #${open.number} is open and no worker is on it${others.length ? ` (its worker ${others[0].id} moved on${[...serves(others[0].id)][0] ? ` to ${[...serves(others[0].id)][0]}` : ''})` : ''}` };
  if (!workers.length && !w.sessionIds.length) return { state: 'stalled', why: 'no worker was ever started for it' };
  if (!mine.length && others.length) {
    const s = others[0];
    const now = [...serves(s.id)][0];
    return { state: 'stalled', why: `its worker ${s.id} moved on${now ? ` to ${now}` : ''}` };
  }
  if (!workers.length) return { state: 'stalled', why: 'its workers are gone' };
  const last = [...mine].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  return { state: 'stalled', why: `${last.id} ${last.status === 'error' ? 'failed' : last.status === 'idle' ? 'finished its turn' : 'stopped'} ${ago(last.lastActivityAt, f.now)}${pr}, nothing waits on a person` };
}

/** Every open (or stalled) request's live state, by id. */
export function workLiveAll(items: readonly WorkItem[], f: Omit<WorkLiveFacts, 'items'>): Map<string, WorkLive> {
  const facts = { ...f, items };
  const cache = new Map<string, Set<string>>();
  const served = (sid: string) => {
    let s = cache.get(sid);
    if (!s) cache.set(sid, (s = servedBy(sid, items)));
    return s;
  };
  const out = new Map<string, WorkLive>();
  for (const w of items) {
    const l = workLive(w, facts, served);
    if (l) out.set(w.id, l);
  }
  return out;
}

/** "3 working, 2 waiting on input, 1 stalled": the counts, in WORK_LIVE_STATES order, zeros left out. */
export function liveCounts(states: Iterable<WorkLive>): Record<WorkLiveState, number> {
  const n = Object.fromEntries(WORK_LIVE_STATES.map((s) => [s, 0])) as Record<WorkLiveState, number>;
  for (const l of states) n[l.state]++;
  return n;
}
