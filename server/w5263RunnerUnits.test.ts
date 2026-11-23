import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COOLDOWN_MS, DROPIN, RunnerUnits, STUCK_MS, busySince, findRunnerUnits, parseShow, runnerRootOf, type RunnerUnitsDeps } from '../machine/runnerUnits.ts';
import type { RunnerCensus } from '../machine/benchRunners.ts';

/**
 * w5263, w5264: biscuit on 2026-11-23 (w5262). The disk filled at about 08:36Z; ffu-runner.service (ffu-biscuit) reached
 * systemd's start limit at 08:37:08Z and stayed failed, and ffu-biscuit-2's listener lost its job's dispatch to ENOSPC at
 * 08:37:16Z and polled with status=Busy, taking no job, until it was restarted by hand at 12:28:50Z. The log lines below
 * are that listener's own (ffu-biscuit-2/_diag/Runner_20261117-193110-utc.log), shortened; no real unit is touched.
 */

const R2 = '/home/ben-ryding/ffw/ffu-runners/ffu-biscuit-2';
const R1 = '/home/ben-ryding/ffu-runner';

const STUCK_TAIL = [
  "[2026-11-23 08:06:29Z INFO JobDispatcher] finish job request for job e5479c8b-a36b-507b-a8ff-b0fdbe38576e with result: Succeeded",
  '[2026-11-23 08:06:29Z INFO Terminal] WRITE LINE: 2026-11-23 08:06:29Z: Job lint completed with result: Succeeded',
  '[2026-11-23 08:06:30Z INFO JobDispatcher] Job request 0 for plan 990d45fb-999e-88e6-8ccc-6733380fe752 job eae317d7-d22e-5850-ab97-404fcb33132a received.',
  '[2026-11-23 08:06:30Z INFO BrokerMessageListener] Received job status event. JobState: Busy',
  '[2026-11-23 08:06:30Z INFO Terminal] WRITE LINE: 2026-11-23 08:06:30Z: Running job: check',
  '[2026-11-23 08:06:31Z INFO JobDispatcher] Successfully renew job eae317d7-d22e-5850-ab97-404fcb33132a, job is valid till 11/23/2026 8:16:31 AM',
  '[2026-11-23 08:37:16Z INFO ProcessInvokerWrapper] Finished process 1310962 with exit code 134, and elapsed time 00:30:45.0874606.',
  '[2026-11-23 08:37:16Z INFO JobDispatcher] Worker finished for job eae317d7-d22e-5850-ab97-404fcb33132a. Code: 134',
  '[2026-11-23 08:37:16Z INFO JobDispatcher] Return code 134 indicate worker encounter an unhandled exception or app crash, attach worker stdout/stderr to JobRequest result.',
  '[2026-11-23 08:43:25Z ERR  GitHubActionsService] GET request to https://broker.actions.githubusercontent.com/message?sessionId=fee1f0a2&status=Busy&runnerVersion=2.338.2&os=Linux&architecture=X64 failed. HTTP Status: Forbidden',
  '[2026-11-23 08:43:25Z ERR  BrokerMessageListener] GitHub.DistributedTask.WebApi.TaskAgentSessionExpiredException: Runner session is invalid',
  '[2026-11-23 09:28:56Z ERR  GitHubActionsService] GET request to https://broker.actions.githubusercontent.com/message?sessionId=3f55e9f5&status=Busy&runnerVersion=2.338.2&os=Linux&architecture=X64 failed.',
  '[2026-11-23 11:22:34Z INFO BrokerMessageListener] No message retrieved within last 30 minutes.',
  '',
].join('\n');

