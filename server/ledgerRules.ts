// The ledger cleanup's rules (docs/orchestrators.md, "Ledger cleanup"): which pull requests belong to a request, when a
// merge ends it, what a worker's final report says, how a worker was cut off, and which requests have gone quiet. All
// pure: server/ledgerSweep.ts gathers the facts and applies the result.
import type { SessionInfo, TranscriptEvent, WorkErrorHandled, WorkItem, WorkPr } from '../shared/types.ts';
import type { Config } from './config.ts';
import { requestWaitOf } from '../shared/workState.ts';
import { mergedText } from './mergedIntake.ts';
import { afterReopen, doneOf } from './work.ts';

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

/**
 * The requests a PR's title names as its own (w631): a leading "w165: …", "w604/w556: …" or "w605 (1): …", or a title
 * that ends in its ids alone, "… (w184)", "… (w197/w214)". 407 of the 606 PRs of both repos name a request in their
 * title, and the PRs from before the `Request:` line (w293) only there: Ben's w150–w214 sat stalled for days with every
 * PR merged. A request named inside other words ("(w170 diagnostics)", "since w170", "w292 index-shift regression") is
 * not one. `part`: the title says it is a step, not the whole (a numbered part, a plan, docs only, diagnostics, a
 * follow-up, a draft), so its merge leaves the request open like `Part of:`.
 */
export function titleIdsIn(title: string): { ids: string[]; part: boolean } {
  const ids = new Set<string>();
  const list = (s: string) => s.split(/\s*[/,&+]\s*/).map((x) => x.trim().toLowerCase());
  const lead = /^\s*((?:w\d+\s*[/,&+]\s*)*w\d+)\s*(\(\s*\d+\s*\))?\s*:/i.exec(title);
  if (lead) for (const id of list(lead[1])) ids.add(id);
  const tail = /\(\s*((?:w\d+\s*[/,&+]\s*)*w\d+)\s*\)\s*$/i.exec(title);
  if (tail) for (const id of list(tail[1])) ids.add(id);
  const part = !!lead?.[2] || /\b(plan|docs only|design|investigation|diagnostics|follow-?up|draft|part \d|step \d|phase \d|do not merge)\b/i.test(title);
  return { ids: [...ids], part };
}

/** Why a request stays open after a merge because its last merged PR said `Part of: <id>`, or undefined. */
export function partOfReason(id: string, prs: readonly WorkPr[]): string | undefined {
  const last = prs.filter((p) => p.state === 'merged').sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).at(-1);
  return last?.partOf ? `PR #${last.number} is one step of it (${last.via === 'title' ? 'its title marks it a step' : `its description says Part of: ${id}`}); more follows` : undefined;
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
    // A reopened request (w731): a PR created before the reopen is not the reopened work's, whatever it says or who opened it.
    if (!afterReopen(w, p.createdAt)) continue;
    const says = requestIdsIn(p.body);
    let via: LinkedPr['via'] | undefined;
    if (says.length) via = says.some((id) => mine.has(id)) ? 'line' : undefined;
    else if (ctx.opened.some((o) => o.number === p.number && o.repo.toLowerCase() === p.repo.toLowerCase()) && p.createdAt >= w.createdAt) via = 'worker';
    else if (branch && p.head === branch) via = 'branch';
    // Its title names it (w631): also when its description says it is for another request ("w604/w556: …", Request: w604).
    const titled = via ? undefined : titleIdsIn(p.title);
    if (titled?.ids.some((id) => mine.has(id))) via = 'title';
    if (via) out.push({ ...p, via, partOf: via === 'title' ? titled!.part : via === 'line' && partOfIdsIn(p.body).some((id) => mine.has(id)) });
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

/**
 * A release request's title (w515): it cuts, ships or tags a release, names the build it releases ("Release 0.50.0.74",
 * "Release Build 79", "Hotfix release 0.50.0.55"), or posts its notes. A title that merely says "release" ("the release
 * pipeline", "Release-readiness check", "until the new release is verified") is not one.
 */
