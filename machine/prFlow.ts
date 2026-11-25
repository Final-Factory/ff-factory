// ff-pr (w1478): a worker's pull request routine in one command each, so it costs a model call or two, not ten.
// Measured on 81 beast worker sessions of 2026-10-15..18: 163 pull requests took 825 CI-polling calls, 581 git
// fetch/merge/push calls and 141 create/merge calls, about 10 calls each, and every call re-reads the session's ~346k
// tokens of context. `ff-pr push` does the merge of the base, the push, the PR and the w907 check that the push landed
// (the PR's head is HEAD, not CONFLICTING) in one call and prints the blocked_on line to wait with; after the wait,
// `ff-pr merge` reads the head's check runs (the fine-grained token cannot read check runs through `gh pr checks`, so
// it reads workflow runs) and merges on green with --match-head-commit, or names what is red or still running.
//
//   ff-pr push [--base <branch>] [--title <t> --body-file <f>] [--draft] [--no-merge-base]
//   ff-pr status [--pr <n>]
//   ff-pr merge [--pr <n>]
//
// Exit codes: 0 done (pushed and landed, green, merged), 1 the worker must act (a conflict, red CI, a push that did not
// land, no PR and no title), 2 usage, 3 CI still running (wait with blocked_on, then run it again).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ghEnvFor, readGhAppTokens, remotesOf } from './ghApp.ts';
import { awayLabelsOf, awayNote, failedNote, offlineLabels, settleJobs, type Leg } from './awayRunners.ts';
import { noPrCi } from './ciPaths.ts';
import { fontAtlasNoise, mayBeDynamicFont } from '../server/editorNoise.ts';
import { STALE_EVIDENCE, evidenceArgs, evidenceGated, evidencePython, evidenceRefusal, evidenceVerdict, findLocalPrEvidence, noScriptRefusal, updateLocalPlugin } from './evidenceGate.ts';

export interface Ran {
  code: number;
  out: string;
  err: string;
}
export type Runner = (cmd: string, args: string[]) => Ran;
export interface PrDeps {
  run: Runner;
  write: (s: string) => void;
  sleep: (ms: number) => void;
  /** w3088: the pr_evidence.py `merge` runs on a gated repository's pull request first (machine/evidenceGate.ts); none refuses. */
  evidenceScript?: () => string | undefined;
  python?: string;
  /**
   * w4926: brings this machine's ff-agents plugin up to the released version (claude plugin marketplace update, then
   * claude plugin update), for a refusal that says only that the local pr_evidence.py is older than the released one.
   * Answers what went wrong, or undefined when it worked. None: such a refusal stands.
   */
  updatePlugin?: () => string | undefined;
  /** The environment ff-pr runs in, named when gh cannot authenticate (w5430). None: nothing is named. */
  env?: NodeJS.ProcessEnv;
}

/** One workflow run on the PR's head, as `gh run list --json` answers it. */
export interface WorkflowRun {
  databaseId: number;
  name?: string;
  workflowName?: string;
  status: string;
  conclusion?: string;
}

export interface CiVerdict {
  state: 'green' | 'red' | 'pending' | 'none';
  red: string[];
  pending: string[];
}

const GOOD = new Set(['success', 'skipped', 'neutral']);

/**
 * The verdict of a head's workflow runs. A workflow run again on the same commit (a rerun, rerun-lost-runner.yml) counts
 * by its newest run only, so an old red run that a rerun turned green does not hold the merge.
 */
export function ciVerdict(runs: WorkflowRun[]): CiVerdict {
  const newest = new Map<string, WorkflowRun>();
  for (const r of runs) {
    const k = r.workflowName || r.name || String(r.databaseId);
    const had = newest.get(k);
    if (!had || r.databaseId > had.databaseId) newest.set(k, r);
  }
  const red: string[] = [];
  const pending: string[] = [];
  for (const [k, r] of newest) {
    if (r.status !== 'completed') pending.push(k);
    else if (!GOOD.has((r.conclusion ?? '').toLowerCase())) red.push(`${k} (${r.conclusion || 'no conclusion'}, run ${r.databaseId})`);
  }
  return { state: !newest.size ? 'none' : red.length ? 'red' : pending.length ? 'pending' : 'green', red, pending };
}

