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
//
// w643 (Lothsahn: Waiting is a person, Queued is capacity, Blocked is a thing): an agent alive between turns
// (`between_turns`, w475's Waiting) is shown as Working when its own work is still going (a background job such as CI,
// a check-in it set), Queued when a message to it waits for a free agent slot, and Blocked when that message waits for
// its machine (offline, or its daemon outdated). Needs you is the one state where a person must act.
//
// w691 (w665: a worker whose agent host never started was shown mid-turn for hours): an agent whose last message found no
// agent host to run in (`hostFailure`) is Blocked on its machine, whatever its status says; nothing runs for it.
import type { SessionInfo } from './types.ts';

export type AgentState = 'working' | 'needs_you' | 'between_turns' | 'idle' | 'error' | 'stopped';

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  /** Its own work goes on (a job, a check-in); a held message shows Queued or Blocked instead (agentState). */
  between_turns: 'Working',
  idle: 'Idle',
  error: 'Error',
  stopped: 'Stopped',
};

/** The order agents are listed in (Lothsahn: "running at the top, waiting below them, and idle below them"). */
export const AGENT_STATE_RANK: Record<AgentState, number> = { working: 0, needs_you: 0, between_turns: 1, idle: 2, error: 3, stopped: 4 };

/** What an agent between turns waits on: a job it started that is still running, a message queued for it, or only its check-in. */
export type WaitKind = 'job' | 'queued' | 'timer';

export interface AgentStateView {
  state: AgentState;
  label: string;
  /** Between turns: on what, e.g. "CI on PR #1098 · check-in 06:10 UTC", "a queued message (…)", "check-in 16:29 UTC: “merge #1083…”". */
  waitsOn?: string;
  /** Between turns: a running job, a queued message, or a timer alone. */
  kind?: WaitKind;
  /** Its check-in (ISO), when one is ahead. */
  until?: string;
  /** Stopped, but something will resume it: its check-in or a queued message ("check-in tomorrow 00:08 UTC"). */
  resumes?: string;
  /** Stopped when its daemon went away (w613): its sandbox is kept for it ("its daemon restarted at 21:04 UTC"). */
  held?: string;
  /** Until when that hold lasts (w656: "21:34 UTC"). */
  heldUntil?: string;
  /** Stopped and its sandbox released for other work (w640): why ("its check-in is 9 h away"). */
  released?: string;
}

type AgentFacts = Pick<SessionInfo, 'status'> & Partial<Pick<SessionInfo, 'machineId' | 'hostFailure' | 'wakeAt' | 'wakeNote' | 'queuedSend' | 'queuedOn' | 'backgroundTasks' | 'backgroundJobs' | 'heldSince' | 'placeReleased' | 'releaseDue'>>;

/**
 * How long an agent whose daemon went away under it keeps its sandbox (w613) before the release pass may release it
 * (server/placeAgain.ts): 30 minutes, time for a person or its orchestrator to resume it after a worker update. A day
 * until w656 (Lothsahn, 2026-10-07: every sandbox held while BEAST and LothDesktop had agent slots free). A message
 * resumes it, and stop_agent ends the hold at once.
 */
export const HOLD_PLACE_MS = 30 * 60_000;

/** Whether a status or error line says no agent host could be started (the daemon's words: "could not start its agent host: …", "its agent host did not start"). */
export const hostStartFailed = (text: string | undefined) => !!text && /could not start its agent host|its agent host did not start/i.test(text);

