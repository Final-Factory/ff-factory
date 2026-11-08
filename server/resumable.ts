import { gateSetter, gatesOf, isWith } from '../shared/blockers.ts';
import { WORK_OPEN, type WorkItem } from '../shared/types.ts';

/**
 * The sessions whose temp folder must survive while they are stopped (w1097): a worker that a request it is on still
 * waits for (its newest worker, or one with a gate of its own on it, ownGates), or one with a check-in pending (`wakes`), so it will be resumed and expects its files (lothsahn, 2026-10-12: "For w1097 why are workers deleting stuff
 * in temp? Can't we have the cleanup process when a worker is done do this for them so the worker doesn't have to worry
 * about it?"). A worker is "done" when every request it is on is closed or with another worker (AgentManager.workOver's
 * rule, server/agents.ts), not when its process ends: a wait for CI, a person or a pause (LothDesktop's V: grow,
 * 2026-10-12) ends the process too, and the sweep of w913 emptied those folders (dcf976fc on w1086 lost its "before"
 * clips and a player build in progress). A stalled request counts as open here: the ledger's follow-ups resume it.
 *
 * A closed request no longer counts (w3656, lothsahn, 2026-11-08: "once a request closes, why doesn't its temp directory
 * get cleaned up?"). From w1575 to w3656 a done, rejected or cancelled request kept its worker resumable for 7 days in case
 * it was reopened, and the folder with it: LothDesktop's tmp reached 166 GB, a closed request's 27 GB clone among it. Its
 * folder now goes once nothing wrote in it for closedSessionMinutes (installLeftovers.ts closedSessions); a reopen within
 * that time still finds it, a later one clones again.
 */
export function resumableSessions(sessionIds: Iterable<string>, work: Iterable<WorkItem>, _now = Date.now(), wakes: Iterable<string> = []): string[] {
  const items = [...work].filter((w) => w.status !== 'merged' && (WORK_OPEN.includes(w.status) || w.status === 'stalled'));
  // w2026: one pass over the requests (the stall profiles of 2026-10-24 had a scan of every request per session here)
  const withThem = new Set<string>(wakes);
  for (const w of items) {
    for (const sid of w.sessionIds) if (!withThem.has(sid) && isWith(w, sid)) withThem.add(sid);
    for (const sid of ownGates(w)) withThem.add(sid);
  }
  return [...sessionIds].filter((sid) => withThem.has(sid)).sort();
}

/**
 * The workers that set a gate on open request `w` for their own part (blocked_on: CI, a PR, a request; w2987). FF Factory
 * resumes each when its gate clears, whatever else the request does meanwhile: another leg linked later, the request Active
 * again, or the worker taken off `sessionIds` (w2566's pass at 12:40Z on 2026-11-03 took 50e2b52d off w2895 while its CI
 * gate on ffu #135 stayed; its folder then counted as nobody's, and its ffu clone and rust.sh were gone when CI resumed it).
 */
function ownGates(w: WorkItem): string[] {
  if (w.status === 'merged' || !(WORK_OPEN.includes(w.status) || w.status === 'stalled')) return [];
  return gatesOf(w).flatMap((g) => gateSetter(g) ?? []);
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
  // w2026: the requests by session in one pass, in ledger order, not a scan of every request per session
  const bySession = new Map<string, WorkItem[]>();
  const gated = new Map<WorkItem, Set<string>>();
  for (const w of work) {
    const own = new Set(ownGates(w));
    gated.set(w, own);
    for (const sid of new Set([...w.sessionIds, ...own])) {
      const list = bySession.get(sid);
      if (list) list.push(w);
      else bySession.set(sid, [w]);
    }
  }
  const out: Record<string, SessionOwner> = {};
  for (const s of sessions) {
    const mine = bySession.get(s.id) ?? [];
    if (!mine.some((w) => w.status !== 'merged' && (WORK_OPEN.includes(w.status) || w.status === 'stalled'))) continue;
    out[s.id] = {
      ...(s.machineSandbox ? { sandbox: s.machineSandbox } : {}),
      requests: mine.map((w) => ({ id: w.id.toLowerCase(), status: w.status, with: isWith(w, s.id) || !!gated.get(w)?.has(s.id) })).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  return out;
}
