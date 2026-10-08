// What a request is really doing now (w418, asked by Lothsahn): Working, Waiting on input, Queued, Blocked, Merged with a
// follow-up pending, or Stalled, derived live from its workers and its own fields. Shown by list_work, read_work and the
// Dispatcher page; it never changes a request. The stored status (and the cleanup's `stalled`, which still decides what
// it closes or stalls, server/ledgerSweep.ts) stays as it is (docs/orchestrators.md, "Ledger").
//
// The three waits (w643, Lothsahn: "make sure you consistently apply all 3 states in all cases"): Waiting on input is a
// PERSON who must act, and says on whom; Queued is capacity ONLY (no free machine, sandbox or agent slot), and a Queued
// request while a computer that could take it has room is flagged; Blocked is a THING (another request, a deploy, a
// machine, a usage limit, a lock, a time, CI) and names it. A worker between turns with its own work still going (a
// background job such as CI, a check-in it set) is Working: it holds the request and comes back to it by itself.
//
// w691 (w665: a worker that needed a person to reboot a Mac set check-ins and showed Working for 10 hours): a worker that
// says only a person can move it on is Waiting on input, check-in or not. Its own declaration (the waiting_on_person
// tool, SessionInfo.waitingOn) comes first; the "still open:" line of its report is read as a backstop (personWaitIn).
// And a worker whose agent host never started (SessionInfo.hostFailure) is Blocked on its machine, not mid-turn.
import type { SessionInfo, WorkItem } from './types.ts';
import { agentState, hostFailureText } from './agentState.ts';
import { blockerName } from './blockers.ts';

export type WorkLiveState = 'working' | 'waiting' | 'queued' | 'blocked' | 'followup' | 'stalled';
export const WORK_LIVE_STATES: readonly WorkLiveState[] = ['working', 'waiting', 'queued', 'blocked', 'followup', 'stalled'];
export const WORK_LIVE_LABEL: Record<WorkLiveState, string> = {
  working: 'Working',
  waiting: 'Waiting on input',
  queued: 'Queued',
  blocked: 'Blocked',
  followup: 'Merged, follow-up pending',
  stalled: 'Stalled',
};

export interface WorkLive {
  state: WorkLiveState;
  /** Why, in a few words: who works on it, what it waits for, why nothing is. */
  why: string;
  /** Waiting on input: who it waits on (display names, or "a reviewer"). Blocked: what it waits on ("w633 finishing"). */
  waitsOn?: string[];
  /**
   * Queued while a computer that could take it has room (w643): a bug the dispatcher must fix (start it, or block it on
   * what it really waits for). Names the computers.
   */
  roomOn?: string[];
}

export interface WorkLiveFacts {
  session: (id: string) => SessionInfo | undefined;
  /** Every request (open ones are enough): which request a worker linked to several serves is decided across them. */
  items: readonly WorkItem[];
  /**
   * The server's send queue (w384): why a message to this worker waits, if one does, and on what (w643). Default: the
   * session's own copy (SessionInfo.queuedSend, queuedOn), which the page has too.
   */
  queuedSend?: (sessionId: string) => string | undefined;
  /** The computers with room for one more worker now (Agents.places, hasRoom); undefined when unknown. */
  room?: readonly string[];
  now: number;
}

/** WORK_OPEN's statuses, and stalled: spelled out, since the web build takes only type imports from shared/types.ts. */
const LIVE = new Set<WorkItem['status']>(['new', 'question', 'queued', 'blocked', 'active', 'stalled']);
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

