import { execFileSync } from 'node:child_process';
import { simpleCommands } from './waitGuard.ts';

/**
 * The rerun guard of a worker's shell (w3784, ben). Ben's standing rule: "a flaky test gets its cause fixed. Never rerun it
 * to get green, and never lengthen a timeout on its own." It was written in the evidence-gate merge checklist and in
 * ffu-build-test, and workers that had not loaded those skills broke it twice on 2026-11-08: w3676 re-ran a flaky Windows
 * job, and w3738 re-ran ffu PR #510's failed `test (ffu-windows)` job (run 42538461342, attempt 3) past owner_term timeouts.
 *
 * checkFlakyRerun reads the jobs a rerun would start again from GitHub and refuses when one of them failed in a step
 * (`gh run rerun <id>`, `--failed`, `--job <id>`, and the API's `.../rerun`, `.../rerun-failed-jobs`, `.../jobs/<id>/rerun`).
 * A failed job may be rerun only when its runner died: zero steps, or the check run's annotation "The self-hosted runner
 * lost communication with the server" (run 42538461342's attempt 1, ffu-beast-2, had both). A run gh cannot read is refused
 * (fail closed). Like the rest of the guard it is a SEATBELT: a script file that reruns is the instructions' job.
 *
 * w3836 (ben): a job that failed in a step because its runner ran out of a resource may be rerun once, at attempt 1. ffu run
 * 42608839428's "clippy (ffu-windows)" on ffu-beast-3 failed writing an .rmeta with "Insufficient quota to complete the
 * requested service. (os error 1453)" while the same code passed clippy on macOS and the Windows test job beside it. The
 * job's log is read (`gh api .../actions/jobs/<id>/logs`): an out-of-resource error (RESOURCE_FAULT) with no real failure
 * beside it (REAL_FAILURE: a rustc error[E....], a failed test) passes; a second attempt, or a log that cannot be read, does not.
 */

export interface RerunStep {
  name: string;
  conclusion: string | null;
}

export interface RerunJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps: RerunStep[];
  /** The run attempt the job belongs to (1 before any rerun). Absent: unknown, so no resource-fault rerun. */
  run_attempt?: number;
}

/** What a rerun names: the run, or one job; `repo` is gh's OWNER/REPO, absent for the cwd's own repository. */
export interface RerunTarget {
  repo?: string;
  run?: string;
  job?: string;
}

/**
 * Reads the jobs a rerun would start again (the run's latest attempt, or the one job) and a job's check-run annotation
 * messages and log. A failure answers `{ error }`.
 */
export interface RerunReader {
  jobs(t: RerunTarget, cwd: string | undefined, env?: Record<string, string | undefined>): RerunJob[] | { error: string };
  annotations(repo: string | undefined, job: number, cwd: string | undefined, env?: Record<string, string | undefined>): string[] | { error: string };
  log(repo: string | undefined, job: number, cwd: string | undefined, env?: Record<string, string | undefined>): string | { error: string };
}

export const RULE = '"a flaky test gets its cause fixed. Never rerun it to get green, and never lengthen a timeout on its own."';
const ROUTE =
  'Fix the flake\'s cause instead; or, when that fix already has its own request, merge past the unrelated red and name that ' +
  'request (wNNN) in the PR. Only a job whose runner died may be rerun: zero steps, or the annotation "The self-hosted runner ' +
  'lost communication with the server"; or, once (attempt 1), a step that failed because the runner ran out of memory, disk, ' +
  'page file or commit quota (os error 1453, 1455, 112, 28).';
const LOST = /self-hosted runner lost communication with the server/i;

/**
 * w3836: the runner ran out of a resource. Windows: 1453 "Insufficient quota to complete the requested service" (commit
 * memory, ffu run 42608839428), 1455 "The paging file is too small" (LNK1171 cites it), 112 "There is not enough space on
 * the disk"; POSIX: 28 "No space left on device"; and a process out of memory.
 */
export const RESOURCE_FAULT =
  /\(os error (?:1453|1455|112|28)\)|Insufficient quota to complete the requested service|paging file is too small|LNK1171.*\b1455\b|No space left on device|not enough space on the disk|\bout of memory\b|memory allocation of \d+ bytes failed/i;