/** Why a dead agent host blocks an agent: "its agent host did not start on m3". */
export const hostFailureText = (s: Pick<SessionInfo, 'machineId'>) => `its agent host did not start on ${s.machineId ?? 'its machine'}`;

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
 * The agent's state. Between turns only while alive (idle) with something real pending: a background job still running
 * (the SDK's live set; a restart ends them), a message queued for it, or a check-in still ahead; its label is Working,
 * or Queued / Blocked for a queued message (w643). A stopped agent is Stopped, with `resumes` when its check-in or a
 * queued message will start it again.
 */
export function agentState(s: AgentFacts, time: (iso: string, now: number) => string = utcTime, now: number = Date.now()): AgentStateView {
  const v = (state: AgentState, more: Partial<AgentStateView> = {}): AgentStateView => ({ state, label: AGENT_STATE_LABEL[state], ...more });
  // Before the status: an older daemon went on reporting it mid-turn after its host failed to start (w665).
  if (s.hostFailure) return { ...v('error', { waitsOn: hostFailureText(s) }), label: 'Blocked' };
  if (s.status === 'running' || s.status === 'starting') return v('working');
  if (s.status === 'waiting_permission') return v('needs_you');
  if (s.status === 'error') return v('error');
  const wakeAhead = !!s.wakeAt && Date.parse(s.wakeAt) > now - OVERDUE_MS;
  const checkIn = wakeAhead ? `check-in ${time(s.wakeAt!, now)}` : undefined;
  if (s.status === 'stopped') {
    const resumes = checkIn ?? (s.queuedSend ? 'a queued message' : undefined);
    const heldAt = s.heldSince ? Date.parse(s.heldSince) : NaN;
    const held = heldAt && now - heldAt < HOLD_PLACE_MS ? `its daemon restarted at ${time(s.heldSince!, now)}` : undefined;
    const heldUntil = held ? time(new Date(heldAt + HOLD_PLACE_MS).toISOString(), now) : undefined;
    const released = s.placeReleased ? s.placeReleased.why : undefined;
    return v('stopped', { ...(resumes ? { resumes } : {}), ...(held ? { held, heldUntil } : {}), ...(released ? { released } : {}) });
  }
  const jobs = jobsText(s);
  if (jobs) return v('between_turns', { kind: 'job', waitsOn: [jobs, checkIn].filter(Boolean).join(' · '), ...(wakeAhead ? { until: s.wakeAt } : {}) });
  if (s.queuedSend) return { ...v('between_turns', { kind: 'queued', waitsOn: `a queued message (${s.queuedSend})` }), label: s.queuedOn === 'machine' ? 'Blocked' : 'Queued' };
  if (checkIn) {
    const note = firstWords(s.wakeNote);
    return v('between_turns', { kind: 'timer', waitsOn: note ? `${checkIn}: ${note}` : checkIn, until: s.wakeAt });
  }
  return v('idle');
}

/** "Working: CI on PR #1098 · check-in 06:10 UTC", "Queued: a queued message (…)", "Stopped (resumes at check-in 16:29 UTC)", "Idle", …. */
export const agentStateText = (s: AgentFacts, time?: (iso: string, now: number) => string, now?: number) => {
  const a = agentState(s, time, now);
  const released = a.released ? `; its sandbox is released (${a.released}): it is placed again when it resumes` : '';
  return a.waitsOn ? `${a.label}: ${a.waitsOn}` : a.resumes ? `${a.label} (resumes at ${a.resumes}${released})` : a.held ? `${a.label} (${a.held}; its sandbox is kept for it until ${a.heldUntil})` : a.released ? `${a.label} (its sandbox is released: ${a.released})` : a.label;
};

/** Whether the agent is alive between turns with something real pending (w475's Waiting). */
export const isBetweenTurns = (s: AgentFacts, now?: number) => agentState(s, undefined, now).state === 'between_turns';

/**
 * Whether the agent will come back to its sandbox, so the sandbox is not free: between turns, or stopped with a check-in
 * ahead or a message queued for it (it resumes there).
 */
export const holdsItsPlace = (s: AgentFacts, now?: number) => {
  const a = agentState(s, undefined, now);
  return a.state === 'between_turns' || !!a.resumes || !!a.held;
};

/**
 * Whether the agent keeps its sandbox from other work (w640): it holds its place and has not released it. A worker
 * stopped with its check-in far away (server/placeAgain.ts) will still come back, as the ledger counts it
 * (holdsItsPlace), but is placed again when it does, so its sandbox is free meanwhile. A stopped worker whose release
 * is due (w656: its w613 hold past, or stopped while idle) keeps it until the release pass releases it, which it does
 * only for a clean worktree: until then new work must not take it.
 */
export const holdsSandbox = (s: AgentFacts, now?: number) =>
  !s.placeReleased && (holdsItsPlace(s, now) || (s.status === 'stopped' && (!!s.heldSince || !!s.releaseDue)));

/** Agents in list order: Working mid-turn (and Needs you), between turns, Idle, Error, Stopped; the most recent first in each. */
export function sortAgents<T extends AgentFacts & Pick<SessionInfo, 'lastActivityAt'>>(list: readonly T[], now?: number): T[] {
  return [...list].sort((a, b) => AGENT_STATE_RANK[agentState(a, undefined, now).state] - AGENT_STATE_RANK[agentState(b, undefined, now).state] || b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/**
 * A place's rank for the lists of sandboxes (w509, Lothsahn: sort sandboxes by status): one with an agent mid-turn (or
 * one that needs you) first, then one between turns, then Idle, then those with no live agent or unused. With its latest activity.
 */
export function placeRank(agents: readonly (AgentFacts & Pick<SessionInfo, 'lastActivityAt'>)[], now?: number): { rank: number; latest: string } {
  let rank = 3;
  let latest = '';
  for (const s of agents) {
    const st = agentState(s, undefined, now).state;
    const r = st === 'working' || st === 'needs_you' ? 0 : st === 'between_turns' ? 1 : st === 'idle' ? 2 : 3;
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
