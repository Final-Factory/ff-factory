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

const idsOn = (text: string, re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => m[1].toLowerCase()))];

/** The `Request: w293` and `Part of: w293` lines of a PR description: the ledger requests it says it is for. */
export function requestIdsIn(text: string): string[] {
  return idsOn(text, /^\s*(?:Request|Part of):\s*(w\d+)\b/gim);
}

/**
 * The requests a PR says it is one step of, with a `Part of: w424` line (w424): linked like a `Request:` line, but its
 * merge leaves them open for what follows (another PR, a deploy, a check), until a `Request:` PR of theirs merges or
 * their worker reports `DONE: <id>`. A `Request:` line for the same request wins.
 */
export function partOfIdsIn(text: string): string[] {
  const full = new Set(idsOn(text, /^\s*Request:\s*(w\d+)\b/gim));
  return idsOn(text, /^\s*Part of:\s*(w\d+)\b/gim).filter((id) => !full.has(id));
}

/** Why a request stays open after a merge because its last merged PR said `Part of: <id>`, or undefined. */
export function partOfReason(id: string, prs: readonly WorkPr[]): string | undefined {
  const last = prs.filter((p) => p.state === 'merged').sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).at(-1);
  return last?.partOf ? `PR #${last.number} is one step of it (its description says Part of: ${id}); more follows` : undefined;
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

export type LinkedPr = PrRecord & { via: NonNullable<WorkPr['via']>; partOf: boolean };

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
    if (via) out.push({ ...p, via, partOf: via === 'line' && partOfIdsIn(p.body).some((id) => mine.has(id)) });
  }
  return out;
}

