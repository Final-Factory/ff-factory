/**
 * Which pull request and commit a pair run checks, and whether a worker's report waits on one (w2057). w665's PR #2340 had
 * its pair run filed by hand (w1936, 21:51 on 10-23) and passed at 12:55 on 10-24, but w665's worker d558ba14 was never told:
 * it waited 17 h ("waiting on a Windows or Linux pair worker to run `MP-lowore-pin-pair` for PR #2340"), and at 15:58 a second
 * run of the same PR was queued. A pair run is matched to a pull request and a commit by these, so a filing joins the open
 * run of its PR, or is answered with the finished run of its PR and commit, and a finished run reaches the requests of its PR.
 */
import type { WorkItem } from '../shared/types.ts';

/** The repo a bare "#2340" or "PR 2340" names: pair runs are the game's multiplayer checks. */
export const GAME_REPO = 'Final-Factory/FinalFactory';

const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;
const PR_REPO = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/;
const PR_BARE = /\bPRs?\s*#?(\d{1,6})\b|(?:^|[\s(])#(\d{3,6})\b/i;

/** "owner/repo#N" for a pull request named in `text` (a link, "owner/repo#N", "PR #N", "#N"), the first one; else undefined. */
export function prIn(text: string | undefined, repo = GAME_REPO): string | undefined {
  if (!text) return undefined;
  const u = PR_URL.exec(text);
  if (u) return `${u[1]}#${Number(u[2])}`;
  const r = PR_REPO.exec(text);
  if (r) return `${r[1]}#${Number(r[2])}`;
  const b = PR_BARE.exec(text);
  if (b) return `${repo}#${Number(b[1] ?? b[2])}`;
  return undefined;
}

/** A pull request as the caller wrote it ("#2340", "2340", "owner/repo#2340", a link) as "owner/repo#N", or undefined. */
export function normPr(s: string | undefined, repo = GAME_REPO): string | undefined {
  const t = String(s ?? '').trim();
  if (!t) return undefined;
  if (/^\d{1,6}$/.test(t)) return `${repo}#${Number(t)}`;
  return prIn(t.startsWith('#') ? ` ${t}` : t, repo);
}

/** Same pull request, the repo's case aside. */
export const samePr = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Commit ids (7 to 40 hex, at least one digit) in `text`, lower case. */
export function commitsIn(text: string | undefined): string[] {
  return [...String(text ?? '').matchAll(/\b[0-9a-f]{7,40}\b/gi)].map((m) => m[0].toLowerCase()).filter((x) => /\d/.test(x) && /[a-f]/.test(x));
}

/** One commit is a prefix of the other (a short sha and its full id), at least 7 characters. */
export const sameCommit = (a: string | undefined, b: string | undefined) => !!a && !!b && Math.min(a.length, b.length) >= 7 && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

/** The pull request a pair run checks: the one request_pair recorded, else the first its title, constraints or brief names. */
export function pairPrOf(x: Pick<WorkItem, 'pair' | 'title' | 'constraints' | 'brief'>): string | undefined {
  return x.pair?.pr ?? prIn(x.title) ?? prIn(x.constraints) ?? prIn(x.brief);
}

/** The commits a pair run ran: the one request_pair recorded, else every one its title, brief, outcome or legs' DONE reports name. */
export function pairCommitsOf(x: Pick<WorkItem, 'pair' | 'title' | 'brief' | 'outcome' | 'done'>): string[] {
  if (x.pair?.commit) return [x.pair.commit.toLowerCase()];
  const texts = [x.title, x.brief, x.outcome ?? '', ...Object.values(x.done ?? {}).map((d) => d.text ?? d.report)];
  return [...new Set(texts.flatMap(commitsIn))];
}

/** Whether a finished pair run checked `commit` (and so answers a new filing for it). */
export const pairRanCommit = (x: Parameters<typeof pairCommitsOf>[0], commit: string | undefined) => !!commit && pairCommitsOf(x).some((c) => sameCommit(c, commit));

/** The part of a leg's report meant for `waiter`: from its "For wNNN:" line on, else the report's start; at most `max` characters. */
export function resultFor(text: string | undefined, waiter: string, max = 1200): string {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const m = new RegExp(`^\\s*(?:[*_>-]\\s*)*For ${waiter}\\b`, 'im').exec(t);
  const from = m ? t.slice(m.index).trim() : t;
  return from.length > max ? `${from.slice(0, max - 1)}…` : from;
}

const WAIT =/\b(?:waiting|waits|wait|blocked|held|holding)\b/i;
const PAIR = /\bpair(?:ed)?[- ](?:run|worker|leg|check|test|machine|computer|scenario|audit)s?\b|\btwo[- ](?:machine|computer)s? (?:run|check|test|pair)\b|\bMP-[\w-]*-pair\b|\b(?:a|the) (?:windows|linux|non-mac)[\w /-]{0,30}\bpair\b/i;

/**
 * A still-open line that waits on a pair run (w2057): "waiting on a Windows or Linux pair worker to run MP-lowore-pin-pair",
 * "the merge is held for the MP-x-pair run", "blocked on the pair run w1936". Not "repair", nor a pair of anything else.
 */
export const pairWaitLine = (line: string) => WAIT.test(line) && PAIR.test(line);

/** What the worker is told who ends a turn waiting on a pair run its request has none of (w2057, Agents.pairWaitNudge). */
export const pairWaitNotice = (id: string, line: string) =>
  `[FF Factory] Your report says ${id} waits on a pair run: "${line.slice(0, 200)}". No pair run is filed for ${id}, so nothing will run it and nobody will resume you: an ask in your report reaches no one (w2057; w665 waited 17 h this way). Call request_pair now (what, brief, pr and commit: the pull request and the head commit the legs run, cross_os only for w1692's reasons), then end your turn with a "${id}: still open: blocked on <the pair run>" line. When a pair run of that pull request and commit has already finished, request_pair answers with its result and files nothing; when one is open, you wait on it.`;
