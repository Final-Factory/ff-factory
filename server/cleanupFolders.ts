import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { localWorkWhy, norm, OUTSIDE_ROOT_WHY, sizeOf, within } from './cleanup.ts';
import { requestIdsIn, CONTEXT_MAX_AGE_HOURS } from './staleOutput.ts';
import type { SessionOwner } from './resumable.ts';

/**
 * The folders a clean-up worker may delete, judged against the ledger (w1379). On 2026-10-15 w1374, LothDesktop's low-disk
 * clean-up, deleted the temp folder of stopped worker a735f37c: builds and preview clips of w1332 (the comet catch tail),
 * which was stalled on a usage limit and then waiting for Ben's OK of the look. The daemon's own sweeps had kept it (they
 * leave a session a request still waits for, server/resumable.ts, w1097; the portal's clean-up log for that day holds
 * no entry for it). The clean-up worker deleted it by hand: its brief carried a list of live workers and of "stopped but will
 * resume" ones that somebody had written out, and a735f37c was not on it.
 *
 * So the list comes from the ledger, not from a brief. The daemon writes the facts (`CleanupFacts`: its live sessions, and
 * the portal's sessions with a request not closed, from `welcome`/`resumable`) to a file; `ff-leftovers folders` lists every
 * folder a clean-up could take, each with its owner and a verdict, and `ff-leftovers check <path>` judges one path. A
 * folder is deletable only when it belongs to a request that is closed (done, merged, rejected, cancelled) or to no worker
 * at all (an orphan). Whatever is not provably so is kept, and the answer says why: a stale or missing fact keeps everything.
 *
 * And the ledger is not the only owner (w1387). The same day w1385, LothDesktop's next low-disk clean-up, deleted
 * V:fw	mpfa-31ffe8cc (564 MB) on a DELETE row: no open request named worker 31ffe8cc (w1367, the nightly merge review,
 * was done). The portal's own clean-up had kept that folder three times that evening, "holds a git repo with uncommitted or
 * unpushed work (...fa-31ffe8ccf)", and the clone could not be recovered. So a folder the ledger frees is checked as
 * the portal's sweeps check it (cleanup.ts localWorkWhy): a git repo in it, under it or around it with uncommitted
 * changes, commits on no remote or a stash keeps it, with the repo and what it holds.
 */
export interface CleanupFacts {
  /** When the daemon wrote the file (ISO). */
  at: string;
  /** The daemon's link to the portal is up and its welcome came: the sessions' requests are as the portal last said. */
  connected: boolean;
  /** The machine's worker install folder: nothing outside it is ever a candidate (w896). */
  root?: string;
  /** The workers' temp root, <root>/tmp. */
  tempRoot?: string;
  sandboxes: { id: string; path: string }[];
  /** Sessions whose process runs here now. */
  live: string[];
  /** Sessions a request still waits for (server/resumable.ts resumableSessions). */
  resumable: string[];
  /** Every session of the machine with a request not closed, and the requests it is on (server/resumable.ts ownersOf); absent: the portal never said, and nothing is deletable. */
  owners?: Record<string, SessionOwner>;
  /** Request ids open and closed in the ledger, as the portal last said (server/staleOutput.ts StaleContext). */
  open: string[];
  closed: string[];
  /** When the portal said it (ISO). */
  contextAt?: string;
}

export interface FolderRow {
  path: string;
  kind: 'session-temp' | 'scratch' | 'sandbox-output' | 'named' | 'other';
  verdict: 'keep' | 'delete';
  why: string;
  bytes?: number;
}

/** The daemon writes the facts every 30 s; older than this and it is not running or not writing. */
export const FACTS_MAX_AGE_MS = 5 * 60_000;

