// What an agent is doing, in one word (w475, asked by Lothsahn: "clear between 'available' workers (idle) and
// 'waiting' workers"): Working (mid-turn), Needs you (a permission), Waiting (alive between turns, with something real
// pending: a background job it started, a message queued for it, or a wake_me check-in still ahead), Idle (finished,
// nothing pending: free for new work, and the idle reaper's candidate), Error, or Stopped. Pure: the page,
// list_sandboxes, list_machines, the capacity block and the ledger's request states (shared/workState.ts) all read it.
//
// w509 (Lothsahn: "aren't waiting jobs waiting on tests or other things to run?"): Waiting says on what, a running job
// first ("CI on PR #1098 · check-in 06:10"), and tells a job apart from a timer alone. A stopped agent is never Waiting
// (49c5dc06 and 6c4fe619 read "Waiting" while stopped, on check-ins they had set with "nothing to do" notes), and an
// overdue check-in (one that should have fired) does not count.
import type { SessionInfo } from './types.ts';

export type AgentState = 'working' | 'needs_you' | 'waiting' | 'idle' | 'error' | 'stopped';

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  waiting: 'Waiting',
  idle: 'Idle',
  error: 'Error',
  stopped: 'Stopped',
};

/** The order agents are listed in (Lothsahn: "running at the top, waiting below them, and idle below them"). */
export const AGENT_STATE_RANK: Record<AgentState, number> = { working: 0, needs_you: 0, waiting: 1, idle: 2, error: 3, stopped: 4 };

/** What a Waiting agent waits on: a job it started that is still running, a message queued for it, or only its check-in. */
export type WaitKind = 'job' | 'queued' | 'timer';

export interface AgentStateView {
  state: AgentState;
  label: string;
  /** Waiting: on what, e.g. "CI on PR #1098 · check-in 06:10 UTC", "a queued message (…)", "check-in 16:29 UTC: “merge #1083…”". */
  waitsOn?: string;
  /** Waiting: a running job, a queued message, or a timer alone. */
  kind?: WaitKind;
  /** Its check-in (ISO), when one is ahead. */
  until?: string;
  /** Stopped, but something will resume it: its check-in or a queued message ("check-in tomorrow 00:08 UTC"). */
  resumes?: string;
}

type AgentFacts = Pick<SessionInfo, 'status'> & Partial<Pick<SessionInfo, 'wakeAt' | 'wakeNote' | 'queuedSend' | 'backgroundTasks' | 'backgroundJobs'>>;

/** A check-in this much past its time has fired or is failing to: it is not pending any more. */
export const OVERDUE_MS = 2 * 60_000;

/** "16:29 UTC", "tomorrow 00:08 UTC" or "10-08 09:00 UTC": the day said when it is not today (w509: "16:29" read as yesterday). */
export function utcTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000);
  const hm = iso.slice(11, 16);
  return days === 0 ? `${hm} UTC` : days === 1 ? `tomorrow ${hm} UTC` : days === -1 ? `yesterday ${hm} UTC` : `${iso.slice(5, 10)} ${hm} UTC`;
}

