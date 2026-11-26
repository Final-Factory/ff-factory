import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COOLDOWN_MS, DROPIN, DROPIN_NAME, RunnerUnits, STUCK_MS, TMPDIR_DROPIN_NAME, busySince, findRunnerUnits, loadedHasTmpdir, parseShow, runnerRootOf, runnerTempDir, tmpdirDropin, type RunnerUnitsDeps } from '../machine/runnerUnits.ts';
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

/**
 * w6001: ffu-biscuit-4's own lines (_diag/Runner_20261126-084924-utc.log, biscuit, 2026-11-26), shortened: its stack traces
 * and the session id are cut. After the job completed it logged one more GET ...?status=Busy poll, cancelled as it went back
 * to status=Online; read as busy, (d) skipped the listener and (b) restarted it as stuck about 10 minutes later.
 */
const COMPLETED_TAIL = [
  '[2026-11-26 09:28:55Z INFO BrokerMessageListener] Acknowledging runner request \'2f85a2bd-7c64-5dc6-ab51-c1c09108b9b3\'.',
  '[2026-11-26 09:28:56Z INFO JobDispatcher] Job request 0 for plan 2dd02758-c40e-4921-bfd5-30984a0588db job 2f85a2bd-7c64-5dc6-ab51-c1c09108b9b3 received.',
  '[2026-11-26 09:28:56Z INFO BrokerMessageListener] Received job status event. JobState: Busy',
  '[2026-11-26 09:28:56Z INFO Terminal] WRITE LINE: 2026-11-26 09:28:56Z: Running job: check',
  '[2026-11-26 09:34:57Z INFO JobDispatcher] Successfully renew job 2f85a2bd-7c64-5dc6-ab51-c1c09108b9b3, job is valid till 11/26/2026 9:44:57 AM',
  '[2026-11-26 09:35:31Z INFO ProcessInvokerWrapper] Finished process 2602614 with exit code 100, and elapsed time 00:06:35.0076438.',
  '[2026-11-26 09:35:31Z INFO JobDispatcher] Worker finished for job 2f85a2bd-7c64-5dc6-ab51-c1c09108b9b3. Code: 100',
  '[2026-11-26 09:35:31Z INFO JobDispatcher] finish job request for job 2f85a2bd-7c64-5dc6-ab51-c1c09108b9b3 with result: Succeeded',
  '[2026-11-26 09:35:31Z INFO Terminal] WRITE LINE: 2026-11-26 09:35:31Z: Job check completed with result: Succeeded',
  '[2026-11-26 09:35:31Z INFO JobDispatcher] Stop renew job request for job 2f85a2bd-7c64-5dc6-ab51-c1c09108b9b3.',
  '[2026-11-26 09:35:31Z INFO JobNotification] Entering JobCompleted Notification',
  '[2026-11-26 09:35:31Z INFO BrokerMessageListener] Received job status event. JobState: Online',
  '[2026-11-26 09:35:31Z WARN GitHubActionsService] GET request to https://broker.actions.githubusercontent.com/message?sessionId=d21d1ad1&status=Busy&runnerVersion=2.338.2&os=Linux&architecture=X64&disableUpdate=false has been cancelled.',
  '[2026-11-26 09:35:31Z ERR  BrokerServer] Catch exception during request',
  '[2026-11-26 09:35:31Z ERR  BrokerServer] System.Threading.Tasks.TaskCanceledException: The operation was canceled.',
  '[2026-11-26 09:35:31Z WARN BrokerServer] Back off 12.705 seconds before next retry. 4 attempt left.',
  '[2026-11-26 09:35:31Z INFO BrokerMessageListener] Get messages has been cancelled using local token source. Continue to get messages with new status.',
  '[2026-11-26 09:39:52Z INFO GitHubActionsService] AAD Correlation ID for this token request: Unknown',
  '[2026-11-26 09:46:23Z WARN GitHubActionsService] GET request to https://broker.actions.githubusercontent.com/message?sessionId=d21d1ad1&status=Online&runnerVersion=2.338.2&os=Linux&architecture=X64&disableUpdate=false timed out after 100 seconds.',
  '[2026-11-26 09:46:23Z ERR  BrokerServer] System.TimeoutException: The HTTP request timed out after 00:01:40.',
  '',
].join('\n');
/** The same listener while its job ran (cut before "Worker finished"), and handed a new job after the one that completed. */
const RUNNING_TAIL = `${COMPLETED_TAIL.split('\n').slice(0, 5).join('\n')}\n`;
const NEXT_JOB_TAIL = `${COMPLETED_TAIL}[2026-11-26 09:50:02Z INFO BrokerMessageListener] Acknowledging runner request '7a1c'.\n[2026-11-26 09:50:03Z INFO JobDispatcher] Job request 0 for plan 5e2b job 7a1c received.\n[2026-11-26 09:50:03Z INFO Terminal] WRITE LINE: 2026-11-26 09:50:03Z: Running job: check\n`;