const RELEASE_TITLE = /\bci-release\b|\bbundleVersion\b|^\W*((hotfix|develop|master|beta) )?release (\(?\d|build \d|v\d)|\b(cut|ship|tag)\b[^.;:\n]{0,24}\brelease\b(?!-)|\b(cut|ship|tag) (build |v)?\d+(\.\d+)*\b|\b(post|publish|write)\b[^;:\n]{0,30}\b(patch|release) notes\b/i;
/** A release request's brief: it runs ci-release, or asks for the patch notes to be posted. "Add a patch notes line" is not one (w487). */
const RELEASE_BRIEF = /\/ff-agents:ci-release\b|\b(post|publish)\b[^.\n]{0,30}\bpatch notes\b|\bpatch notes (are |get )?(posted|published)\b/i;
/**
 * A step the brief puts after the merge (w515): only where it says so ("post-merge", "after the merge, verify", "run a
 * 2-peer check after the merge", "audit it when it lands", "once merged, deploy", "merge, then deploy"). A 2-peer check or a paired audit in a
 * "Done when" list that ends "merge once green and verified" comes before the merge (w408, w411, w449, w454, w484, w489).
 */
const PEER_CHECK = /\bpost-merge\b|\bafter (it|the pr|the merge|merging)\b[^.\n]{0,40}\b(merges?|merged|lands?|landed|check|verify|test|run|watch|audit)\b|\bonce (it'?s |the pr is )?merged\b|\b(check|verify|test|run|watch|audit|confirm)\b[^.\n]{0,60}\b(after (the merge|merging|it merges|it'?s merged|it lands)|(when|once) (it|the pr) (lands|merges|is merged|has merged))\b|\b(then|and) deploy(ed)?\b/i;
const PLAN = /\bPR ?([1-9])\b[^]*\bPR ?([2-9])\b|\b(phase|part|step|stage) ?\d+ (of|\/) ?\d+\b|\bstacked (prs?|pull requests)\b|\bin (two|three|four|2|3|4) (prs?|pull requests|steps|phases)\b/i;
const MORE_COMING = /\b(more (is |are )?coming|second pr|next pr|follow-?up pr|follow-?ups?|remaining (steps?|work|items?)|still (needs?|to do|have to|open)|next steps?|will (then )?(open|file|do|follow|post|send)|not yet|todo|to do next|left to do|waiting (for|on)|blocked)\b/i;

/** Whether the request is a release (its work ends when the build is live and the patch notes are posted). */
export const isRelease = (w: Pick<WorkItem, 'title' | 'brief'> & Partial<Pick<WorkItem, 'prs'>>) =>
  releaseRun(w) || ((RELEASE_TITLE.test(w.title) || RELEASE_BRIEF.test(w.brief)) && !harnessOnly(w));

/** The repos of FF Factory and the agents' harness: a request whose every PR is in one changes tooling, not a build (w2446). */
const HARNESS_REPOS = new Set(['final-factory/ff-factory', 'final-factory/final-factory-agents', 'final-factory/finalfactory-agent-kit']);
/**
 * What the request did, over the words of its title (w2446; lothsahn, 2026-10-28: "Release detection should come from what
 * the request does (a release run), not from "release" or "patch notes" in its title"): a version bump PR of it (head
 * release/<n> or urgent/<v>, trigger-ci-release.sh) is a release run; PRs only in the harness repos are not (w2444, "Release
 * harness: post patch notes once live on development", ff-factory #740, was held for notes it never had to post).
 */
const releaseRun = (w: Partial<Pick<WorkItem, 'prs'>>) => (w.prs ?? []).some((p) => /^(urgent\/|release\/\d)/.test(p.head ?? ''));
const harnessOnly = (w: Partial<Pick<WorkItem, 'prs'>>) => !!w.prs?.length && w.prs.every((p) => HARNESS_REPOS.has(p.repo.toLowerCase()));

/**
 * What is still left after a PR of this request merged, in words, or undefined when nothing is: a release is done when
 * its build is live and its notes are posted; a request that asks for a check after the merge (a 2-peer run) or plans
 * several PRs is not done by one; nor is one whose worker's last report says more is coming or waits on someone.
 */
export function afterMergeReason(w: Pick<WorkItem, 'title' | 'brief' | 'constraints' | 'question' | 'flag' | 'legs'> & Partial<Pick<WorkItem, 'prs'>>, reports: readonly string[]): string | undefined {
  if (w.question) return 'it waits on a question';
  // w1863: w1789 merged two PRs while its m5 timing leg waited; the leg is work left, not a report's words.
  if (w.legs?.length) return `its leg${w.legs.length > 1 ? 's' : ''} for ${w.legs.map((l) => l.needs.join(' or ')).join(' and ')} ${w.legs.length > 1 ? 'are' : 'is'} queued and not started`;
  if (w.flag) return w.flag.kind === 'error' ? 'it waits on an escalated error' : 'it waits on a design question';
  const brief = `${w.title}\n${w.brief}\n${w.constraints ?? ''}`;
  if (isRelease(w)) return 'a release ends when the build is live and the patch notes are posted';
  if (PEER_CHECK.test(brief)) return 'its brief asks for a step after the merge (a check, an audit, a verification)';
  if (PLAN.test(brief)) return 'its brief plans more than one PR';
  const last = reports.map((r) => r.slice(-700)).find((r) => MORE_COMING.test(r));
  if (last) return `its worker's last report says more is coming: "${last.trim().slice(-160).replace(/\s+/g, ' ')}"`;
  return undefined;
}

// ---------------------------------------------------------------- a deploy after the merge (w631)