/** w3836: a real failure in the same log keeps the rerun refused: a rustc error code, a failed test, a panic. */
export const REAL_FAILURE = /error\[E\d{4}\]|test result: FAILED|^\s*failures:\s*$|panicked at/im;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** w3836: the out-of-resource line of a job's log, when that and no real failure is why it failed. Exported for tests. */
export function resourceFault(log: string): string | undefined {
  const lines = log.replace(ANSI, '').split(/\r?\n/);
  if (lines.some((l) => REAL_FAILURE.test(l))) return undefined;
  return lines.find((l) => RESOURCE_FAULT.test(l))?.replace(/^\S+Z\s+/, '').trim().slice(0, 240);
}

/** A job the rerun starts again because it failed (a cancelled or skipped job is not a red test). */
const FAILED = new Set(['failure', 'timed_out']);

function gh(args: string[], cwd: string | undefined, env?: Record<string, string | undefined>): string {
  return execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } as NodeJS.ProcessEnv });
}

const why = (e: unknown) => {
  const err = e as { stderr?: string; message?: string };
  return (String(err.stderr ?? '').trim().split('\n').pop() || err.message || String(e)).slice(0, 300);
};

/** RerunReader through gh api; `{owner}/{repo}` is gh's own placeholder for the cwd's repository. */
export const ghRerunReader: RerunReader = {
  jobs(t, cwd, env) {
    const repo = t.repo ?? '{owner}/{repo}';
    try {
      if (t.job) {
        const j = JSON.parse(gh(['api', `repos/${repo}/actions/jobs/${t.job}`], cwd, env)) as RerunJob;
        return [{ id: j.id, name: j.name, conclusion: j.conclusion, steps: j.steps ?? [], run_attempt: j.run_attempt }];
      }
      const out = gh(['api', '--paginate', `repos/${repo}/actions/runs/${t.run}/jobs?per_page=100`, '--jq', '.jobs[] | {id, name, conclusion, run_attempt, steps: [(.steps // [])[] | {name, conclusion}]}'], cwd, env);
      return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as RerunJob);
    } catch (e) {
      return { error: why(e) };
    }
  },
  annotations(repo, job, cwd, env) {
    try {
      const out = gh(['api', '--paginate', `repos/${repo ?? '{owner}/{repo}'}/check-runs/${job}/annotations`, '--jq', '.[].message'], cwd, env);
      return out.split('\n').filter((l) => l.trim());
    } catch (e) {
      return { error: why(e) };
    }
  },
  log(repo, job, cwd, env) {
    try {
      return execFileSync('gh', ['api', `repos/${repo ?? '{owner}/{repo}'}/actions/jobs/${job}/logs`], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } as NodeJS.ProcessEnv });
    } catch (e) {
      return { error: why(e) };
    }
  },
};

const REPO_FLAG = /^(?:--repo|-R)$/;

/** The reruns a shell command asks for. Exported for tests. */
export function rerunTargets(cmd: string): RerunTarget[] {
  const out: RerunTarget[] = [];
  for (const c of simpleCommands(cmd)) {
    if (c.verb !== 'gh') continue;
    let repo: string | undefined;
    const a: string[] = [];
    for (let k = 0; k < c.args.length; k++) {
      const x = c.args[k];
      if (REPO_FLAG.test(x)) repo = c.args[++k];
      else if (/^--repo=/.test(x)) repo = x.slice(7);
      else if (/^-R./.test(x)) repo = x.slice(2).replace(/^=/, '');
      else a.push(x);
    }
    if (a[0] === 'run' && a[1] === 'rerun') {
      let run: string | undefined;
      let job: string | undefined;
      for (let k = 2; k < a.length; k++) {
        const x = a[k];
        if (x === '--job' || x === '-j') job = a[++k];
        else if (/^--job=/.test(x)) job = x.slice(6);
        else if (/^-j\d/.test(x)) job = x.slice(2);
        else if (/^\d+$/.test(x) && !run) run = x;
      }
      // `gh run rerun` with neither asks interactively, which a worker's shell cannot answer: nothing reruns.
      if (run || job) out.push({ repo, run, job });
      continue;
    }
    if (a[0] === 'api') {
      for (const x of a.slice(1)) {
        const m = /^\/?repos\/([^/\s]+\/[^/\s]+)\/actions\/(runs|jobs)\/(\d+)\/(rerun|rerun-failed-jobs)\/?(?:\?.*)?$/.exec(x);
        if (!m) continue;
        const r = m[1] === '{owner}/{repo}' || m[1] === ':owner/:repo' ? repo : m[1];
        out.push(m[2] === 'jobs' ? { repo: r, job: m[3] } : { repo: r, run: m[3] });
      }
    }
  }
  return out;
}

