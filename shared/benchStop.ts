// w3730: a person stops a machine's bench ticket from the dashboard or through their orchestrator (lothsahn, 2026-11-08,
// about bench locks: "Make sure that this situation can never happen again… get it fixed"). The portal sends the daemon's
// `bench_revoke` (machine/benchRevoke.ts, w3715): bench_queue.py's own revoke, then the helper's process tree 90 s later if
// it still holds. This is the one rule, for the page and the server alike, of which tickets a person may stop that way.
import type { BenchTicketGlance } from './types.ts';

/** A ticket name as bench_queue.py writes it and the daemon's bench_revoke takes it. */
export const BENCH_TICKET_RE = /^t\d{8}$/;

/**
 * Why a running ticket cannot be stopped with bench_revoke, or undefined when it can: only a worker's own ticket. The
 * daemon refuses a harness ticket (no session, or a timed run's leg: machine/benchRevoke.ts isHarnessTicket); an editor's
 * life ticket (`editor:<sandbox>`, w1962) and the urgent release lane's and the nightly's are FF Factory's own lanes, which
 * the idle watch leaves alone too (server/benchHolders.ts), so the page offers no Stop for them either.
 */
export function benchStopRefusal(t: Pick<BenchTicketGlance, 'ticket' | 'session' | 'what' | 'exempt' | 'preempt'>): string | undefined {
  if (!BENCH_TICKET_RE.test(t.ticket)) return `"${t.ticket}" is not a bench ticket name (t and 8 digits)`;
  if (!t.session || t.session.startsWith('editor:')) return `${t.ticket} is an editor's ticket (a harness ticket): it ends with the editor; stop the editor instead`;
  if (/^timed run /.test(t.what)) return `${t.ticket} is a timed run's leg (a harness ticket): the timed run ends it; cancel the run instead (timed_place cancel)`;
  if (t.preempt || t.exempt === 'release') return `${t.ticket} is the urgent release lane's (FF Factory's own lane), not a worker's own ticket`;
  if (t.exempt === 'nightly') return `${t.ticket} is the nightly's (FF Factory's own lane), not a worker's own ticket`;
  return undefined;
}

/** The `why` the daemon writes into the ticket's revoked file and logs: who stopped it, and from where. */
export const benchStopWhy = (person: string, via: string) => `stopped by ${person} ${via} (w3730)`;