/** A wake_me note's first words, as a reason. */
const firstWords = (note: string | undefined, words = 7) => {
  const w = (note ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return w.length ? `“${w.slice(0, words).join(' ')}${w.length > words ? '…' : ''}”` : '';
};

/** What its running jobs are, from the descriptions the agent gave them: "CI on PR #1098", "player build", or "2 background tasks". */
function jobsText(s: AgentFacts): string | undefined {
  const jobs = s.backgroundJobs ?? [];
  const n = Math.max(jobs.length, s.backgroundTasks ?? 0);
  if (!n) return undefined;
  const named = jobs.map((j) => j.description.trim()).filter(Boolean);
  if (!named.length) return n === 1 ? 'a background task' : `${n} background tasks`;
  const shown = named.slice(0, 2).join(', ');
  return n > 2 ? `${shown} (+${n - 2} more)` : shown;
}

/**
 * The agent's state. Waiting only while alive between turns (idle) with something real pending: a background job still
 * running (the SDK's live set; a restart ends them), a message queued for it, or a check-in still ahead. A stopped agent
 * is Stopped, with `resumes` when its check-in or a queued message will start it again.
 */
export function agentState(s: AgentFacts, time: (iso: string, now: number) => string = utcTime, now: number = Date.now()): AgentStateView {
  const v = (state: AgentState, more: Partial<AgentStateView> = {}): AgentStateView => ({ state, label: AGENT_STATE_LABEL[state], ...more });
  if (s.status === 'running' || s.status === 'starting') return v('working');
  if (s.status === 'waiting_permission') return v('needs_you');
  if (s.status === 'error') return v('error');
  const wakeAhead = !!s.wakeAt && Date.parse(s.wakeAt) > now - OVERDUE_MS;
  const checkIn = wakeAhead ? `check-in ${time(s.wakeAt!, now)}` : undefined;
  if (s.status === 'stopped') {
    const resumes = checkIn ?? (s.queuedSend ? 'a queued message' : undefined);
    return v('stopped', resumes ? { resumes } : {});
  }
  const jobs = jobsText(s);
  if (jobs) return v('waiting', { kind: 'job', waitsOn: [jobs, checkIn].filter(Boolean).join(' · '), ...(wakeAhead ? { until: s.wakeAt } : {}) });
  if (s.queuedSend) return v('waiting', { kind: 'queued', waitsOn: `a queued message (${s.queuedSend})` });
  if (checkIn) {
    const note = firstWords(s.wakeNote);
    return v('waiting', { kind: 'timer', waitsOn: note ? `${checkIn}: ${note}` : checkIn, until: s.wakeAt });
  }
  return v('idle');
}

/** "Waiting: CI on PR #1098 · check-in 06:10 UTC", "Stopped (resumes at check-in 16:29 UTC)", "Idle", …. */
export const agentStateText = (s: AgentFacts, time?: (iso: string, now: number) => string, now?: number) => {
  const a = agentState(s, time, now);
  return a.waitsOn ? `${a.label}: ${a.waitsOn}` : a.resumes ? `${a.label} (resumes at ${a.resumes})` : a.label;
};

/** Whether the agent is alive between turns with something real pending (Waiting). */
export const isWaitingAgent = (s: AgentFacts, now?: number) => agentState(s, undefined, now).state === 'waiting';

/**
 * Whether the agent will come back to its sandbox, so the sandbox is not free: Waiting, or stopped with a check-in ahead
 * or a message queued for it (it resumes there).
 */
export const holdsItsPlace = (s: AgentFacts, now?: number) => {
  const a = agentState(s, undefined, now);
  return a.state === 'waiting' || !!a.resumes;
};

/** Agents in list order: Working (and Needs you), Waiting, Idle, Error, Stopped; the most recent activity first in each. */
export function sortAgents<T extends AgentFacts & Pick<SessionInfo, 'lastActivityAt'>>(list: readonly T[], now?: number): T[] {
  return [...list].sort((a, b) => AGENT_STATE_RANK[agentState(a, undefined, now).state] - AGENT_STATE_RANK[agentState(b, undefined, now).state] || b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/**
 * A place's rank for the lists of sandboxes (w509, Lothsahn: sort sandboxes by status): one with a Working agent (or one
 * that needs you) first, then Waiting, then Idle, then those with no live agent or unused. With its latest activity.
 */
export function placeRank(agents: readonly (AgentFacts & Pick<SessionInfo, 'lastActivityAt'>)[], now?: number): { rank: number; latest: string } {
  let rank = 3;
  let latest = '';
  for (const s of agents) {
    const st = agentState(s, undefined, now).state;
    const r = st === 'working' || st === 'needs_you' ? 0 : st === 'waiting' ? 1 : st === 'idle' ? 2 : 3;
    rank = Math.min(rank, r);
    if (s.lastActivityAt > latest) latest = s.lastActivityAt;
  }
  return { rank, latest };
}

/** Places in list order by placeRank: rank first, the most recent activity first within one. Stable otherwise. */
export function sortPlaces<P>(places: readonly P[], agentsOf: (p: P) => readonly (AgentFacts & Pick<SessionInfo, 'lastActivityAt'>)[], now?: number): P[] {
  const keyed = places.map((p, i) => ({ p, i, ...placeRank(agentsOf(p), now) }));
  keyed.sort((a, b) => a.rank - b.rank || b.latest.localeCompare(a.latest) || a.i - b.i);
  return keyed.map((k) => k.p);
}
