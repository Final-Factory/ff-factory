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
  return !!(w.autoClosed?.sha || w.autoClosed?.by || fixedByPr(w.outcome));
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
