import { WORK_OPEN, type WorkFinding, type WorkItem } from '../shared/types.ts';

/**
 * A request's "Findings / outcome" record (w3706, docs/orchestrators.md "Findings and outcome"). lothsahn: "every time
 * a worker finishes the ledger gets updated for a workitem about its findings or outcomes before the workitem is closed.
 * That way you can look things up quickly without the full transcript".
 *
 * The server keeps it; workers write nothing new. Every report a worker ends a turn with is kept whole (FINDING_CHARS)
 * on the requests that turn was on (Orchestrators.workerTurnEnded), so a moved request keeps the earlier worker's
 * findings, and the "Latest:" line and the log (cut at 200 and 300 characters) stop being the only record. Every close,
 * whatever made it (a DONE, a SUPERSEDED, a person's close, the ledger cleanup, a merged PR, a merge into another
 * request), writes the final outcome in Store.putWork (settleOutcome), the one place a work item is saved: the close
 * note, plus the last worker's report when the note does not already hold it. list_work with an id and read_work show
 * both in full.
 */

/** One worker report as kept: its head, which carries the TL;DR the worker prompt asks for. */
export const FINDING_CHARS = 3_000;
/** The whole record's worker reports (a few KB a request; work.json keeps up to 2000 closed ones). */
export const FINDINGS_CHARS = 9_000;
/** An older report shrinks to this much of its head before any report is dropped. */
export const FINDING_HEAD = 600;
/** The last worker report the outcome quotes when the close note does not hold it. */
const OUTCOME_REPORT_CHARS = 2_500;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const size = (fs: readonly WorkFinding[]) => fs.reduce((n, f) => n + f.text.length, 0);
const isClosed = (w: WorkItem) => !!w.status && !WORK_OPEN.includes(w.status) && w.status !== 'stalled';

/** The requests a turn's report is about: the ones it names among those it was on, else all of them. */
export function findingTargets<T extends Pick<WorkItem, 'id'>>(items: readonly T[], text: string): T[] {
  const named = new Set([...text.matchAll(/\bw\d+\b/gi)].map((m) => m[0].toLowerCase()));
  const hit = items.filter((w) => named.has(w.id.toLowerCase()));
  return hit.length ? hit : [...items];
}

/**
 * Keep a worker's report on `w` (false when there is nothing new to keep: an empty report, or the same one again). The
 * newest report stays whole; older ones shrink to their heads, then the oldest go, each worker's first one last.
 */
export function recordFinding(w: WorkItem, by: string, text: string, now = new Date()): boolean {
  const body = text.trim();
  if (!body) return false;
  const kept = clip(body, FINDING_CHARS);
  const list = (w.findings ??= []);
  const last = list.at(-1);
  if (last && last.by === by && last.text === kept) return false;
  list.push({ at: now.toISOString(), by, text: kept, ...(body.length > kept.length ? { chars: body.length } : {}) });
  fitFindings(list);
  return true;
}

/** Bring the record under FINDINGS_CHARS: shrink older reports to their heads, then drop the oldest. */
export function fitFindings(list: WorkFinding[]) {
  for (let i = 0; i < list.length - 1 && size(list) > FINDINGS_CHARS; i++) {
    const f = list[i]!;
    if (f.text.length <= FINDING_HEAD) continue;
    f.chars ??= f.text.length;
    f.text = clip(f.text, FINDING_HEAD);
  }
  while (size(list) > FINDINGS_CHARS && list.length > 1) {
    // A worker's first report holds what it found first (the cause, the measurement): it goes after its later ones.
    const later = list.findIndex((f, i) => i < list.length - 1 && list.slice(0, i).some((e) => e.by === f.by));
    list.splice(later >= 0 ? later : 0, 1);
  }
}

/**
 * The final outcome of a closed request, written on every save of it (Store.putWork), so no close goes without one: the
 * note it was closed with and, when that does not already hold it, the last worker report (a DONE keeps only its first
 * line as the note; the cleanup's and a person's close notes say why it closed, not what was found). A reopened request
 * moves its old outcome into the reports, so a second close writes a new one and the first stays readable.
 */
export function settleOutcome(w: WorkItem, now = new Date()) {
  if (isClosed(w)) {
    const text = outcomeText(w);
    const same = !!w.finalOutcome && w.finalOutcome.status === w.status;
    if (same && w.finalOutcome!.text === text) return;
    w.finalOutcome = { at: same ? w.finalOutcome!.at : now.toISOString(), status: w.status, text };
    return;
  }
  if (!w.finalOutcome || w.status === 'stalled') return;
  const o = w.finalOutcome;
  delete w.finalOutcome;
  (w.findings ??= []).push({ at: o.at, by: 'ledger', text: clip(`Closed as ${o.status}, then reopened. Its outcome then: ${o.text}`, FINDING_CHARS) });
  fitFindings(w.findings);
}

function outcomeText(w: WorkItem): string {
  const note = (w.mergedInto && !w.outcome ? `merged into ${w.mergedInto}` : (w.outcome ?? '')).trim();
  const last = [...(w.findings ?? [])].reverse().find((f) => f.by !== 'ledger');
  if (!last || note.includes(last.text)) return note || `closed as ${w.status}`;
  const quoted = clip(last.text, OUTCOME_REPORT_CHARS);
  return `${note || `closed as ${w.status}`}\n\nThe last worker report (worker ${last.by}, ${stamp(last.at)}):\n${quoted}`;
}

const stamp = (at: string) => at.slice(0, 16).replace('T', ' ');

/**
 * The record as list_work with an id prints it: the outcome, then the worker reports newest first, each whole as kept.
 * Empty when there is nothing yet (a request older than w3706 shows its Latest line and log as before).
 */
export function findingsLines(w: WorkItem, indent = '  '): string[] {
  const fs = w.findings ?? [];
  const o = w.finalOutcome;
  if (!fs.length && !o) return [];
  const block = (text: string, pad: string) => text.split('\n').map((l) => (l ? `${pad}${l}` : '')).join('\n');
  const lines = [`Findings / outcome (w3706: kept across its workers; the outcome, then ${fs.length} worker report${fs.length === 1 ? '' : 's'}, newest first):`];
  if (o) lines.push(`${indent}Outcome (${o.status}, ${stamp(o.at)}):`, block(o.text, indent + indent));
  for (const f of [...fs].reverse()) {
    const cut = f.chars ? ` (the first ${f.text.length} of ${f.chars} characters)` : '';
    const who = f.by === 'ledger' ? 'the ledger' : `worker ${f.by}`;
    lines.push(`${indent}${stamp(f.at)} ${who}${cut}:`, o && o.text.includes(f.text) ? `${indent}${indent}(quoted in the outcome above)` : block(f.text, indent + indent));
  }
  return lines;
}