interface Pr {
  number: number;
  url: string;
  headRefOid: string;
  mergeable: string;
  state: string;
  baseRefName: string;
  baseRefOid?: string;
  /** w5549: its head branch, and whether that branch is in another repository (a fork). */
  headRefName?: string;
  isCrossRepository?: boolean;
}

interface Opts {
  base?: string;
  title?: string;
  bodyFile?: string;
  draft: boolean;
  mergeBase: boolean;
  pr?: string;
}

export function parseArgs(argv: string[]): { cmd: string; o: Opts } | string {
  const cmd = argv[0] ?? '';
  const o: Opts = { draft: false, mergeBase: true };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === '--base') o.base = val();
      else if (a === '--title') o.title = val();
      else if (a === '--body-file') o.bodyFile = val();
      else if (a === '--pr') {
        const v = val();
        if (o.pr !== undefined && o.pr !== v) return `--pr ${v} and ${o.pr} name different pull requests`;
        o.pr = v;
      }
      else if (a === '--draft') o.draft = true;
      else if (a === '--no-merge-base') o.mergeBase = false;
      else if (!a.startsWith('-') && (cmd === 'status' || cmd === 'merge')) {
        // the form the ci-release skill writes: ff-pr merge <n> (w5166)
        if (o.pr !== undefined && o.pr !== a) return `${a} and ${o.pr} name different pull requests`;
        o.pr = a;
      } else return `unknown option ${a}`;
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (!['push', 'status', 'merge'].includes(cmd)) return cmd ? `unknown command ${cmd}` : 'no command';
  if ((o.title === undefined) !== (o.bodyFile === undefined)) return '--title and --body-file go together';
  return { cmd, o };
}

export const USAGE = `usage: ff-pr push [--base <branch>] [--title <t> --body-file <f>] [--draft] [--no-merge-base]
       ff-pr status [<n> | --pr <n>]
       ff-pr merge [<n> | --pr <n>]
  push: merge origin/<base> in (stops on a conflict), push the branch, open its PR when --title/--body-file are given
        and it has none, check that the PR's head is HEAD and it does not conflict (w907), and print the blocked_on to wait with
  status: the PR and its head's CI (workflow runs), nothing changed
  merge: merge the PR (--merge --match-head-commit) when every workflow run on its head finished green and, in
         Final-Factory/FinalFactory, pr_evidence.py --repo <repo> --pr <n> passes (w3088); else say what is red, running or failing
Exit: 0 done, 1 you must act (conflict, red, push not landed, Evidence check failed), 2 usage, 3 CI still running.
`;

const PR_FIELDS = 'number,url,headRefOid,mergeable,state,baseRefName,baseRefOid,headRefName,isCrossRepository';

function prView(d: PrDeps, pr?: string): Pr | undefined {
  const r = d.run('gh', ['pr', 'view', ...(pr ? [pr] : []), '--json', PR_FIELDS]);
  if (r.code !== 0) return undefined;
  try {
    return JSON.parse(r.out) as Pr;
  } catch {
    return undefined;
  }
}

function repoOf(url: string): string {
  return /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? '<owner/repo>';
}

function headRuns(d: PrDeps, sha: string, repo?: string): WorkflowRun[] | string {
  const r = d.run('gh', ['run', 'list', '--commit', sha, '--json', 'databaseId,name,workflowName,status,conclusion', '-L', '100']);
  if (r.code !== 0) return (r.err || r.out).trim().split('\n').slice(-3).join(' ');
  let runs: WorkflowRun[];
  try {
    runs = JSON.parse(r.out) as WorkflowRun[];
  } catch {
    return 'gh run list answered no JSON';
  }
  if (repo) settleAwayRuns(d, repo, runs);
  return runs;
}