/** Why nothing may be deleted on these facts, or undefined when they can be trusted. */
export function factsProblem(f: CleanupFacts | undefined, now = Date.now()): string | undefined {
  if (!f) return 'no ledger facts on this machine (the FF Factory daemon has not written them: it is old or not running)';
  const age = now - Date.parse(f.at);
  if (!Number.isFinite(age) || age > FACTS_MAX_AGE_MS) return `the daemon's ledger facts are ${Number.isFinite(age) ? `${Math.round(age / 60_000)} min` : 'of unknown age'} old (it writes them every 30 s)`;
  if (!f.connected) return "the daemon is not connected to the portal, so the ledger's facts may have changed";
  if (!f.owners) return 'the portal has not said which sessions its requests are on (it predates w1379, or its welcome has not come)';
  if (!f.root) return 'this machine has no worker install folder, so nothing is a candidate here (w896)';
  return undefined;
}

const sessionOfDir = (name: string) => /^ffa-([\w-]+)$/i.exec(name)?.[1];

/** One session's folder: kept while its worker runs or a request that is not closed names it. */
export function judgeSession(sid: string, f: CleanupFacts): Pick<FolderRow, 'verdict' | 'why'> {
  if (f.live.includes(sid)) return { verdict: 'keep', why: `worker ${sid} is running now` };
  const own = f.owners?.[sid];
  if (own) {
    const open = own.requests.filter((r) => !['merged', 'done', 'rejected', 'cancelled'].includes(r.status));
    const withIt = open.filter((r) => r.with);
    const list = (rs: typeof open) => rs.map((r) => `${r.id} (${r.status})`).join(', ');
    if (withIt.length) return { verdict: 'keep', why: `stopped worker ${sid} is still on ${list(withIt)}, which has not closed: it resumes there and needs its files` };
    return { verdict: 'keep', why: `worker ${sid} was on ${list(open)}, which has not closed (it moved on to another worker; the daemon sweeps these itself, w1097)` };
  }
  if (f.resumable.includes(sid)) return { verdict: 'keep', why: `a request still waits for worker ${sid}` };
  return { verdict: 'delete', why: `no open, stalled or paused request names worker ${sid}: its requests are closed, or it belongs to no request (an orphan)` };
}

/** A folder named for requests ("w1332-comet-catch-tail", "results-w166"): by those requests' state. */
export function judgeNamed(name: string, f: CleanupFacts, now = Date.now()): Pick<FolderRow, 'verdict' | 'why'> {
  const ids = requestIdsIn(name);
  if (!ids.length) return { verdict: 'keep', why: 'names no request, so it cannot be attributed: listed for a person, never deleted' };
  const open = new Set(f.open);
  const closed = new Set(f.closed);
  const fresh = f.contextAt && now - Date.parse(f.contextAt) < CONTEXT_MAX_AGE_HOURS * 3_600_000;
  if (!fresh) return { verdict: 'keep', why: `the ledger's request states are older than ${CONTEXT_MAX_AGE_HOURS} h or missing` };
  const live = ids.filter((id) => open.has(id));
  if (live.length) return { verdict: 'keep', why: `${live.join(', ')} has not closed (open, stalled or paused)` };
  const unknown = ids.filter((id) => !closed.has(id));
  if (unknown.length) return { verdict: 'keep', why: `${unknown.join(', ')} is in neither list of the ledger: not provably closed` };
  return { verdict: 'delete', why: `${ids.join(', ')} closed` };
}

/** A sandbox's build and capture output belongs to the workers in it. */
export function judgeSandbox(id: string, f: CleanupFacts): Pick<FolderRow, 'verdict' | 'why'> {
  const here = Object.entries(f.owners ?? {}).filter(([, o]) => o.sandbox === id);
  const live = here.filter(([sid]) => f.live.includes(sid)).map(([sid]) => sid);
  if (live.length) return { verdict: 'keep', why: `worker ${live.join(', ')} works in ${id} now` };
  const waiting = here.filter(([sid]) => f.resumable.includes(sid) || judgeSession(sid, f).verdict === 'keep');
  if (waiting.length) return { verdict: 'keep', why: `worker ${waiting.map(([sid]) => sid).join(', ')} in ${id} is on a request that has not closed (${waiting.flatMap(([, o]) => o.requests.filter((r) => !['merged', 'done', 'rejected', 'cancelled'].includes(r.status)).map((r) => r.id)).join(', ')})` };
  return { verdict: 'delete', why: `no worker in ${id} is running or on an open, stalled or paused request` };
}