/** A sentence about deploying this app after the merge: the portal (fffctl update, ops_worker deploy) or the machines' daemons. */
const DEPLOY_SENTENCE = /\b(re)?deploy(s|ed|ing|ment)?\b|\bfffctl update\b|\b(worker|machine|daemon)s?'? (update|install|reinstall)s?\b|\bupdate (the |each |every |all )?(worker |enrolled )?(machines?|workers?|daemons?)\b|\b(re)?install(ed|s)? on (the |each |every |all )?(machines?|workers?)\b/i;
/** Steps that are not a deploy even when the same sentence names one: a sentence with these is never set aside. */
const OTHER_STEP = /\b(audit(ed|s)?|2-peer|two-peer|paired|nightly|soak|release notes|patch notes|ci-release)\b/i;
/** The deploy step names the worker machines (their daemons must run the merge too). */
const MACHINE_STEP = /\b(worker|machine|daemon)s?'? (update|install|reinstall)s?\b|\bupdate (the |each |every |all )?(worker |enrolled )?(machines?|workers?|daemons?)\b|\b(re)?install(ed|s)? on (the |each |every |all )?(machines?|workers?)\b|--update\b|-Update\b/i;
/** The deploy step names the portal itself. */
const PORTAL_STEP = /\bportal\b|\bfffctl update\b|\bops_worker deploy\b|\bthe app\b/i;

const sentences = (t: string) => t.split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim());

/**
 * What deploys a request still waits on when a deploy is the only step left after its merge (w631: w605, w513, w537 and
 * w600 stayed open after their PRs merged, the brief or the last report naming a portal deploy or machine updates, which
 * then happened through the ops worker or by hand while nothing told the ledger), or undefined: nothing is left, or
 * something besides a deploy is (afterMergeReason still finds a reason once the sentences about deploying are set aside).
 * `portal`: this app's portal must run the merge; `machines`: every connected worker machine's daemon too.
 */
export function deployStep(w: Pick<WorkItem, 'title' | 'brief' | 'constraints' | 'question' | 'flag' | 'legs'> & Partial<Pick<WorkItem, 'prs'>>, reports: readonly string[]): { portal: boolean; machines: boolean } | undefined {
  if (w.question || w.flag || w.legs?.length || isRelease(w)) return undefined;
  if (!afterMergeReason(w, reports)) return undefined;
  const aside: string[] = [];
  const strip = (t: string) =>
    sentences(t)
      .filter((s) => {
        if (!DEPLOY_SENTENCE.test(s) || OTHER_STEP.test(s)) return true;
        aside.push(s);
        return false;
      })
      .join(' ');
  const rest = { title: strip(w.title), brief: strip(w.brief), constraints: strip(w.constraints ?? '') };
  // Each report as afterMergeReason reads it: its last 700 characters.
  const tails = reports.map((r) => strip(r.slice(-700)));
  if (!aside.length || afterMergeReason(rest, tails)) return undefined;
  const text = aside.join(' ');
  const machines = MACHINE_STEP.test(text);
  return { portal: PORTAL_STEP.test(text) || !machines, machines };
}

