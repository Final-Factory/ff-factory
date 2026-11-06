import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitsOnlyAway, awayLabelsOf, isAwayLeg, offlineByMachine, offlineLabels } from '../machine/awayRunners.ts';
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

test('w3147: when the token cannot list the runners, FF Factory seeing the m3 offline stands in (and online or unknown does not)', async () => {
  assert.deepEqual(offlineByMachine(['ffu-macos'], (id) => (id === 'm3' ? false : true)), ['ffu-macos']);
  assert.deepEqual(offlineByMachine(['ffu-macos'], () => true), []);
  assert.deepEqual(offlineByMachine(['ffu-macos'], () => undefined), []);
  assert.deepEqual(offlineByMachine(['ffu-macos']), []);
  // Measured 2026-11-06 04:45Z: the portal's token is refused the repository's runner list (Administration: read).
  const run = (m3: boolean | undefined) => async (_cmd: string, args: string[]) => {
    const a = args.join(' ');
    if (a.includes('statusCheckRollup')) return { code: 1, stdout: '', stderr: 'Resource not accessible by personal access token' };
    if (a.includes('state,headRefOid')) return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'a'.repeat(40) }), stderr: '' };
    if (a.includes('/actions/runners')) return { code: 1, stdout: '', stderr: 'gh: Resource not accessible by personal access token (HTTP 403)' };
    if (a.includes('/jobs')) return { code: 0, stdout: JSON.stringify({ jobs: JOBS_ONLY_MAC }), stderr: '' };
    if (a.includes('actions/runs?head_sha')) return { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 7, name: 'ci', status: 'in_progress', conclusion: null }] }), stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${a}` };
  };
  const off = await ghChecks('Final-Factory/ffu#212', run(false) as never, (id) => (id === 'm3' ? false : true));
  assert.equal(off.green, true);
  const on = await ghChecks('Final-Factory/ffu#212', run(true) as never, () => true);
  assert.notEqual(on.green, true);
  assert.notEqual(on.done, true);
});

// w3272: Final-Factory/ffu #318's run 42254706033 as the portal read it at 16:47Z (GitHub's jobs API, read 2026-11-06 23:3xZ:
// test (ffu-windows) failed 16:46:56Z, both macOS legs queued with every m3 runner offline, the Linux legs still going).
const JOBS_318_WINDOWS_RED = [
  { name: 'check', status: 'in_progress', conclusion: null, labels: ['self-hosted', 'ffu-linux'] },
  { name: 'test (ffu-macos)', status: 'queued', conclusion: null, labels: ['self-hosted', 'ffu-macos'] },
  { name: 'hashcheck (ffu-windows)', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-windows'] },
  { name: 'hashcheck (ffu-macos)', status: 'queued', conclusion: null, labels: ['self-hosted', 'ffu-macos'] },
  { name: 'test (ffu-windows)', status: 'completed', conclusion: 'failure', labels: ['self-hosted', 'ffu-windows'] },
  { name: 'hashcheck (ffu-linux)', status: 'queued', conclusion: null, labels: ['self-hosted', 'ffu-linux'] },
  { name: 'lint', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-linux'] },
  { name: 'check-release', status: 'queued', conclusion: null, labels: ['self-hosted', 'ffu-linux'] },
  { name: 'release', status: 'completed', conclusion: 'skipped', labels: [] },
];
// w3272: Final-Factory/ffu #292's run 42249832978 when the portal settled it green at 16:38Z (every leg but macOS done).
const JOBS_292_GREEN = [
  { name: 'hashcheck (ffu-macos)', status: 'queued', conclusion: null, labels: ['self-hosted', 'ffu-macos'] },
  { name: 'test (ffu-macos)', status: 'queued', conclusion: null, labels: ['self-hosted', 'ffu-macos'] },
  { name: 'check', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-linux'] },
  { name: 'lint', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-linux'] },
  { name: 'test (ffu-windows)', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-windows'] },
  { name: 'hashcheck (ffu-windows)', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-windows'] },
  { name: 'hashcheck (ffu-linux)', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-linux'] },
  { name: 'check-release', status: 'completed', conclusion: 'success', labels: ['self-hosted', 'ffu-linux'] },
  { name: 'release', status: 'completed', conclusion: 'skipped', labels: [] },
];

/** The portal's gh as it is (statusCheckRollup refused, w829), one unfinished run with `jobs`, the runner list `runners` or refused. */
const portalGh = (jobs: object[], runners?: object) => async (_cmd: string, args: string[]) => {
  const a = args.join(' ');
  if (a.includes('statusCheckRollup')) return { code: 1, stdout: '', stderr: 'Resource not accessible by personal access token' };
  if (a.includes('state,headRefOid')) return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'b'.repeat(40) }), stderr: '' };
  if (a.includes('/actions/runners')) return runners ? { code: 0, stdout: JSON.stringify(runners), stderr: '' } : { code: 1, stdout: '', stderr: 'HTTP 403' };
  if (a.includes('/jobs')) return { code: 0, stdout: JSON.stringify({ jobs }), stderr: '' };
  if (a.includes('actions/runs?head_sha')) return { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 42254706033, name: 'ci', status: 'in_progress', conclusion: null }] }), stderr: '' };
  return { code: 1, stdout: '', stderr: `unexpected ${a}` };
};
const m3 = (on: boolean) => (id: string) => (id === 'm3' ? on : true);

test('w3272: a failed Windows leg with the macOS legs queued ends the portal CI wait at once, red (ffu #318)', async () => {
  for (const [why, run, online] of [
    ['runner list refused, m3 offline (as on the portal)', portalGh(JOBS_318_WINDOWS_RED), m3(false)],
    ['runner list read, m3 offline', portalGh(JOBS_318_WINDOWS_RED, RUNNERS_M3_OFF), m3(false)],
    ['m3 online: its legs would run, but the run is red already', portalGh(JOBS_318_WINDOWS_RED, RUNNERS_M3_ON), m3(true)],
  ] as const) {
    const s = await ghChecks('Final-Factory/ffu#318', run as never, online);
    assert.equal(s.done, true, why);
    assert.notEqual(s.green, true, why);
    assert.match(s.text, /1 of 1 workflow runs failed \(ci \(test \(ffu-windows\) failed/, why);
  }
});

test('w3272: every leg that can run green with the macOS legs queued ends the portal CI wait, green (ffu #292)', async () => {
  const s = await ghChecks('Final-Factory/ffu#292', portalGh(JOBS_292_GREEN) as never, m3(false));
  assert.equal(s.done, true);
  assert.equal(s.green, true);
  assert.match(s.text, /2 ffu-macos legs still queued/);
  const on = await ghChecks('Final-Factory/ffu#292', portalGh(JOBS_292_GREEN, RUNNERS_M3_ON) as never, m3(true));
  assert.equal(on.done, false, 'the m3 online: its legs will run, so they are waited for');
});

test('w3272: ff-pr reads a failed leg as a red run at once, the m3 on or off', () => {
  for (const runners of [RUNNERS_M3_OFF, RUNNERS_M3_ON]) {
    const runs: WorkflowRun[] = [{ databaseId: 42254706033, name: 'ci', workflowName: 'ci', status: 'in_progress' }];
    assert.equal(settleAwayRuns({ run: fakeGh(runners, JOBS_318_WINDOWS_RED) }, 'Final-Factory/ffu', runs), 0);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].conclusion, 'failure');
    assert.match(String(runs[0].name), /test \(ffu-windows\) failed/);
  }
  const game: WorkflowRun[] = [{ databaseId: 1, name: 'ci', workflowName: 'ci', status: 'in_progress' }];
  settleAwayRuns({ run: fakeGh(RUNNERS_M3_OFF, JOBS_318_WINDOWS_RED) }, 'Final-Factory/FinalFactory', game);
  assert.equal(game[0].status, 'in_progress', 'repositories without away labels keep waiting for the run');
});

test('w3272: the rollup reading ends an ffu wait on a failed check while others still run; other repositories wait', () => {
  const rollup = JOBS_318_WINDOWS_RED.map((j) => ({ name: j.name, status: j.status.toUpperCase(), conclusion: j.conclusion?.toUpperCase() }));
  const s = checksState({ state: 'OPEN', statusCheckRollup: rollup }, 'Final-Factory/ffu#318', ['ffu-macos']);
  assert.equal(s.done, true);
  assert.notEqual(s.green, true);
  assert.match(s.text, /test \(ffu-windows\)/);
  assert.equal(checksState({ state: 'OPEN', statusCheckRollup: rollup }, 'Final-Factory/FinalFactory#1', []).done, false);
});