/**
 * w3147 (machine/awayRunners.ts): a run that waits only on legs queued for an away runner label, every runner of it offline,
 * counts as a green finish, so ff-pr merges an ffu PR on green Linux and Windows legs while the m3 is off. w3272: a run
 * with a failed leg counts as a red finish at once, the m3 on or off. In place.
 */
export function settleAwayRuns(d: Pick<PrDeps, 'run'>, repo: string, runs: WorkflowRun[]): number {
  const labels = awayLabelsOf(repo);
  if (!labels.length || runs.every((w) => w.status === 'completed')) return 0;
  const rr = d.run('gh', ['api', `repos/${repo}/actions/runners?per_page=100`]);
  let away: string[] = [];
  try {
    if (rr.code === 0) away = offlineLabels(JSON.parse(rr.out) as Parameters<typeof offlineLabels>[0], labels);
  } catch {
    away = [];
  }
  let legs = 0;
  for (const w of runs) {
    if (w.status === 'completed') continue;
    const j = d.run('gh', ['api', `repos/${repo}/actions/runs/${w.databaseId}/jobs?per_page=100`]);
    if (j.code !== 0) continue;
    let jobs: Leg[];
    try {
      jobs = (JSON.parse(j.out) as { jobs?: Leg[] }).jobs ?? [];
    } catch {
      continue;
    }
    const s = settleJobs(jobs, away);
    if (!s) continue;
    w.status = 'completed';
    w.conclusion = s.conclusion;
    const name = `${w.name ?? w.workflowName ?? w.databaseId}`;
    if (s.conclusion === 'failure') w.name = `${name}${failedNote(s.failed)}`;
    else {
      legs += s.legs;
      w.name = `${name}${awayNote(s.legs, away)}`;
    }
  }
  return legs;
}

function ciLine(v: CiVerdict): string {
  if (v.state === 'none') return 'CI: no workflow run on this head yet (GitHub may not have started it; a branch gets CI only through a PR)';
  if (v.state === 'green') return 'CI: green';
  return `CI: ${v.state}${v.red.length ? `; red: ${v.red.join(', ')}` : ''}${v.pending.length ? `; running: ${v.pending.join(', ')}` : ''}`;
}

/**
 * w5017 (machine/ciPaths.ts): whether no workflow runs on this PR because its workflows' pull_request path filters, read
 * at the PR's base, leave out every file it changes (ffu's ci.yml ignores docs/**). Anything it cannot read says no.
 */
export function prSkipsCi(d: Pick<PrDeps, 'run'>, pr: Pr): { skips: boolean; why: string } {
  const repo = repoOf(pr.url);
  const ref = pr.baseRefOid || pr.baseRefName;
  const f = d.run('gh', ['api', `repos/${repo}/pulls/${pr.number}/files`, '--paginate', '--jq', '.[] | .filename, (.previous_filename // empty)']);
  if (f.code !== 0) return { skips: false, why: `its changed files could not be read: ${(f.err || f.out).trim().split('\n').pop()}` };
  const files = [...new Set(f.out.split('\n').map((l) => l.trim()).filter(Boolean))];
  const l = d.run('gh', ['api', `repos/${repo}/contents/.github/workflows?ref=${ref}`, '--jq', '.[] | select(.type == "file") | .name']);
  if (l.code !== 0) return { skips: false, why: `the base's workflows could not be listed: ${(l.err || l.out).trim().split('\n').pop()}` };
  const names = l.out
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => /\.ya?ml$/.test(n));
  const load = (name: string) => {
    const r = d.run('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/.github/workflows/${name}?ref=${ref}`]);
    return r.code === 0 ? r.out : undefined;
  };
  return noPrCi(names, load, files);
}

function noCiLine(pr: Pr, why: string): string {
  return `CI: none will run: ${why} (workflows at ${pr.baseRefName} ${(pr.baseRefOid || '').slice(0, 10)})`.replace(/ \)$/, ')');
}

function waitLine(pr: Pr, sha: string): string {
  return `next: mcp__machine__blocked_on with head "${sha}" and prs ["ci:${repoOf(pr.url)}#${pr.number}"], end your turn; on resume: ff-pr merge`;
}

