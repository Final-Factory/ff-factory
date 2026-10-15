import { isWith } from '../shared/blockers.ts';
import { WORK_OPEN, type WorkItem } from '../shared/types.ts';

/**
 * The sessions whose temp folder must survive while they are stopped (w1097): a worker that a request it is on still
 * waits for, so it will be resumed and expects its files (lothsahn, 2026-10-12: "For w1097 why are workers deleting stuff
 * in temp? Can't we have the cleanup process when a worker is done do this for them so the worker doesn't have to worry
 * about it?"). A worker is "done" when every request it is on is closed or with another worker (AgentManager.workOver's
 * rule, server/agents.ts), not when its process ends: a wait for CI, a person or a pause (LothDesktop's V: grow,
 * 2026-10-12) ends the process too, and the sweep of w913 emptied those folders (dcf976fc on w1086 lost its "before"
 * clips and a player build in progress). A stalled request counts as open here: the ledger's follow-ups resume it.
 */
export function resumableSessions(sessionIds: Iterable<string>, work: Iterable<WorkItem>): string[] {
  const items = [...work].filter((w) => w.status !== 'merged' && (WORK_OPEN.includes(w.status) || w.status === 'stalled'));
  return [...sessionIds].filter((sid) => items.some((w) => w.sessionIds.includes(sid) && isWith(w, sid))).sort();
}

/** A request a session is on, as a machine's clean-up needs it (w1379). */
export interface OwnedRequest {
  /** "w1332". */
  id: string;
  status: string;
  /** The session is the one the request is with now (shared/blockers.ts isWith), not an earlier worker it moved on from. */
  with: boolean;
}

/** What the ledger says about one session, for the clean-up of its folders on a machine (w1379). */
export interface SessionOwner {
  /** The machine sandbox it works in, when it has one: a sandbox's build and capture output belongs to its worker. */
  sandbox?: string;
  requests: OwnedRequest[];
}

/**
 * The sessions of a machine with at least one request that is not closed (open or stalled), each with every request
 * it is on, closed ones included. A session missing from the result has no live request: its requests are closed or it
 * has none, and nothing waits for its folders (w1379: the machine's `ff-leftovers folders` says so to a clean-up worker;
 * before it, w1374's worker kept a hand-written list of the stopped workers that would resume, and left out a735f37c,
 * on w1332, stalled that day, whose builds and preview clips it deleted).
 */
export function ownersOf(sessions: Iterable<{ id: string; machineSandbox?: string }>, work: Iterable<WorkItem>): Record<string, SessionOwner> {
  const items = [...work];
  const out: Record<string, SessionOwner> = {};
  for (const s of sessions) {
    const mine = items.filter((w) => w.sessionIds.includes(s.id));
    if (!mine.some((w) => w.status !== 'merged' && (WORK_OPEN.includes(w.status) || w.status === 'stalled'))) continue;
    out[s.id] = {
      ...(s.machineSandbox ? { sandbox: s.machineSandbox } : {}),
      requests: mine.map((w) => ({ id: w.id.toLowerCase(), status: w.status, with: isWith(w, s.id) })).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  return out;
}
