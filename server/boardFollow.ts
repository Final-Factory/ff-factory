// Escalated threads followed to their result (w480; docs/intake.md, "Escalations from Max"): the pure rules the
// intake's board watches use, shared with scripts/escalation-catchup.ts.
//
// When Max escalates a thread, FFBox links its conversation to the request FF Factory answered with and watches board
// ref conv-<conversation>; the merge notice ("Fixed in PR #N, coming in version X") comes only when FF Factory pushes
// that ref a `done` answer. Its own board_check cannot find the request: the ledger leaves a conversation's own request
// out of that conversation's check (Orchestrators.rankBoard), and an escalated request's source is that conversation.
// So the watch names the request it follows (`follow`), and its answer is that request's standing.
import type { WorkItem } from '../shared/types.ts';

/** A board answer FFBox follows, by its ref (server/intake.ts). `follow`: the request an escalated thread is linked to. */
export interface BoardWatch {
  q: { keys: string[]; title?: string; summary?: string; conversation?: string };
  /** The digest of the last answer FFBox has (boardDigest); '' when it has none yet. */
  last: string;
  /** When FFBox started following it (the follow window counts from here). */
  at: number;
  follow?: string;
}

/** The FFBox board ref an escalated conversation's merge notice waits on (ffwatch fff_escalation_link). */
export const escalationRef = (conversation: string) => `conv-${conversation}`;

/**
 * The pull request a close names as the fix: "already fixed by #1076", "fixed in PR #1076 (Build 78)", "#1076 already
 * fixed this". Undefined when it names none, or mentions any other PR beside it.
 */
