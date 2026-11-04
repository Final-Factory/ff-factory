/**
 * A hand-off request's report in full (w3105). A session's `lastResult` keeps 1200 characters (`reportClip`, enough for the
 * ledger's first line and its closing `DONE:`/still-open lines), so a timed leg's run table reached the worker Blocked on
 * it cut short: w3094's 7 KB DONE (a table and eight JSON lines) arrived at w2895's worker as "5795 chars left out", no
 * report was filed, and the leg's logs were swept when it closed (2026-11-04). The requests whose report another worker
 * waits on keep their newest report whole (WorkItem.handoff), up to HANDOFF_REPORT_CHARS; ordinary turns keep the cut.
 */
import type { WorkItem } from '../shared/types.ts';
import { gatesOf } from '../shared/blockers.ts';

/** The most of a hand-off report the ledger keeps (it goes to the dashboard with the request, as its brief does). */
export const HANDOFF_REPORT_CHARS = 24_000;
/** The most of it quoted inline in one waiting worker's resume (the wake note keeps 16,000 in all). */
export const HANDOFF_QUOTE_CHARS = 12_000;

const FOR_LINE = /^\s*(?:[*_>#-]\s*)*For w\d+\b/im;

/**
 * Whether `w`'s newest report is a hand-off another worker reads: `w` is a timed leg or a pair run, another request is
 * Blocked on its report (or was: `waitedOn`), or the report itself says `For wNNN:`.
 */
export function isHandoff(w: WorkItem, text: string, all: Iterable<WorkItem>): boolean {
  if (w.timedLeg || w.pair || FOR_LINE.test(text)) return true;
  const id = w.id.toLowerCase();
  for (const o of all) {
    if (o.id === w.id) continue;
    if (o.waitedOn?.some((x) => x.toLowerCase() === id)) return true;
    if (gatesOf(o).some((g) => g.kind === 'request' && g.on === 'report' && g.ref?.toLowerCase() === id)) return true;
  }
  return false;
}

/** The record kept on the request: the text whole up to HANDOFF_REPORT_CHARS (`chars` is its length before any cut). */
export function handoffReport(session: string, at: string, text: string): NonNullable<WorkItem['handoff']> {
  const t = text.trim();
  return { session, at, text: t.length > HANDOFF_REPORT_CHARS ? t.slice(0, HANDOFF_REPORT_CHARS) : t, chars: t.length };
}

/**
 * What a waiting worker's resume quotes of a hand-off report for `waiter`: the whole report when it fits in `max`, else its
 * `For <waiter>:` section on (whole when that fits), else the start; a cut one says where the rest is (read_work).
 */
export function handoffQuote(r: Pick<NonNullable<WorkItem['handoff']>, 'text' | 'chars'>, leg: string, waiter: string, max = HANDOFF_QUOTE_CHARS): string {
  const t = r.text.trim();
  const more = `(cut: the whole report, ${r.chars} characters, is in read_work ${leg}, "Last report in full")`;
  if (t.length <= max && r.chars <= t.length) return t;
  const m = new RegExp(`^\\s*(?:[*_>#-]\\s*)*For ${waiter}\\b`, 'im').exec(t);
  const from = m ? t.slice(m.index).trim() : t;
  if (from.length <= max && r.chars <= t.length) return m ? `… ${from}` : from;
  return `${from.slice(0, max - more.length - 3)}\n… ${more}`;
}
