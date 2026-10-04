// The ledger cleanup's rules (docs/orchestrators.md, "Ledger cleanup"): which pull requests belong to a request, when a
// merge ends it, what a worker's final report says, how a worker was cut off, and which requests have gone quiet. All
// pure: server/ledgerSweep.ts gathers the facts and applies the result.
import type { SessionInfo, WorkItem, WorkPr } from '../shared/types.ts';
import type { Config } from './config.ts';
import { mergedText } from './mergedIntake.ts';

export interface CleanupSettings {
  enabled: boolean;
  everyHours: number;
  /** GitHub owner/name repos whose pull requests are linked to requests; undefined: the game repo and this app's own. */
  repos?: string[];
}

/** config.json "ledger.cleanup": on every 4 hours unless set otherwise (1 to 168 hours). */
export function cleanupSettings(cfg: Pick<Config, 'ledger'>): CleanupSettings {
  const c = cfg.ledger?.cleanup ?? {};
  const hours = Number(c.everyHours);
  return {
    enabled: c.enabled !== false,
    everyHours: Number.isFinite(hours) && hours >= 1 ? Math.min(168, hours) : 4,
    ...(Array.isArray(c.repos) ? { repos: c.repos.filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)) } : {}),
  };
}

/** Quiet this long, with no running worker, before a request counts as stalled (Lothsahn, w306: 24 hours). */
export const STALL_AFTER_MS = 24 * 3_600_000;
/** A worker's last report is left alone this long before a request is closed on it: the person may still be talking to it. */
export const REPORT_QUIET_MS = 60 * 60_000;

/** A pull request as the sweep sees it, from gh. */
export interface PrRecord {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
  sha?: string;
}

/** The `Request: w293` lines of a PR description: the ledger requests it says it is for. */
export function requestIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/^\s*Request:\s*(w\d+)\b/gim)].map((m) => m[1].toLowerCase()))];
}

/** `https://github.com/<owner>/<name>/pull/<n>` links in text a worker wrote. */
export function prUrlsIn(text: string): { repo: string; number: number }[] {
  return [...text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)].map((m) => ({ repo: m[1], number: Number(m[2]) }));
}

const SHARED_BRANCH = /^(develop|master|main|release\/.*)$/;

/** A PR a worker opened itself: its `gh pr create` printed the URL, at this time. */
export interface OpenedPr {
  repo: string;
  number: number;
  at: string;
}

export type LinkedPr = PrRecord & { via: NonNullable<WorkPr['via']> };

/**
 * Which of several requests a worker's work at time `at` belongs to: the latest one filed by then. A worker that does
 * requests one after another (w314, then w324) opens each one's PRs for the request it was on, never the earlier one's.
 */
export function ownerAt<T extends Pick<WorkItem, 'id' | 'createdAt'>>(requests: readonly T[], at: string): T | undefined {
  return requests.filter((r) => r.createdAt <= at).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id, 'en', { numeric: true }))[0];
}

/**
 * The pull requests that belong to a request, on strong evidence only (w340): its description has `Request: <id>`; the
 * request's own worker opened it while working on that request (`ctx.opened`, already limited to what this request owns),
 * after the request was filed; or its head branch is the request's own branch (an intake request's `ffbox/...`).
 * Never from related ids, from PR numbers a brief or a report mentions, from a worker or sandbox the request merely shares,
 * or for a PR that merged before the request was filed. A PR that says it is for another request is not this one's.
 */
export function prsOf(w: WorkItem, all: readonly PrRecord[], ctx: { opened: readonly OpenedPr[] }): LinkedPr[] {
  const mine = new Set([w.id, ...(w.mergedInto ? [w.mergedInto] : [])]);
  const branch = w.source?.branch && !SHARED_BRANCH.test(w.source.branch) ? w.source.branch : undefined;
  const out: LinkedPr[] = [];
  for (const p of all) {
    if (p.state === 'merged' && p.mergedAt && p.mergedAt < w.createdAt) continue;
    const says = requestIdsIn(p.body);
    let via: LinkedPr['via'] | undefined;
    if (says.length) via = says.some((id) => mine.has(id)) ? 'line' : undefined;
    else if (ctx.opened.some((o) => o.number === p.number && o.repo.toLowerCase() === p.repo.toLowerCase()) && p.createdAt >= w.createdAt) via = 'worker';
    else if (branch && p.head === branch) via = 'branch';
    if (via) out.push({ ...p, via });
  }
  return out;
}

