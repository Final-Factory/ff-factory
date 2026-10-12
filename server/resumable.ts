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
