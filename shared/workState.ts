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
//
// w1504 (w1243 showed Waiting on input on Ben, and its slot "Needs you", for days after Ben had answered and the PR the
// report named had merged; Ben: "i dont know what it needs me to do for this slot"): a person-wait counts only until that
// person answers the request (a note, or a [needs you] answer) or a pull request it names merges, whichever comes first
// (personWaitSettled), and a request Blocked on a thing shows Blocked unless the person-wait is newer than its gates.
//
// w1812 (worker c28c5061 asked one set of questions, raised on both w1767 and w1768; Ben answered on w1767 and was asked
// again on w1768: "i already answered this why are you asking me in the waiting on input for this still"): one question from
// one worker on several requests is one wait. The person's answer on any of them, given after it was raised, settles it on
// all of them (sharedWaitSettled).
//
// w1841 (Ben's Stalled filter showed six requests that were not stalled: "why are these stalled?"): Stalled is only what
// nothing will move. A worker an urgent release's build paused is Blocked on that build, and one whose report waits on a
// machine's bench lock is Blocked on that lock (both resume by themselves). A wait on the bug's reporter or a player
// (through FFBox and Discord) is Waiting, on them, and never goes to a person's orchestrator as [needs you]. A wait on a
// person counts whichever worker of the request said it, also one that went on to other work since (its last report on
// the request, read from the log). A worker that waits on another request's worker (its files, its results) is Blocked on
// that request. And a worker that says it waits on the orchestrator for its own work says so in the Stalled line.
import type { BenchLock, BuildHold, SessionInfo, WorkItem } from './types.ts';
import { agentState, hostFailureText } from './agentState.ts';
import { gatesName, gatesOf } from './blockers.ts';
import { admitsPriority, needsOf, reservedText, ROOM_STAND_MS, unfitWhy, type ReservedRoom, type RoomFit } from './capacity.ts';
import type { QueueWait } from './queueWaits.ts';

export type WorkLiveState = 'working' | 'waiting' | 'queued' | 'blocked' | 'paused' | 'followup' | 'stalled';
export const WORK_LIVE_STATES: readonly WorkLiveState[] = ['working', 'waiting', 'queued', 'blocked', 'paused', 'followup', 'stalled'];
export const WORK_LIVE_LABEL: Record<WorkLiveState, string> = {
  working: 'Working',
  waiting: 'Waiting on input',
  queued: 'Queued',
  blocked: 'Blocked',
  paused: 'Paused',
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
  /** Waiting on input for something a worker asked (its permission, declaration or report; w1504): that worker's session id. */
  worker?: string;
  /** Working (w1104): the machines its working workers run on, each once, in the workers' order ("lothdesktop", "beast"); absent when none is known. */
  machines?: string[];
  /**
   * Waiting on input on someone outside the team (w1841): the bug's reporter or a player, through FFBox and Discord. Nobody's
   * orchestrator is sent it as [needs you]; FFBox passes their answer on.
   */
  outside?: boolean;
  /** Waiting on input on a worker's own words (w1868): its whole line, where `why` quotes it cut short. */
  line?: string;
}

/**
 * The machine ids the given workers run on (w1104), each once: a machine sandbox worker's `machineId` is the machine part of
 * "<machine>/<slot>". A worker on no machine (the portal's own host) names none.
 */
export function machinesOf(workers: readonly Pick<SessionInfo, 'machineId'>[]): string[] {
  return [...new Set(workers.map((s) => s.machineId?.split('/')[0].trim()).filter((m): m is string => !!m))];
}
const withMachines = (l: WorkLive, workers: readonly Pick<SessionInfo, 'machineId'>[]): WorkLive => {
  const machines = machinesOf(workers);
  return machines.length ? { ...l, machines } : l;
};