/** Merge a request's stored PRs with what gh says now (gh wins on state; a stored PR gh no longer lists keeps its last state). */
export function mergePrs(stored: readonly WorkPr[], found: readonly (PrRecord & { via?: WorkPr['via']; partOf?: boolean })[]): WorkPr[] {
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
      // A link found now says whether it is `Part of:`; a PR only looked up by number keeps what its link said.
      ...((f.via ? f.partOf : was?.partOf) ? { partOf: true } : {}),
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

const DONE_STATEMENT = /(^|\n)\s*[*_#>\s-]*(done|delivered|complete[d]?|finished|all done)\b|\b(is|are|was|were|now|has been|have been) (done|complete[d]?|delivered|finished|merged|live|posted|published|sent|fixed)\b|\bnothing (more|else|left) to do\b|\bno further (work|steps?|action)\b|\b(fully |already )?merged (in)?to (develop|main|master)\b|\bso I'?m idle\b|\bnothing (is |was )?(still )?(open|pending)( or (open|pending))?\b/i;
/** Phrases that say nothing is left, which NOT_DONE's words (open, pending) would otherwise read as work left (w363). */
const NOTHING_LEFT = /\bnothing (is |was )?(still )?(open|pending|left)( or (open|pending))?\b|\bno (open|pending) (PRs?|work|questions?|steps?)\b/gi;
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
  if (NOT_DONE.test(tail.replace(NOTHING_LEFT, '')) || /\?\s*$/.test(tail)) return 'more';
  if (!DONE_STATEMENT.test(tail)) return 'unsure';
  if (release && !(NOTES_POSTED.test(tail) && /\b(live|landed)\b/i.test(tail))) return 'unsure';
  return 'delivered';
}

// ---------------------------------------------------------------- how a worker was cut off

const LIMIT = /(usage|session|weekly|rate|plan)[ -]limit|hit your limit|limit (reached|resets?)|resets? (at|in|on) \d|too many requests|overloaded|429/i;
const REFUSED = /permission (was )?denied|was denied|denied by|refused|not allowed|blocked by (the )?(guard|hook|rule)|guard:/i;

export type CutOff = { kind: 'limit' | 'restart' | 'refused'; reason: string };

/** A turn whose whole result is Claude's limit line ("You've hit your session limit · resets 7pm"). */
const LIMIT_END = /^\W*(you'?ve (hit|reached) your (\w+[ -])?limit|(claude )?(usage|session|weekly) limit (reached|hit))/i;

/**
 * Whether a worker that is not running stopped for a reason a resume could fix: a usage or rate limit, an app restart
 * (its turn was still open when its process ended), or a refused tool (which would refuse again). `evidence` is its
 * status detail and the text of its last few events.
 */
export function cutOffOf(s: Pick<SessionInfo, 'status' | 'statusDetail' | 'turnOpenSince'> & { lastResult?: string }, evidence: readonly string[]): CutOff | undefined {
  // A usage limit ends the turn normally (idle) with only Claude's limit line as its result (w363: w17, w34, w36, w83, w93
  // said "You've hit your session/weekly limit" and nothing resumed or stalled them).
  const limitEnd = s.status === 'idle' && LIMIT_END.test((s.lastResult ?? '').trim());
  if (s.status !== 'stopped' && s.status !== 'error' && !limitEnd) return undefined;
  if (limitEnd) return { kind: 'limit', reason: `stopped on a usage or rate limit: ${(s.lastResult ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}` };
  const text = [s.statusDetail ?? '', ...evidence].join('\n');
  const clip = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (LIMIT.test(text)) return { kind: 'limit', reason: `stopped on a usage or rate limit: ${clip(text.split('\n').find((l) => LIMIT.test(l)) ?? text)}` };
  if (REFUSED.test(text)) return { kind: 'refused', reason: `stopped on a refused tool: ${clip(text.split('\n').find((l) => REFUSED.test(l)) ?? text)}` };
  if (/restart/i.test(s.statusDetail ?? '') || (s.turnOpenSince && s.status === 'stopped')) return { kind: 'restart', reason: 'its turn was cut off by an app restart' };
  return undefined;
}

// ---------------------------------------------------------------- DONE: wNNN (w419)

/**
 * The requests a worker's report says are finished: lines that are only `DONE: w342` (markdown around it allowed), one
 * request per line, several lines allowed. A mention inside a sentence ("reply DONE: w342") is not one.
 */
export function doneIdsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').matchAll(/^[\s*_>`-]*DONE:?\s+(w\d+)[\s.`*_]*$/gim)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Words that say how a step after the merge went: a report that says DONE must cover it. */
const STEP_REPORTED = /\b(audit(ed)?|2-peer|two-peer|paired|verif(y|ied|ication)|checked|nightly|soak|no desyncs?|first[- ]hour|re-?ran|ran|passed|green|confirmed)\b/i;

/**
 * Why a worker's `DONE: <id>` cannot close this request yet, or undefined when it can: a pull request of it is still
 * open, a release whose report does not link the posted patch notes and say it is live, a step after the merge the
 * brief asks for that the report does not cover, or a brief that plans several PRs when fewer than two merged and the
 * report does not say they all did.
 */
export function doneProblem(w: Pick<WorkItem, 'title' | 'brief' | 'constraints' | 'prs'>, report: string): string | undefined {
  const open = (w.prs ?? []).find((p) => p.state === 'open');
  if (open) return `PR #${open.number} is still open: merge or close it first`;
  const brief = `${w.title}\n${w.brief}\n${w.constraints ?? ''}`;
  if (isRelease(w) && !(NOTES_POSTED.test(report) && /\b(live|landed)\b/i.test(report))) return 'a release is done when its build is live and its patch notes are posted: say it is live and link the posted notes';
  if (PEER_CHECK.test(brief) && !STEP_REPORTED.test(report)) return 'its brief asks for a step after the merge (a check, an audit, a verification): say in the report what it showed';
  const merged = (w.prs ?? []).filter((p) => p.state === 'merged').length;
  if (PLAN.test(brief) && merged < 2 && !/\b(all|both|every|the last|final) (of the )?(prs?|pull requests|parts|phases|steps|stages)\b/i.test(report)) return 'its brief plans more than one PR: say they have all merged';
  return undefined;
}

// ---------------------------------------------------------------- asking about a merged request (w419)

/** No word about a merged request this long, and the cleanup asks its worker whether it is done (see followUpDecision). */
export const FOLLOW_UP_QUIET_MS = 6 * 3_600_000;
/** At most one such question per request a day. */
export const FOLLOW_UP_EVERY_MS = 24 * 3_600_000;

export type FollowUp = { kind: 'ask'; worker: SessionInfo; why: string; quietHours: number } | { kind: 'stall'; why: string };

/**
 * When the cleanup may next ask about this merged request: 6 hours after the last word about it (its merge, a report
 * from a worker still on it, the last question), and a day after the last question.
 */
export function followUpDue(w: Pick<WorkItem, 'prs' | 'followUp'>, workers: readonly SessionInfo[], serving: (s: SessionInfo) => boolean): number {
  const asked = w.followUp ? Date.parse(w.followUp.at) || 0 : 0;
  const mergedAt = Math.max(0, ...(w.prs ?? []).filter((p) => p.state === 'merged').map((p) => Date.parse(p.at ?? '') || 0));
  const word = Math.max(mergedAt, asked, ...workers.filter(serving).map((s) => Date.parse(s.lastActivityAt) || 0));
  return Math.max(word + FOLLOW_UP_QUIET_MS, asked ? asked + FOLLOW_UP_EVERY_MS : 0);
}

/**
 * What the cleanup does about a request whose pull requests merged but which stays open for a step after the merge
 * (`reason`, afterMergeReason's): nothing while there was word about it in the last 6 hours (a report from a worker still
 * on it, the merge itself, or the last question) or it was asked in the last day; else ask its most recent worker
 * "Is it done?", or, when no worker is left to ask, stall it as follow-up unconfirmed. `serving` says whether a worker's
 * current turn is on this request (shared/workState.ts servedBy): a worker that moved on brings no word about it.
 */
export function followUpDecision(
  w: Pick<WorkItem, 'prs' | 'followUp'>,
  workers: readonly SessionInfo[],
  reason: string,
  now: number,
  serving: (s: SessionInfo) => boolean,
  canResume: boolean,
): FollowUp | undefined {
  const prs = w.prs ?? [];
  const merged = prs.filter((p) => p.state === 'merged');
  if (!merged.length || prs.some((p) => p.state === 'open')) return undefined;
  if (now < followUpDue(w, workers, serving)) return undefined;
  const asked = w.followUp ? Date.parse(w.followUp.at) || 0 : 0;
  const mergedAt = Math.max(0, ...merged.map((p) => Date.parse(p.at ?? '') || 0));
  const word = Math.max(mergedAt, asked, ...workers.filter(serving).map((s) => Date.parse(s.lastActivityAt) || 0));
  const quietHours = Math.floor((now - word) / 3_600_000);
  const worker = [...workers].filter((s) => s.status !== 'error').sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  if (!worker || !canResume) return { kind: 'stall', why: `follow-up unconfirmed: ${reason}, no word for ${quietHours} h, and ${worker ? 'this server cannot resume its worker' : 'no worker is left to ask'}` };
  return { kind: 'ask', worker, why: reason, quietHours };
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