/** A job that ended well: no worker for the instant between "Worker finished" and its "completed" line. */
const ENDING_TAIL = [
  '[2026-11-23 08:06:30Z INFO Terminal] WRITE LINE: 2026-11-23 08:06:30Z: Running job: check',
  '[2026-11-23 08:30:00Z INFO JobDispatcher] Worker finished for job eae317d7-d22e-5850-ab97-404fcb33132a. Code: 100',
  '',
].join('\n');
const ENDED_TAIL = `${ENDING_TAIL}[2026-11-23 08:30:00Z INFO JobDispatcher] finish job request for job eae317d7 with result: Succeeded\n[2026-11-23 08:30:00Z INFO Terminal] WRITE LINE: 2026-11-23 08:30:00Z: Job check completed with result: Succeeded\n`;

const at = (iso: string) => Date.parse(iso);

test('the units that run a registered runner are found by their ExecStart and .runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5263-units-'));
  try {
    fs.writeFileSync(path.join(dir, 'ffu-runner.service'), `[Unit]\nDescription=GitHub Actions runner for Final-Factory/ffu (w2784)\n[Service]\nWorkingDirectory=${R1}\nExecStart=${R1}/run.sh\nRestart=always\n`);
    fs.writeFileSync(path.join(dir, 'ffu-biscuit-2.service'), `[Service]\nWorkingDirectory=${R2}\nExecStart=${R2}/run.sh\nRestart=always\nNice=10\n`);
    fs.writeFileSync(path.join(dir, 'ff-machine.service'), '[Service]\nExecStart=/usr/bin/node daemon.ts\n');
    fs.writeFileSync(path.join(dir, 'unregistered.service'), '[Service]\nExecStart=/opt/fresh/run.sh\n');
    const registered = new Set([`${R1}/.runner`, `${R2}/.runner`]);
    assert.deepEqual(findRunnerUnits(dir, (p) => registered.has(p)), [
      { unit: 'ffu-biscuit-2.service', root: R2 },
      { unit: 'ffu-runner.service', root: R1 },
    ]);
    assert.equal(runnerRootOf(`ExecStart=-${R2}/run.sh --once`, (p) => registered.has(p)), R2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a listener's log is busy from the job it took after its last idle word, through a crashed worker and Busy polls", () => {
  assert.equal(busySince(STUCK_TAIL), at('2026-11-23T08:06:30Z'));
  assert.equal(busySince(ENDING_TAIL), at('2026-11-23T08:06:30Z'));
  assert.equal(busySince(ENDED_TAIL), undefined);
  assert.equal(busySince('[2026-11-23 12:28:53Z INFO Terminal] WRITE LINE: 2026-11-23 12:28:53Z: Listening for Jobs\n'), undefined);
  assert.equal(busySince(undefined), undefined);
});

test('systemctl show is read for its state and result', () => {
  assert.deepEqual(parseShow('ActiveState=failed\nResult=start-limit-hit\n'), { activeState: 'failed', result: 'start-limit-hit' });
});

interface World {
  show: Record<string, string>;
  free: number;
  census: RunnerCensus;
  tail: Record<string, string | undefined>;
  paused: Set<number>;
  dropins: Map<string, string>;
  calls: string[];
  logs: string[];
  now: number;
}

function world(over: Partial<World> = {}): { w: World; units: RunnerUnits } {
  const w: World = {
    show: { 'ffu-runner.service': 'ActiveState=active\nResult=success\n', 'ffu-biscuit-2.service': 'ActiveState=active\nResult=success\n' },
    free: 48 * 1024 ** 3,
    census: { listeners: [{ pid: 710511, root: R2, busy: false }], workers: [], leftovers: [] },
    tail: { [R2]: STUCK_TAIL },
    paused: new Set(),
    dropins: new Map([['ffu-runner.service', DROPIN], ['ffu-biscuit-2.service', DROPIN]]),
    calls: [],
    logs: [],
    now: at('2026-11-23T08:38:00Z'),
    ...over,
  };
  const d: RunnerUnitsDeps = {
    units: () => [{ unit: 'ffu-biscuit-2.service', root: R2 }, { unit: 'ffu-runner.service', root: R1 }],
    readDropin: (u) => w.dropins.get(u),
    writeDropin: (u, t) => void w.dropins.set(u, t),
    systemctl: async (args) => {
      w.calls.push(args.join(' '));
      return args[0] === 'show' ? w.show[args.at(-1)!] : '';
    },
    freeBytes: async () => w.free,
    floorGB: () => 10,
    census: async () => w.census,
    diag: (root) => w.tail[root],
    paused: () => w.paused,
    log: (t) => void w.logs.push(t),
    now: () => w.now,
  };
  return { w, units: new RunnerUnits(d) };
}

