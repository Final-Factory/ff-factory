import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkFlakyRerun, rerunTargets, resourceFault, type RerunJob, type RerunReader, type RerunTarget } from './rerunGuard.ts';
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
function reader(jobs: Fixture[] | RerunJob[] | { error: string }, notes?: string[] | { error: string }, logs: Record<number, string> | { error: string } = {}) {
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
    log(_repo, job) {
      return 'error' in logs && typeof logs.error === 'string' ? (logs as { error: string }) : ((logs as Record<number, string>)[job] ?? '');
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

// w3836: ffu run 42608839428's "clippy (ffu-windows)" (job 129131642138, ffu-beast-3, attempt 1) failed in its clippy step
// writing an .rmeta: "Insufficient quota to complete the requested service. (os error 1453)". The refused case is a real
// compile error: run 42537986568's "repeat" (job 128906443375, ffu-biscuit) failed on rustc error[E0433]. Both logs are the
// failing step's own lines from `gh api repos/Final-Factory/ffu/actions/jobs/<id>/logs` (2026-11-09), trimmed to them.
const text = (n: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', n), 'utf8');
const QUOTA_LOG = text('rerun-resource-fault-job.txt');
const E0433_LOG = text('rerun-compile-error-job.txt');
const CLIPPY: RerunJob = { id: 129131642138, name: 'clippy (ffu-windows)', conclusion: 'failure', run_attempt: 1, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run cargo clippy --workspace --all-targets --all-features --locked -- -D warnings', conclusion: 'failure' }] };
const REPEAT: RerunJob = { id: 128906443375, name: 'repeat', conclusion: 'failure', run_attempt: 1, steps: [{ name: 'Run cargo test --workspace --all-features --locked --no-run', conclusion: 'failure' }] };

test('w3836: the fixture logs read as a resource fault and as a real compile error', () => {
  assert.match(resourceFault(QUOTA_LOG)!, /Insufficient quota to complete the requested service\. \(os error 1453\)/);
  assert.equal(resourceFault(E0433_LOG), undefined);
  for (const line of [
    'error: linking with `link.exe` failed: exit code: 1171\nLINK : fatal error LNK1171: unable to load mspdbcore.dll (error code: 1455)',
    'error: failed to write ...: The paging file is too small for this operation to complete. (os error 1455)',
    'error: could not write output to ...: There is not enough space on the disk. (os error 112)',
    'error: failed to create directory: No space left on device (os error 28)',
    'memory allocation of 4294967296 bytes failed',
    'rustc-LLVM ERROR: out of memory',
  ])
    assert.ok(resourceFault(line), line);
  // A resource line beside a real failure is still a real failure.
  assert.equal(resourceFault(`${QUOTA_LOG}\ntest result: FAILED. 3 passed; 1 failed`), undefined);
  assert.equal(resourceFault("thread 'x' panicked at src/lib.rs:3:5:\nNo space left on device (os error 28)"), undefined);
});

test('w3836: an out-of-resource runner fault at attempt 1 may be rerun once; a compile error or attempt 2 stays refused', () => {
  const cmd = 'gh run rerun 42608839428 --failed -R Final-Factory/ffu';
  assert.equal(checkFlakyRerun(cmd, { reader: reader([OK, CLIPPY], undefined, { [CLIPPY.id]: QUOTA_LOG }).r }), undefined);
  assert.equal(checkFlakyRerun('gh run rerun --job 129131642138 -R Final-Factory/ffu', { reader: reader([CLIPPY], undefined, { [CLIPPY.id]: QUOTA_LOG }).r }), undefined);

  const second = checkFlakyRerun(cmd, { reader: reader([{ ...CLIPPY, run_attempt: 2 }], undefined, { [CLIPPY.id]: QUOTA_LOG }).r });
  assert.match(second!, /Refused \(w3836\).*os error 1453.*attempt 2: an out-of-resource fault is rerun once, at attempt 1/);
  assert.match(second!, /a flaky test gets its cause fixed/);
  assert.match(checkFlakyRerun(cmd, { reader: reader([{ ...CLIPPY, run_attempt: undefined }], undefined, { [CLIPPY.id]: QUOTA_LOG }).r })!, /attempt unknown/);

  const compile = checkFlakyRerun('gh run rerun 42537986568 --failed -R Final-Factory/ffu', { reader: reader([REPEAT], undefined, { [REPEAT.id]: E0433_LOG }).r });
  assert.match(compile!, /Refused \(w3784\): "repeat" \(job 128906443375\) of run 42537986568 in Final-Factory\/ffu failed in its step .*a real failure/);

  // One resource fault does not carry a real failure in another job of the same run.
  assert.ok(checkFlakyRerun(cmd, { reader: reader([CLIPPY, REPEAT], undefined, { [CLIPPY.id]: QUOTA_LOG, [REPEAT.id]: E0433_LOG }).r }));
  // A log gh cannot read is refused (fail closed).
  assert.match(checkFlakyRerun(cmd, { reader: reader([CLIPPY], undefined, { error: 'HTTP 410: Gone' }).r })!, /its log could not be read \(HTTP 410: Gone\)/);
});
