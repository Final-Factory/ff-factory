import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkFlakyRerun, rerunTargets, type RerunJob, type RerunReader, type RerunTarget } from './rerunGuard.ts';
import { sandboxGuard } from './guard.ts';

// w3784: both fixtures are the `test (ffu-windows)` job of ffu PR #510's CI run 42538461342, read with
// `gh api repos/Final-Factory/ffu/actions/jobs/<id>` and `.../check-runs/<id>/annotations` (2026-11-08). Attempt 1 lost its
// runner (ffu-beast-2) with zero steps and the lost-communication annotation; attempt 2 failed in cargo test with
// owner_term timeouts, and w3738 re-ran it to get green.
type Fixture = RerunJob & { annotations: { message: string }[] };
const load = (n: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', n), 'utf8')) as Fixture;
const RUNNER_LOSS = load('rerun-runner-loss-job.json');
const OWNER_TERM = load('rerun-owner-term-job.json');
const OK: RerunJob = { id: 1, name: 'fmt', conclusion: 'success', steps: [{ name: 'cargo fmt', conclusion: 'success' }] };

/** A reader over fixed jobs; records what it was asked. */
function reader(jobs: Fixture[] | RerunJob[] | { error: string }, notes?: string[] | { error: string }) {
  const asked: { jobs: RerunTarget[]; notes: number[] } = { jobs: [], notes: [] };
  const r: RerunReader = {
    jobs(t) {
      asked.jobs.push(t);
      return jobs;
    },
    annotations(_repo, job) {
      asked.notes.push(job);
      if (notes) return notes;
      const j = (Array.isArray(jobs) ? jobs : []).find((x) => x.id === job) as Fixture | undefined;
      return (j?.annotations ?? []).map((a) => a.message);
    },
  };
  return { r, asked };
}

test('the fixtures are what they say: zero steps with runner loss, and a failed cargo test step', () => {
  assert.equal(RUNNER_LOSS.steps.length, 0);
  assert.equal(RUNNER_LOSS.conclusion, 'failure');
  assert.match(RUNNER_LOSS.annotations[0].message, /self-hosted runner lost communication with the server/);
  assert.equal(OWNER_TERM.conclusion, 'failure');
  assert.ok(OWNER_TERM.steps.some((s) => s.conclusion === 'failure' && /cargo test/.test(s.name)));
});

test('a rerun of a job that failed in a step is refused, quoting Ben\'s rule and the other route', () => {
  for (const cmd of [
    'gh run rerun 42538461342 --failed -R Final-Factory/ffu',
    'gh run rerun 42538461342 --failed',
    'gh run rerun 42538461342',
    'gh run rerun --job 128943801750 --repo Final-Factory/ffu',
    'gh run rerun -j 128943801750',
    'gh -R Final-Factory/ffu run rerun --failed 42538461342 2>&1 | tail -3',
    'cd "$TMPDIR/ffu" && gh run rerun 42538461342 --failed',
    'bash -c "gh run rerun 42538461342 --failed"',
    'gh api -X POST repos/Final-Factory/ffu/actions/runs/42538461342/rerun-failed-jobs',
    'gh api --method POST repos/Final-Factory/ffu/actions/jobs/128943801750/rerun',
  ]) {
    const { r } = reader([OK, OWNER_TERM]);
    const why = checkFlakyRerun(cmd, { reader: r });
    assert.ok(why, cmd);
    assert.match(why!, /a flaky test gets its cause fixed\. Never rerun it to get green, and never lengthen a timeout on its own\./);
    assert.match(why!, /merge past the unrelated red and name that request \(wNNN\)/);
    assert.match(why!, /Run \.\/tools\/check_temp_leaks\.sh cargo test/);
  }
});

test('a rerun of a runner that died with zero steps is allowed without reading annotations', () => {
  const { r, asked } = reader([OK, RUNNER_LOSS]);
  assert.equal(checkFlakyRerun('gh run rerun 42538461342 --failed -R Final-Factory/ffu', { reader: r }), undefined);
  assert.deepEqual(asked.jobs, [{ repo: 'Final-Factory/ffu', run: '42538461342', job: undefined }]);
  assert.deepEqual(asked.notes, []);
});

test('a failed job with steps but none failed passes only with the lost-communication annotation', () => {
  const cut: Fixture = { ...RUNNER_LOSS, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'cargo test', conclusion: null }] };
  assert.equal(checkFlakyRerun('gh run rerun 1 --failed', { reader: reader([cut]).r }), undefined);
  const plain: Fixture = { ...cut, annotations: [{ message: 'The job running on runner X has exceeded the maximum execution time of 60 minutes.' }] };
  assert.match(checkFlakyRerun('gh run rerun 1 --failed', { reader: reader([{ ...plain, conclusion: 'timed_out' }]).r })!, /timed out with steps and no runner-loss annotation/);
  assert.match(checkFlakyRerun('gh run rerun 1 --failed', { reader: reader([cut], { error: 'Resource not accessible by personal access token' }).r })!, /annotations could not be read \(Resource not accessible/);
});

test('a run gh cannot read is refused (fail closed); one with no failed job passes', () => {
  assert.match(checkFlakyRerun('gh run rerun 9 --failed', { reader: reader({ error: 'HTTP 404: Not Found' }).r })!, /run 9 could not be read \(HTTP 404: Not Found\)/);
  assert.equal(checkFlakyRerun('gh run rerun 9', { reader: reader([OK, { ...OWNER_TERM, conclusion: 'cancelled' }]).r }), undefined);
});

test('other gh run and api calls are not reruns', () => {
  for (const cmd of ['gh run view 42538461342 --log-failed | tail -80', 'gh run list --commit abc', 'gh run rerun', 'gh api repos/o/r/actions/runs/1/jobs', 'git commit -m "gh run rerun 1 --failed"', 'grep -n "run rerun" server/*.ts'])
    assert.deepEqual(rerunTargets(cmd), [], cmd);
  assert.deepEqual(rerunTargets('gh run rerun 5 --repo=o/r --job=7 --debug'), [{ repo: 'o/r', run: '5', job: '7' }]);
  assert.deepEqual(rerunTargets('gh api -X POST repos/{owner}/{repo}/actions/runs/5/rerun -R o/r'), [{ repo: 'o/r', run: '5' }]);
});

test('the sandbox guard denies the owner_term rerun and lets the runner-loss rerun through', async () => {
  const guard = (jobs: Fixture[]) => sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: [], prBase: () => undefined, evidence: () => undefined, rerunJobs: reader(jobs).r });
  const call = (g: ReturnType<typeof guard>) =>
    g({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh run rerun 42538461342 --failed -R Final-Factory/ffu' }, cwd: 'C:/ffsb/sb1', session_id: 's', transcript_path: 't' } as never, undefined, { signal: new AbortController().signal });
  const denied = (await call(guard([OWNER_TERM]))) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput!.permissionDecisionReason!, /w3784/);
  assert.deepEqual(await call(guard([RUNNER_LOSS])), {});
});