export interface WorkLiveFacts {
  session: (id: string) => SessionInfo | undefined;
  /** Every request (open ones are enough): which request a worker linked to several serves is decided across them. */
  items: readonly WorkItem[];
  /**
   * The server's send queue (w384): why a message to this worker waits, if one does, and on what (w643). Default: the
   * session's own copy (SessionInfo.queuedSend, queuedOn), which the page has too.
   */
  queuedSend?: (sessionId: string) => string | undefined;
  /** The computers with room for one more game worker now (server/placement.ts roomNow); undefined when unknown. */
  room?: readonly string[];
  /** The computers with an agent slot for work that needs no editor and no game sandbox (w1098); undefined when unknown. */
  agentRoom?: readonly string[];
  /** Computers with room that a placement hold keeps work off (w1089), with who and why: a Queued request says so. */
  heldRoom?: readonly { id: string; why: string; for: readonly ('game' | 'agent')[] }[];
  /** Computers with room that placement.minPriority reserves for higher work (w1643): room only for a request at that level now. */
  reservedRoom?: readonly ReservedRoom[];
  /** Each computer with room, id to its platform and no-timed-runs reason (w1944, RoomNow.fit): work it cannot run is not WRONG beside it. */
  roomFit?: Readonly<Record<string, RoomFit>>;
  /** Since when each computer has had room, `${kind}:${id}` to epoch ms (w1944, RoomNow.since); absent: room counts at once. */
  roomSince?: Readonly<Record<string, number>>;
  /** The urgent release build that paused this worker (w1841, server/buildPlans.ts pausedFor); undefined when none did. */
  buildHold?: (sessionId: string) => BuildHold | undefined;
  /** A machine's bench lock while a timed run holds it (w1841, MachineStats.benchLock); undefined when free or unknown. */
  benchLock?: (machineId: string) => BenchLock | undefined;
  /**
   * What workers wait for in their machines' queues now (w1949, shared/queueWaits.ts queueWaitsAll over the machines' stats):
   * a bench ticket not granted yet, a Unity slot, a sandbox editor's queued start. Undefined when unknown.
   */
  queueWaits?: readonly QueueWait[];
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
 * those linked to it since (decide_work link: small reports sharing one worker). What the worker is turning to, not all it
 * has in hand: for what it holds, with the older requests it goes on with (w915), see holdsOf. Spend, the wrap-up, and
 * who a request waits on (stillOn) read this one.
 */
export function servedBy(sessionId: string, items: readonly WorkItem[]): Set<string> {
  const mine = items.filter((w) => live(w) && w.sessionIds.includes(sessionId)).map((w) => ({ w, l: linkOf(w, sessionId) }));
  const lastSent = Math.max(-1, ...mine.filter((x) => x.l.how === 'sent').map((x) => x.l.at));
  return new Set(mine.filter((x) => (x.l.how === 'sent' ? x.l.at === lastSent : x.l.at >= lastSent)).map((x) => x.w.id));
}

/** What a worker has of the open requests it was sent (w915): see holdsOf. */
export interface Holds {
  /** The requests its current turn serves: servedBy. */
  served: Set<string>;
  /** Every request it holds: those it serves, and those it was sent earlier and has not let go of. */
  held: Set<string>;
  /** Requests it set aside (`<id>: paused: …`), with the request it is on first ('' when unknown). */
  paused: Map<string, string>;
}

/**
 * The open requests worker `sessionId` holds (w915; w909 showed Stalled "its worker moved on to w911" while that worker was
 * mid-turn on w909's own PR, because only the request it was last sent counted). A worker holds a request when it was sent
 * it, the request is open, and the worker has not reported it DONE. Sending it a second request does not take the first
 * away: it shows Working while the worker is busy (a worker that goes on with both is the common case). Held stops when
 * the worker says DONE, writes `<id>: paused: …` (Paused, below), or was asked to wrap it up and said nothing about it
 * (`released`, WorkItem.setAside); being sent the request again, or the one it paused for closing, holds it again.
 * The request it serves now (servedBy) is held whatever else is recorded: a refused DONE leaves its worker on it.
 */
export function holdsOf(sessionId: string, items: readonly WorkItem[]): Holds {
  const served = servedBy(sessionId, items);
  const held = new Set(served);
  const paused = new Map<string, string>();
  const byId = new Map(items.map((w) => [w.id, w]));
  for (const w of items) {
    if (served.has(w.id) || !live(w) || !w.sessionIds.includes(sessionId) || w.done?.[sessionId]) continue;
    const a = w.setAside?.[sessionId];
    if (a && (Date.parse(a.at) || 0) > linkOf(w, sessionId).at) {
      if (a.kind === 'released') continue;
      const first = a.for ? byId.get(a.for) : undefined;
      if (!a.for || (first && live(first) && !first.done?.[sessionId])) {
        paused.set(w.id, a.for ?? '');
        continue;
      }
    }
    held.add(w.id);
  }
  return { served, held, paused };
}

const NEEDS_PERSON =
  /\b(needs?|waiting (for|on)|blocked on) (your|a person'?s|a human'?s|the (user|owner|requester)'?s|human|their|his|her|ben'?s|lothsahn'?s) (decision|input|approval|answer|confirmation|go-?ahead|ok|call)\b|\b(please|can you|could you|should I) (decide|confirm|approve|choose|pick|tell me)\b|\bdecision needed\b|\bwhich (option|one) (do you|should)\b|\?\s*$/i;

/** Whether a worker's last report ends asking a person to decide (its tail, as the cleanup reads reports). */
export const asksAPerson = (report: string | undefined) => !!report && NEEDS_PERSON.test(report.trim().slice(-600));

/**
 * The line of a report's end that asks the person (w1868: "17e0097f stopped asking for a decision" never said which): the
 * last line or sentence of its tail that asks, whole, without Markdown; undefined when none does on its own.
 */
export function askingLine(report: string | undefined): string | undefined {
  if (!report) return undefined;
  const tail = report.trim().slice(-1200);
  const lines = tail
    .split(/\n+/)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((l) => l.replace(/^[\s>*_#-]+|[*_`]+/g, '').trim())
    .filter((l) => l.length > 3);
  return lines.findLast((l) => NEEDS_PERSON.test(l));
}

/** Capitalised words after "waiting for" that are not a person. */
const NOT_A_PERSON = new Set(['ci', 'steam', 'steamworks', 'unity', 'github', 'ffbox', 'claude', 'windows', 'mac', 'linux', 'discord', 'apple', 'xcode', 'metal', 'rosetta', 'tailscale', 'portal', 'beast', 'max', 'nightly', 'build', 'release', 'deploy', 'master', 'develop', 'main', 'the', 'this', 'that']);
const WAITS = '(?:waiting (?:for|on)|waits (?:for|on)|blocked on|needs|requires)';
const WHAT_THEY_GIVE = "(?:decision|input|approval|answer|call|go-?ahead|ok|confirmation|reply|choice|pick|verdict|sign-?off|login|password|code|key)";
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

/** w1841 (b): a wait on the bug's reporter or a player: "waiting on the reporter X to answer", "FFBox passes the answer on". */
const OUTSIDE_WAIT =
  /\b(?:waiting|waits|wait) (?:for|on) (?:the |a |our |that )?(?:bug )?(?:reporter|player|players|tester)\b|\b(?:waiting|waits) (?:for|on) [^;]{0,80}?\b(?:answer|reply|respond)[^;]{0,20}\b(?:in|on) (?:the |their )?(?:discord|bug) thread\b|\bffbox (?:passes|relays|forwards|brings) (?:the|their|its) (?:answer|reply)\b/i;
const OUTSIDE_NAMED = /\b(reporter|player|tester)\s+(?!(?:to|in|on|and|or|answers?|replies|says)\b)([\w.-]{2,32})/i;
const OUTSIDE_ROLE = /\b(reporter|players?|tester)\b/i;
/** Who outside the team a line waits on: "the reporter Reteoteigam", "the player", "the reporter". */
export function outsideWho(text: string): string {
  const n = OUTSIDE_NAMED.exec(text);
  if (n) return `the ${n[1].toLowerCase()} ${n[2]}`;
  return `the ${OUTSIDE_ROLE.exec(text)?.[1].toLowerCase() ?? 'reporter'}`;
}
const WAITED_ON = /\b(?:waiting|waits|wait) (?:for|on) (?:the )?([A-Z][\w.-]{1,31})\b/;
/**
 * A still-open line that waits on the reporter or a player (w1841): who, or undefined. A line that names one of `team` (the
 * request's people) as the one it waits on ("waiting on Ben to answer in the Discord thread") is a person's wait.
 */
export function outsideWaitOf(line: string, team: readonly string[] = []): string | undefined {
  if (!OUTSIDE_WAIT.test(line)) return undefined;
  const named = WAITED_ON.exec(line)?.[1];
  if (named && team.some((p) => personKey(p) === personKey(named))) return undefined;
  if (OUTSIDE_ROLE.test(line)) return outsideWho(line);
  return named && !NOT_A_PERSON.has(named.toLowerCase()) ? named : 'the reporter';
}
/** A waiting_on_person declaration whose `who` is the reporter or a player, not one of the team (w1841). */
export const outsideDeclared = (d: Pick<NonNullable<SessionInfo['waitingOn']>, 'who' | 'what'>, team: readonly string[] = []) =>
  (OUTSIDE_ROLE.test(d.who) && !team.some((p) => personKey(p) === personKey(d.who))) || OUTSIDE_WAIT.test(d.what) || (/\b(?:discord|ffbox)\b/i.test(d.what) && !team.some((p) => personKey(p) === personKey(d.who)));

/** w1841 (e): "needs the w1761 stills", "waiting for w1761's worker": the other request a line waits on (its words up to a ; or .). */
const WAITS_ON_WORK = /\b(?:needs?|waiting (?:for|on)|waits (?:for|on)|blocked on|until)\b([^;.]{0,140})/gi;
export function requestWaitOf(line: string, selfId: string): string | undefined {
  const body = line.replace(/^\s*w\d+\s*[:—–-]\s*(?:still open|not done)\s*:?/i, '');
  for (const m of body.matchAll(WAITS_ON_WORK)) {
    const id = /\b(w\d+)\b/i.exec(m[1])?.[1]?.toLowerCase();
    if (id && id !== selfId.toLowerCase()) return id;
  }
  return undefined;
}

/** w1841 (a): "waiting on BEAST's bench lock", "waits on the beast timed-run lock": the machine named, or '' for its own. */
const BENCH_WAIT = /\b(?:waiting|waits|wait) (?:for|on) (?:the |a )?(?:(\w+)(?:'s)? )?(?:bench(?:[- ]lock| queue)|timed[- ]runs?(?:[- ]lock)?)\b/i;
export function benchWaitOf(line: string): string | undefined {
  const m = BENCH_WAIT.exec(line);
  return m ? (m[1] ?? '').toLowerCase() : undefined;
}

/** w1841 (d): "waiting on the orchestrator to run the two-machine check": a wait on the orchestrator or the dispatcher. */
const ORCHESTRATOR_WAIT = /\b(?:waiting|waits|wait) (?:for|on) (?:the |my |its |ben'?s |lothsahn'?s )?(?:orchestrator|dispatcher)\b/i;
export const orchestratorWaitIn = (line: string) => ORCHESTRATOR_WAIT.test(line);
/**
 * Work a worker does itself (w1841, w1685: "waiting on the orchestrator to run the two-machine check"): a pair or two-machine
 * check, a build, its CI, a test or audit run. Not a second machine's worker, which only the dispatcher starts.
 */
const OWN_WORK = /\bto (?:run|do|start|kick off|trigger|launch|finish|make) (?:the |a |my |its |our )?[^;.]{0,60}?\b(?:check|build|ci|tests?|audit|run|clips?|playtest|capture)\b/i;
export const ownWorkWait = (line: string) => ORCHESTRATOR_WAIT.test(line) && OWN_WORK.test(line) && !/\b(?:worker|sandbox|place|move)\b/i.test(line);

/**
 * The newest "still open" line worker `s` wrote about request `w` (w1841): its last report's, or else its last report on it
 * in the request's log ("hh:mm worker <id>: w12: still open: …", or a wrap-up), while nothing about that worker came after
 * it there (a message sent to it, an answer passed on, a DONE, a block). A worker that went on to other work keeps what it
 * last said about this one.
 */
export function lastOpenLine(w: Pick<WorkItem, 'id' | 'log'>, s: Pick<SessionInfo, 'id' | 'lastResult'>, now: number): OpenLine | undefined {
  const own = s.lastResult ? stillOpenLine(s.lastResult.trim().slice(-2000), w.id) : undefined;
  if (own) return { line: own, logged: false };
  for (let i = w.log.length - 1; i >= 0; i--) {
    const l = w.log[i];
    if (!l.includes(s.id)) continue;
    const m = /^(\d\d):(\d\d) (?:wrap-up from )?worker (\S+): (.*)$/.exec(l);
    if (!m || m[3] !== s.id) return undefined;
    const line = stillOpenLine(m[4], w.id);
    if (!line) return undefined;
    // The log says only hh:mm (UTC): the last such time not after now.
    const d = new Date(now);
    d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
    const at = d.getTime() > now ? d.getTime() - 86_400_000 : d.getTime();
    return { line, logged: true, at };
  }
  return undefined;
}

/** A worker's newest "still open" line on a request (lastOpenLine): from its last report, or from the request's log, with when. */
export interface OpenLine {
  line: string;
  logged: boolean;
  /** When a logged line was written (from its hh:mm); a report's own time is its session's (reportAt). */
  at?: number;
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

/** When a worker wrote its last report (w1504): lastResultAt, else (a session older than that field) its last activity. */
export const reportAt = (s: Pick<SessionInfo, 'lastResultAt' | 'lastActivityAt'>) => Date.parse(s.lastResultAt ?? s.lastActivityAt) || 0;

/** The pull request numbers a line names: "PR #1699", "FinalFactory#1699", ".../pull/1699". */
const prsNamedIn = (line: string) => new Set([...line.matchAll(/(?:#|\/pull\/)(\d+)\b/g)].map((m) => Number(m[1])));
/** "Ben", "Ben (or his orchestrator)", "Ben Ryding": the first word, lower case, as a report names a person. */
const personKey = (name: string) => name.trim().toLowerCase().split(/[\s(,]/)[0];
const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** The key of a worker's "still open" line as a wait on a person (server/needsYou.ts keys; one message per key). */
export const reportWaitKey = (sessionId: string, line: string) => `report:${sessionId}:${line.replace(/\s+/g, ' ').trim().slice(0, 300)}`;

/**
 * What makes waits on several requests ONE question (w1812): the same declaration of the same worker (its key names the
 * worker and when it declared), or the same "still open" line of the same worker's report with the request ids left out
 * ("w1767: still open: waiting on Ben to pick" and "w1768: still open: waiting on Ben to pick"). A dispatcher's question is
 * its request's own: undefined, never shared. Questions that differ keep their own keys and their own messages.
 */
export function questionShareKey(key: string): string | undefined {
  if (key.startsWith('declared:')) return key;
  if (key.startsWith('report:')) return key.replace(/\bw\d+\b:?/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return undefined;
}

/**
 * Whether a wait on a person, said at `at`, was answered on another request that carries the same question (w1812): one of
 * `who` added a note to it after `at`, or answered its [needs you] of the same question (`share`, questionShareKey) after
 * `at`. `others` are the requests held by the same worker that carry it. Why, or undefined.
 */
export function sharedWaitSettled(others: readonly Pick<WorkItem, 'id' | 'notes' | 'needsYou'>[], at: number, who: readonly string[], share: string | undefined): string | undefined {
  if (!share) return undefined;
  const a = answerAfter(others, at, who, share);
  return a && `${a.by} answered it on ${a.on}${a.note ? ' with a note' : ''} at ${minute(a.at)}`;
}

/**
 * The newest answer one of `who` gave after `at` on any of `items` (w1812): a note they added, or their answer to its
 * [needs you] (of the question `share` names, when given). Where, by whom, when, and the note's words.
 */
export function answerAfter(items: readonly Pick<WorkItem, 'id' | 'notes' | 'needsYou'>[], at: number, who: readonly string[], share?: string): { on: string; by: string; at: string; note?: string } | undefined {
  const people = new Set(who.map(personKey));
  const after = (iso: string | undefined) => (Date.parse(iso ?? '') || 0) > at;
  let best: { on: string; by: string; at: string; note?: string } | undefined;
  const take = (c: NonNullable<typeof best>) => {
    if (!best || Date.parse(c.at) > Date.parse(best.at)) best = c;
  };
  for (const x of items) {
    const note = [...(x.notes ?? [])].reverse().find((n) => after(n.at) && people.has(personKey(n.by)));
    if (note) take({ on: x.id, by: note.by, at: note.at, note: note.text });
    const a = x.needsYou?.answered;
    if (a && (!share || questionShareKey(x.needsYou!.key) === share) && after(a.at) && people.has(personKey(a.by))) {
      // Its words: the note it was answered with, on the request it was answered on (kept a moment before the answer).
      const on = items.find((i) => i.id === (a.on ?? x.id));
      const words = [...(on?.notes ?? [])].reverse().find((n) => after(n.at) && Date.parse(n.at) <= Date.parse(a.at) && people.has(personKey(n.by)));
      take({ on: a.on ?? x.id, by: a.by, at: a.at, ...(words ? { note: words.text } : {}) });
    }
  }
  return best;
}

/** The worker whose wait is weighed (w1841): its id, and whether another worker of the request took up what came at a time. */
export interface WaitingWorker {
  id: string;
  elsewhere: (at: number) => boolean;
}

/**
 * Whether a wait on a person, said at `at`, is settled since (w1504): one of `who` (display names, as WorkLive.waitsOn
 * says them) added a note to the request or answered its [needs you] after it, or a pull request of the request that
 * `line` names merged after it. Why, or undefined while the wait stands. A pull request not linked to the request is not
 * read: its state is not known here.
 */
export function personWaitSettled(w: Pick<WorkItem, 'notes' | 'needsYou' | 'prs'>, at: number, who: readonly string[], line: string, by?: WaitingWorker): string | undefined {
  const people = new Set(who.map(personKey));
  const after = (iso: string | undefined) => (Date.parse(iso ?? '') || 0) > at;
  // w1841: on a request with several workers, a note another worker took up (it reported after the note, the waiting one did
  // not) answered that worker, not this one (w1782: Ben's notes on item 2 went to 8ef702f6; ac694f80 still waited on his pick).
  // w1868: a note that answered some of several questions leaves the rest waiting (needsYou.answeredAsks): only the record's answer settles it.
  const partial = !!w.needsYou && !w.needsYou.answered && !!w.needsYou.answeredAsks?.length;
  const note = partial ? undefined : [...(w.notes ?? [])].reverse().find((n) => after(n.at) && people.has(personKey(n.by)) && !by?.elsewhere(Date.parse(n.at) || 0));
  if (note) return `${note.by} answered it with a note at ${minute(note.at)}`;
  const a = w.needsYou?.answered;
  const theirs = !by || !w.needsYou?.worker || w.needsYou.worker === by.id;
  if (a && theirs && after(a.at) && people.has(personKey(a.by))) return `${a.by} answered it at ${minute(a.at)}`;
  const named = prsNamedIn(line);
  const pr = (w.prs ?? []).find((p) => p.state === 'merged' && named.has(p.number) && after(p.at));
  if (pr) return `PR #${pr.number}, which it names, merged at ${minute(pr.at!)}`;
  return undefined;
}

/** Blocked on a thing (w643): the gates it records, each named, with what the first waits for and who set it. */
function blockedLive(gates: readonly NonNullable<WorkItem['blocked']>[], now: number): WorkLive {
  const first = gates[0];
  const more = gates.length > 1 ? `; also ${gates.slice(1).map((g) => g.what).join('; ')}` : '';
  // w1094: what the blocker watch last read of a CI gate's checks, so a gate that is still open says why.
  const read = gates.find((g) => g.kind === 'ci' && g.read)?.read;
  const ci = read ? `; last read: ${read.text} (${ago(read.at, now)})` : '';
  return { state: 'blocked', why: `${first.what}${more} (since ${ago(first.at, now)}, set by ${first.by})${ci}`, waitsOn: gates.map((g) => gatesName([g], now)) };
}

/** Waiting on someone outside the team (w1841 (b)): the reporter or a player, through FFBox and Discord. */
const outsideLive = (worker: string, who: string, line: string): WorkLive => ({
  state: 'waiting',
  why: `${worker} waits on ${who} to answer through FFBox and Discord: "${line.slice(0, 160)}"`,
  waitsOn: [who],
  worker,
  outside: true,
  line,
});

/**
 * Blocked on a bench lock (w1841 (a)): the first of `workers` whose line (`lineOf`) waits on a bench lock that a timed run
 * holds now, on the machine it names or its own. A lock that is free is no wait: it is resumed (Agents.resumeBenchWaits).
 */
function benchedOf(workers: readonly SessionInfo[], lineOf: (s: SessionInfo) => string | undefined, f: Pick<WorkLiveFacts, 'benchLock' | 'now'>): WorkLive | undefined {
  if (!f.benchLock) return undefined;
  for (const s of workers) {
    const line = lineOf(s);
    const named = line !== undefined ? benchWaitOf(line) : undefined;
    if (named === undefined) continue;
    const machine = named || s.machineId?.split('/')[0].trim().toLowerCase();
    const lock = machine ? f.benchLock(machine) : undefined;
    if (!machine || !lock) continue;
    return { state: 'blocked', why: `${s.id} waits on ${machine}'s bench lock (held since ${ago(lock.since, f.now)}: ${lock.owner.slice(0, 120)}); its check-in, or FF Factory when the lock is free, brings it back`, waitsOn: [`${machine}'s bench lock`] };
  }
  return undefined;
}

/**
 * w1949: what worker `s` waits for in its machine's queues now: a bench ticket or a Unity slot of its own session, or, with
 * `editor`, its sandbox editor's start queued in the bench queue (the daemon's ticket, which names the sandbox only).
 */
function queueWaitOf(s: SessionInfo, f: Pick<WorkLiveFacts, 'queueWaits'>, editor: boolean): QueueWait | undefined {
  const waits = f.queueWaits;
  if (!waits?.length) return undefined;
  const own = waits.find((q) => q.session === s.id);
  if (own || !editor) return own;
  const [m, slot] = (s.machineId ?? '').split('/').map((x) => x.trim().toLowerCase());
  const sandbox = (s.machineSandbox ?? slot)?.trim().toLowerCase();
  return m && sandbox ? waits.find((q) => q.kind === 'editor' && q.machine.toLowerCase() === m && q.sandbox?.toLowerCase() === sandbox) : undefined;
}

/** Blocked on a queue (w1949): "Blocked on the exclusive bench lock on lothdesktop (held by w1908 / t00000911, 2 ahead in queue)". */
function queueLive(s: SessionInfo, q: QueueWait): WorkLive {
  const back = 'it shows Working again by itself once';
  const why =
    q.kind === 'slot'
      ? `${s.id} waits on ${q.machine} for ${q.what}; ${back} the slot is granted`
      : q.kind === 'editor'
        ? `its sandbox ${q.sandbox}'s editor start waits in ${q.machine}'s bench queue for ${q.what}; the editor starts by itself at its turn, and ${s.id}'s check-in brings it back`
        : `${s.id} waits in ${q.machine}'s bench queue for ${q.what}; ${back} the ticket is granted`;
  return { state: 'blocked', why, waitsOn: [q.on] };
}

/** The live state of one request, or undefined once it is closed. */
/**
 * Queued for capacity (w643), by the same room test as Capacity's ROOM/BUSY and decide_work queue (w1089), on what the
 * request needs (w1098): with a computer that could take it free, that is wrong, and says so (`roomOn`). `head` is what is
 * queued: the request, or a leg of it held for named computers while its own worker works elsewhere (w1863).
 */
function queuedLive(w: WorkItem, f: WorkLiveFacts, wanted: readonly string[] | undefined, head: string, start = 'start it, or block it on what it waits for'): WorkLive {
  const needs = wanted?.map((n) => n.toLowerCase());
  const kind = needsOf(w);
  const known = kind === 'game' ? f.room : f.agentRoom;
  // A computer reserved for higher work (w1643) is room only for a request whose priority now reaches its level.
  const reserved = (f.reservedRoom ?? []).filter((r) => r.for.includes(kind) && (!needs?.length || needs.includes(r.id.toLowerCase())));
  const room = [...(known ?? []), ...reserved.filter((r) => admitsPriority(r.min, w.priority)).map((r) => r.id)].filter((id) => !needs?.length || needs.includes(id.toLowerCase()));
  const what = `for capacity${needs?.length ? ` on ${needs.join(' or ')}` : ''}`;
  const slot = kind === 'agent' ? 'an agent slot' : 'room';
  // w1944: a computer it cannot run on (a Mac for an MP scenario, the m5 for timed work) is no room for it, and says why.
  const unfit = room.map((id) => ({ id, why: unfitWhy(w, id, f.roomFit) })).filter((x): x is { id: string; why: string } => !!x.why);
  const fits = room.filter((id) => !unfit.some((u) => u.id === id));
  // w1944: and room that freed moments ago is the capacity ping's to bring, not yet a wrong Queued.
  const age = (id: string) => (f.roomSince ? f.now - (f.roomSince[`${kind}:${id}`] ?? f.now) : Infinity);
  const stood = fits.filter((id) => age(id) >= ROOM_STAND_MS);
  const have = (ids: readonly string[]) => `${ids.join(', ')} ${ids.length > 1 ? 'have' : 'has'} ${slot}`;
  if (stood.length) return { state: 'queued', why: `${head} ${what}, but ${have(stood)}: the dispatcher should ${start}`, roomOn: stood };
  if (fits.length) {
    const mins = Math.max(...fits.map((id) => Math.floor(age(id) / 60_000)));
    return { state: 'queued', why: `${head} ${what}; ${have(fits)} since ${mins} min ago: the capacity ping brings it to the dispatcher` };
  }
  const held = (f.heldRoom ?? []).filter((h) => h.for.includes(kind) && (!needs?.length || needs.includes(h.id.toLowerCase())));
  const reservedWhy = reservedText(reserved, kind, w.priority, slot);
  const heldWhy = `${held.length ? `; ${held.map((h) => `${h.id} has ${slot} but is held (${h.why})`).join('; ')}` : ''}${reservedWhy ? `; ${reservedWhy}` : ''}${unfit.length ? `; ${unfit.map((u) => `${u.id} has ${slot} but cannot take it: ${u.why}`).join('; ')}` : ''}`;
  return { state: 'queued', why: `${head} ${what}${known ? ': no computer that could take it has ' + slot : ''}${heldWhy}` };
}

/**
 * A request's legs held for named computers (w1863, WorkItem.legs), as Queued, or undefined without one. Its own status is
 * another matter (active: its worker works elsewhere), so this is read before the states a worker's turn would give it.
 */
function legLive(w: WorkItem, f: WorkLiveFacts): WorkLive | undefined {
  if (!w.legs?.length || w.status === 'queued') return undefined;
  const since = w.legs.map((l) => minute(l.at).slice(11)).join(', ');
  const head = `its leg${w.legs.length > 1 ? 's' : ''} (since ${since} UTC; its own worker elsewhere) queued`;
  return queuedLive(w, f, w.legs.flatMap((l) => l.needs), head, 'start a worker for it there');
}

export function workLive(w: WorkItem, f: WorkLiveFacts, holdsFor?: (sessionId: string) => Holds): WorkLive | undefined {
  if (!live(w)) return undefined;
  const holds = holdsFor ?? ((sid: string) => holdsOf(sid, f.items));
  const workers = w.sessionIds.map((id) => f.session(id)).filter((s): s is SessionInfo => !!s);
  // Mine: the workers that hold it, serving it now or not (w915). Only the report- and message-based signals below read
  // `serving`: what a worker said last, and what waits to be sent it, is about the request it is on now.
  const mine = workers.filter((s) => holds(s.id).held.has(w.id));
  const serving = mine.filter((s) => holds(s.id).served.has(w.id));
  const others = workers.filter((s) => !mine.includes(s));
  const movedTo = (s: SessionInfo) => [...holds(s.id).served][0];
  const sharedWith = (list: readonly SessionInfo[]) => {
    const ids = [...new Set(list.flatMap((s) => [...holds(s.id).held]))].filter((id) => id !== w.id).sort();
    return ids.length ? `, shared with ${ids.join(', ')}` : '';
  };

  // Working: one of its workers is mid-turn on it, or FFBox runs it. Not one whose agent host never started (w691): an
  // older daemon went on reporting it mid-turn, and nothing runs.
  const busy = mine.filter((s) => BUSY.has(s.status) && !s.hostFailure);
  if (busy.length) {
    // w1949: mid-turn in a queue (`bench_queue.py run`, `unity-slot run`, its editor gate) is Blocked on it, by the queue's
    // own state its daemon reports; Working again once it is granted. Working while any busy worker of it waits on nothing.
    const queued = busy.map((s) => ({ s, q: queueWaitOf(s, f, false) }));
    if (queued.every((x) => x.q)) return queueLive(queued[0].s, queued[0].q!);
    const tool = busy.find((s) => s.activeTool)?.activeTool;
    return withMachines({ state: 'working', why: `${busy.map((s) => s.id).join(', ')} ${busy[0].status === 'starting' ? 'starting' : 'mid-turn'}${tool ? `, in ${tool.name} since ${ago(tool.since, f.now)}` : ''}${sharedWith(busy)}` }, busy);
  }
  if (w.ffbox && (w.ffbox.state === 'sent' || w.ffbox.state === 'accepted')) return { state: 'working', why: `on FFBox${w.ffbox.conversation ? ` (conversation ${w.ffbox.conversation})` : ''}` };

  // w1863: a leg held for a named computer that has room now is wrong whatever else the request is doing: said first.
  const leg = legLive(w, f);
  if (leg?.roomOn) return leg;

  // Waiting on input: a person must approve, answer, decide or allow something.
  if (w.approval?.state === 'pending') return { state: 'waiting', why: 'an intake request waiting for a reviewer to approve or decline it', waitsOn: ['a reviewer'] };
  if (w.question) return { state: 'waiting', why: `the dispatcher's question: ${w.question.text}`, waitsOn: names([w.requestedBy]) };
  if (w.flag) return { state: 'waiting', why: `${w.flag.kind === 'error' ? 'an error the ledger cleanup escalated' : 'a design question'}: ${w.flag.text}`, waitsOn: names(w.flag.for) };
  const asking = mine.find((s) => s.status === 'waiting_permission');
  if (asking) {
    const p = asking.pendingPermissions[0];
    return { state: 'waiting', why: `${asking.id} waits for permission${p ? ` to use ${p.toolName}` : ''}`, waitsOn: names(asking.requestedBy ? [asking.requestedBy] : w.requesters), worker: asking.id };
  }

  // Blocked on its machine (w691): a worker's message found no agent host to run in. Nothing runs for it, whatever its
  // status says; it unblocks when a host starts (its first event), and the dispatcher is told it failed.
  const dead = mine.find((s) => s.hostFailure);
  if (dead) return { state: 'blocked', why: `${dead.id}: ${hostFailureText(dead)} (${dead.hostFailure!.error.slice(0, 120)}; ${ago(dead.hostFailure!.at, f.now)})`, waitsOn: [dead.machineId ?? 'its machine'] };

  // A person-wait stands until that person answers the request or a pull request it names merges (w1504), and, on a
  // request Blocked on a thing, only while it is newer than the newest gate: a gate set after it is what it waits on now.
  const gates = gatesOf(w);
  const gatedAt = w.status === 'blocked' && gates.length ? Math.max(...gates.map((g) => Date.parse(g.at) || 0)) : undefined;
  // w1812: and until that person answers the same question on another request the same worker holds (`others`).
  const stands = (at: number, who: readonly string[], line: string, others: readonly WorkItem[] = [], share?: string, by?: WaitingWorker) =>
    (gatedAt === undefined || at > gatedAt) && !personWaitSettled(w, at, who, line, by) && !sharedWaitSettled(others, at, who, share);
  // w1841: another worker of the request reported after a time and this one did not: what came then went to that one.
  const waiting = (s: SessionInfo): WaitingWorker => ({ id: s.id, elsewhere: (t) => reportAt(s) <= t && workers.some((o) => o.id !== s.id && reportAt(o) > t) });
  const team = [...new Set([w.requestedBy, ...w.requesters].map((r) => r.displayName))];
  const heldWith = (s: SessionInfo) => f.items.filter((x) => x.id !== w.id && live(x) && x.sessionIds.includes(s.id) && !x.done?.[s.id]);

  // Waiting on a person, declared (w691): the worker says only a person can move it on, and who. A check-in it set as
  // well does not make it Working: no wake-up moves a person.
  const whoOf = (d: NonNullable<SessionInfo['waitingOn']>) => {
    const who = d.who.split(/\s*(?:,|&|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
    return who.length ? who : names(w.requesters);
  };
  // A declaration that names no request is on every request its worker holds: one question (w1812).
  const declared = mine.find(
    (s) =>
      s.waitingOn &&
      (!s.waitingOn.request || s.waitingOn.request.toLowerCase() === w.id.toLowerCase()) &&
      stands(Date.parse(s.waitingOn.at) || 0, whoOf(s.waitingOn), s.waitingOn.what, s.waitingOn.request ? [] : heldWith(s), `declared:${s.id}:${s.waitingOn.at}`, waiting(s)),
  );
  if (declared) {
    const d = declared.waitingOn!;
    // w1841 (b): the reporter or a player, outside the team: FFBox passes their answer on; nobody's orchestrator is asked.
    const outside = outsideDeclared(d, team);
    return { state: 'waiting', why: `${declared.id} waits on ${d.who}${outside ? ' (through FFBox and Discord)' : ''}: ${d.what} (since ${ago(d.at, f.now)})`, waitsOn: whoOf(d), worker: declared.id, ...(outside ? { outside: true } : {}) };
  }

  // Working, between turns (w475, w643): a worker on it has its own work still going (a background job such as CI or a
  // build, or a check-in it set) and comes back to it by itself, also when stopped until that check-in (w509, w640).
  // Not Waiting: nobody else needs to act.
  const coming = mine.map((s) => ({ s, a: agentState(s, undefined, f.now) })).find((x) => (x.a.state === 'between_turns' && x.a.kind !== 'queued') || x.a.resumes?.startsWith('check-in'));
  // Its last report says a person must act (w691, the backstop): the check-in it set does not make it Working. A job
  // still running (CI, a build) does: work goes on meanwhile.
  const people = team;
  const said = mine
    .map((s) => ({ s, p: personWaitIn(s.lastResult, w.id, people) }))
    .find((x) => {
      // w1841: a line that waits on the reporter or a player is theirs (outsider, below), not a person's of the team.
      if (!x.p || outsideWaitOf(x.p.line, people)) return false;
      // w1812: the same line on another request this worker holds is the same question.
      const share = questionShareKey(reportWaitKey(x.s.id, x.p.line));
      const others = heldWith(x.s).filter((o) => {
        const l = personWaitIn(x.s.lastResult, o.id, people)?.line;
        return !!l && questionShareKey(reportWaitKey(x.s.id, l)) === share;
      });
      return stands(reportAt(x.s), x.p.who ? [x.p.who] : names(w.requesters), x.p.line, others, share, waiting(x.s));
    });
  if (said && !(coming && coming.a.kind === 'job')) return { state: 'waiting', why: `${said.s.id}'s report says a person must act: "${said.p!.line.slice(0, 160)}"`, waitsOn: said.p!.who ? [said.p!.who] : names(w.requesters), worker: said.s.id };

  // w1841 (b): its report waits on the bug's reporter or a player (w1778: "waiting on the reporter Reteoteigam to answer in
  // the Discord thread ... FFBox passes the answer on"). Waiting, on them, check-in or not; never sent as [needs you].
  const outsider = mine
    .map((s) => {
      const line = s.lastResult ? stillOpenLine(s.lastResult.trim().slice(-2000), w.id) : undefined;
      const who = line ? outsideWaitOf(line, team) : undefined;
      return who && line && stands(reportAt(s), [], line) ? { s, who, line } : undefined;
    })
    .find((x) => !!x);
  if (outsider && !(coming && coming.a.kind === 'job')) return outsideLive(outsider.s.id, outsider.who, outsider.line);

  // w1841 (a): a worker an urgent release's build paused (w1475 and w1768 for w1836 on BEAST) is Blocked on that build. One
  // asked to pause mid-turn is told to carry on when it is done (server/buildPlans.ts done); one paused between turns comes
  // back by its own check-in or held message, which the build holds until then. One with nothing to bring it back is left
  // to the lines below.
  const paused = mine
    .map((s) => ({ s, h: f.buildHold?.(s.id) }))
    .find((x) => x.h && (x.h.told || x.s.id === coming?.s.id || !!(f.queuedSend?.(x.s.id) ?? x.s.queuedSend)));
  if (paused) {
    const h = paused.h!;
    return { state: 'blocked', why: `${paused.s.id} paused for ${h.what} on ${h.machine}; ${h.told ? 'FF Factory tells it to carry on when the build is done' : 'what brings it back waits for the build'}`, waitsOn: [`the build on ${h.machine} (${h.what})`] };
  }

  // w1949: between turns while its own ticket or Unity slot waits in its machine's queue (a run it left going), or, for work
  // that needs an editor, while its sandbox editor's start waits there and a check-in brings it back: Blocked on that queue.
  const comesBack = (s: SessionInfo) => {
    const a = agentState(s, undefined, f.now);
    return (a.state === 'between_turns' && a.kind !== 'queued') || !!a.resumes?.startsWith('check-in');
  };
  const inQueue = mine.map((s) => ({ s, q: queueWaitOf(s, f, needsOf(w) === 'game' && comesBack(s)) })).find((x) => x.q);
  if (inQueue) return queueLive(inQueue.s, inQueue.q!);

  // w1841 (a): its report waits on a machine's bench lock, which a timed run holds now: Blocked on that lock. Its check-in
  // brings it back, or FF Factory tells it when the lock is free (Agents.resumeBenchWaits).
  const benched = benchedOf(mine, (s) => (s.lastResult ? stillOpenLine(s.lastResult.trim().slice(-2000), w.id) : undefined), f);
  if (benched && !(coming && coming.a.kind === 'job')) return benched;

  // Blocked on its gates (w754): a request that waits on other requests or pull requests is Blocked, whatever check-ins its
  // worker left behind (w750 showed "Working" for an hour while its worker polled gh every 20 minutes). Nothing a worker
  // polls moves a gate. A job it runs meanwhile (CI, a build) is still work.
  if (w.status === 'blocked' && gates.length && !(coming && coming.a.kind === 'job')) return blockedLive(gates, f.now);

  // w1863: a leg waiting for its computer is Queued, also while the request's own worker is between turns elsewhere.
  if (leg) return leg;

  if (coming) return withMachines({ state: 'working', why: `${coming.a.state === 'stopped' ? `${coming.s.id} stopped until its ${coming.a.resumes}` : `${coming.s.id} between turns: ${coming.a.waitsOn}`}${sharedWith([coming.s])}` }, [coming.s]);

  const decide = serving.find((s) => asksAPerson(s.lastResult) && stands(reportAt(s), names(w.requesters), (s.lastResult ?? '').trim().slice(-600)));
  if (decide) {
    const line = askingLine(decide.lastResult);
    return { state: 'waiting', why: `${decide.id} stopped asking for a decision${line ? `: "${line}"` : ''}`, waitsOn: names(w.requesters), worker: decide.id };
  }

  // A message to one of its workers waits in the send queue: for a free slot (Queued) or for its machine (Blocked).
  const held = serving.map((s) => ({ s, why: f.queuedSend?.(s.id) ?? s.queuedSend, on: s.queuedOn })).find((x) => x.why);
  if (held?.on === 'machine') return { state: 'blocked', why: `a message to ${held.s.id} waits for its machine (${held.why})`, waitsOn: [held.s.machineId ?? 'its machine'] };
  // w1094: a worker resumed after its sandbox went to other work waits for a sandbox on its machine: Queued, named so.
  if (held) return { state: 'queued', why: `a message to ${held.s.id} waits for a ${/^(no sandbox on|being placed again|its branch )/.test(held.why ?? '') ? 'sandbox on its machine' : 'free agent slot'} (${held.why})` };

  // Blocked on a thing (w643): the blocker it records.
  if (w.status === 'blocked' && gates.length) return blockedLive(gates, f.now);

  // Not decided yet: the dispatcher has it (its [work request] went out when it was filed or reopened).
  if (w.status === 'new') return { state: 'working', why: `the dispatcher has it to decide, since ${ago(w.updatedAt, f.now)}` };

  // Queued: capacity only. With a computer that could take it free, that is wrong, and says so (w643).
  if (w.status === 'queued') return queuedLive(w, f, w.queuedFor?.needs, 'queued');

  // Paused (w915): its worker wrote `<id>: paused: …`, set it aside for the request it is on first. Not Stalled: someone
  // decided to wait, and said on what.
  const pausing = workers.find((s) => holds(s.id).paused.has(w.id) && s.status !== 'stopped' && s.status !== 'error');
  if (pausing) {
    const first = holds(pausing.id).paused.get(w.id);
    return { state: 'paused', why: `worker ${pausing.id} on ${first || 'other work'} first` };
  }

  // The cleanup stalled it: its own reason, which says more than anything derived here (w418: kept as it is).
  if (w.stalled) return { state: 'stalled', why: `${w.stalled.kind}: ${w.stalled.reason}` };

  // w1841: what each of its workers last said about it, also one that went on to other work since (its last report on it in
  // the log). (c) A wait on a person stands whichever worker said it (w1782: item 3 waited on Ben's pick through ac694f80
  // while 8ef702f6 was idle); (b) one on the reporter or a player; (e) one on another request's worker (w1818 needs w1761's
  // stills) is Blocked on that request; (a) one on a bench lock that a timed run holds.
  const lines = workers
    .filter((s) => !w.done?.[s.id])
    .map((s) => ({ s, l: lastOpenLine(w, s, f.now) }))
    .filter((x): x is { s: SessionInfo; l: OpenLine } => !!x.l);
  const atOf = (x: (typeof lines)[number]) => x.l.at ?? reportAt(x.s);
  // The reports of the workers that hold it were weighed above (`said`, `outsider`, with w1812's shared questions).
  const weighed = (x: (typeof lines)[number]) => !x.l.logged && mine.includes(x.s);
  for (const x of lines.filter((y) => !weighed(y))) {
    const p = personWaitIn(x.l.line, w.id, people);
    if (p && !outsideWaitOf(p.line, team) && stands(atOf(x), p.who ? [p.who] : names(w.requesters), p.line, [], undefined, waiting(x.s))) {
      return { state: 'waiting', why: `${x.s.id}'s ${x.l.logged ? 'last report on it' : 'report'} says a person must act: "${p.line.slice(0, 160)}"`, waitsOn: p.who ? [p.who] : names(w.requesters), worker: x.s.id };
    }
  }
  for (const x of lines.filter((y) => !weighed(y))) {
    const who = outsideWaitOf(x.l.line, team);
    if (who && stands(atOf(x), [], x.l.line)) return outsideLive(x.s.id, who, x.l.line);
  }
  for (const x of lines) {
    const id = requestWaitOf(x.l.line, w.id);
    const other = id ? f.items.find((o) => o.id.toLowerCase() === id && live(o)) : undefined;
    if (other && stands(atOf(x), [], x.l.line)) {
      return { state: 'blocked', why: `${x.s.id} waits on ${other.id}: "${x.l.line.slice(0, 160)}" (blocked_on with requests or reports resumes it by itself)`, waitsOn: [other.id] };
    }
  }
  const benchedLate = benchedOf(lines.map((x) => x.s), (s) => lines.find((x) => x.s === s)?.l.line, f);
  if (benchedLate) return benchedLate;

  // Merged, follow-up pending: its pull requests merged, none is open, and the request is still open.
  const prs = w.prs ?? [];
  if (prs.some((p) => p.state === 'merged') && !prs.some((p) => p.state === 'open')) {
    return { state: 'followup', why: followUpReason(w) ?? 'merged; the cleanup has not said yet what is left' };
  }

  // Stalled: nothing works on it and nothing waits on a person.
  const open = prs.find((p) => p.state === 'open');
  const pr = open ? `; PR #${open.number} is open` : '';
  if (open && !mine.length) return { state: 'stalled', why: `PR #${open.number} is open and no worker is on it${others.length ? ` (its worker ${others[0].id} moved on${movedTo(others[0]) ? ` to ${movedTo(others[0])}` : ''})` : ''}` };
  if (!workers.length && !w.sessionIds.length) return { state: 'stalled', why: 'no worker was ever started for it' };
  if (!mine.length && others.length) {
    const s = others[0];
    const now = movedTo(s);
    return { state: 'stalled', why: `its worker ${s.id} moved on${now ? ` to ${now}` : ''}` };
  }
  if (!workers.length) return { state: 'stalled', why: 'its workers are gone' };
  // w1841 (d): its worker says it waits on the orchestrator (w1685: "waiting on the orchestrator to run the two-machine
  // check"): Stalled, as nothing moves it, and the line says what to tell it.
  const orch = lines.find((x) => orchestratorWaitIn(x.l.line));
  if (orch) {
    const own = ownWorkWait(orch.l.line);
    return { state: 'stalled', why: `${orch.s.id} says it waits on the orchestrator: "${orch.l.line.slice(0, 160)}"${own ? '; that is its own work (pair and two-machine checks, builds, its CI): tell it to run it' : ''}` };
  }
  const last = [...mine].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  return { state: 'stalled', why: `${last.id} ${last.status === 'error' ? 'failed' : last.status === 'idle' ? 'finished its turn' : 'stopped'} ${ago(last.lastActivityAt, f.now)}${pr}, nothing waits on a person` };
}

/** Every open (or stalled) request's live state, by id. */
export function workLiveAll(items: readonly WorkItem[], f: Omit<WorkLiveFacts, 'items'>): Map<string, WorkLive> {
  const facts = { ...f, items };
  const cache = new Map<string, Holds>();
  const holds = (sid: string) => {
    let h = cache.get(sid);
    if (!h) cache.set(sid, (h = holdsOf(sid, items)));
    return h;
  };
  const out = new Map<string, WorkLive>();
  for (const w of items) {
    const l = workLive(w, facts, holds);
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

/**
 * The ledger at a glance (w1089, lothsahn: "the dispatcher queued show 8 on the right side pane, but the left side pane says
 * 34 active 6 queued"): the counts of every live state, in the order a person scans them, zeros left out, as
 * [count, label] pairs. The sidebar row and the Dispatcher page both call this on the one workLiveAll map, so their counts
 * cannot differ: before, the row counted each request's stored status, so a request whose worker's message waits for a free
 * agent slot (stored active) counted active there and Queued on the page.
 */
export const GLANCE_ORDER: readonly WorkLiveState[] = ['waiting', 'working', 'queued', 'blocked', 'stalled', 'followup', 'paused'];
const GLANCE_WORD: Record<WorkLiveState, string> = { waiting: 'waiting', working: 'working', queued: 'queued', blocked: 'blocked', stalled: 'stalled', followup: 'to follow up', paused: 'paused' };
export function ledgerGlance(states: Iterable<WorkLive>): [number, string][] {
  const n = liveCounts(states);
  return GLANCE_ORDER.filter((s) => n[s]).map((s) => [n[s], GLANCE_WORD[s]] as [number, string]);
}
