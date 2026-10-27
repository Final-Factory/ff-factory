// w2411: a timed run's result follows its request. lothsahn, 2026-10-27: "File a fix so timed-run results follow the
// request to its new worker". A run was delivered to the session that filed it (TimedRunRecord.session); when FF Factory
// moved the request to a new worker meanwhile, the message went to the old one, which the w2079 rule then refused to
// move again, so it was dropped: w2257's tr_0d985b752b (about an hour of LothLaptop, ledger 2026-10-26 10:25: "a message
// for its old worker 5e988861 on beast/slot3 did not move it again (w2079)"), and w2363's tr_0ed821dfd1 and tr_84cc11005b
// (filed by 604e4321 on lothdesktop, moved to beast at 14:11Z on 2026-10-27).
import { newestFirst } from '../shared/blockers.ts';
import { WORK_OPEN, type SessionInfo, type WorkItem } from '../shared/types.ts';

/** Where a timed run's message goes: a worker (`moved` when that is not the one that filed it), or kept for the next one. */
export type TimedRoute = { to: string; moved: boolean; work: WorkItem[] } | { keep: string; work: WorkItem[] };

/** A request a timed result still serves: open, merged with a follow-up pending, or stalled (a person may revive it). */
const live = (w: WorkItem) => WORK_OPEN.includes(w.status) || w.status === 'merged' || w.status === 'stalled';

/**
 * The worker a timed run's message goes to: the one that filed it while it still holds one of the run's requests; else
 * the newest worker of such a request (latestWorker's order) that exists and has not failed; else none: the result is
 * kept for the next worker (`keep` says why). A run whose requests are all closed, or that names none, goes to its filer.
 */
export function timedRoute(filer: string, requests: readonly string[], work: (id: string) => WorkItem | undefined, session: (id: string) => SessionInfo | undefined): TimedRoute {
  const open = requests.map(work).filter((w): w is WorkItem => !!w && live(w));
  if (!open.length) return { to: filer, moved: false, work: [] };
  if (open.some((w) => w.sessionIds.includes(filer) && !w.movedOff?.[filer])) return { to: filer, moved: false, work: open };
  for (const w of open) {
    const to = newestFirst(w).find((id) => {
      const s = session(id);
      return !!s && s.kind === 'worker' && s.status !== 'error' && !w.movedOff?.[id];
    });
    if (to) return { to, moved: true, work: open };
  }
  return { keep: `${open.map((w) => w.id).join(', ')} ${open.length > 1 ? 'have' : 'has'} no worker now (worker ${filer}, which filed it, was moved off)`, work: open };
}