/**
 * The reason a shell command reruns a CI job whose steps really failed, or undefined. Exported for tests.
 */
export function checkFlakyRerun(cmd: string, ctx: { cwd?: string; env?: Record<string, string | undefined>; reader?: RerunReader } = {}): string | undefined {
  const targets = rerunTargets(cmd);
  if (!targets.length) return undefined;
  const read = ctx.reader ?? ghRerunReader;
  for (const t of targets) {
    const what = t.job ? `job ${t.job}` : `run ${t.run}`;
    const where = t.repo ? ` in ${t.repo}` : '';
    const jobs = read.jobs(t, ctx.cwd, ctx.env);
    if (!Array.isArray(jobs))
      return `Refused (w3784): ${what}${where} could not be read (${jobs.error}), so this rerun cannot be checked against Ben's rule ${RULE} ${ROUTE} Read the jobs with \`gh api repos/<owner>/<repo>/actions/runs/<id>/jobs\` and \`gh run view <id> --log-failed\`.`;
    const failed = jobs.filter((j) => FAILED.has(String(j.conclusion)));
    for (const j of failed) {
      const step = j.steps.find((s) => s.conclusion === 'failure');
      if (!step) continue;
      const of = `"${j.name}" (job ${j.id})${t.job ? '' : ` of run ${t.run}`}${where}`;
      // w3836: once, a runner that ran out of a resource; a second attempt means the fault is the job's, or the machine's.
      const log = read.log(t.repo, j.id, ctx.cwd, ctx.env);
      const fault = typeof log === 'string' ? resourceFault(log) : undefined;
      if (fault && j.run_attempt === 1) continue;
      if (fault)
        return `Refused (w3836): ${of} failed in its step "${step.name}" on a runner out of resources ("${fault}"), but it is attempt ${j.run_attempt ?? 'unknown'}: an out-of-resource fault is rerun once, at attempt 1. A second one is the machine's to fix (its page file, disk or runner count) or the job's. Ben's rule: ${RULE} ${ROUTE}`;
      if (typeof log !== 'string')
        return `Refused (w3784): ${of} failed in its step "${step.name}", and its log could not be read (${log.error}) to show its runner ran out of resources. Ben's rule: ${RULE} ${ROUTE}`;
      return `Refused (w3784): ${of} failed in its step "${step.name}": that is a real failure, not a runner that died. Ben's rule: ${RULE} ${ROUTE}`;
    }
    for (const j of failed) {
      // Zero steps: the runner died. A failed step was settled above (w3836: a resource fault at attempt 1 passes).
      if (!j.steps.length || j.steps.some((s) => s.conclusion === 'failure')) continue;
      const notes = read.annotations(t.repo, j.id, ctx.cwd, ctx.env);
      if (!Array.isArray(notes))
        return `Refused (w3784): "${j.name}" (job ${j.id})${t.job ? "" : ` of run ${t.run}`}${where} ran steps, and its annotations could not be read (${notes.error}) to show its runner died. Ben's rule: ${RULE} ${ROUTE}`;
      if (!notes.some((n) => LOST.test(n)))
        return `Refused (w3784): "${j.name}" (job ${j.id})${t.job ? "" : ` of run ${t.run}`}${where} ${j.conclusion === 'timed_out' ? 'timed out' : 'failed'} with steps and no runner-loss annotation. Ben's rule: ${RULE} ${ROUTE}`;
    }
  }
  return undefined;
}
