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
}

/** What a rerun names: the run, or one job; `repo` is gh's OWNER/REPO, absent for the cwd's own repository. */
export interface RerunTarget {
  repo?: string;
  run?: string;
  job?: string;
}

/**
 * Reads the jobs a rerun would start again (the run's latest attempt, or the one job) and a job's check-run annotation
 * messages. A failure answers `{ error }`.
 */
export interface RerunReader {
  jobs(t: RerunTarget, cwd: string | undefined, env?: Record<string, string | undefined>): RerunJob[] | { error: string };
  annotations(repo: string | undefined, job: number, cwd: string | undefined, env?: Record<string, string | undefined>): string[] | { error: string };
}

export const RULE = '"a flaky test gets its cause fixed. Never rerun it to get green, and never lengthen a timeout on its own."';
const ROUTE =
  'Fix the flake\'s cause instead; or, when that fix already has its own request, merge past the unrelated red and name that ' +
  'request (wNNN) in the PR. Only a job whose runner died may be rerun: zero steps, or the annotation "The self-hosted runner ' +
  'lost communication with the server".';
const LOST = /self-hosted runner lost communication with the server/i;

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
        return [{ id: j.id, name: j.name, conclusion: j.conclusion, steps: j.steps ?? [] }];
      }
      const out = gh(['api', '--paginate', `repos/${repo}/actions/runs/${t.run}/jobs?per_page=100`, '--jq', '.jobs[] | {id, name, conclusion, steps: [(.steps // [])[] | {name, conclusion}]}'], cwd, env);
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
      if (step)
        return `Refused (w3784): "${j.name}" (job ${j.id})${t.job ? "" : ` of run ${t.run}`}${where} failed in its step "${step.name}": that is a real failure, not a runner that died. Ben's rule: ${RULE} ${ROUTE}`;
    }
    for (const j of failed) {
      if (!j.steps.length) continue;
      const notes = read.annotations(t.repo, j.id, ctx.cwd, ctx.env);
      if (!Array.isArray(notes))
        return `Refused (w3784): "${j.name}" (job ${j.id})${t.job ? "" : ` of run ${t.run}`}${where} ran steps, and its annotations could not be read (${notes.error}) to show its runner died. Ben's rule: ${RULE} ${ROUTE}`;
      if (!notes.some((n) => LOST.test(n)))
        return `Refused (w3784): "${j.name}" (job ${j.id})${t.job ? "" : ` of run ${t.run}`}${where} ${j.conclusion === 'timed_out' ? 'timed out' : 'failed'} with steps and no runner-loss annotation. Ben's rule: ${RULE} ${ROUTE}`;
    }
  }
  return undefined;
}
