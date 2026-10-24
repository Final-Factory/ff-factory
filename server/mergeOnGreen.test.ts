import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMergeOnGreenPilot, mergeOnGreenPercent } from './mergeOnGreen.ts';
import { inPilot } from './autoCompact.ts';
import { normalizeSetting } from './appConfig.ts';
import { checksState, ghMerge, runsState } from './blockerWatch.ts';
import type { Config } from './config.ts';

/**
 * w2045 (lothsahn: "Have FF Factory merge green PRs itself with no model; the worker reports before the wait"): the pilot's
 * split and the green reading it merges on. The merge itself, end to end: orchestrators.test.ts, "w2045".
 */

const worker = (p: number | undefined) => ({ worker: { mergeOnGreenPilotPercent: p } as Config['worker'] });
const ids = Array.from({ length: 2000 }, (_, i) => `w${i + 1}`);

test('mergeOnGreenPercent: 0 (off) by default; config sets it; over 100 is all', () => {
  assert.equal(mergeOnGreenPercent({}), 0);
  assert.equal(mergeOnGreenPercent(worker(50)), 50);
  assert.equal(mergeOnGreenPercent(worker(250)), 100);
  assert.equal(normalizeSetting('worker.mergeOnGreenPilotPercent', '50'), 50);
  assert.throws(() => normalizeSetting('worker.mergeOnGreenPilotPercent', 101), /whole number from 0 to 100/);
  assert.equal(ids.filter((id) => inMergeOnGreenPilot(id, {})).length, 0, 'off: no request is in it');
  assert.equal(ids.filter((id) => inMergeOnGreenPilot(id, worker(100))).length, ids.length);
});

test('the arm: a stable half of REQUEST ids at 50, a 2x2 with w2043 (fresh session after a merge, `fresh:` by request)', () => {
  const arm = new Set(ids.filter((id) => inMergeOnGreenPilot(id, worker(50))));
  assert.ok(arm.size > 900 && arm.size < 1100, `${arm.size} of 2000`);
  assert.equal(inMergeOnGreenPilot('W7', worker(50)), inMergeOnGreenPilot('w7', worker(50)), 'the id is read in lower case');
  const fresh = new Set(ids.filter((id) => inPilot(`fresh:${id}`, 50)));
  const cells = [
    ids.filter((id) => arm.has(id) && fresh.has(id)).length,
    ids.filter((id) => arm.has(id) && !fresh.has(id)).length,
    ids.filter((id) => !arm.has(id) && fresh.has(id)).length,
    ids.filter((id) => !arm.has(id) && !fresh.has(id)).length,
  ];
  for (const c of cells) assert.ok(c > 400 && c < 600, `each cell near 500: ${cells.join(', ')}`);
});

test('green only when every check passed or skipped: a red, a running or a merged PR is never green', () => {
  const ref = 'Final-Factory/FinalFactory#1';
  assert.equal(checksState({ statusCheckRollup: [{ name: 'Test in editmode', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'x', status: 'COMPLETED', conclusion: 'SKIPPED' }] }, ref).green, true);
  assert.equal(checksState({ statusCheckRollup: [{ name: 'Test in editmode', status: 'COMPLETED', conclusion: 'FAILURE' }] }, ref).green, undefined);
  assert.equal(checksState({ statusCheckRollup: [{ name: 'Test in editmode', status: 'IN_PROGRESS' }] }, ref).green, undefined);
  assert.equal(checksState({ statusCheckRollup: [{ name: 'Test in editmode', status: 'COMPLETED', conclusion: 'CANCELLED' }] }, ref).green, undefined);
  assert.equal(checksState({ state: 'MERGED' }, ref).green, undefined);
  assert.equal(checksState({ statusCheckRollup: [] }, ref).green, undefined);
  assert.equal(runsState({ workflow_runs: [{ name: 'Test Runner', status: 'completed', conclusion: 'success' }] }, ref).green, true);
  assert.equal(runsState({ workflow_runs: [{ name: 'Test Runner', status: 'completed', conclusion: 'failure' }] }, ref).green, undefined);
  assert.equal(runsState({ workflow_runs: [{ name: 'Test Runner', status: 'completed', conclusion: 'startup_failure' }] }, ref).green, undefined);
  assert.equal(runsState({ workflow_runs: [] }, ref).green, undefined);
});

test('ghMerge: gh pr merge at exactly the head, with the repo named; what gh said when it refuses', async () => {
  const calls: string[][] = [];
  await ghMerge('Final-Factory/FinalFactory#12', 'abc1234def', async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: '', stderr: '' } as never;
  });
  assert.deepEqual(calls, [['gh', 'pr', 'merge', '12', '-R', 'Final-Factory/FinalFactory', '--merge', '--match-head-commit', 'abc1234def']]);
  await assert.rejects(
    ghMerge('Final-Factory/FinalFactory#12', 'abc1234def', async () => ({ code: 1, stdout: '', stderr: 'Head branch was modified. Review and try the merge again.' }) as never),
    /gh pr merge Final-Factory\/FinalFactory#12: Head branch was modified/,
  );
});
