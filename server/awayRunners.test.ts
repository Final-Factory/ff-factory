import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitsOnlyAway, awayLabelsOf, isAwayLeg, offlineLabels } from '../machine/awayRunners.ts';
import { settleAwayRuns, type WorkflowRun } from '../machine/prFlow.ts';
import { checksState, ghChecks } from './blockerWatch.ts';

// w3147: measured 2026-11-06 04:08Z on Final-Factory/ffu, both m3 runners offline and 56 ffu-macos jobs queued.
const RUNNERS_M3_OFF = { runners: [
  { name: 'ffu-biscuit', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'ffu-linux' }] },
  { name: 'ffu-beast', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'ffu-windows' }] },
  { name: 'ffu-m3', status: 'offline', labels: [{ name: 'self-hosted' }, { name: 'ffu-macos' }] },
  { name: 'ffu-m3-2', status: 'offline', labels: [{ name: 'self-hosted' }, { name: 'ffu-macos' }] },
] };
const RUNNERS_M3_ON = { runners: RUNNERS_M3_OFF.runners.map((r) => (r.name === 'ffu-m3' ? { ...r, status: 'online' } : r)) };
const JOBS_ONLY_MAC = [
  { name: 'check', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-linux'] },
  { name: 'test (ffu-windows)', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-windows'] },
  { name: 'test (ffu-macos)', status: 'queued', conclusion: null, labels: ['self-hosted', 'ffu-macos'] },
  { name: 'hashcheck (ffu-linux)', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-linux'] },
  { name: 'hashcheck (ffu-windows)', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-windows'] },
  { name: 'hashcheck (ffu-macos)', status: 'queued', conclusion: null, labels: ['self-hosted', 'ffu-macos'] },
  { name: 'release', status: 'completed', conclusion: 'skipped', labels: ['self-hosted', 'ffu-linux'] },
];

test('w3147: away labels are ffu-macos on ffu only, and away only while every runner carrying it is offline', () => {
  assert.deepEqual(awayLabelsOf('final-factory/ffu'), ['ffu-macos']);
  assert.deepEqual(awayLabelsOf('Final-Factory/FinalFactory'), []);
  assert.deepEqual(offlineLabels(RUNNERS_M3_OFF, ['ffu-macos']), ['ffu-macos']);
  assert.deepEqual(offlineLabels(RUNNERS_M3_ON, ['ffu-macos']), []);
  assert.deepEqual(offlineLabels({ runners: [] }, ['ffu-macos']), [], 'no runner with the label: not away');
});

test('w3147: a run waiting only on queued macOS legs counts as green; a red, a running macOS leg or a queued Linux leg does not', () => {
  assert.equal(awaitsOnlyAway(JOBS_ONLY_MAC, ['ffu-macos']), true);
  assert.equal(awaitsOnlyAway(JOBS_ONLY_MAC, []), false);
  const red = JOBS_ONLY_MAC.map((j) => (j.name === 'test (ffu-windows)' ? { ...j, conclusion: 'failure' } : j));
  assert.equal(awaitsOnlyAway(red, ['ffu-macos']), false);
  const macRunning = JOBS_ONLY_MAC.map((j) => (j.name === 'test (ffu-macos)' ? { ...j, status: 'in_progress' } : j));
  assert.equal(awaitsOnlyAway(macRunning, ['ffu-macos']), false);
  const linuxQueued = JOBS_ONLY_MAC.map((j) => (j.name === 'check' ? { ...j, status: 'queued', conclusion: null } : j));
  assert.equal(awaitsOnlyAway(linuxQueued, ['ffu-macos']), false);
  assert.equal(awaitsOnlyAway(JOBS_ONLY_MAC.filter((j) => j.status === 'completed'), ['ffu-macos']), false, 'a finished run is not this case');
  assert.equal(isAwayLeg({ name: 'test (ffu-macos)', status: 'QUEUED' }, ['ffu-macos']), true, 'a rollup check by its matrix name');
});

test('w3147: the rollup reading leaves queued macOS checks out only when the label is away', () => {
  const rollup = JOBS_ONLY_MAC.map((j) => ({ name: j.name, status: j.status.toUpperCase(), conclusion: j.conclusion?.toUpperCase() }));
  const ref = 'Final-Factory/ffu#270';
  assert.equal(checksState({ state: 'OPEN', statusCheckRollup: rollup }, ref).done, false);
  const s = checksState({ state: 'OPEN', statusCheckRollup: rollup }, ref, ['ffu-macos']);
  assert.equal(s.green, true);
  assert.match(s.text, /all 5 checks passed or skipped; 2 ffu-macos legs still queued/);
});

const fakeGh = (runners: object, jobs: object[]) => (cmd: string, args: string[]) => {
  const a = args.join(' ');
  if (a.includes('/actions/runners')) return { code: 0, out: JSON.stringify(runners), err: '' };
  if (a.includes('/jobs')) return { code: 0, out: JSON.stringify({ jobs }), err: '' };
  return { code: 1, out: '', err: `unexpected ${cmd} ${a}` };
};

test('w3147: ff-pr settles a run that waits only on queued macOS legs while the m3 is off, and not while it is on', () => {
  const runs = (): WorkflowRun[] => [{ databaseId: 42126190535, name: 'ci', workflowName: 'ci', status: 'in_progress' }];
  const off = runs();
  assert.equal(settleAwayRuns({ run: fakeGh(RUNNERS_M3_OFF, JOBS_ONLY_MAC) }, 'Final-Factory/ffu', off), 2);
  assert.equal(off[0].status, 'completed');
  assert.equal(off[0].conclusion, 'success');
  const on = runs();
  assert.equal(settleAwayRuns({ run: fakeGh(RUNNERS_M3_ON, JOBS_ONLY_MAC) }, 'Final-Factory/ffu', on), 0);
  assert.equal(on[0].status, 'in_progress');
  const other = runs();
  assert.equal(settleAwayRuns({ run: fakeGh(RUNNERS_M3_OFF, JOBS_ONLY_MAC) }, 'Final-Factory/FinalFactory', other), 0);
});

test('w3147: the portal CI wait reads a run waiting only on queued macOS legs as green while the m3 is off', async () => {
  const run = async (_cmd: string, args: string[]) => {
    const a = args.join(' ');
    if (a.includes('statusCheckRollup')) return { code: 1, stdout: '', stderr: 'Resource not accessible by personal access token' };
    if (a.includes('state,headRefOid')) return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'a'.repeat(40) }), stderr: '' };
    if (a.includes('/actions/runners')) return { code: 0, stdout: JSON.stringify(RUNNERS_M3_OFF), stderr: '' };
    if (a.includes('/jobs')) return { code: 0, stdout: JSON.stringify({ jobs: JOBS_ONLY_MAC }), stderr: '' };
    if (a.includes('actions/runs?head_sha')) return { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 7, name: 'ci', status: 'in_progress', conclusion: null }] }), stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${a}` };
  };
  const s = await ghChecks('Final-Factory/ffu#270', run as never);
  assert.equal(s.green, true);
  assert.match(s.text, /all 1 workflow runs passed or skipped; 2 ffu-macos legs/);
});