export function fixedByPr(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const found = new Set<number>();
  for (const re of [/\bfixed\s+(?:by|in|with|via)\s+(?:(?:PR|pull request)\s*)?#(\d{1,7})\b/gi, /(?:\b(?:PR|pull request)\s*)?#(\d{1,7})\s+(?:already\s+)?fix(?:ed|es)\b/gi]) {
    for (const m of text.matchAll(re)) found.add(Number(m[1]));
  }
  // Any other #N in the close leaves it unclear which one is the fix ("fixed by #1076 and #1080", "see also #1000").
  const all = new Set([...text.matchAll(/#(\d{1,7})\b/g)].map((m) => Number(m[1])));
  return found.size === 1 && all.size === 1 ? [...found][0] : undefined;
}

/** The request a watch follows, through a merge into another. */
export function followed(id: string, work: ReadonlyMap<string, WorkItem>): WorkItem | undefined {
  let w = work.get(id);
  for (let i = 0; i < 5 && w?.status === 'merged' && w.mergedInto; i++) w = work.get(w.mergedInto) ?? w;
  return w;
}

/** Whether a finished request's fix (its commit, its PR) can still be learnt: an auto-close, a linked one, or a PR named. */
export function fixLearnable(w: WorkItem): boolean {
  if (w.status !== 'done') return false;
  if (w.delivery?.fixCommit) return !w.delivery.fixPr || !w.delivery.releasedIn;
  return !!(w.delivery?.fixPr || w.autoClosed?.sha || w.autoClosed?.by || fixedByPr(w.outcome));
}

// ---------------------------------------------------------------- players' reports a request fixed (w502)

const REPORT_ID = String.raw`\d{8}T\d{6}Z-(?:crash|desync)-[0-9a-f]{6,32}`;

/** The player reports a request claims: its `report:<id>` keys (its subjects, or an intake diagnosis that joined it). */
export function reportIdsOf(w: Pick<WorkItem, 'keys'>): string[] {
  return w.keys.filter((k) => k.startsWith('report:')).map((k) => k.slice('report:'.length));
}

/**
 * The reports a pull request's description says it fixes: one line each, exactly `Report: <report id>` (w502), like the
 * `Discord:` lines FFBox reads. A report id quoted mid-sentence is not a claim. At most 20, each once.
 */
export function reportLines(text: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').matchAll(/^[ \t>*-]*Report:[ \t]*`?(\d{8}T\d{6}Z-(?:crash|desync)-[0-9a-f]{6,32})`?[ \t]*\r?$/gim)) {
    out.add(m[1]);
    if (out.size === 20) break;
  }
  return [...out];
}

/** What FFBox records for a report its request fixed (the report_fixed message, less its type). */
export interface ReportFix {
  reportId: string;
  workId: string;
  pr?: number;
  version: string;
  mergedIn: string;
}

/**
 * Every report a finished request claims whose fix is merged and released (w502): one line per report, from the request
 * it continues as (a merge into another follows that one). `target` is the branch the fix landed on ("develop").
 * Requests that changed in the last `days` days only.
 */
export function reportFixesOf(work: ReadonlyMap<string, WorkItem>, target: string, now: number, days = 30): ReportFix[] {
  const out = new Map<string, ReportFix>();
  for (const w of work.values()) {
    const ids = reportIdsOf(w);
    if (!ids.length) continue;
    const f = followed(w.id, work);
    const d = f?.delivery;
    if (!f || f.status !== 'done' || !d?.fixCommit || !d.releasedIn || now - Date.parse(f.updatedAt) > days * 86_400_000) continue;
    for (const reportId of ids) out.set(reportId, { reportId, workId: f.id, ...(d.fixPr ? { pr: d.fixPr } : {}), version: d.releasedIn, mergedIn: `${target}@${d.fixCommit}` });
  }
  return [...out.values()].sort((a, b) => a.reportId.localeCompare(b.reportId));
}

/** w502's one-time sweep: reports a finished request is certainly the fix for, and the ones it only mentions. */
export interface ReportSweep {
  /** Its report keys (subjects, or a diagnosis that joined it): marked fixed once its fix is merged and released. */
  certain: { workId: string; reportIds: string[]; released: boolean }[];
  /** Report ids its title, brief, notes or outcome mention but it does not claim: for a person to decide, never guessed. */
  uncertain: { workId: string; title: string; reportIds: string[] }[];
}

export function reportSweep(work: ReadonlyMap<string, WorkItem>, now: number, days = 30): ReportSweep {
  const certain: ReportSweep['certain'] = [];
  const uncertain: ReportSweep['uncertain'] = [];
  for (const w of work.values()) {
    if (w.status !== 'done' || now - Date.parse(w.updatedAt) > days * 86_400_000) continue;
    const own = new Set(reportIdsOf(w));
    if (own.size) certain.push({ workId: w.id, reportIds: [...own], released: !!(w.delivery?.fixCommit && w.delivery.releasedIn) });
    const text = [w.title, w.brief, w.outcome ?? '', ...(w.notes ?? []).map((n) => n.text)].join('\n');
    const named = [...new Set([...text.matchAll(new RegExp(REPORT_ID, 'g'))].map((m) => m[0]))].filter((id) => !own.has(id));
    if (named.length) uncertain.push({ workId: w.id, title: w.title, reportIds: named.slice(0, 20) });
  }
  const byId = (a: { workId: string }, b: { workId: string }) => Number(a.workId.slice(1)) - Number(b.workId.slice(1));
  return { certain: certain.sort(byId), uncertain: uncertain.sort(byId) };
}

/** An escalation's request FFBox may never have heard is done (w480's catch-up): one per escalated conversation. */
export interface CatchUpLine {
  ref: string;
  workId: string;
  /** The request the thread hears about: the escalated one, or the one it was merged into. */
  followId: string;
  conversation: string;
  threadId: string;
  closedAt: string;
  outcome: string;
  title: string;
}

/**
 * The escalated requests closed done in the last `days` days, whose threads may never have heard: every one, since FF
 * Factory cannot know what FFBox said. FFBox's own once-only guards (fff-fixed:<conversation>, pr-merged:*) keep a
 * thread that was told from hearing it twice. An escalation's request is an `ffbox-request` with a Discord thread and an
 * FFBox conversation (escalationSource); one merged into another follows that one when it is done.
 */
export function escalationCatchUp(work: ReadonlyMap<string, WorkItem>, now: number, days = 14): CatchUpLine[] {
  const out = new Map<string, CatchUpLine>();
  for (const w of work.values()) {
    const s = w.source;
    if (s?.kind !== 'ffbox-request' || !s.threadId || !s.conversation || !/^\d{1,12}$/.test(s.conversation)) continue;
    const f = followed(w.id, work);
    if (!f || f.status !== 'done' || now - Date.parse(f.updatedAt) > days * 86_400_000) continue;
    const ref = escalationRef(s.conversation);
    const line = { ref, workId: w.id, followId: f.id, conversation: s.conversation, threadId: s.threadId, closedAt: f.updatedAt, outcome: f.outcome ?? '', title: w.title };
    const was = out.get(ref);
    if (!was || Date.parse(line.closedAt) > Date.parse(was.closedAt)) out.set(ref, line);
  }
  return [...out.values()].sort((a, b) => a.closedAt.localeCompare(b.closedAt));
}
