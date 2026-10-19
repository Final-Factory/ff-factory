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
      else if (a === '--pr') o.pr = val();
      else if (a === '--draft') o.draft = true;
      else if (a === '--no-merge-base') o.mergeBase = false;
      else return `unknown option ${a}`;
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (!['push', 'status', 'merge'].includes(cmd)) return cmd ? `unknown command ${cmd}` : 'no command';
  if ((o.title === undefined) !== (o.bodyFile === undefined)) return '--title and --body-file go together';
  return { cmd, o };
}

export const USAGE = `usage: ff-pr push [--base <branch>] [--title <t> --body-file <f>] [--draft] [--no-merge-base]
       ff-pr status [--pr <n>]
       ff-pr merge [--pr <n>]
  push: merge origin/<base> in (stops on a conflict), push the branch, open its PR when --title/--body-file are given
        and it has none, check that the PR's head is HEAD and it does not conflict (w907), and print the blocked_on to wait with
  status: the PR and its head's CI (workflow runs), nothing changed
  merge: merge the PR (--merge --match-head-commit) when every workflow run on its head finished green; else say what is red or running
Exit: 0 done, 1 you must act (conflict, red, push not landed), 2 usage, 3 CI still running.
`;

const PR_FIELDS = 'number,url,headRefOid,mergeable,state,baseRefName';

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

function headRuns(d: PrDeps, sha: string): WorkflowRun[] | string {
  const r = d.run('gh', ['run', 'list', '--commit', sha, '--json', 'databaseId,name,workflowName,status,conclusion', '-L', '100']);
  if (r.code !== 0) return (r.err || r.out).trim().split('\n').slice(-3).join(' ');
  try {
    return JSON.parse(r.out) as WorkflowRun[];
  } catch {
    return 'gh run list answered no JSON';
  }
}

function ciLine(v: CiVerdict): string {
  if (v.state === 'none') return 'CI: no workflow run on this head yet (GitHub may not have started it; a branch gets CI only through a PR)';
  if (v.state === 'green') return 'CI: green';
  return `CI: ${v.state}${v.red.length ? `; red: ${v.red.join(', ')}` : ''}${v.pending.length ? `; running: ${v.pending.join(', ')}` : ''}`;
}

function waitLine(pr: Pr, sha: string): string {
  return `next: mcp__machine__blocked_on with head "${sha}" and prs ["ci:${repoOf(pr.url)}#${pr.number}"], end your turn; on resume: ff-pr merge`;
}

function git(d: PrDeps, args: string[]): Ran {
  return d.run('git', args);
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
  d.write(`ff-pr: ${pr.url} head ${sha} (${pr.mergeable.toLowerCase()}), base ${pr.baseRefName}\n${waitLine(pr, sha)}\n`);
  return 0;
}

function prAndCi(d: PrDeps, o: Opts): { pr: Pr; v: CiVerdict } | number {
  const pr = prView(d, o.pr);
  if (!pr) {
    d.write(`ff-pr: no PR ${o.pr ? o.pr : 'for this branch'} (gh pr view failed)\n`);
    return 1;
  }
  const runs = headRuns(d, pr.headRefOid);
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
  d.write(`ff-pr: ${pr.url} ${pr.state.toLowerCase()}, head ${pr.headRefOid.slice(0, 10)}, ${pr.mergeable.toLowerCase()}, base ${pr.baseRefName}\n${ciLine(v)}\n`);
  return v.state === 'green' ? 0 : v.state === 'red' ? 1 : 3;
}

export function merge(d: PrDeps, o: Opts): number {
  const got = prAndCi(d, o);
  if (typeof got === 'number') return got;
  const { pr, v } = got;
  if (pr.state === 'MERGED') {
    d.write(`ff-pr: ${pr.url} is already merged\n`);
    return 0;
  }
  if (pr.state !== 'OPEN') {
    d.write(`ff-pr: ${pr.url} is ${pr.state.toLowerCase()}\n`);
    return 1;
  }
  if (v.state !== 'green') {
    d.write(`ff-pr: not merged: ${pr.url} ${ciLine(v)}\n${v.state === 'red' ? 'Read a red run with gh run view <run> --log-failed, fix, and ff-pr push.\n' : `${waitLine(pr, pr.headRefOid)}\n`}`);
    return v.state === 'red' ? 1 : 3;
  }
  const m = d.run('gh', ['pr', 'merge', String(pr.number), '--merge', '--match-head-commit', pr.headRefOid]);
  if (m.code !== 0) {
    d.write(`ff-pr: gh pr merge refused:\n${(m.err || m.out).trim()}\n`);
    return 1;
  }
  const after = prView(d, String(pr.number));
  d.write(`ff-pr: ${pr.url} ${after?.state === 'MERGED' ? 'merged' : `merge asked (state ${after?.state ?? 'unknown'})`} at head ${pr.headRefOid.slice(0, 10)}\n`);
  return 0;
}

export function prMain(argv: string[], d: PrDeps): number {
  const a = parseArgs(argv);
  if (typeof a === 'string') {
    d.write(`ff-pr: ${a}\n${USAGE}`);
    return 2;
  }
  return a.cmd === 'push' ? push(d, a.o) : a.cmd === 'status' ? status(d, a.o) : merge(d, a.o);
}

export const realPrDeps: PrDeps = {
  run: (cmd, args) => {
    // gh on a repository a GitHub App is installed on (w1519): the app's token. Node finds gh.exe itself on Windows, past the
    // gh shim (a .cmd), so ff-pr asks machine/ghApp.ts directly; elsewhere the shim would do the same.
    const env = cmd === 'gh' && process.env.FF_GH_APP_NAMES ? (ghEnvFor(args, process.env, readGhAppTokens(process.env.FF_GH_APP_FILE), remotesOf(process.cwd()), Date.now()) as NodeJS.ProcessEnv) : undefined;
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000, ...(env ? { env } : {}) });
    return { code: r.status ?? (r.error ? 127 : 1), out: r.stdout ?? '', err: r.stderr ?? (r.error ? r.error.message : '') };
  },
  write: (s) => void process.stdout.write(s),
  sleep: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
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