const acts = (w: World) => w.calls.filter((c) => !c.startsWith('show'));

test('(a) a unit at its start limit is reset and started once the disk is above the floor, and not below it', async () => {
  const { w, units } = world({ show: { 'ffu-runner.service': 'ActiveState=failed\nResult=start-limit-hit\n', 'ffu-biscuit-2.service': 'ActiveState=active\n' }, free: 3 * 1024 ** 3, tail: {} });
  await units.tick();
  assert.deepEqual(acts(w), [], 'below the 10 GB floor it would only fail again');
  w.free = 48 * 1024 ** 3;
  await units.tick();
  assert.deepEqual(acts(w), ['reset-failed ffu-runner.service', 'start ffu-runner.service']);
  assert.match(w.logs.join('\n'), /ffu-runner\.service .* had failed \(start-limit-hit\): reset and started, 48\.0 GB free/);
  w.calls = [];
  w.now += COOLDOWN_MS - 1;
  await units.tick();
  assert.deepEqual(acts(w), [], 'a unit just started is left alone for the cooldown');
});

test('(b) a listener busy with no worker in every look for 10 minutes is restarted; one look is not enough', async () => {
  const { w, units } = world();
  await units.tick();
  assert.deepEqual(acts(w), [], 'the first look starts the count');
  w.now += STUCK_MS - 60_000;
  await units.tick();
  assert.deepEqual(acts(w), []);
  w.now += 60_000;
  await units.tick();
  assert.deepEqual(acts(w), ['restart ffu-biscuit-2.service']);
  assert.match(w.logs.join('\n'), /listener pid 710511 busy since 2026-11-23T08:06:30\.000Z \(its log\) with no job worker for 10 min: restarted/);
});

test('(b) never while a worker runs, never while paused, and a job that ends well between two looks clears the count', async () => {
  const running = world({ census: { listeners: [{ pid: 710511, root: R2, busy: true }], workers: [{ pid: 1310962, root: R2 }], leftovers: [] } });
  const paused = world({ paused: new Set([710511]) });
  for (const { w, units } of [running, paused]) {
    await units.tick();
    w.now += STUCK_MS + 60_000;
    await units.tick();
    assert.deepEqual(acts(w), []);
  }
  const ending = world({ tail: { [R2]: ENDING_TAIL } });
  await ending.units.tick();
  ending.w.tail[R2] = ENDED_TAIL;
  ending.w.now += 60_000;
  await ending.units.tick();
  ending.w.tail[R2] = ENDING_TAIL; // the next job ends the same way, seconds later
  ending.w.now += STUCK_MS;
  await ending.units.tick();
  assert.deepEqual(acts(ending.w), [], 'the idle look in between reset the count');
});

test('(c) each runner unit gets the drop-in once, with one daemon-reload', async () => {
  const { w, units } = world({ dropins: new Map(), tail: {} });
  await units.tick();
  assert.equal(w.dropins.get('ffu-runner.service'), DROPIN);
  assert.equal(w.dropins.get('ffu-biscuit-2.service'), DROPIN);
  assert.deepEqual(acts(w), ['daemon-reload']);
  assert.match(DROPIN, /^\[Unit\]\nStartLimitIntervalSec=0\n\[Service\]\nRestartSec=30s\nOOMPolicy=continue\n/m);
  w.calls = [];
  await units.tick();
  assert.deepEqual(acts(w), []);
});