test('w6001: the cancelled status=Busy poll after a completed job is idle; a running or newly handed job is busy', () => {
  assert.equal(busySince(COMPLETED_TAIL), undefined);
  assert.equal(busySince(RUNNING_TAIL), at('2026-11-26T09:28:55Z'));
  assert.equal(busySince(NEXT_JOB_TAIL), at('2026-11-26T09:50:02Z'));
  // a Busy poll after the completed line that was not cancelled is idle too: no job line follows the idle word
  const uncancelled = COMPLETED_TAIL.split('\n').filter((l) => !l.includes('cancelled using local token source')).join('\n');
  assert.equal(busySince(uncancelled), undefined);
  // a tail that is all Busy polls (the job's lines rolled out of the 64 KB) still counts from its oldest uncancelled one
  const polls = COMPLETED_TAIL.split('\n').slice(12, 17).join('\n');
  assert.equal(busySince(polls), undefined);
  assert.equal(busySince(polls.split('\n').slice(0, 4).join('\n')), at('2026-11-26T09:35:31Z'));
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

function world(over: Partial<World> = {}): { w: World; d: RunnerUnitsDeps; units: RunnerUnits } {
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
  return { w, d, units: new RunnerUnits(d) };
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

/**
 * w5834: on biscuit on 2026-11-25 every Runner.Listener and Runner.Worker start left clr-debug-pipe-<pid>-*-in/out and
 * dotnet-diagnostic-<pid>-*-socket in /tmp (44 pairs): .NET puts them in TMPDIR, or /tmp when it is unset.
 */
test('(d) each runner unit gets a temp folder inside the worker root and no .NET diagnostic pipes', () => {
  assert.equal(runnerTempDir({ unit: 'ffu-biscuit-2.service', root: R2 }, '/home/ben-ryding/ffw'), `${R2}/_tmp`);
  assert.equal(runnerTempDir({ unit: 'ffu-runner.service', root: R1 }, '/home/ben-ryding/ffw/'), '/home/ben-ryding/ffw/runner-tmp/ffu-runner', 'a runner outside the root keeps its folder; its temp moves inside');
  assert.equal(runnerTempDir({ unit: 'ffu-runner.service', root: '/home/ben-ryding/ffwx/r' }, '/home/ben-ryding/ffw'), '/home/ben-ryding/ffw/runner-tmp/ffu-runner');
  assert.equal(runnerTempDir({ unit: 'ffu-runner.service', root: R1 }, undefined), undefined);
  const text = tmpdirDropin('/home/ben ryding/ffw/runner-tmp/ffu-runner');
  assert.match(text, /^\[Service\]\nEnvironment="TMPDIR=\/home\/ben ryding\/ffw\/runner-tmp\/ffu-runner"\nEnvironment=DOTNET_EnableDiagnostics=0\nExecStartPre=-\/bin\/mkdir -p "\/home\/ben ryding\/ffw\/runner-tmp\/ffu-runner"\n/m);
});

function tmpWorld(over: Partial<World> = {}, env: Record<number, string | null | undefined> = {}, deps: Partial<RunnerUnitsDeps> = {}) {
  const { w, d } = world({ tail: { [R2]: ENDED_TAIL }, ...over });
  for (const u of ['ffu-runner.service', 'ffu-biscuit-2.service']) w.dropins.set(`${u}/${DROPIN_NAME}`, DROPIN);
  // what systemd has loaded: a daemon-reload loads each unit's TMPDIR drop-in, unless it is told to fail
  const sd = { loaded: new Map<string, string>(), reloadFails: 0, override: '', showFails: false };
  const units = new RunnerUnits({
    ...d,
    systemctl: async (args) => {
      if (args[0] === 'daemon-reload' && sd.reloadFails > 0) {
        sd.reloadFails--;
        w.calls.push('daemon-reload (failed)');
        throw new Error('Failed to connect to bus');
      }
      const out = await d.systemctl(args);
      if (args[0] === 'daemon-reload') {
        for (const [k, t] of w.dropins) {
          const m = k.endsWith(`/${TMPDIR_DROPIN_NAME}`) && /Environment="(TMPDIR=[^"]*)"/.exec(t);
          if (m) sd.loaded.set(k.slice(0, -TMPDIR_DROPIN_NAME.length - 1), m[1]);
        }
      }
      if (args[0] === 'show' && args.includes('Environment') && sd.showFails) throw new Error('Failed to connect to bus');
      if (args[0] === 'show' && args.includes('Environment')) return `Environment=${[sd.loaded.get(args.at(-1)!), sd.override].filter(Boolean).join(' ')}\n`;
      return out;
    },
    readDropin: (u, name = DROPIN_NAME) => w.dropins.get(`${u}/${name}`),
    writeDropin: (u, t, name = DROPIN_NAME) => void w.dropins.set(`${u}/${name}`, t),
    tempDir: (u) => runnerTempDir(u, '/home/ben-ryding/ffw'),
    startedTmpdir: (pid) => env[pid],
    ...deps,
  });
  return { w, units, sd };
}

test('(d) the drop-in is written once, and an idle listener started without it is restarted once', async () => {
  const env: Record<number, string | null | undefined> = { 710511: null };
  const { w, units } = tmpWorld({}, env);
  await units.tick();
  assert.equal(w.dropins.get(`ffu-biscuit-2.service/${TMPDIR_DROPIN_NAME}`), tmpdirDropin(`${R2}/_tmp`));
  assert.equal(w.dropins.get(`ffu-runner.service/${TMPDIR_DROPIN_NAME}`), tmpdirDropin('/home/ben-ryding/ffw/runner-tmp/ffu-runner'));
  assert.deepEqual(acts(w), ['daemon-reload', 'restart ffu-biscuit-2.service']);
  assert.match(w.logs.join('\n'), /idle listener pid 710511 started with TMPDIR=\(unset\): restarted for TMPDIR=.*ffu-biscuit-2\/_tmp/);
  w.calls = [];
  env[710511] = `${R2}/_tmp`;
  w.now += COOLDOWN_MS;
  await units.tick();
  assert.deepEqual(acts(w), [], 'written once; a listener that has it is left alone');
});

/**
 * w5884's review of #1285 (F1): a daemon-reload that failed once left the drop-in on disk but unloaded, later passes wrote
 * nothing and never reloaded, and each restarted listener came back without TMPDIR: 8 restarts in 2 hours, unbounded.
 */
test('(d) a failed daemon-reload is retried, no restart waits on an unloaded drop-in, and a unit is restarted for TMPDIR once at most', async () => {
  const env: Record<number, string | null | undefined> = { 710511: null };
  const { w, units, sd } = tmpWorld({}, env);
  sd.reloadFails = 1;
  for (let i = 0; i < 120; i++) {
    await units.tick();
    w.now += 60_000;
  }
  const restarts = w.calls.filter((c) => c === 'restart ffu-biscuit-2.service');
  assert.equal(w.calls.filter((c) => c === 'daemon-reload (failed)').length, 1);
  assert.equal(w.calls.filter((c) => c === 'daemon-reload').length, 1, 'the owed reload is made on the next pass, and only then');
  assert.equal(restarts.length, 1, 'restarted once, after the reload loaded TMPDIR, though the listener still lacks it');
  assert.equal(w.logs.filter((l) => l.includes('after its one restart')).length, 1, 'still without it after its restart: said once');
});

test('(d) an override that sets TMPDIR after ours is never restarted for, and said once', async () => {
  const { w, units, sd } = tmpWorld({}, { 710511: null });
  sd.override = '"TMPDIR=/tmp/elsewhere"';
  for (let i = 0; i < 8; i++) {
    await units.tick();
    w.now += COOLDOWN_MS;
  }
  assert.deepEqual(w.calls.filter((c) => c.startsWith('restart')), []);
  assert.equal(w.logs.filter((l) => l.includes('has not loaded TMPDIR')).length, 1);
});

test('(d) a listener that took a job since the pass began is not restarted (a fresh census)', async () => {
  const { w, units } = tmpWorld({}, { 710511: null });
  const listeners = [{ pid: 710511, root: R2, busy: false }];
  let looks = 0;
  w.census = { listeners, workers: [], leftovers: [] };
  const census = w.census;
  Object.defineProperty(w, 'census', { get: () => (++looks > 1 ? { ...census, listeners: [{ ...listeners[0], busy: true }] } : census) });
  await units.tick();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('restart')), []);
});

