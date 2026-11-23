/**
 * w4553: two ffu rows that edit the same code, found when the later one starts (w5197: both run, each told of the other).
 *
 * Over 2026-11-15 12:00Z to 2026-11-17 11:00Z, 7 of the 8 "not mergeable" refusals of merge on green were ffu pull requests,
 * and about half of those were two rows started together that edited the same file (w4548's `git merge-tree` re-runs:
 * ffu#841 `sector/structures.rs`, #853 `ffu-platform/src/lib.rs` and `docs/play.md`, #855 `sector/rewards.rs`, #838
 * `sector/tech.rs`, #869 `ff1power.rs`). Each costs a worker resume, a merge of main and another ~18 min ffu CI run.
 *
 * Before the dispatcher starts an ffu row (start_agent with a work_id whose repo is ffu), its expected files (the ones the
 * dispatcher declares with `files`, and the paths its title, brief and start prompt name) are checked against
 * - the changed files of the open ffu pull requests updated in the last few days, and
 * - the expected files of the other ffu rows in flight (started, still open, no pull request needed yet: the rows of a
 *   triage fan-out start minutes apart, before any of them has opened one).
 * An overlap holds nothing since w5197 (lothsahn, 2026-11-23: "Let FFU look requests run at once; each merges main before
 * pushing, and the later PR fixes conflicts"; five look requests on `crates/ffu-render/src/mesh.wgsl` had run one at a time).
 * The row starts; its start prompt and the start_agent reply name the files it shares and with whom, both requests' logs
 * get the line, and the worker of each other request it shares files with is told once, so both merge origin/main before
 * they push and the later pull request resolves the conflicts.
 *
 * Files most ffu pull requests touch (the hubs: `sector.rs`, `snapshot.rs`, the client's `main.rs`, ...) are left out, read
 * from the last merged pull requests: a note on them would come with nearly every ffu row, and their conflicts are the
 * sorted-list kind w4548 fixes in ffu itself (keep_sorted).
 */

import type { WorkItem } from '../shared/types.ts';
import { isCargoRepo } from '../shared/capacity.ts';
import { isOpen } from './work.ts';

export const FFU_REPO = 'Final-Factory/ffu';
/** An open ffu pull request counts for this long after its last update; older ones are parked, not in flight. */
export const OPEN_PR_FRESH_MS = 72 * 3600_000;
/** A file changed by at least this share of the recent merged pull requests is a hub (see above). */
export const HUB_SHARE = 0.1;
/** Below this many merged pull requests no file is called a hub. */
const HUB_MIN_PRS = 20;
/** A brief that names more files than this is a plan, not a row: it predicts nothing (declare `files` for it). */
export const MAX_NAMED = 12;

/** File names too common to identify a file by their name alone. */
const GENERIC = new Set(['lib.rs', 'main.rs', 'mod.rs', 'tests.rs', 'build.rs', 'readme.md', 'cargo.toml', 'cargo.lock', 'changelog.md', 'claude.md', 'agents.md']);

const PATH = /(?<![\w./@:-])((?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:rs|md|toml|wgsl|py|json|ron|ya?ml|sh))(?::\d+(?:-\d+)?)?(?![\w/-]|\.\w)/g;

