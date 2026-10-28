import type { WorkItem } from './types.ts';

/**
 * A request's Latest line as the ledger, read_work and the page show it (w2433). Its `outcome` is rewritten only when a report
 * comes (a worker's turn ends, a close): a worker that waited on a person and was resumed by their answer can work a long
 * turn before it reports again, so its question stood as the Latest line after it was answered (w2320, 2026-10-26: lothsahn
 * answered at 22:58Z, and the line still read "waiting on lothsahn to pick the next cut" an hour later). While the line is
 * still the one the answer was given on (WorkNeedsYou.answered.outcome), it says the answer instead.
 */
export function latestLine(w: Pick<WorkItem, 'outcome' | 'needsYou'>): string | undefined {
  const a = w.needsYou?.answered;
  if (!w.outcome || !a || a.outcome === undefined || a.outcome !== w.outcome) return w.outcome;
  const worker = w.needsYou?.worker;
  return `${a.by} answered${a.on ? ` (on ${a.on})` : ''} at ${a.at.slice(11, 16)} UTC what it waited on; ${worker ? `its worker ${worker} resumed on the answer and has not reported since` : 'no report since'}.`;
}