/** A check, after "then" or "after the deploy", that the worker says it does itself once the deploy has happened. */
const THEN_CHECK = /\bthen\b[^.;\n]{0,40}?\b(verify|verifies|check|checks|confirm|confirms|test|tests|watch|read|reads|show|shows|look|try|smoke)\b[^.\n]{0,140}/i;
const AFTER_DEPLOY_CHECK = /\b(?:after|once|when)\b[^.;\n]{0,40}\b(?:deploy\w*|goes live|is live|lands)\b[^.;\n]{0,30}?[,:]?\s*(?:I|it|the worker|we)?\s*(?:will |'ll )?(?:verify|check|confirm|test|watch|read|show|look|try|smoke)\b[^.\n]{0,140}/i;

/**
 * The step a worker's report puts after a deploy that the worker does itself ("waiting for the go-ahead for the portal
 * deploy ...; then I verify a live PR read and the health check", w889), or undefined. Only text after a mention of
 * deploying counts. Such a request is not finished when the deploy lands: its worker is resumed to do it (w890), and the
 * cleanup does not close the request on the deploy alone.
 */
export function postDeployStep(reports: readonly string[]): string | undefined {
  for (const r of reports) {
    const tail = r.slice(-700);
    const at = tail.search(DEPLOY_SENTENCE);
    if (at < 0) continue;
    const m = THEN_CHECK.exec(tail.slice(at)) ?? AFTER_DEPLOY_CHECK.exec(tail);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
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
export const LIMIT_END = /^\W*(you'?ve (hit|reached) your (\w+[ -])?limit|(claude )?(usage|session|weekly) limit (reached|hit))/i;

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

// ---------------------------------------------------------------- a last turn that ended in an error (w1870)

/** A turn the CLI ended with an error subtype instead of a report: its result reads "stopped: error_during_execution". */
const STOPPED_RESULT = /^stopped: (error_[a-z_]+)/;
/** A turn the API ended: its whole result is Claude Code's error line (w1733: "API Error: Can't reach the API server …"). */
const API_ERROR_RESULT = /^API Error\b/i;
/**
 * A tool the harness or a person refused, in the words Claude Code and the hooks use. Narrower than REFUSED: a failed
 * tool's own output ("connection refused") is no refusal, and a refusal is escalated at once (it would be refused again).
 */
const REFUSED_TOOL = /\bpermission (to use \S+ )?(was |has been )?denied\b|\bwas denied\b|\bdenied by\b|\bblocked by (the )?(guard|hook|rule)\b|\bguard:|\bhook error\b|\btool use was rejected\b/i;
/** The system line an interrupt leaves in a host session's transcript (AgentSession.interrupt). */
const INTERRUPTED = /^interrupted\.?$/i;
/** Errors only a person can clear, and what each needs (w1870, lothsahn: "escalated to an operator if the error can't be fixed"). */
const NEEDS_PERSON: readonly [RegExp, string][] = [
  [/\bnot logged in\b|\bplease run \/login\b|\binvalid api key\b|\bauthentication_error\b|\b(oauth|login) token (has )?expired\b|\bgh auth login\b/i, 'a login'],
  [/\bresource not accessible by (personal access|integration) token\b|\bwithout `?workflows?`? permission\b|\bpermission to \S+ denied to\b|\bmust have admin rights\b/i, 'a permission'],
  [/\b(machine|computer|daemon|agent host) (\S+ )?(is )?(offline|unreachable|not connected)\b|\bno agent host\b|\bdisk (is )?full\b|\bno space left on device\b/i, 'a machine'],
];

/**
 * How a worker's last turn ended, when not with a report (w1870): `interrupt`, stopped mid-turn on purpose by the
 * dispatcher or a person (interrupt_agent, stop_agent, the UI: SessionInfo.stoppedOnPurpose), which is no error; or
 * `error`: its turn ended in an error result (error_during_execution and the like), a usage or rate limit, an app restart,
 * a refused tool (cutOffOf), or the session itself failed. `needs` names what only a person can give (a login, a
 * permission, a machine), read in its failed tools' output (`tools`, toolErrors) too. `turnAt` tells one errored turn from
 * the next. Undefined for a turn that ended with a report.
 */
export type TurnTrouble =
  | { kind: 'interrupt'; reason: string; turnAt: string }
  | { kind: 'error'; cause: 'error' | 'limit' | 'restart' | 'refused' | 'crash'; reason: string; turnAt: string; needs?: string };

export function turnTroubleOf(
  s: Pick<SessionInfo, 'status' | 'statusDetail' | 'turnOpenSince' | 'stoppedOnPurpose' | 'lastActivityAt' | 'lastResultAt'> & { lastResult?: string },
  evidence: readonly string[],
  tools: readonly string[] = [],
): TurnTrouble | undefined {
  const result = (s.lastResult ?? '').trim();
  const stopped = STOPPED_RESULT.exec(result)?.[1] ?? (API_ERROR_RESULT.test(result) ? 'an API error' : undefined);
  const turnAt = s.lastResultAt ?? s.lastActivityAt;
  // A turn that ended with a report, and no turn open since, is no trouble whatever its words say: the report's own
  // "refused" or "limit" is not a refused tool or a cut-off (w1867's "`ff-pr merge` reported #562 as refused"). Only a
  // failed session is.
  const reported = !!result && !stopped && !LIMIT_END.test(result) && !s.turnOpenSince;
  if (reported && s.status !== 'error') return undefined;
  const text = [s.statusDetail ?? '', ...tools, ...evidence, result].join('\n');
  const needs = NEEDS_PERSON.find(([re]) => re.test(text))?.[1];
  const onPurpose = !!s.stoppedOnPurpose || evidence.some((e) => INTERRUPTED.test(e.trim()));
  if (stopped && onPurpose) return { kind: 'interrupt', reason: `its turn was interrupted on purpose (${stopped})`, turnAt };
  const cut = reported ? undefined : cutOffOf(s, evidence);
  if (cut) return { kind: 'error', cause: cut.kind, reason: cut.reason, turnAt, ...(needs ? { needs } : {}) };
  if (stopped) {
    const cause = LIMIT.test(text) ? 'limit' : REFUSED_TOOL.test(text) ? 'refused' : 'error';
    // The newest such line: the last few events can reach back into an earlier turn.
    const line = text.split('\n').findLast((l) => (cause === 'limit' ? LIMIT : cause === 'refused' ? REFUSED_TOOL : /\S/).test(l) && !STOPPED_RESULT.test(l.trim()));
    return { kind: 'error', cause, reason: `its last turn ended in ${stopped}${line ? `: ${line.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''}`, turnAt, ...(needs ? { needs } : {}) };
  }
  if (s.status === 'error') return { kind: 'error', cause: 'crash', reason: `its session failed${s.statusDetail ? `: ${s.statusDetail.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''}`, turnAt, ...(needs ? { needs } : {}) };
  return undefined;
}

/** The text of a worker's last few transcript events that can say how its turn ended (its errors, system lines, results, words). */
export const turnEvidence = (events: readonly TranscriptEvent[]) => events.flatMap((e) => (e.kind === 'error' || e.kind === 'system' || e.kind === 'result' || e.kind === 'assistant' ? [e.text] : []));
/** Its failed tools' output: what a person may have to give (a login, a permission), never a cut-off by itself. */
export const toolErrors = (events: readonly TranscriptEvent[]) => events.flatMap((e) => (e.kind === 'tool_result' && e.isError ? [e.text] : []));

/** The last error lines of a worker's transcript, for an escalation (w1870): its errors, system lines, failed tools and results. */
export const errorLinesOf = (events: readonly TranscriptEvent[], n = 3) =>
  events
    .filter((e) => e.kind === 'error' || e.kind === 'system' || (e.kind === 'result' && !e.ok && !STOPPED_RESULT.test(e.text.trim())) || (e.kind === 'tool_result' && e.isError))
    .slice(-n)
    .map((e) => (e as { text: string }).text.replace(/\s+/g, ' ').trim().slice(0, 240))
    .filter(Boolean);

/** Resumes for errors one worker gets on one request before the cleanup escalates instead (a different error each time). */
export const ERROR_RESUMES = 2;
/** An errored turn this fresh is left alone for now: the dispatcher or the worker's own check-in may be on it already. */
export const ERROR_SETTLE_MS = 10 * 60_000;

/** An error in a few words, to tell the same error again from a new one: no numbers, ids or times. */
export const errorKey = (reason: string) => {
  const [head, ...rest] = reason.toLowerCase().split(':');
  const words = rest.join(':').replace(/\b[0-9a-f]{7,}\b|\d+/g, '#').match(/[a-z_#]+/g) ?? [];
  return `${head.trim()}: ${words.slice(0, 3).join(' ')}`;
};

export type TroubleDecision =
  | { do: 'none' }
  | { do: 'wait'; why: string }
  | { do: 'leave'; why: string }
  | { do: 'replace' }
  | { do: 'resume' }
  | { do: 'escalate'; why: string; step: string };

/**
 * What the cleanup does about a request whose latest worker's turn ended in trouble instead of a report (w1870), given
 * what it did before for that worker (`prev`, WorkItem.errorHandled): nothing for a turn it already handled; an interrupt
 * is re-placed (left to the dispatcher when it queued or blocked the request itself); an error is resumed, at most
 * ERROR_RESUMES times, and escalated to a person when that cannot fix it: the same error after a resume, a refused tool
 * (it would be refused again), or what only a person can give. A usage limit is not decided here (cutOffStep's wait).
 */
export function troubleDecision(w: Pick<WorkItem, 'status'>, t: TurnTrouble, prev: WorkErrorHandled | undefined, now: number): TroubleDecision {
  if (prev && prev.turnAt === t.turnAt) return { do: 'none' };
  const fresh = now - (Date.parse(t.turnAt) || 0) < ERROR_SETTLE_MS;
  if (t.kind === 'interrupt') {
    if (w.status === 'queued' || w.status === 'blocked') return { do: 'leave', why: `the request is ${w.status}: the dispatcher places it again` };
    return fresh ? { do: 'wait', why: 'it was interrupted minutes ago: the dispatcher may be placing it now' } : { do: 'replace' };
  }
  if (t.needs) return { do: 'escalate', why: `it needs ${t.needs}, which only a person can give`, step: `give the worker ${t.needs} (${t.reason.slice(0, 120)}), then add a note to the request: the worker resumes with it` };
  if (t.cause === 'refused') return { do: 'escalate', why: 'a refused tool would be refused again on a resume', step: 'allow what was refused, or say in a note how the worker should do it instead: it resumes with your note' };
  const again = prev && prev.how === 'resumed' && errorKey(prev.error) === errorKey(t.reason);
  if (again) return { do: 'escalate', why: `the same error came back after the cleanup resumed it (${prev.at.slice(0, 16).replace('T', ' ')} UTC)`, step: 'read the error lines and say in a note what the worker should do differently, or fix what fails (a tool, a machine, a setting): it resumes with your note' };
  if (prev && prev.resumes >= ERROR_RESUMES) return { do: 'escalate', why: `it ended in an error again after ${prev.resumes} resumes by the cleanup`, step: 'read the error lines and say in a note what the worker should do differently: it resumes with your note' };
  if (fresh) return { do: 'wait', why: 'its errored turn ended minutes ago' };
  if (w.status === 'queued') return { do: 'leave', why: 'the request is queued: its next worker gets the error with the request' };
  return { do: 'resume' };
}

/** The "Done when" part of a request's brief (the request's done criteria), clipped; undefined when the brief has none. */
export function doneCriteriaOf(brief: string): string | undefined {
  const m = /(?:^|\n)[\s*_#>-]*done when[*_]*:?[*_]*[ \t]*\n?([^]*?)(?=\n\s*\n\s*(?:\*\*|#|---|[A-Z][\w ]{2,40}:)|$)/i.exec(brief ?? '');
  const text = m?.[1]?.trim();
  return text ? (text.length > 900 ? `${text.slice(0, 899).trimEnd()}…` : text) : undefined;
}

/**
 * Why a request whose PRs merged must not close yet on its worker's word (w1870, lothsahn: "Merged PRs are not enough on
 * their own"): its latest worker's last report is not a DONE for it (a `DONE: wNNN` line, or the DONE the ledger
 * recorded from that report). Undefined when it is, or when no worker ever worked on it (a person's own PR).
 */
export function notDoneReason(w: Pick<WorkItem, 'id' | 'done' | 'reopenedAt'>, workers: readonly SessionInfo[]): string | undefined {
  const last = [...workers].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  if (!last) return undefined;
  const report = last.lastResult ?? '';
  // A DONE from before a reopen says nothing about the reopened work (w731).
  if (doneIdsIn(report).includes(w.id.toLowerCase()) && afterReopen(w, last.lastResultAt ?? last.lastActivityAt)) return undefined;
  const said = doneOf(w)[last.id];
  const reportAt = Date.parse(last.lastResultAt ?? '') || 0;
  if (said && (Date.parse(said.at) || 0) >= reportAt - 60_000) return undefined;
  const line = report.replace(/\s+/g, ' ').trim();
  return `its latest worker ${last.id}'s last report is not a DONE for ${w.id}${line ? ` ("${line.length > 120 ? `${line.slice(0, 119)}…` : line}")` : ''}`;
}

/**
 * Why a merged request must stay open whatever its PRs and reports say (w2493, lothsahn: "the cleanup never closes a request
 * that is blocked (on a time, another request, a machine or a person)"): a question open, a worker waiting on a person for
 * it (waiting_on_person), or a blocker the dispatcher or a worker set (not the cleanup's own deploy block, which the deploy
 * clears) after the last DONE for it. w2443 and w2014 were closed at 00:00Z on 2026-10-29 while the dispatcher had them
 * blocked on w2482 and on 2026-10-31 16:04Z. Undefined when nothing holds it.
 */
export function heldOpenReason(w: Pick<WorkItem, 'id' | 'status' | 'blocked' | 'question' | 'done' | 'reopenedAt'>, workers: readonly SessionInfo[]): string | undefined {
  if (w.question) return 'it waits on a question';
  const id = w.id.toLowerCase();
  const waiting = workers.find((s) => s.waitingOn && (!s.waitingOn.request || s.waitingOn.request.toLowerCase() === id));
  if (waiting?.waitingOn) return `its worker ${waiting.id} waits on ${waiting.waitingOn.who} to ${waiting.waitingOn.what.replace(/\s+/g, ' ').slice(0, 120)}`;
  const b = w.status === 'blocked' ? w.blocked : undefined;
  if (!b || b.by === 'ledger cleanup') return undefined;
  // A DONE for it after the block was set says the block is the last thing left behind it (w643's w650).
  const dones = [
    ...Object.values(doneOf(w)).map((d) => Date.parse(d.at) || 0),
    ...workers.filter((s) => doneIdsIn(s.lastResult ?? '').includes(id) && afterReopen(w, s.lastResultAt ?? s.lastActivityAt)).map((s) => Date.parse(s.lastResultAt ?? s.lastActivityAt) || 0),
  ];
  if (dones.some((t) => t >= (Date.parse(b.at) || 0))) return undefined;
  return `it is blocked on ${b.what.replace(/\s+/g, ' ').slice(0, 120)} (set by ${b.by})`;
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

/**
 * A worker's status lines for requests that are not finished (w631): `w342: still open: the 2-peer check`, also
 * `NOT DONE: w342: …` (markdown around it allowed), by request id, the line as written.
 */
export function stillOpenIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (text ?? '').matchAll(/^[\s*_>`-]*(?:NOT[ -]DONE:?\s*[*_`]*(w\d+)\b|(w\d+)[*_`]*\s*[:—–-]\s*[*_`]*\s*(?:still open|not done)\b).*$/gim)) {
    const id = (m[1] ?? m[2]).toLowerCase();
    if (!out.has(id)) out.set(id, m[0].replace(/^[\s*_>`-]+/, '').trim());
  }
  return out;
}

/**
 * A worker's lines setting a request aside while it does other work first (w915): `w342: paused: waiting for w414's PR`,
 * also `w342: set aside …` (markdown around it allowed), by request id, the line as written. The request shows Paused
 * ("worker on w414 first") instead of Stalled; `<id>: still open: …` takes it up again.
 */
export function pausedIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (text ?? '').matchAll(/^[\s*_>`-]*(w\d+)[*_`]*\s*[:—–-]\s*[*_`]*\s*(?:paused|set aside|on hold)\b.*$/gim)) {
    const id = m[1].toLowerCase();
    if (!out.has(id)) out.set(id, m[0].replace(/^[\s*_>`-]+/, '').trim());
  }
  return out;
}

/**
 * Whether a report from a worker on request `ref` carries what `waiter`, blocked on `ref` reporting, waits for (w1869;
 * lothsahn: a block on "w1785 reporting (dec9a619's LothDesktop timing …)" cleared on "w1785: still open: the LothDesktop
 * A/B is running…", and w1820's worker resumed with no timing). It does only with `DONE: <ref>`, a line `For <waiter>: …`
 * (its worker is told to write one, Orchestrators.tellReportWaited), or a still-open line that waits on the waiter
 * (`reportWaitsOn`, w2357). A progress report, a reply ("understood"), or a turn end with no status line at all does not:
 * w2335 was woken four times on 2026-10-27 by its timed leg w2338's turns that said only that its bench ticket was still
 * queued (w2377), and w2419 twice the same evening by its pair run w2425's client leg saying it waited for the host (w2426,
 * lothsahn: "a request blocked on a pair run resumes only once the host leg has reported its result"). Before w2426 any
 * other waiter also took a report with no still-open line, or one naming `ref`, as delivery.
 */
export function reportDelivers(report: string | undefined, ref: string, waiter?: string): boolean {
  if (!report) return false;
  if (doneIdsIn(report).includes(ref.toLowerCase())) return true;
  return !!waiter && (reportFor(report, waiter) || reportWaitsOn(report, ref, waiter));
}

/** Whether a report has a line `For <waiter>: …` (w1869): the result a request blocked on its request's report waits for. */
export function reportFor(report: string | undefined, waiter: string): boolean {
  return !!report && /^w\d+$/i.test(waiter) && new RegExp(`^[\\s*_>\`-]*for\\s+${waiter.toLowerCase()}\\b[*_\`]*\\s*[:—–-]`, 'im').test(report);
}

/**
 * Whether pair run `ref`'s legs have delivered its result to `waiter`, the request that asked for it (w2426, lothsahn: "a
 * request blocked on a pair run resumes only once the host leg has reported its result (the "For wNNN:" line and DONE), or
 * once every leg has ended. A leg's mid-run turn end (waiting on message_pair, a build finished) must not unblock it").
 * `legs` are the legs' latest finished reports, leg 1 (the host) first (undefined: none yet, or mid-turn). It delivers when
 * the host's report has both the `For <waiter>:` line and `DONE: <ref>`, when the host's still-open line waits on the
 * waiter (w2357: a cycle nothing else wakes), or when every leg's report says `DONE: <ref>`. A client leg's report never
 * delivers by itself, whatever it names: w2425's client said "The "For w2419:" result line will come from the host leg's
 * report" while the host was still building, and w2419 resumed on it (2026-10-27 21:00 and 21:01 UTC).
 */
export function pairDelivers(legs: readonly (string | undefined)[], ref: string, waiter?: string): boolean {
  const id = ref.toLowerCase();
  const host = legs[0];
  if (host && waiter && doneIdsIn(host).includes(id) && reportFor(host, waiter)) return true;
  if (host && waiter && reportWaitsOn(host, ref, waiter)) return true;
  return legs.length > 0 && legs.every((r) => !!r && doneIdsIn(r).includes(id));
}

/**
 * Whether a report from a worker on `ref` says `ref` now waits on `waiter` (w2357): its still-open or paused line for `ref`
 * waits on `waiter` ("w2338: still open: waiting for w2335's worker 9524a4bc to send its fix commit"), read as the ledger
 * reads a wait (shared/workState.ts requestWaitOf): a mere mention, "its fix-side legs at e947f566c4 on
 * sandbox/slot3-w2335, queued for biscuit's bench ticket", is no wait on it (w2377). Then `waiter`, blocked
 * on `ref` reporting, has what it can act on (the half that is done, and what is asked of it), and holding it would close
 * a cycle nothing wakes (w2335 and its timed leg w2338, 2026-10-27).
 */
export function reportWaitsOn(report: string | undefined, ref: string, waiter: string): boolean {
  if (!report || !/^w\d+$/i.test(waiter) || waiter.toLowerCase() === ref.toLowerCase()) return false;
  const id = ref.toLowerCase();
  const line = stillOpenIn(report).get(id) ?? pausedIn(report).get(id);
  return !!line && requestWaitOf(line, id) === waiter.toLowerCase();
}

/** The PRs the ledger holds as open that a worker's report says merged (w515: "PR #1089 was merged", ".../pull/1089 merged"). */
export function mergedMentionsIn(text: string, prs: readonly WorkPr[]): WorkPr[] {
  if (!/\bmerged\b/i.test(text ?? '')) return [];
  return prs.filter((p) => p.state === 'open' && new RegExp(`(#|/pull/|\\bPR )${p.number}\\b`, 'i').test(text));
}

/** Words that say how a step after the merge went: a report that says DONE must cover it. */
const STEP_REPORTED = /\b(audit(ed)?|2-peer|two-peer|paired|verif(y|ied|ication)|checked|nightly|soak|no desyncs?|first[- ]hour|re-?ran|ran|passed|green|confirmed)\b/i;

/**
 * Why a worker's `DONE: <id>` cannot close this request yet, or undefined when it can: a pull request of it is still
 * open, a release whose report does not link the posted patch notes and say it is live, a step after the merge the
 * brief asks for that the report does not cover, or a brief that plans several PRs when fewer than two merged and the
 * report does not say they all did. `unverified`: open PRs gh could not read just now (w515): the refusal says so rather
 * than "still open", which the ledger cannot know.
 */
export function doneProblem(w: Pick<WorkItem, 'title' | 'brief' | 'constraints' | 'prs'>, report: string, unverified: readonly number[] = []): string | undefined {
  const open = (w.prs ?? []).find((p) => p.state === 'open');
  if (open && unverified.includes(open.number)) return `couldn't verify PR #${open.number} on GitHub just now (the ledger last read it as open): say DONE again in a later report`;
  if (open) return `PR #${open.number} is still open: merge or close it first`;
  const brief = `${w.title}\n${w.brief}\n${w.constraints ?? ''}`;
  if (isRelease(w) && !(NOTES_POSTED.test(report) && /\b(live|landed)\b/i.test(report))) return 'a release is done when its build is live and its patch notes are posted: say it is live and link the posted notes';
  if (PEER_CHECK.test(brief) && !STEP_REPORTED.test(report)) return 'its brief asks for a step after the merge (a check, an audit, a verification): say in the report what it showed';
  const merged = (w.prs ?? []).filter((p) => p.state === 'merged').length;
  if (PLAN.test(brief) && merged < 2 && !/\b(all|both|every|the last|final) (of the )?(prs?|pull requests|parts|phases|steps|stages)\b/i.test(report)) return 'its brief plans more than one PR: say they have all merged';
  return undefined;
}

/**
 * The `Learned:` line of a DONE report (w741), its text after the colon: the file or PR where the worker wrote down
 * what the request taught it, or "nothing new". A line of its own, markdown around it allowed.
 */
export function learnedIn(text: string): string | undefined {
  const m = (text ?? '').match(/^[\s*_>`-]*Learned[*_`]*:[*_`]*[ \t]*(\S.*)$/im);
  return m ? m[1].trim() : undefined;
}

/**
 * Why a live DONE needs its `Learned:` line first (w741; Ben, 2026-10-09: "If you learn something after struggling or
 * figure out new ways to do things better, update the harness"): none at all, or "nothing new" on a request a person
 * reopened (a reopen is a correction: its DONE names the check that would have caught the miss, or why there is none).
 * Asked only of a DONE as it is said (doneMarkers), never of one stored before this rule, so those still close.
 */
export function learnedProblem(w: Pick<WorkItem, 'reopenedAt'>, report: string): string | undefined {
  const learned = learnedIn(report);
  if (!learned) return 'say what it taught you: add a line `Learned: <the file or PR where you wrote it down>` or `Learned: nothing new` (the ff-agents evidence-gate skill, lessons/lessons-belong-in-the-harness-repo.md)';
  if (w.reopenedAt && /^[*_`"]*nothing new\b/i.test(learned)) return 'a person reopened it: the `Learned:` line names the check that would have caught the miss (a file or PR), or says `no check possible: <why>`';
  return undefined;
}

/**
 * Why a live DONE needs its report first (w2541, docs/reports.md): the request is marked as one whose result is a report
 * (a design, an analysis, a profile, research) and none is filed for it yet.
 */
export function reportProblem(w: Pick<WorkItem, 'report' | 'reports'>): string | undefined {
  if (!w.report || w.reports?.length) return undefined;
  return `its result is a report (${w.report.kind}, asked by ${w.report.by}): file it first with mcp__machine__file_report (title, kind ${w.report.kind}, the whole result as Markdown with its stills and evidence labels), then say DONE again`;
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
  // A standing agent's delegation the dispatcher queued waits for capacity, however long (w527: no expiry while queued).
  if (w.delegation && w.status === 'queued') return false;
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