/** The verdict for one path, wherever it is. */
export function judgePath(p: string, f: CleanupFacts, now = Date.now()): FolderRow {
  const row = (kind: FolderRow['kind'], r: Pick<FolderRow, 'verdict' | 'why'>): FolderRow => ({ path: p, kind, ...r });
  const bad = factsProblem(f, now);
  if (bad) return row('other', { verdict: 'keep', why: bad });
  const root = f.root!;
  if (!within(p, root) || norm(p) === norm(root)) return row('other', { verdict: 'keep', why: OUTSIDE_ROOT_WHY });
  if (f.tempRoot && within(p, f.tempRoot) && norm(p) !== norm(f.tempRoot)) {
    const first = norm(p).slice(norm(f.tempRoot).length + 1).split('/')[0]!;
    const sid = sessionOfDir(first);
    if (sid) return row('session-temp', judgeSession(sid, f));
    return row('other', { verdict: 'keep', why: 'not a worker temp folder (ffa-<session>)' });
  }
  for (const sb of f.sandboxes) {
    if (!within(p, sb.path)) continue;
    const rel = norm(p).slice(norm(sb.path).length + 1).split('/');
    if (['builds', '.nightly-builds'].includes(rel[0] ?? '') && rel.length >= 2) return row('sandbox-output', judgeSandbox(sb.id, f));
    return row('other', { verdict: 'keep', why: "a sandbox's own files (only its Builds/ and .nightly-builds/ output is a candidate)" });
  }
  const rel = norm(p).slice(norm(root).length + 1).split('/');
  if (rel[0] === 'scratch' && rel.length >= 2) return row('scratch', judgeNamed(rel[1]!, f, now));
  const named = rel.find((seg) => requestIdsIn(seg).length);
  if (named) return row('named', judgeNamed(named, f, now));
  return row('other', { verdict: 'keep', why: 'not a place with an owner in the ledger' });
}

const entries = (dir: string) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Folders never looked into for repos: a clone's own .git, and the big trees a repo is never inside. */
const NO_LOOK = /^(\.git|node_modules|library)$/i;
/** How far below a folder its repos are looked for: the portal's sweeps look one level down; a worker's legs nest deeper. */
const REPO_DEPTH = 3;

export interface RepoAt {
  repo: string;
  /** The repo holds `p` (p is inside its work tree), rather than `p` holding the repo. */
  around: boolean;
}

/** The git repos (or worktrees: .git may be a file) at `p`, below it to REPO_DEPTH, and the one it is inside, up to `root`. */
export function reposAround(p: string, root: string): RepoAt[] {
  const out: RepoAt[] = [];
  const isRepo = (d: string) => fs.existsSync(path.join(d, '.git'));
  for (let d = path.dirname(p); within(d, root) && norm(d) !== norm(root) && path.dirname(d) !== d; d = path.dirname(d)) {
    if (isRepo(d)) {
      out.push({ repo: d, around: true });
      break;
    }
  }
  const down = (d: string, depth: number) => {
    if (isRepo(d)) {
      out.push({ repo: d, around: false }); // its nested repos are its submodules: its own status covers them
      return;
    }
    if (depth >= REPO_DEPTH) return;
    for (const e of entries(d)) if (e.isDirectory() && !e.isSymbolicLink() && !NO_LOOK.test(e.name)) down(path.join(d, e.name), depth + 1);
  };
  down(p, 0);
  return out;
}

/** Git ignores `p` in `repo` (a build cache, node_modules): deleting it takes nothing git holds. Unknown counts as no. */
export function gitIgnores(repo: string, p: string, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('git', ['--no-optional-locks', '-C', repo, 'check-ignore', '-q', '--', path.relative(repo, p)], { timeout: timeoutMs, windowsHide: true }, (e) => resolve(!e)),
  );
}

/**
 * Why a git repo keeps `p`, or undefined: one in or under it with uncommitted changes, commits on no remote or a stash
 * (cleanup.ts localWorkWhy, the portal sweeps' own check), or the one around it with such work when git does not ignore `p`.
 */
