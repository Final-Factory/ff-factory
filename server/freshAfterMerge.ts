// A fresh session after each merged pull request, a one-day pilot (w2043, lothsahn: "Do a pilot for one day"; docs/spend.md
// "A fresh session after each merge, a pilot"). w2008 measured that most of a worker session's cost lands after its first
// push: the context keeps growing while it waits on CI, merges and takes the next step. In the pilot arm a worker whose
// request had a pull request merge during its session is not resumed with that context: the next message it would get (a CI
// or deploy resume, its own check-in, a person's or the dispatcher's word, the next request) starts a NEW session in the same
// sandbox and branch instead (Agents.startFreshSession), with a short hand-off of what merged and what is left: a compaction
// without the old context. Never mid-turn: only a message to a worker between turns is turned into a fresh session.
//
// The arm is drawn by a hash of the REQUEST id, apart from the other pilots' (autoCompact.ts inPilot: `early:`, `terse:`,
// `readchain:` hash session ids), so every session of a request is in one arm and spend compares per request.
// worker.freshAfterMergePilotPercent (default 0: off) is the arm's share.
import type { Config } from './config.ts';
import type { SessionInfo, WorkItem, WorkPr } from '../shared/types.ts';
import { inPilot } from './autoCompact.ts';
import { isOpen } from './work.ts';
import { isMidTurn } from './sessions.ts';
import { noteLine, type PriorNote } from './priorDecisions.ts';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The pilot's share of requests, in percent, when worker.freshAfterMergePilotPercent is not set: off. */
export const FRESH_AFTER_MERGE_DEFAULT_PERCENT = 0;

/** Said in the fresh session's first message, and in the request's log: scripts and the comparison read it. */
export const FRESH_AFTER_MERGE_MARK = 'Fresh session after a merge (pilot w2043)';

/** The pilot's share in force (config worker.freshAfterMergePilotPercent, 0-100; 0 is off). */
export function freshAfterMergePercent(cfg: Partial<Pick<Config, 'worker'>>): number {
  const v = cfg.worker?.freshAfterMergePilotPercent;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(100, v) : FRESH_AFTER_MERGE_DEFAULT_PERCENT;
}

/** The arm a request is in: 'pilot' or 'control', or undefined while the pilot is off. Stable: the same id always answers the same. */
export function freshAfterMergeArm(workId: string, cfg: Partial<Pick<Config, 'worker'>>): 'pilot' | 'control' | undefined {
  const p = freshAfterMergePercent(cfg);
  if (p <= 0) return undefined;
  return inPilot(`fresh:${workId.toLowerCase()}`, p) ? 'pilot' : 'control';
}

/** The pull requests of `w` that merged since `since` (an ISO time: the session's start), oldest first. */
export function mergedSince(w: Pick<WorkItem, 'prs'>, since: string): WorkPr[] {
  const from = Date.parse(since);
  if (!Number.isFinite(from)) return [];
  return (w.prs ?? []).filter((p) => p.state === 'merged' && (Date.parse(p.at ?? '') || 0) >= from).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

/**
 * Whether a message to this worker starts a fresh session instead (w2043): it is a worker between turns, it is on exactly one
 * open request, that request is in the pilot arm, and a pull request of it merged during this session. Returns the request and
 * what merged, or undefined (the message goes to the session as always).
 */
export function freshAfterMergeDue(s: Pick<SessionInfo, 'id' | 'kind' | 'status' | 'createdAt'>, items: Iterable<WorkItem>, cfg: Partial<Pick<Config, 'worker'>>): { w: WorkItem; merged: WorkPr[] } | undefined {
  if (s.kind !== 'worker' || isMidTurn(s) || freshAfterMergePercent(cfg) <= 0) return undefined;
  const open = [...items].filter((w) => isOpen(w) && w.sessionIds.includes(s.id));
  if (open.length !== 1) return undefined;
  const w = open[0];
  if (freshAfterMergeArm(w.id, cfg) !== 'pilot') return undefined;
  const merged = mergedSince(w, s.createdAt);
  return merged.length ? { w, merged } : undefined;
}

/**
 * Whether a session has had a pull request merge on any request it served, in the pilot arm (w2043): the dispatcher's next
 * request for it goes to a new session even when it is related (Agents' message_agent), as a request that continues does.
 */
export function mergedInSession(s: Pick<SessionInfo, 'id' | 'kind' | 'createdAt'>, items: Iterable<WorkItem>, cfg: Partial<Pick<Config, 'worker'>>): WorkItem | undefined {
  if (s.kind !== 'worker' || freshAfterMergePercent(cfg) <= 0) return undefined;
  return [...items].find((w) => (w.sessionIds.includes(s.id) || !!w.movedOff?.[s.id]) && freshAfterMergeArm(w.id, cfg) === 'pilot' && mergedSince(w, s.createdAt).length > 0);
}

/**
 * The hand-off the fresh session's first message opens with (w2043): the request, what merged, what is left (the old
 * session's last word on it) and the message that brought it. The branch and git state follow in the harness's handover
 * (work.ts handoverNote).
 */
export function freshAfterMergeText(w: Pick<WorkItem, 'id' | 'title' | 'outcome' | 'status'>, old: Pick<SessionInfo, 'id' | 'lastResult'>, merged: readonly WorkPr[], message: string, relatedNotes: readonly PriorNote[] = []): string {
  const prs = merged.map((p) => `${p.repo}#${p.number}${p.title ? ` "${clip(p.title, 80)}"` : ''} (merged ${(p.at ?? '').slice(0, 16).replace('T', ' ')} UTC${p.sha ? `, ${p.sha.slice(0, 10)}` : ''})`);
  const left = w.outcome ? clip(oneLine(w.outcome), 400) : old.lastResult ? clip(oneLine(old.lastResult), 400) : 'not said: read the request with read_work';
  return [
    `[FF Factory] ${FRESH_AFTER_MERGE_MARK}: ${w.id} "${clip(w.title, 100)}" goes on in this NEW session in the same sandbox and branch. Worker ${old.id} was on it until its pull request merged; that session has ended, and its conversation is not carried over (a compaction without the old context, to cut what a long context costs on every call).`,
    `Merged: ${prs.join('; ')}.`,
    `What is left, in that worker's last word: ${left}`,
    // w2085: d57b4ea5, w1958's fresh session, asked Ben for a look OK on a tooltip line he had decided in a note of 04:59.
    `Decisions already made: its people's notes, verbatim, follow the brief below ("Notes since it was filed")${relatedNotes.length ? ', and theirs on its related requests are here' : ''}. Read them before you ask anyone anything: a question they settle is not asked (w2085; Ben, 2026-10-24: "you keep asking me questions i already answered"), and a UI change whose content they decided (their wording or behaviour as plain text in an existing component, nothing else moved) merges on green with no look OK.`,
    ...relatedNotes.map((n) => noteLine(n, w.id)),
    `Read the request (read_work ${w.id}) and the branch's git log for anything more before you act; do not redo research the merged work already settled. The message that brought this session:`,
    '~~~text',
    message.trim(),
    '~~~',
  ].join('\n');
}
