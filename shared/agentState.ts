// What an agent is doing, in one word (w475, asked by Lothsahn: "clear between 'available' workers (idle) and
// 'waiting' workers"): Working (mid-turn), Needs you (a permission), Waiting (between turns, but something will wake it:
// its wake_me, a background task it left running, or a message queued for it), Idle (finished, nothing pending: free for
// new work, and the idle reaper's candidate), Error, or Stopped. Pure: the page, list_sandboxes, list_machines, the
// capacity block and the ledger's request states (shared/workState.ts) all read it.
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

export interface AgentStateView {
  state: AgentState;
  label: string;
  /** Waiting: what will wake it, e.g. "check-in at 23:12", "a background task", "a queued message". */
  waitsOn?: string;
  /** Waiting on a wake_me: when (ISO). */
  until?: string;
}

type AgentFacts = Pick<SessionInfo, 'status'> & Partial<Pick<SessionInfo, 'wakeAt' | 'queuedSend' | 'backgroundTasks'>>;

/** "23:12" in UTC, or with `time` the caller's own clock (the page uses the browser's). */
const utcTime = (iso: string) => `${iso.slice(11, 16)} UTC`;

/**
 * The agent's state. Between turns (idle, or stopped and due to be resumed), it is Waiting while a wake_me is pending, a
 * message waits in the send queue for a free slot, or (idle only: a restart ends them) a background task is still open.
 */
export function agentState(s: AgentFacts, time: (iso: string) => string = utcTime): AgentStateView {
  const v = (state: AgentState, waitsOn?: string, until?: string): AgentStateView => ({ state, label: AGENT_STATE_LABEL[state], ...(waitsOn ? { waitsOn } : {}), ...(until ? { until } : {}) });
  if (s.status === 'running' || s.status === 'starting') return v('working');
  if (s.status === 'waiting_permission') return v('needs_you');
  if (s.status === 'error') return v('error');
  if (s.wakeAt) return v('waiting', `check-in at ${time(s.wakeAt)}`, s.wakeAt);
  if (s.queuedSend) return v('waiting', `a queued message (${s.queuedSend})`);
  if (s.status === 'idle' && (s.backgroundTasks ?? 0) > 0) return v('waiting', s.backgroundTasks === 1 ? 'a background task' : `${s.backgroundTasks} background tasks`);
  return v(s.status === 'stopped' ? 'stopped' : 'idle');
}

/** "Waiting: check-in at 23:12", "Idle", …: the state with what it waits on. */
export const agentStateText = (s: AgentFacts, time?: (iso: string) => string) => {
  const a = agentState(s, time);
  return a.waitsOn ? `${a.label}: ${a.waitsOn}` : a.label;
};

/** Whether the agent is committed to work it will come back to (Waiting), so neither it nor its sandbox is free. */
export const isWaitingAgent = (s: AgentFacts) => agentState(s).state === 'waiting';

/** Agents in list order: Working (and Needs you), Waiting, Idle, Error, Stopped; the most recent activity first in each. */
export function sortAgents<T extends AgentFacts & Pick<SessionInfo, 'lastActivityAt'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => AGENT_STATE_RANK[agentState(a).state] - AGENT_STATE_RANK[agentState(b).state] || b.lastActivityAt.localeCompare(a.lastActivityAt));
}