export async function gitKeeps(p: string, root: string, localWork: (dir: string) => Promise<string | undefined> = (d) => localWorkWhy(d, 60_000)): Promise<string | undefined> {
  const held: string[] = [];
  for (const { repo, around } of reposAround(p, root)) {
    if (around && (await gitIgnores(repo, p))) continue;
    const why = await localWork(repo);
    if (why) held.push(`${repo}${around ? ' (around it)' : ''}: ${why}`);
  }
  if (!held.length) return undefined;
  return `holds a git repo with uncommitted or unpushed work (${held.join('; ')}), as the portal's clean-up keeps it (w1387): push it or ask its person; never delete it`;
}

/** A DELETE row checked for git work, which turns it into KEEP with the reason and the ledger's own verdict beside it. */
export async function withGitCheck(r: FolderRow, root: string | undefined, localWork?: (dir: string) => Promise<string | undefined>): Promise<FolderRow> {
  if (r.verdict !== 'delete' || !root) return r;
  const why = await gitKeeps(r.path, root, localWork);
  return why ? { ...r, verdict: 'keep', why: `${why}. The ledger alone said: ${r.why}` } : r;
}

/** Every folder a clean-up could take, judged. Sizes are measured for the deletable ones only unless `sizes` asks for all. */
export async function planFolders(f: CleanupFacts, o: { now?: number; sizes?: 'all' | 'delete' | 'none'; localWork?: (dir: string) => Promise<string | undefined> } = {}): Promise<FolderRow[]> {
  const now = o.now ?? Date.now();
  const bad = factsProblem(f, now);
  if (bad) return [{ path: f.root ?? '(no install folder)', kind: 'other', verdict: 'keep', why: bad }];
  const paths: string[] = [];
  if (f.tempRoot) for (const e of entries(f.tempRoot)) if (e.isDirectory() && sessionOfDir(e.name)) paths.push(path.join(f.tempRoot, e.name));
  for (const e of entries(path.join(f.root!, 'scratch'))) paths.push(path.join(f.root!, 'scratch', e.name));
  for (const sb of f.sandboxes) {
    for (const top of ['Builds', '.nightly-builds']) for (const e of entries(path.join(sb.path, top))) paths.push(path.join(sb.path, top, e.name));
  }
  const rows: FolderRow[] = [];
  for (const p of paths) rows.push(await withGitCheck(judgePath(p, f, now), f.root, o.localWork));
  const mode = o.sizes ?? 'delete';
  if (mode !== 'none') for (const r of rows) if (mode === 'all' || r.verdict === 'delete') r.bytes = await sizeOf(r.path).catch(() => undefined);
  return rows.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'keep' ? -1 : 1) || a.path.localeCompare(b.path));
}

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/** The listing a clean-up worker reads: what to keep and why, what it may delete. */
export function renderFolders(rows: FolderRow[], f: CleanupFacts | undefined, now = Date.now()): string {
  const bad = factsProblem(f, now);
  if (bad) return `Nothing may be deleted on this machine's facts: ${bad}.\nReport that; do not guess which folders are free.\n`;
  const line = (r: FolderRow) => `${r.verdict === 'keep' ? 'KEEP  ' : 'DELETE'}  ${r.bytes === undefined ? '' : `${gb(r.bytes)}  `}${r.path}\n        ${r.why}`;
  const keep = rows.filter((r) => r.verdict === 'keep');
  const del = rows.filter((r) => r.verdict === 'delete');
  const total = del.reduce((n, r) => n + (r.bytes ?? 0), 0);
  return [
    `Folders under ${f!.root} judged against the ledger (facts ${Math.max(0, Math.round((now - Date.parse(f!.at)) / 1000))} s old): ${keep.length} to KEEP, ${del.length} deletable${total ? ` (${gb(total)})` : ''}.`,
    ...keep.map(line),
    ...del.map(line),
    'Delete only the DELETE rows, and only inside the install folder. A KEEP row belongs to a request that has not closed (open, stalled or paused), holds a git repo with work on no remote, or could not be attributed: report it, never remove it.',
    '`ff-leftovers check <path>...` judges any other path before you delete it.',
    '',
  ].join('\n');
}
