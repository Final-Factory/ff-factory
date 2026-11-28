/**
 * A worker's own check-in that nothing can deliver (w6768, lothsahn, 2026-11-28: "a request that waits on its worker's own
 * check-in must never sit forever because that worker can't wake up").
 *
 * Two cases the 4-hourly ledger review found on 2026-11-28:
 * - w6370: worker e41a69e8 set a check-in for 09:45Z, released lothdesktop/slot5, and was removed with that sandbox when the
 *   dispatcher deleted slot5 at 22:04Z on 11-27 (delete_sandbox removed every session on its list, released ones too). The
 *   Waker then dropped its check-in without a word, and the request read "Merged, follow-up pending" for 14 hours.
 * - w6484: worker 69908625 on beast/agent1 set a check-in for about 10:06Z; BEAST was offline from 07:39Z. The wake was
 *   refused (the machine offline), tried again 10 times a minute apart, and dropped; nothing moved the work, since the
 *   w2544 move only reads Blocked and Queued requests and held messages, never a stopped worker's pending check-in.
 *
 * The Waker now says so (Waker.onLost), the request carries it (WorkItem.lostCheckIn), and its live state is Stalled with
 * the reason until a worker on it starts a turn again. Another worker on the request that comes back by itself (its own
 * check-in, a job between turns) wins: the request is not Stalled then, and the dispatcher is not told (review w6771, B1).
 */
import type { SessionInfo, WorkItem } from './types.ts';

/** What a request keeps of a check-in nothing can deliver. */
export interface LostCheckIn {
  /** The worker whose check-in it was. */
  worker: string;
  /** When it was due, ISO. */
  due: string;
  /** Its note, as the worker wrote it (the hand-over's message once it moves). */
  note: string;
  /** "is gone", or "is on beast (offline 147 min)". */
  why: string;
  /** When FF Factory saw it, ISO. */
  seen: string;
  /** The turns each worker on the request had then: a later turn by any of them (or a new worker) ends it. */
  turns: Record<string, number>;
  /**
   * The request's sessionIds then: a worker added since ends it for good, also once it leaves again (review w6771, M1; turns
   * only grow, so a turn taken since ends it for good too).
   */
  ids?: string[];
}

/** "its check-in at 09:45Z is due, and worker e41a69e8 is gone": the request's Stalled line and its log. */
export function lostLine(l: Pick<LostCheckIn, 'worker' | 'due' | 'why'>): string {
  return `its check-in at ${l.due.slice(11, 16)}Z is due, and worker ${l.worker} ${l.why}`;
}

/**
 * Whether `w`'s lost check-in still stands: no worker on it is mid-turn, none has taken a turn since, and no new worker came.
 * `workers` are the request's workers that still exist (onRequest).
 */
export function lostStands(w: Pick<WorkItem, 'lostCheckIn'> & Partial<Pick<WorkItem, 'sessionIds'>>, workers: readonly Pick<SessionInfo, 'id' | 'turns' | 'status'>[]): w is { lostCheckIn: LostCheckIn } {
  const l = w.lostCheckIn;
  if (!l) return false;
  if (l.ids && (w.sessionIds ?? []).some((id) => !l.ids!.includes(id))) return false;
  return workers.every((s) => s.id in l.turns && s.turns <= l.turns[s.id] && s.status !== 'running' && s.status !== 'starting' && s.status !== 'waiting_permission');
}