/** The repository paths a text names (`crates/ffu-sim/src/sector/tech.rs`, `sector/rewards.rs:12`, `docs/play.md`). */
export function filesNamed(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH)) out.add(m[1].replace(/^\.\//, ''));
  return [...out];
}

/** Whether two paths are one file: equal, or one is the other's tail at a `/` (a bare generic name like lib.rs never is). */
export function sameFile(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  if (!long.endsWith(`/${short}`)) return false;
  return short.includes('/') || !GENERIC.has(short);
}

/** The hubs: files changed by at least HUB_SHARE of `merged` (each pull request's changed files). */
export function hubFilesOf(merged: readonly (readonly string[])[], share = HUB_SHARE): string[] {
  if (merged.length < HUB_MIN_PRS) return [];
  const count = new Map<string, number>();
  for (const files of merged) for (const f of new Set(files)) count.set(f, (count.get(f) ?? 0) + 1);
  return [...count].filter(([, n]) => n >= share * merged.length).map(([f]) => f).sort();
}

/** A row's expected files: what the dispatcher declared, and what its text names unless it names a plan's worth. */
export function expectedFiles(declared: readonly string[] | undefined, text: string, hubs: readonly string[]): string[] {
  const keep = (f: string) => !hubs.some((h) => sameFile(h, f));
  const named = filesNamed(text).filter(keep);
  const mine = [...(declared ?? []).map((f) => f.trim()).filter(Boolean).filter(keep), ...(named.length > MAX_NAMED ? [] : named)];
  return mine.filter((f, i) => mine.findIndex((g) => sameFile(f, g)) === i);
}

export interface FfuPr {
  number: number;
  body?: string;
  updatedAt?: string;
  headRefName?: string;
  files: string[];
}

/** Another ffu row in flight: its request, its expected files, and its open pull requests. */
export interface FfuRow {
  id: string;
  files: string[];
  prs: number[];
}

export interface FfuClash {
  /** The request in flight it collides with. */
  id?: string;
  /** Its open pull request, when it has one: the row waits for that to merge. */
  pr?: number;
  files: string[];
}

/** The request a pull request is for, by its `Request:` or `Part of:` line or a `wNNN-` head branch. */
export function prRequest(pr: Pick<FfuPr, 'body' | 'headRefName'>): string | undefined {
  const line = /^(?:Request|Part of):\s*(w\d+)\b/im.exec(pr.body ?? '');
  if (line) return line[1].toLowerCase();
  const branch = /(?:^|\/)(w\d+)(?:[-_/]|$)/i.exec(pr.headRefName ?? '');
  return branch?.[1].toLowerCase();
}

/**
 * Where `mine` (a row's expected files) collides: with each fresh open pull request (its changed files, hubs left out) and
 * each other row in flight (its expected files and its pull requests' files). One clash per request or pull request.
 */
export function ffuClashes(args: { id: string; mine: readonly string[]; prs: readonly FfuPr[]; rows: readonly FfuRow[]; hubs: readonly string[]; now: number }): FfuClash[] {
  const { id, mine, hubs, now } = args;
  if (!mine.length) return [];
  const isHub = (f: string) => hubs.some((h) => sameFile(h, f));
  const shared = (theirs: readonly string[]) => mine.filter((m) => theirs.some((t) => !isHub(t) && sameFile(m, t)));
  const fresh = args.prs.filter((p) => prRequest(p) !== id.toLowerCase() && (!p.updatedAt || now - Date.parse(p.updatedAt) <= OPEN_PR_FRESH_MS));
  const out: FfuClash[] = [];
  const seenPr = new Set<number>();
  for (const r of args.rows) {
    if (r.id.toLowerCase() === id.toLowerCase()) continue;
    const own = fresh.filter((p) => r.prs.includes(p.number) || prRequest(p) === r.id.toLowerCase());
    for (const p of own) {
      seenPr.add(p.number);
      const files = shared(p.files);
      if (files.length) out.push({ id: r.id, pr: p.number, files });
    }
    if (own.some((p) => out.some((c) => c.pr === p.number))) continue;
    const files = shared(r.files);
    if (files.length) out.push({ id: r.id, ...(own[0] ? { pr: own[0].number } : {}), files });
  }
  for (const p of fresh) {
    if (seenPr.has(p.number)) continue;
    const files = shared(p.files);
    if (files.length) out.push({ ...(prRequest(p) ? { id: prRequest(p) } : {}), pr: p.number, files });
  }
  return out;
}

/** One clash in words: "ffu#841 (w4376): sector/structures.rs". */
export function clashLine(c: FfuClash): string {
  const who = c.pr ? `${FFU_REPO}#${c.pr}${c.id ? ` (${c.id})` : ''}` : `${c.id} (in flight, no pull request yet)`;
  return `${who}: ${c.files.join(', ')}`;
}

/** What the starting row's worker is told (w5197): the files it shares, with whom, and how to land beside them. */
export function sharedFilesNote(id: string, clashes: readonly FfuClash[]): string {
  return `\n\n[ffu files shared with work in flight (w5197)] ${id} may edit files other ffu work in flight edits: ${clashes.map(clashLine).join('; ')}. Nothing waits on it: merge origin/main into your branch before every push (\`ff-pr push\` does), and if the other pull request merges first, yours resolves the conflicts. Keep to the parts of those files your work needs.`;
}

/** What the worker of a request `starting` shares files with is told (w5197). */
export function peerFilesNote(starting: string, files: readonly string[]): string {
  return `[ffu files shared with work in flight (w5197)] ${starting} just started on ffu work that may edit files yours edits too: ${files.join(', ')}. Nothing waits on it: merge origin/main into your branch before every push (\`ff-pr push\` does), and if ${starting}'s pull request merges first, yours resolves the conflicts.`;
}

type Run = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** gh reads of ffu's pull requests, cached: open ones for a minute, the hubs (from the last 100 merged) for an hour. */
export class FfuPrReads {
  private open?: { at: number; prs: FfuPr[] };
  private hub?: { at: number; files: string[] };
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async openPrs(run: Run): Promise<FfuPr[]> {
    if (this.open && this.now() - this.open.at < 60_000) return this.open.prs;
    const prs = (await ghList(run, ['--state', 'open', '--limit', '100', '--json', 'number,body,updatedAt,headRefName,files'])).map((p) => ({
      number: p.number,
      body: p.body,
      updatedAt: p.updatedAt,
      headRefName: p.headRefName,
      files: (p.files ?? []).map((f) => f.path),
    }));
    this.open = { at: this.now(), prs };
    return prs;
  }

  async hubs(run: Run): Promise<string[]> {
    if (this.hub && this.now() - this.hub.at < 3600_000) return this.hub.files;
    const merged = await ghList(run, ['--state', 'merged', '--limit', '100', '--json', 'files']);
    const files = hubFilesOf(merged.map((p) => (p.files ?? []).map((f) => f.path)));
    this.hub = { at: this.now(), files };
    return files;
  }
}

async function ghList(run: Run, args: string[]): Promise<{ number: number; body?: string; updatedAt?: string; headRefName?: string; files?: { path: string }[] }[]> {
  const r = await run('gh', ['pr', 'list', '-R', FFU_REPO, ...args], { timeoutMs: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (r.code !== 0) throw new Error(`gh pr list -R ${FFU_REPO}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0].slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

/** The ffu rows in flight beside `id`: open ffu requests a worker was started on, with their expected files and open PRs. */
export function ffuRowsInFlight(work: Iterable<WorkItem>, id: string, hubs: readonly string[]): FfuRow[] {
  const out: FfuRow[] = [];
  for (const x of work) {
    if (x.id === id || !isOpen(x) || !x.sessionIds.length || !isCargoRepo(x.repo)) continue;
    out.push({
      id: x.id,
      files: expectedFiles(x.ffuFiles, `${x.title}\n${x.brief}`, hubs),
      prs: (x.prs ?? []).filter((p) => p.state === 'open' && isCargoRepo(p.repo)).map((p) => p.number),
    });
  }
  return out;
}

/**
 * The start check (w4553): where ffu row `w`, about to start with `prompt` and the dispatcher's declared `files`, collides
 * with the rows in flight and the fresh open ffu pull requests. Empty for a request that is not ffu work, or that already
 * has an open ffu pull request of its own (its work is written; a restart of it holds nobody up).
 */
export function ffuStartClashes(args: { w: WorkItem; declared?: readonly string[]; prompt: string; work: Iterable<WorkItem>; prs: readonly FfuPr[]; hubs: readonly string[]; now: number }): { mine: string[]; clashes: FfuClash[] } {
  const { w, hubs } = args;
  if (!isCargoRepo(w.repo) || (w.prs ?? []).some((p) => p.state === 'open' && isCargoRepo(p.repo))) return { mine: [], clashes: [] };
  const mine = expectedFiles([...(w.ffuFiles ?? []), ...(args.declared ?? [])], `${w.title}\n${w.brief}\n${args.prompt}`, hubs);
  return { mine, clashes: ffuClashes({ id: w.id, mine, prs: args.prs, rows: ffuRowsInFlight(args.work, w.id, hubs), hubs, now: args.now }) };
}