/** w5890, the second review of #1285: its probes, kept as tests. */
test('(d) a daemon-reload that keeps failing is said once and the pass goes on: a failed unit is still started', async () => {
  const { w, units, sd } = tmpWorld({ show: { 'ffu-runner.service': 'ActiveState=failed\nResult=start-limit-hit\n', 'ffu-biscuit-2.service': 'ActiveState=active\nResult=success\n' } }, { 710511: null });
  sd.reloadFails = 1000;
  for (let i = 0; i < 60; i++) {
    await units.tick();
    w.now += 60_000;
  }
  assert.equal(w.calls.filter((c) => c === 'daemon-reload (failed)').length, 60, 'retried each pass');
  assert.ok(w.calls.includes('start ffu-runner.service'), 'failed-unit recovery still runs');
  assert.deepEqual(w.calls.filter((c) => c.startsWith('restart')), [], 'nothing loaded, so no restart for TMPDIR');
  assert.equal(w.logs.filter((l) => l.includes('daemon-reload failed')).length, 1);
});

test('(d) a failing show -p Environment skips only that restart, said once', async () => {
  const { w, units, sd } = tmpWorld({ show: { 'ffu-runner.service': 'ActiveState=failed\nResult=start-limit-hit\n', 'ffu-biscuit-2.service': 'ActiveState=active\nResult=success\n' } }, { 710511: null });
  sd.showFails = true;
  await units.tick();
  await units.tick();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('restart')), []);
  assert.ok(w.calls.includes('start ffu-runner.service'));
  assert.equal(w.logs.filter((l) => l.includes('could not read its loaded environment')).length, 1);
});