function git(d: PrDeps, args: string[]): Ran {
  return d.run('git', args);
}

/**
 * w5069: a warning, never a refusal, for each dynamic TextMesh Pro font asset the branch changes where the Unity editor's
 * runtime atlas growth is the only change (server/editorNoise.ts fontAtlasNoise: glyph, character, glyph-rect and
 * kerning tables, and the atlas texture's pixels). A worker's `git add -A` commits them: 27 of the game repo's 227 FF
 * Factory saves did, and 6d6488f046 cancelled PR #4137's CI (w5067). A person may change a font on purpose, so it only
 * names them, with the command that drops them. Compared against the merge base: what this branch adds, not the base's.
 */
export function atlasWarning(d: PrDeps, base: string): string[] {
  const mb = git(d, ['merge-base', 'HEAD', `origin/${base}`]).out.trim();
  if (!mb) return [];
  const changed = git(d, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=M', mb, 'HEAD', '--', '*.asset']).out.split('\0').filter(Boolean);
  const noise: string[] = [];
  for (const f of changed) {
    const now = git(d, ['show', `HEAD:${f}`]);
    if (now.code !== 0 || !mayBeDynamicFont(f, now.out)) continue;
    const was = git(d, ['show', `${mb}:${f}`]);
    if (was.code === 0 && fontAtlasNoise(was.out, now.out)) noise.push(f);
  }
  if (noise.length) {
    const q = (f: string) => `"${f.replace(/(["$`\\])/g, '\\$1')}"`;
    d.write(
      `ff-pr: warning: ${noise.length} dynamic TMP font atlas(es) changed only by the Unity editor growing them at runtime (w5069), probably not yours to commit:\n` +
        noise.map((f) => `  ${f}\n`).join('') +
        `  to drop them: git checkout origin/${base} -- ${noise.map(q).join(' ')} && git commit -m "drop editor font atlas noise", then ff-pr push again\n`,
    );
  }
  return noise;
}

