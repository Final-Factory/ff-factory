// Closing intake requests whose work already merged (docs/intake.md, "Closed when it merged"). The rules are pure:
// what counts as merged evidence for a request, from the commits on the base branches, the merged PRs, and the
// other requests in the ledger. server/intake.ts gathers the evidence; Orchestrators.closeMerged applies it.
import type { WorkAutoClosed, WorkItem } from '../shared/types.ts';
import { WORK_OPEN } from '../shared/types.ts';

/** One merge on a base branch: a merged PR (from gh) or a commit (from git log): where its text names things. */
export interface MergeRecord {
  sha: string;
  /** ISO time it merged. */
  at: string;
  number?: number;
  /** The PR's head branch, when gh said. */
  head?: string;
  /** Title and body, or the commit subject and body. */
  text: string;
}

/** Intake kinds whose request is a review or a player report; an operator's dev request is theirs to close, a release or nightly request is not about a merge. */
const KINDS: readonly string[] = ['discord-bug', 'discord-request', 'ffbox-branch', 'ffbox-diagnosis', 'ffbox-request'];

/**
 * The requests that may close because their work merged: intake requests nobody works on yet (a worker on one closes it
 * with its own marker), whether or not a person approved them.
 */
export function mergeCandidates(items: Iterable<WorkItem>): WorkItem[] {
  return [...items].filter((w) => w.source && KINDS.includes(w.source.kind) && !w.recorded && WORK_OPEN.includes(w.status) && w.status !== 'active' && !w.sessionIds.length);
}

/** `git log --format=%H%x1f%cI%x1f%s%x1f%b%x1e` read back. */
export function parseLog(raw: string): MergeRecord[] {
  const out: MergeRecord[] = [];
  for (const chunk of raw.split('\x1e')) {
    const [sha, at, subject = '', body = ''] = chunk.replace(/^\s+/, '').split('\x1f');
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) continue;
    out.push({ sha, at: at ?? '', number: prNumberOf(subject), text: `${subject}\n${body}` });
  }
  return out;
}

/** "Merge pull request #946 from …" and "Fix the belts (#946)". */
export function prNumberOf(subject: string): number | undefined {
  const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject.split('\n')[0]);
  return m ? Number(m[1]) : undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a text names a branch ("from Final-Factory/ffbox/x", "ffbox/x"), not a longer name that starts with it. */
export function namesBranch(text: string, branch: string): boolean {
  return new RegExp(`(?<![\\w.-])${escapeRe(branch)}(?![\\w-]|\\.\\w)`).test(text);
}

/** The Discord threads a PR or commit carries as `Discord: https://discord.com/channels/<guild>/<thread>` lines. */
export function discordThreadsIn(text: string): string[] {
  return [...text.matchAll(/^\s*Discord:\s*https:\/\/discord\.com\/channels\/\d+\/(\d+)/gim)].map((m) => m[1]);
}

/** The Discord threads a request came from: its own and the ones merged into it. */
export function threadsOf(w: Pick<WorkItem, 'source' | 'ffboxDev'>): string[] {
  const s = w.source;
  return [...new Set([s?.threadId, ...(s?.alsoThreads ?? []).map((t) => t.threadId), ...(w.ffboxDev ?? []).map((d) => d.threadId)].filter((x): x is string => !!x))];
}

export const dayOf = (iso: string) => iso.slice(0, 10);

/** "merged as #946 (abc123def456) on 2026-10-03". */
export function mergedText(m: { number?: number; sha?: string; at?: string; base?: string }): string {
  return `merged ${m.number ? `as #${m.number}` : `into ${m.base ?? 'the base branch'}`}${m.sha ? ` (${m.sha.slice(0, 12)})` : ''}${m.at ? ` on ${dayOf(m.at)}` : ''}`;
}

/**
 * Whether a merge on a base branch is this request's: its PR number, a PR or commit that names its branch (a merge, a
 * squash or a cherry-pick whose message says where it came from), or one that carries its Discord thread in the
 * `Discord:` line every fix PR has. The newest record wins.
 */
export function mergedBy(w: WorkItem, records: readonly MergeRecord[]): WorkAutoClosed | undefined {
  const s = w.source;
  if (!s) return undefined;
  const threads = threadsOf(w);
  for (const r of records) {
    let how: WorkAutoClosed['how'] | undefined;
    if (s.pr && r.number === s.pr) how = 'pr';
    else if (s.branch && (r.head === s.branch || namesBranch(r.text, s.branch))) how = 'branch';
    else if (threads.length && discordThreadsIn(r.text).some((t) => threads.includes(t))) how = 'thread';
    if (!how) continue;
    return { at: '', how, ...(r.number ? { pr: r.number } : {}), sha: r.sha, mergedAt: r.at, text: mergedText({ number: r.number, sha: r.sha, at: r.at }) };
  }
  return undefined;
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A request linked to this one that is done: named in either one's related ids, on the same PR or branch, or on the same
 * Discord thread. "Done" only: a rejected, cancelled or merged-into request says nothing about this one's work.
 */
export function linkedDone(w: WorkItem, all: Iterable<WorkItem>): WorkItem | undefined {
  const mine = threadsOf(w);
  const specific = w.keys.filter((k) => /^(pr|branch):/.test(k));
  for (const y of all) {
    if (y.id === w.id || y.status !== 'done') continue;
    if ((w.relatedIds ?? []).some((r) => sameId(r, y.id)) || (y.relatedIds ?? []).some((r) => sameId(r, w.id))) return y;
    if (specific.some((k) => y.keys.includes(k))) return y;
    if (mine.length && threadsOf(y).some((t) => mine.includes(t))) return y;
  }
  return undefined;
}

export function linkedClosed(w: WorkItem, y: WorkItem): WorkAutoClosed {
  return { at: '', how: 'linked', by: y.id, text: `covered by ${y.id} "${y.title.slice(0, 80)}", which is done` };
}