/** Merge a request's stored PRs with what gh says now (gh wins on state; a stored PR gh no longer lists keeps its last state). */
export function mergePrs(stored: readonly WorkPr[], found: readonly (PrRecord & { via?: WorkPr['via'] })[]): WorkPr[] {
  const out = new Map<string, WorkPr>();
  // A link made before w340 carries no `via`: it only stays when the strict rules find it again.
  for (const p of stored.filter((x) => x.via)) out.set(`${p.repo.toLowerCase()}#${p.number}`, p);
  for (const f of found) {
    const key = `${f.repo.toLowerCase()}#${f.number}`;
    const was = out.get(key);
    out.set(key, {
      repo: f.repo,
      number: f.number,
      url: f.url,
      title: f.title.slice(0, 200),
      head: f.head,
      state: f.state,
      ...(f.via ? { via: f.via } : was?.via ? { via: was.via } : {}),
      ...(f.state === 'merged' ? { at: f.mergedAt, ...(f.sha ? { sha: f.sha } : {}) } : f.state === 'closed' ? { at: f.closedAt } : {}),
      ...(was?.noted && was.state === f.state ? { noted: was.noted } : {}),
    });
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------- what is left after a merge

const RELEASE = /\b(ci-release|patch notes|bundleVersion|release)\b/i;
const PEER_CHECK = /\b(2|two)[- ]peers?\b|\bpaired (determinism )?audit\b|determinism-audit|\bpost-merge\b|\bafter (it|the pr|the merge|merging)\b[^.\n]{0,40}\b(merges?|merged|lands?|landed|check|verify|test|run|watch|audit)\b|\bonce (it'?s |the pr is )?merged\b/i;
const PLAN = /\bPR ?([1-9])\b[^]*\bPR ?([2-9])\b|\b(phase|part|step|stage) ?\d+ (of|\/) ?\d+\b|\bstacked (prs?|pull requests)\b|\bin (two|three|four|2|3|4) (prs?|pull requests|steps|phases)\b/i;
const MORE_COMING = /\b(more (is |are )?coming|second pr|next pr|follow-?up pr|follow-?ups?|remaining (steps?|work|items?)|still (needs?|to do|have to|open)|next steps?|will (then )?(open|file|do|follow|post|send)|not yet|todo|to do next|left to do|waiting (for|on)|blocked)\b/i;

/** Whether the request is a release (its work ends when the build is live and the patch notes are posted). */
export const isRelease = (w: Pick<WorkItem, 'title' | 'brief'>) => RELEASE.test(w.title) || /\bpatch notes\b|\/ff-agents:ci-release\b/i.test(w.brief);

/**
 * What is still left after a PR of this request merged, in words, or undefined when nothing is: a release is done when
 * its build is live and its notes are posted; a request that asks for a check after the merge (a 2-peer run) or plans
 * several PRs is not done by one; nor is one whose worker's last report says more is coming or waits on someone.
 */
export function afterMergeReason(w: Pick<WorkItem, 'title' | 'brief' | 'constraints' | 'question' | 'flag'>, reports: readonly string[]): string | undefined {
  if (w.question) return 'it waits on a question';
  if (w.flag) return 'it waits on a design question';
  const brief = `${w.title}\n${w.brief}\n${w.constraints ?? ''}`;
  if (isRelease(w)) return 'a release ends when the build is live and the patch notes are posted';
  if (PEER_CHECK.test(brief)) return 'its brief asks for a step after the merge (a check, an audit, a verification)';
  if (PLAN.test(brief)) return 'its brief plans more than one PR';
  const last = reports.map((r) => r.slice(-700)).find((r) => MORE_COMING.test(r));
  if (last) return `its worker's last report says more is coming: "${last.trim().slice(-160).replace(/\s+/g, ' ')}"`;
  return undefined;
}

/** "merged as #9 (abc123def456) on 2026-10-03", from the PR that merged last. */
export function prMergedText(p: WorkPr): string {
  return mergedText({ number: p.number, sha: p.sha, at: p.at });
}

// ---------------------------------------------------------------- a worker's final report

const DONE_STATEMENT = /(^|\n)\s*[*_#>\s-]*(done|delivered|complete[d]?|finished|all done)\b|\b(is|are|was|were|now|has been|have been) (done|complete[d]?|delivered|finished|merged|live|posted|published|sent)\b|\bnothing (more|else|left) to do\b|\bno further (work|steps?|action)\b/i;
const NOT_DONE = /\b(blocked|waiting (for|on)|needs? (your|a|an|the) (decision|input|approval|answer|confirmation)|could(n'?t| not)|cannot|can'?t|unable|failed|errors?|still (needs?|to|have|open)|remaining|next steps?|follow-?ups?|todo|not yet|pending|question|please (decide|confirm|tell|let)|let me know)\b/i;
const NOTES_POSTED = /discord\.com\/channels\/\d+\/\d+\/\d+/;

/**
 * What a worker's final report says about its request: `delivered` when it states plainly that the work is done, with
 * nothing left, waiting or asked; `more` when it says something is left or waits; otherwise `unsure`. Only `delivered`
 * closes a request. A release's report must also link the posted patch notes.
 */
export function reportVerdict(report: string | undefined, release = false): 'delivered' | 'more' | 'unsure' {
  const text = (report ?? '').trim();
  if (!text) return 'unsure';
  const tail = text.slice(-700);
  if (NOT_DONE.test(tail) || /\?\s*$/.test(tail)) return 'more';
  if (!DONE_STATEMENT.test(tail)) return 'unsure';
  if (release && !(NOTES_POSTED.test(tail) && /\b(live|landed)\b/i.test(tail))) return 'unsure';
  return 'delivered';
}

// ---------------------------------------------------------------- how a worker was cut off

const LIMIT = /(usage|session|weekly|rate|plan)[ -]limit|hit your limit|limit (reached|resets?)|resets? (at|in|on) \d|too many requests|overloaded|429/i;
const REFUSED = /permission (was )?denied|was denied|denied by|refused|not allowed|blocked by (the )?(guard|hook|rule)|guard:/i;

export type CutOff = { kind: 'limit' | 'restart' | 'refused'; reason: string };

/**
 * Whether a worker that is not running stopped for a reason a resume could fix: a usage or rate limit, an app restart
 * (its turn was still open when its process ended), or a refused tool (which would refuse again). `evidence` is its
 * status detail and the text of its last few events.
 */
export function cutOffOf(s: Pick<SessionInfo, 'status' | 'statusDetail' | 'turnOpenSince'>, evidence: readonly string[]): CutOff | undefined {
  if (s.status !== 'stopped' && s.status !== 'error') return undefined;
  const text = [s.statusDetail ?? '', ...evidence].join('\n');
  const clip = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (LIMIT.test(text)) return { kind: 'limit', reason: `stopped on a usage or rate limit: ${clip(text.split('\n').find((l) => LIMIT.test(l)) ?? text)}` };
  if (REFUSED.test(text)) return { kind: 'refused', reason: `stopped on a refused tool: ${clip(text.split('\n').find((l) => REFUSED.test(l)) ?? text)}` };
  if (/restart/i.test(s.statusDetail ?? '') || (s.turnOpenSince && s.status === 'stopped')) return { kind: 'restart', reason: 'its turn was cut off by an app restart' };
  return undefined;
}

// ---------------------------------------------------------------- gone quiet, and covered by newer work

/** A request nothing is working on: new, queued or active, with no one's question, approval or design call pending. */
export function stallCandidate(w: WorkItem): boolean {
  if (!['new', 'queued', 'active'].includes(w.status)) return false;
  if (w.approval?.state === 'pending' || w.question || w.flag) return false;
  return true;
}

/** The finished request that probably covers an old one: a newer finished release for a release, else a strong overlap. */
export function supersededBy(w: WorkItem, finished: readonly WorkItem[], strong: readonly { ref: string }[]): WorkItem | undefined {
  const newer = finished.filter((y) => y.status === 'done' && y.id !== w.id && y.updatedAt > w.createdAt);
  if (isRelease(w)) {
    const y = newer.filter((x) => isRelease(x) && x.createdAt > w.createdAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (y) return y;
  }
  for (const o of strong) {
    const y = newer.find((x) => x.id === o.ref);
    if (y) return y;
  }
  return undefined;
}