function defaultBase(d: PrDeps): string {
  const r = git(d, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  return r.code === 0 && r.out.trim() ? r.out.trim().replace(/^origin\//, '') : 'main';
}

export function push(d: PrDeps, o: Opts): number {
  const branch = git(d, ['branch', '--show-current']).out.trim();
  if (!branch) {
    d.write('ff-pr: not on a branch (detached HEAD)\n');
    return 1;
  }
  // The shell guard (server/guard.ts PROTECTED_BRANCH) never sees the push this script makes, so it refuses the same
  // ones: master/main take changes only through a pull request, and develop is retired (w1137).
  if (/^(?:master|main|develop)$/i.test(branch)) {
    d.write(`ff-pr: you are on ${branch}, which takes changes only through a pull request: commit on your own branch\n`);
    return 1;
  }
  let pr = prView(d);
  const base = o.base ?? pr?.baseRefName ?? defaultBase(d);
  if (base === branch) {
    d.write(`ff-pr: the base (${base}) is the branch itself\n`);
    return 1;
  }
  const dirty = git(d, ['status', '--porcelain', '--untracked-files=no']).out.trim();
  if (dirty) d.write(`ff-pr: note: ${dirty.split('\n').length} changed file(s) not committed; they are not pushed\n`);
  if (o.mergeBase) {
    const f = git(d, ['fetch', '-q', 'origin', base]);
    if (f.code !== 0) {
      d.write(`ff-pr: git fetch origin ${base} failed: ${(f.err || f.out).trim()}\n`);
      return 1;
    }
    const m = git(d, ['merge', '--no-edit', `origin/${base}`]);
    if (m.code !== 0) {
      const conflicts = git(d, ['diff', '--name-only', '--diff-filter=U']).out.trim();
      d.write(`ff-pr: merging origin/${base} stopped${conflicts ? ` on conflicts in:\n${conflicts}\n` : `: ${(m.err || m.out).trim()}\n`}Resolve, commit, and run ff-pr push again.\n`);
      return 1;
    }
    const said = m.out.trim().split('\n').pop() ?? '';
    d.write(`ff-pr: merged origin/${base}: ${said || 'done'}\n`);
  }
  atlasWarning(d, base);
  const p = git(d, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  if (p.code !== 0) {
    d.write(`ff-pr: git push failed:\n${(p.err || p.out).trim()}\n`);
    return 1;
  }
  const sha = git(d, ['rev-parse', 'HEAD']).out.trim();
  if (!pr || pr.state !== 'OPEN') {
    if (pr && pr.state === 'MERGED') {
      d.write(`ff-pr: ${pr.url} is already merged; open a new PR for these commits (--title/--body-file)\n`);
      if (!o.title) return 1;
    }
    if (!o.title || !o.bodyFile) {
      d.write(`ff-pr: pushed ${branch} at ${sha.slice(0, 10)}; it has no open PR: run ff-pr push --title <t> --body-file <f> to open one\n`);
      return 1;
    }
    if (!fs.existsSync(o.bodyFile)) {
      d.write(`ff-pr: no body file at ${o.bodyFile}\n`);
      return 1;
    }
    const c = d.run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', o.title, '--body-file', o.bodyFile, ...(o.draft ? ['--draft'] : [])]);
    if (c.code !== 0) {
      d.write(`ff-pr: gh pr create failed:\n${(c.err || c.out).trim()}\n`);
      return 1;
    }
    pr = undefined;
  }
  // w907: the push must show as the PR's head, and the PR must not conflict, before a CI wait means anything. GitHub
  // takes a few seconds to move the head and work out mergeable (UNKNOWN until then).
  for (let i = 0; i < 12; i++) {
    pr = prView(d);
    if (pr && pr.headRefOid === sha && pr.mergeable !== 'UNKNOWN') break;
    d.sleep(5_000);
  }
  if (!pr) {
    d.write('ff-pr: pushed, but gh pr view finds no PR for this branch\n');
    return 1;
  }
  if (pr.headRefOid !== sha) {
    d.write(`ff-pr: the push did not land: ${pr.url} is at ${pr.headRefOid.slice(0, 10)}, HEAD is ${sha.slice(0, 10)} (w907)\n`);
    return 1;
  }
  if (pr.mergeable === 'CONFLICTING') {
    d.write(`ff-pr: ${pr.url} conflicts with ${pr.baseRefName}: merge origin/${pr.baseRefName} in, resolve, and run ff-pr push again\n`);
    return 1;
  }
  evidenceWarning(d, pr);
  const skip = prSkipsCi(d, pr);
  const next = skip.skips ? `${noCiLine(pr, skip.why)}\nnext: ff-pr merge (no CI to wait for)` : waitLine(pr, sha);
  d.write(`ff-pr: ${pr.url} head ${sha} (${pr.mergeable.toLowerCase()}), base ${pr.baseRefName}\n${next}\n`);
  return 0;
}

/**
 * One Evidence check. w4926: when what is wrong is that this machine's ff-agents is a release behind (w4873's version bump
 * was refused at 1.34.382 against 1.34.383, and passed after a hand-run plugin update), ff-pr updates the plugin, finds the
 * newest pr_evidence.py again and runs it once more, instead of refusing for a reason no PR edit fixes. Any other refusal,
 * a failed update, or a second run's verdict stands as it is.
 */
function runEvidence(d: PrDeps, script: string, repo: string, pr: number): { r: Ran; v: ReturnType<typeof evidenceVerdict> } {
  const once = (s: string) => {
    const r = d.run(d.python ?? evidencePython(), evidenceArgs(s, repo, pr));
    return { r, v: evidenceVerdict(r.code, r.out, r.err) };
  };
  const first = once(script);
  const stale = first.v.ok ? null : STALE_EVIDENCE.exec(`${first.r.out}\n${first.r.err}`);
  if (!stale || !d.updatePlugin) return first;
  d.write(`ff-pr: this machine's pr_evidence.py is ff-agents ${stale[1]}, but ${stale[2]} is released: updating the plugin and checking again\n`);
  const failed = d.updatePlugin();
  if (failed) {
    d.write(`ff-pr: the plugin update failed: ${failed}\n`);
    return first;
  }
  return once(d.evidenceScript?.() ?? script);
}

/**
 * w4498: after a push, the Evidence check the merge will run, as a warning only: a description that fails it is fixed now,
 * not found after green CI (FinalFactory #3748 and #3760 had no Evidence section, each refused only at the merge).
 */
function evidenceWarning(d: PrDeps, pr: Pr): void {
  const repo = repoOf(pr.url);
  if (!evidenceGated(repo)) return;
  const script = d.evidenceScript?.();
  if (!script) return;
  const { r, v } = runEvidence(d, script, repo, pr.number);
  if (v.ok) return;
  d.write(
    `ff-pr: WARNING: ${evidenceRefusal(repo, pr.number, r.code, v)}\n` +
      `ff-pr merge and merge on green refuse it until it passes: give its description a "## Evidence" section (a "Kind:" line, Kind: other for tooling, tests or automation code; a claims table, | Claim | Basis |, each row MEASURED or SOURCED; a "Not verified:" line) with gh pr edit ${pr.number} --body-file <f>.\n`,
  );
}

function prAndCi(d: PrDeps, o: Opts): { pr: Pr; v: CiVerdict } | number {
  const pr = prView(d, o.pr);
  if (!pr) {
    d.write(`ff-pr: no PR ${o.pr ? o.pr : 'for this branch'} (gh pr view failed)\n`);
    return 1;
  }
  const runs = headRuns(d, pr.headRefOid, repoOf(pr.url));
  if (typeof runs === 'string') {
    d.write(`ff-pr: ${pr.url}: could not read its CI: ${runs}\n`);
    return 1;
  }
  return { pr, v: ciVerdict(runs) };
}

export function status(d: PrDeps, o: Opts): number {
  const got = prAndCi(d, o);
  if (typeof got === 'number') return got;
  const { pr, v } = got;
  const skip = v.state === 'none' ? prSkipsCi(d, pr) : undefined;
  d.write(`ff-pr: ${pr.url} ${pr.state.toLowerCase()}, head ${pr.headRefOid.slice(0, 10)}, ${pr.mergeable.toLowerCase()}, base ${pr.baseRefName}\n${skip?.skips ? noCiLine(pr, skip.why) : ciLine(v)}\n`);
  return v.state === 'green' || skip?.skips ? 0 : v.state === 'red' ? 1 : 3;
}

/**
 * w3088: a gated repository's pull request merges only when `pr_evidence.py --repo <repo> --pr <n>` exits 0. A FAIL, a
 * usage error, a gh failure or no script refuses, naming the failing lines; a pull request the script does not cover
 * (no game code or assets) passes there by itself.
 */
function evidencePasses(d: PrDeps, pr: Pr): boolean {
  const repo = repoOf(pr.url);
  if (!evidenceGated(repo)) return true;
  const script = d.evidenceScript?.();
  if (!script) {
    d.write(`ff-pr: not merged: ${noScriptRefusal(repo, pr.number)}\n`);
    return false;
  }
  const { r, v } = runEvidence(d, script, repo, pr.number);
  if (v.ok) {
    d.write(`ff-pr: Evidence: ${v.lines[0]}\n`);
    return true;
  }
  d.write(`ff-pr: not merged: ${pr.url}: ${evidenceRefusal(repo, pr.number, r.code, v)}\nFix the evidence or the claim (gh pr edit ${pr.number} --body-file <f>), then ff-pr merge again.\n`);
  return false;
}

/**
 * w5549 (the w5451 audit, item 17): ff-pr merge merges the worker's own pull request, the one of the branch it has checked
 * out, as merge on green does (server/mergeOwner.ts). A head in another repository (a fork) is refused, and so is a --pr
 * whose head branch is not the checkout's: the refusal names both. A careless `--pr <n>` with another worker's number is
 * caught here; this runs in the worker's own shell, so it is no wall against a worker that means harm (merge on green is).
 */
function notOwnPr(d: PrDeps, o: Opts, pr: Pr): string | undefined {
  if (pr.isCrossRepository === true) return `its head ${pr.headRefName ?? ''} is a branch of another repository (a fork), not of ${repoOf(pr.url)}`;
  if (!o.pr || !pr.headRefName) return undefined;
  const mine = git(d, ['branch', '--show-current']).out.trim();
  if (mine && mine === pr.headRefName) return undefined;
  return `its head branch is ${pr.headRefName}, and this checkout is on ${mine || 'no branch'}`;
}

export function merge(d: PrDeps, o: Opts): number {
  const got = prAndCi(d, o);
  if (typeof got === 'number') return got;
  const { pr, v } = got;
  const notOwn = pr.state === 'OPEN' ? notOwnPr(d, o, pr) : undefined;
  if (notOwn) {
    d.write(`ff-pr: not merged: ${pr.url} is not this branch's pull request: ${notOwn}. ff-pr merge merges only your own (w5549): run it in the checkout of the branch you pushed.\n`);
    return 1;
  }
  if (pr.state === 'MERGED') {
    d.write(`ff-pr: ${pr.url} is already merged\n`);
    return 0;
  }
  if (pr.state !== 'OPEN') {
    d.write(`ff-pr: ${pr.url} is ${pr.state.toLowerCase()}\n`);
    return 1;
  }
  // w5017: no workflow run at all, and none will come because every changed file is under the workflows' path filters
  // (an ffu docs/ PR): the head check below (--match-head-commit) is the gate. A run that exists, red or running, never
  // takes this way.
  const skip = v.state === 'none' ? prSkipsCi(d, pr) : undefined;
  if (skip?.skips) d.write(`ff-pr: ${noCiLine(pr, skip.why)}; merging on the head check\n`);
  else if (v.state !== 'green') {
    d.write(`ff-pr: not merged: ${pr.url} ${ciLine(v)}${skip ? ` (CI is expected: ${skip.why})` : ''}\n${v.state === 'red' ? 'Read a red run with gh run view <run> --log-failed, fix, and ff-pr push.\n' : `${waitLine(pr, pr.headRefOid)}\n`}`);
    return v.state === 'red' ? 1 : 3;
  }
  if (!evidencePasses(d, pr)) return 1;
  const m = d.run('gh', ['pr', 'merge', String(pr.number), '--merge', '--match-head-commit', pr.headRefOid]);
  if (m.code !== 0) {
    // w1867: a 502 from GitHub can come back on a merge it made ("Merge already in progress" on the retry, the PR page
    // OPEN for minutes after): the base holding the head is the answer, not the error.
    const landed =
      git(d, ['fetch', '-q', 'origin', pr.baseRefName]).code === 0 &&
      git(d, ['merge-base', '--is-ancestor', pr.headRefOid, `origin/${pr.baseRefName}`]).code === 0;
    if (landed) {
      d.write(`ff-pr: ${pr.url} merged at head ${pr.headRefOid.slice(0, 10)}: origin/${pr.baseRefName} holds it, though gh pr merge answered:\n${(m.err || m.out).trim()}\n(GitHub's PR page may show it open for a few minutes.)\n`);
      return 0;
    }
    d.write(`ff-pr: gh pr merge refused:\n${(m.err || m.out).trim()}\n`);
    return 1;
  }
  const after = prView(d, String(pr.number));
  d.write(`ff-pr: ${pr.url} ${after?.state === 'MERGED' ? 'merged' : `merge asked (state ${after?.state ?? 'unknown'})`} at head ${pr.headRefOid.slice(0, 10)}\n`);
  return 0;
}

/**
 * w5430: the worker environment's gh check, before anything is pushed. A worker whose gh cannot authenticate (the Low
 * fence's APPDATA move hid the machine's gh login: "You are not logged into any GitHub hosts") used to push its branch and
 * then fail at gh pr create. Answers the loud refusal, or undefined when gh is logged in. A run with GitHub Apps
 * (FF_GH_APP_NAMES) is left out: its gh token comes per repository (machine/ghApp.ts). gh's token lines are never repeated.
 */
export function ghAuthProblem(d: PrDeps, env: NodeJS.ProcessEnv = d.env ?? {}): string | undefined {
  if (env.FF_GH_APP_NAMES) return undefined;
  const r = d.run('gh', ['auth', 'status', '--hostname', 'github.com']);
  if (r.code === 0) return undefined;
  const said = `${r.out}\n${r.err}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/token/i.test(l))
    .slice(0, 2)
    .join(' / ');
  return (
    `ff-pr: gh cannot authenticate to github.com, so nothing is pushed or opened (gh auth status exited ${r.code}${said ? `: ${said.slice(0, 300)}` : ''}).\n` +
    `gh reads GH_TOKEN, else GH_CONFIG_DIR (${env.GH_CONFIG_DIR || 'unset'}), else %APPDATA%\\GitHub CLI (APPDATA ${env.APPDATA || 'unset'}). ` +
    'A Low-integrity sandbox worker gets GH_CONFIG_DIR from its daemon (w5430); without it this is an FF Factory fault to report to your orchestrator. Never copy a token into the environment.\n'
  );
}

export function prMain(argv: string[], d: PrDeps): number {
  const a = parseArgs(argv);
  if (typeof a === 'string') {
    d.write(`ff-pr: ${a}\n${USAGE}`);
    return 2;
  }
  const auth = ghAuthProblem(d);
  if (auth) {
    d.write(auth);
    return 1;
  }
  return a.cmd === 'push' ? push(d, a.o) : a.cmd === 'status' ? status(d, a.o) : merge(d, a.o);
}

export const realPrDeps: PrDeps = {
  run: (cmd, args) => {
    // gh on a repository a GitHub App is installed on (w1519): the app's token. Node finds gh.exe itself on Windows, past the
    // gh shim (a .cmd), so ff-pr asks machine/ghApp.ts directly; elsewhere the shim would do the same.
    const env = cmd === 'gh' && process.env.FF_GH_APP_NAMES ? (ghEnvFor(args, process.env, readGhAppTokens(process.env.FF_GH_APP_SESSION_FILE), remotesOf(process.cwd()), Date.now()) as NodeJS.ProcessEnv) : undefined;
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000, ...(env ? { env } : {}) });
    return { code: r.status ?? (r.error ? 127 : 1), out: r.stdout ?? '', err: r.stderr ?? (r.error ? r.error.message : '') };
  },
  write: (s) => void process.stdout.write(s),
  sleep: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  evidenceScript: () => findLocalPrEvidence(),
  updatePlugin: () => updateLocalPlugin(),
  env: process.env,
};

/** Write the ff-pr shims (sh for Git Bash and macOS/Linux, .cmd for PowerShell) into the agents' bin folder. */
export function installPrShim(bin: string, node = process.execPath, nodeArgs = process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), script = import.meta.filename): void {
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const q = (s: string) => `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
  fs.mkdirSync(bin, { recursive: true });
  const sh = path.join(bin, 'ff-pr');
  fs.writeFileSync(`${sh}.tmp`, `#!/bin/sh\n# FF Factory: a worker's pull request routine (machine/prFlow.ts). Written by the machine daemon at start.\nexec ${[fwd(node), ...nodeArgs, fwd(script)].map(q).join(' ')} "$@"\n`);
  fs.chmodSync(`${sh}.tmp`, 0o755);
  fs.renameSync(`${sh}.tmp`, sh);
  fs.writeFileSync(`${sh}.cmd`, `@echo off\r\nrem FF Factory: a worker's pull request routine (machine/prFlow.ts).\r\n${[node, ...nodeArgs, script].map((s) => `"${s}"`).join(' ')} %*\r\n`);
}

// Run when started directly (the ff-pr shim).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exit(prMain(process.argv.slice(2), realPrDeps));
  } catch (e) {
    process.stderr.write(`ff-pr: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