/** Capitalised words after "waiting for" that are not a person. */
const NOT_A_PERSON = new Set(['ci', 'steam', 'steamworks', 'unity', 'github', 'ffbox', 'claude', 'windows', 'mac', 'linux', 'discord', 'apple', 'xcode', 'metal', 'rosetta', 'tailscale', 'portal', 'beast', 'max', 'nightly', 'build', 'release', 'deploy', 'master', 'develop', 'main', 'the', 'this', 'that']);
const WAITS = '(?:waiting (?:for|on)|waits (?:for|on)|blocked on|needs|requires)';
const WHAT_THEY_GIVE = "(?:decision|input|approval|answer|call|go-?ahead|ok|confirmation|reply|choice|login|password|code|key)";
/** "(a person)", "needs a person", "a human must …": a person, not named. */
const A_PERSON = /\(\s*(?:a|the) (?:person|human)\s*\)|\b(?:needs?|requires?|waiting (?:for|on)|waits (?:for|on)|blocked on) (?:a|the) (?:person|human)\b|\b(?:a|the) (?:person|human) (?:must|needs to|has to|should|will need to)\b|\bhuman action\b/i;
/** "waiting for Ben to …", "needs Lothsahn's approval": a capitalised first name. */
const NAMED = new RegExp(`\\b${WAITS}\\s+([A-Z][a-z]{1,20})(?:\\s+to\\b|'s\\s+${WHAT_THEY_GIVE}\\b)`);
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The line of a worker's report about request `workId` that is not finished (w631: `w342: still open: …`, or `NOT DONE:
 * w342 …`), as written. The grammar of server/ledgerRules.ts `stillOpenIn`, kept here because the web build takes only
 * types from the server.
 */
function stillOpenLine(report: string, workId: string): string | undefined {
  const id = workId.toLowerCase();
  for (const m of report.matchAll(/^[\s*_>`-]*(?:NOT[ -]DONE:?\s*[*_`]*(w\d+)\b|(w\d+)[*_`]*\s*[:—–-]\s*[*_`]*\s*(?:still open|not done)\b).*$/gim)) {
    if ((m[1] ?? m[2]).toLowerCase() === id) return m[0].replace(/^[\s*_>`-]+/, '').trim();
  }
  return undefined;
}

/**
 * The backstop (w691): the worker's report says, on its "still open:" line for this request, that a person must act:
 * "(a person)", "needs a person", "waiting for Ben to log in", "needs Ben's approval". Only that line, only those words
 * ("waiting for CI to finish" is a machine, not a person), and only the report's tail, as asksAPerson reads it. `people`
 * are display names that count as a person besides a capitalised first name. The explicit declaration (SessionInfo.waitingOn)
 * is the real signal; this catches a worker that did not use it.
 */