test('(d) an override that wins owes one reload, not one each pass', async () => {
  const { w, units, sd } = tmpWorld({}, { 710511: null });
  sd.override = '"TMPDIR=/tmp/elsewhere"';
  for (let i = 0; i < 120; i++) {
    await units.tick();
    w.now += 60_000;
  }
  assert.ok(w.calls.filter((c) => c === 'daemon-reload').length <= 2, `reloads: ${w.calls.filter((c) => c === 'daemon-reload').length}`);
  assert.deepEqual(w.calls.filter((c) => c.startsWith('restart')), []);
});

test('(d) a listener a bench turn pauses after the first look is not restarted', async () => {
  const { w, units } = tmpWorld({}, { 710511: null });
  let looks = 0;
  const paused = new Set<number>([710511]);
  Object.defineProperty(w, 'paused', { get: () => (++looks > 1 ? paused : new Set<number>()) });
  await units.tick();
  assert.deepEqual(w.calls.filter((c) => c.startsWith('restart')), []);
});

test('loadedHasTmpdir reads the last TMPDIR of systemctl show, quoted or not', () => {
  assert.equal(loadedHasTmpdir('Environment=TMPDIR=/a/_tmp DOTNET_EnableDiagnostics=0\n', '/a/_tmp'), true);
  assert.equal(loadedHasTmpdir('Environment="TMPDIR=/home/ben ryding/_tmp" DOTNET_EnableDiagnostics=0\n', '/home/ben ryding/_tmp'), true);
  assert.equal(loadedHasTmpdir('Environment=TMPDIR=/a/_tmp2\n', '/a/_tmp'), false);
  assert.equal(loadedHasTmpdir('Environment=TMPDIR=/a/_tmp TMPDIR=/tmp\n', '/a/_tmp'), false);
  assert.equal(loadedHasTmpdir('Environment=\n', '/a/_tmp'), false);
  assert.equal(loadedHasTmpdir(undefined, '/a/_tmp'), false);
});

test('(d) never restarted while a job runs, while paused or busy, or when its environment cannot be read', async () => {
  const cases = [
    tmpWorld({ census: { listeners: [{ pid: 710511, root: R2, busy: true }], workers: [{ pid: 1310962, root: R2 }], leftovers: [] } }, { 710511: null }),
    tmpWorld({ paused: new Set([710511]) }, { 710511: null }),
    tmpWorld({ tail: { [R2]: ENDING_TAIL } }, { 710511: null }),
    tmpWorld({}, {}),
  ];
  for (const { w, units } of cases) {
    await units.tick();
    assert.deepEqual(acts(w).filter((c) => c !== 'daemon-reload'), []);
  }
});

test('(d) a drop-in that cannot be written is said once and leaves the rest of the look alone', async () => {
  const { w, units } = tmpWorld({ tail: { [R2]: STUCK_TAIL } }, { 710511: null }, {
    tempDir: () => {
      throw new Error('EACCES');
    },
  });
  await units.tick();
  await units.tick();
  assert.equal(w.logs.filter((l) => l.includes(`could not write ${TMPDIR_DROPIN_NAME}`)).length, 2, 'once per unit');
  assert.deepEqual(acts(w), []);
});
