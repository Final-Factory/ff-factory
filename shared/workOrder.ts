// The order of the Dispatcher page's requests (web/src/components/DispatcherPanel.tsx). Here, so the tests can reach it.
import { asWorkPriority, type WorkItem } from './types.ts';

/** The status groups, top to bottom: questions, new, queued, blocked, active, then the stalled ones, then every closed one together. */
export const STATUS_RANK: Record<WorkItem['status'], number> = { question: 0, new: 1, queued: 2, blocked: 2.5, active: 3, stalled: 3.5, done: 4, merged: 4, rejected: 4, cancelled: 4 };
const PRIORITY: Record<WorkItem['priority'], number> = { frantic: 0, urgent: 1, high: 2, normal: 3, low: 4 };

/** Whether `viewerId` (a login) is one of the item's people. */
export function isMine(w: Pick<WorkItem, 'requesters'>, viewerId: string | undefined): boolean {
  const me = viewerId?.toLowerCase();
  return !!me && w.requesters.some((r) => r.userId.toLowerCase() === me);
}

/**
 * The ledger as `viewerId` sees it: by status group, then (open ones) by priority; within one status and priority the
 * viewer's own requests first (w307, asked by Lothsahn), then everyone else's; within each part open ones oldest first,
 * closed ones newest first. Closed ones were never ordered by priority, and are not now.
 */
export function ledgerOrder(work: readonly WorkItem[], viewerId: string | undefined): WorkItem[] {
  const mine = new Map(work.map((w) => [w, isMine(w, viewerId)]));
  return [...work].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank) return rank;
    const open = STATUS_RANK[a.status] < STATUS_RANK.done;
    if (open && a.priority !== b.priority) return PRIORITY[asWorkPriority(a.priority) ?? 'normal'] - PRIORITY[asWorkPriority(b.priority) ?? 'normal'];
    if (mine.get(a) !== mine.get(b)) return mine.get(a) ? -1 : 1;
    return open ? a.createdAt.localeCompare(b.createdAt) : b.updatedAt.localeCompare(a.updatedAt);
  });
}