export function personWaitIn(report: string | undefined, workId: string, people: readonly string[] = []): { who?: string; line: string } | undefined {
  if (!report) return undefined;
  const line = stillOpenLine(report.trim().slice(-2000), workId);
  if (!line) return undefined;
  const known = people.find((p) => new RegExp(`\\b${WAITS}\\s+${escapeRe(p)}(?:\\s+to\\b|'s\\s+${WHAT_THEY_GIVE}\\b)`, 'i').test(line));
  if (known) return { who: known, line };
  const named = NAMED.exec(line)?.[1];
  if (named && !NOT_A_PERSON.has(named.toLowerCase())) return { who: named, line };
  if (A_PERSON.test(line)) return { line };
  return undefined;
}

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

  // Working: one of its workers is mid-turn on it, or FFBox runs it. Not one whose agent host never started (w691): an
  // older daemon went on reporting it mid-turn, and nothing runs.
  const busy = mine.filter((s) => BUSY.has(s.status) && !s.hostFailure);
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

  // Blocked on its machine (w691): a worker's message found no agent host to run in. Nothing runs for it, whatever its
  // status says; it unblocks when a host starts (its first event), and the dispatcher is told it failed.
  const dead = mine.find((s) => s.hostFailure);
  if (dead) return { state: 'blocked', why: `${dead.id}: ${hostFailureText(dead)} (${dead.hostFailure!.error.slice(0, 120)}; ${ago(dead.hostFailure!.at, f.now)})`, waitsOn: [dead.machineId ?? 'its machine'] };

  // Waiting on a person, declared (w691): the worker says only a person can move it on, and who. A check-in it set as
  // well does not make it Working: no wake-up moves a person.
  const declared = mine.find((s) => s.waitingOn && (!s.waitingOn.request || s.waitingOn.request.toLowerCase() === w.id.toLowerCase()));
  if (declared) {
    const d = declared.waitingOn!;
    const who = d.who.split(/\s*(?:,|&|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
    return { state: 'waiting', why: `${declared.id} waits on ${d.who}: ${d.what} (since ${ago(d.at, f.now)})`, waitsOn: who.length ? who : names(w.requesters) };
  }

  // Working, between turns (w475, w643): a worker on it has its own work still going (a background job such as CI or a
  // build, or a check-in it set) and comes back to it by itself, also when stopped until that check-in (w509, w640).
  // Not Waiting: nobody else needs to act.
  const coming = mine.map((s) => ({ s, a: agentState(s, undefined, f.now) })).find((x) => (x.a.state === 'between_turns' && x.a.kind !== 'queued') || x.a.resumes?.startsWith('check-in'));
  // Its last report says a person must act (w691, the backstop): the check-in it set does not make it Working. A job
  // still running (CI, a build) does: work goes on meanwhile.
  const people = [...new Set([w.requestedBy, ...w.requesters].map((r) => r.displayName))];
  const said = mine.map((s) => ({ s, p: personWaitIn(s.lastResult, w.id, people) })).find((x) => x.p);
  if (said && !(coming && coming.a.kind === 'job')) return { state: 'waiting', why: `${said.s.id}'s report says a person must act: "${said.p!.line.slice(0, 160)}"`, waitsOn: said.p!.who ? [said.p!.who] : names(w.requesters) };

  if (coming) return { state: 'working', why: coming.a.state === 'stopped' ? `${coming.s.id} stopped until its ${coming.a.resumes}` : `${coming.s.id} between turns: ${coming.a.waitsOn}` };

  const decide = mine.find((s) => asksAPerson(s.lastResult));
  if (decide) return { state: 'waiting', why: `${decide.id} stopped asking for a decision`, waitsOn: names(w.requesters) };

  // A message to one of its workers waits in the send queue: for a free slot (Queued) or for its machine (Blocked).
  const held = mine.map((s) => ({ s, why: f.queuedSend?.(s.id) ?? s.queuedSend, on: s.queuedOn })).find((x) => x.why);
  if (held?.on === 'machine') return { state: 'blocked', why: `a message to ${held.s.id} waits for its machine (${held.why})`, waitsOn: [held.s.machineId ?? 'its machine'] };
  if (held) return { state: 'queued', why: `a message to ${held.s.id} waits for a free agent slot (${held.why})` };

  // Blocked on a thing (w643): the blocker it records.
  if (w.status === 'blocked' && w.blocked) return { state: 'blocked', why: `${w.blocked.what} (since ${ago(w.blocked.at, f.now)}, set by ${w.blocked.by})`, waitsOn: [blockerName(w.blocked, f.now)] };

  // Not decided yet: the dispatcher has it (its [work request] went out when it was filed or reopened).
  if (w.status === 'new') return { state: 'working', why: `the dispatcher has it to decide, since ${ago(w.updatedAt, f.now)}` };

  // Queued: capacity only. With a computer that could take it free, that is wrong, and says so (w643).
  if (w.status === 'queued') {
    const needs = w.queuedFor?.needs?.map((n) => n.toLowerCase());
    const room = (f.room ?? []).filter((id) => !needs?.length || needs.includes(id.toLowerCase()));
    const what = `for capacity${needs?.length ? ` on ${needs.join(' or ')}` : ''}`;
    if (room.length) return { state: 'queued', why: `queued ${what}, but ${room.join(', ')} ${room.length > 1 ? 'have' : 'has'} room: the dispatcher should start it, or block it on what it waits for`, roomOn: room };
    return { state: 'queued', why: `queued ${what}${f.room ? ': no computer that could take it has room' : ''}` };
  }

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

/** "3 working, 2 waiting on input, 1 blocked": the counts, in WORK_LIVE_STATES order, zeros left out. */
export function liveCounts(states: Iterable<WorkLive>): Record<WorkLiveState, number> {
  const n = Object.fromEntries(WORK_LIVE_STATES.map((s) => [s, 0])) as Record<WorkLiveState, number>;
  for (const l of states) n[l.state]++;
  return n;
}
