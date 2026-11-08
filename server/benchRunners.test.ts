import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchRunners, holdsJob, RELEASE_LOOKS, STALE_JOB_MS, isOpsRunner, listenerLog, OPS_RUNNER_MARK, readListenerLog, runnerCensus, SETTLE_MS, type BenchRunnersDeps, type RunnersState } from '../machine/benchRunners.ts';
import type { Proc } from '../machine/unity.ts';

/**
 * w3112: on m3 on 2026-11-04 w3108 timed FFU under exclusive ticket t00001116 while the Mac's GitHub Actions runners
 * (~/actions-runner, ~/ffu-runner, ~/ffw/ffu-runners/ffu-m3-2) ran jobs (load average up to 24.1, about 2 idle), and
 * debug ffu-server processes the jobs left ran on afterwards. A Runner.Listener is the idle baseline; a running
 * Runner.Worker is a job. These tests feed a process listing of that machine; no real runner is signalled.
 */

const H = '/Users/benryding';
const L = (pid: number, root: string): Proc => ({ pid, ppid: 1, cmd: `${H}/${root}/bin/Runner.Listener run --startuptype service` });
const LISTENERS = [L(501, 'actions-runner'), L(502, 'ffu-runner'), L(503, 'ffw/ffu-runners/ffu-m3-2')];
const JOB: Proc[] = [
  { pid: 610, ppid: 502, cmd: `${H}/ffu-runner/bin/Runner.Worker spawnclient 118 121` },
  { pid: 611, ppid: 610, cmd: `/bin/bash -e ${H}/ffu-runner/_work/_temp/abc.sh` },
  { pid: 612, ppid: 611, cmd: `${H}/ffu-runner/_work/ffu/ffu/target/release/deps/sector-1f2e` },
];
const LEFTOVER: Proc = { pid: 700, ppid: 1, cmd: `${H}/actions-runner/_work/ffu/ffu/target/debug/ffu-server --listen 127.0.0.1:0 ffu-peers-test` };
const OTHER: Proc[] = [{ pid: 800, ppid: 1, cmd: '/System/Library/mediaanalysisd' }];
const NOW = Date.parse('2026-11-04T15:35:00Z');
/** A listener that finished its last job long before the turn and has listened since. */
const IDLE_LOG = '[2026-11-04 14:00:00Z INFO Terminal] WRITE LINE: 2026-11-04 14:00:00Z: Job check completed with result: Succeeded\n';

function harness(o: { platform?: NodeJS.Platform; state?: RunnersState; opsRunner?: (root: string) => boolean } = {}) {
  const s = {
    holder: undefined as { ticket: string; ownerPid?: number } | undefined,
    procs: [...LISTENERS, ...JOB, LEFTOVER, ...OTHER] as Proc[],
    /** A listing to give right after the next pause (a job taken in that instant). */
    afterPause: undefined as Proc[] | undefined,
    /** Each runner root's listener log tail (absent: IDLE_LOG; null: unreadable). */
    diag: {} as Record<string, string | null>,
    /** A log to give a root once its listener (pid) is paused (a job line written as the pause landed). */
    diagAfterPause: undefined as { pid: number; root: string; log: string } | undefined,
    now: NOW,
    signals: [] as string[],
    written: [] as RunnersState[],
    log: [] as string[],
    listings: 0,
  };
  const d: BenchRunnersDeps = {
    holder: () => s.holder,
    procs: async () => {
      s.listings++;
      if (s.afterPause && s.signals.some((x) => x.startsWith('SIGSTOP'))) {
        const p = s.afterPause;
        s.afterPause = undefined;
        s.procs = p;
      }
      return s.procs;
    },
    signal: (pid, sig) => {
      s.signals.push(`${sig} ${pid}`);
    },
    diag: (root) => {
      const rel = root.slice(H.length + 1);
      const a = s.diagAfterPause;
      if (a && a.root === rel && s.signals.includes(`SIGSTOP ${a.pid}`)) s.diag[rel] = a.log;
      const v = s.diag[rel];
      return v === null ? undefined : (v ?? IDLE_LOG);
    },
    read: () => o.state,
    write: (st) => s.written.push(JSON.parse(JSON.stringify(st))),
    log: (t) => s.log.push(t),
    now: () => s.now,
    platform: o.platform ?? 'darwin',
    opsRunner: o.opsRunner,
  };
  return { s, r: new BenchRunners(d) };
}

/** The looks after a ticket is let go until its paused listeners are continued (w3698, RELEASE_LOOKS). */
async function release(r: BenchRunners) {
  for (let i = 0; i < RELEASE_LOOKS; i++) await r.tick();
}

test('w3112: the census: a listener is idle, a worker is a job, a _work process no worker started is a leftover', () => {
  const c = runnerCensus([...LISTENERS, ...JOB, LEFTOVER, ...OTHER]);
  assert.deepEqual(
    c.listeners.map((l) => [l.root, l.busy]),
    [
      [`${H}/actions-runner`, false],
      [`${H}/ffu-runner`, true],
      [`${H}/ffw/ffu-runners/ffu-m3-2`, false],
    ],
  );
  assert.deepEqual(c.workers, [{ pid: 610, root: `${H}/ffu-runner` }]);
  assert.deepEqual(c.leftovers.map((x) => x.pid), [700]);
  // a CI job that takes a ticket itself: its own worker is no job, and nothing of its tree is a leftover
  const own = runnerCensus([...LISTENERS, ...JOB, { pid: 900, ppid: 612, cmd: 'python3 bench_queue.py timed' }], 900);
  assert.deepEqual(own.workers, []);
  assert.deepEqual(own.leftovers, []);
  // Windows command lines, with the doubled separator Win32_Process shows
  const win = runnerCensus([{ pid: 1, ppid: 0, cmd: '"F:\\ffw\\ffu-runners\\ffu-beast-2\\\\bin\\Runner.Listener.exe"  run ' }]);
  assert.equal(win.listeners[0].root, 'F:/ffw/ffu-runners/ffu-beast-2');
});

test('w3112: an exclusive turn pauses the idle runners, waits for the busy one, ends the leftover, and brings them all back at release', async () => {
  const { s, r } = harness();
  await r.tick();
  assert.equal(s.listings, 0, 'no turn, nothing paused: no listing');
  s.holder = { ticket: 't00001116', ownerPid: 4000 };
  await r.tick();
  // the busy ~/ffu-runner (its Runner.Worker 610 runs a job) is never paused: its listener renews the job's lock
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 503', 'SIGTERM 700']);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 503]);
  assert.deepEqual(s.written.at(-1)?.ended.map((e) => e.pid), [700]);
  // the job ends: its listener is paused at the next look; the leftover is not signalled again
  s.procs = [...LISTENERS, ...OTHER];
  s.signals = [];
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 502']);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 503, 502]);
  // the ticket is released: once RELEASE_LOOKS looks agree (w3698), every paused listener is continued, and the file emptied
  s.holder = undefined;
  s.signals = [];
  await release(r);
  assert.deepEqual(s.signals, ['SIGCONT 501', 'SIGCONT 503', 'SIGCONT 502']);
  assert.deepEqual(r.paused(), []);
  assert.deepEqual(s.written.at(-1), { paused: [], ended: [] });
  assert.ok(s.log.some((l) => /runner .*ffu-runner \(listener pid 502\) continued: it takes CI jobs again/.test(l)));
});

test('w3112: a listener that took a job in the instant it was paused is continued at once', async () => {
  const { s, r } = harness();
  s.procs = [...LISTENERS, ...OTHER];
  s.afterPause = [...LISTENERS, { pid: 620, ppid: 501, cmd: `${H}/actions-runner/bin/Runner.Worker spawnclient 1 2` }];
  s.holder = { ticket: 't00001116' };
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 502', 'SIGSTOP 503', 'SIGCONT 501']);
  assert.deepEqual(r.paused().map((p) => p.pid), [502, 503]);
  assert.ok(s.log.some((l) => /took a job as it was paused: continued/.test(l)));
});

test('w3112: a daemon restarted after a turn continues the listeners its file says it paused; a pid that is no listener now is left', async () => {
  const { s, r } = harness({ state: { ticket: 't00001116', paused: [{ pid: 501, root: `${H}/actions-runner`, at: 'x' }, { pid: 999, root: `${H}/gone`, at: 'x' }], ended: [] } });
  await release(r);
  assert.deepEqual(s.signals, ['SIGCONT 501']);
  assert.deepEqual(s.written.at(-1), { paused: [], ended: [] });
});

test('w3454: Windows runners are paused too (the suspend answers later): idle ones at once, a busy one after its job, none ended', async () => {
  // BEAST on 2026-11-07 (Win32_Process): four ffu runners on F: and one in rydin's home, each started by run.cmd
  const W = (pid: number, ppid: number, root: string, exe: string, args: string): Proc => ({ pid, ppid, cmd: `"${root}\\\\bin\\${exe}"  ${args}` });
  const F = 'F:\\ffw\\ffu-runners\\ffu-beast-';
  const listeners = [W(35452, 1, `${F}2`, 'Runner.Listener.exe', 'run'), W(29760, 1, `${F}3`, 'Runner.Listener.exe', 'run'), W(33400, 1, 'C:\\Users\\rydin\\ffu-runner', 'Runner.Listener.exe', 'run')];
  const job = W(25884, 33400, 'C:\\Users\\rydin\\ffu-runner', 'Runner.Worker.exe', 'spawnclient 1980 3588');
  const leftover: Proc = { pid: 9000, ppid: 1, cmd: 'F:\\ffw\\ffu-runners\\ffu-beast-2\\_work\\ffu\\ffu\\target\\debug\\ffu-server.exe --listen 127.0.0.1:0' };
  const { s, r } = harness({ platform: 'win32' });
  const sync = s.signals;
  // the daemon's Windows signal is a PowerShell NtSuspendProcess call: it answers after a while
  (r as unknown as { d: BenchRunnersDeps }).d.signal = (pid, sig) => new Promise((res) => setTimeout(() => res(void sync.push(`${sig} ${pid}`)), 5));
  s.diag = {};
  (r as unknown as { d: BenchRunnersDeps }).d.diag = () => IDLE_LOG;
  s.procs = [...listeners, job, leftover];
  s.holder = { ticket: 't00006095', ownerPid: 4000 };
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 35452', 'SIGSTOP 29760'], 'the busy C: runner is left to finish its job; the leftover is not ended on Windows');
  assert.deepEqual(r.paused().map((p) => p.root), ['F:/ffw/ffu-runners/ffu-beast-2', 'F:/ffw/ffu-runners/ffu-beast-3']);
  s.procs = [...listeners];
  await r.tick();
  assert.deepEqual(s.signals.slice(2), ['SIGSTOP 33400'], 'C:/Users/rydin/ffu-runner is paused once its job ends');
  s.holder = undefined;
  await release(r);
  assert.deepEqual(s.signals.slice(3), ['SIGCONT 35452', 'SIGCONT 29760', 'SIGCONT 33400']);
  assert.ok(!s.log.some((l) => /Windows has no SIGSTOP/.test(l)));
});

// w3195: ffu-biscuit-3's own log (_diag/Runner_20261106-073706-utc.log) as w3153's exclusive turn t00003111 paused it: the
// check-release job ended, the queued check job was acknowledged in the same second, and the listener was paused before
// its acquirejob came back (the next line is 15:25:27Z, "already acquired"; job 127943935420 lost communication at 15:16).
const BISCUIT_3 = [
  '[2026-11-06 15:06:11Z INFO Terminal] WRITE LINE: 2026-11-06 15:06:11Z: Job check-release completed with result: Succeeded',
  '[2026-11-06 15:06:11Z INFO JobDispatcher] Stop renew job request for job 4eae2ede-db0f-517b-ac95-a12979785c08.',
  '[2026-11-06 15:06:11Z INFO BrokerMessageListener] Received job status event. JobState: Online',
  "[2026-11-06 15:06:11Z INFO BrokerMessageListener] Acknowledging runner request '1a5b1101-1f6a-51ed-a9fb-96301946184d'.",
  '[2026-11-06 15:06:11Z INFO ConfigurationStore] HasCredentials()',
  '[2026-11-06 15:06:11Z INFO GitHubActionsService] AAD Correlation ID for this token request: Unknown',
  '',
].join('\n');
const PAUSED_AT = Date.parse('2026-11-06T15:06:14Z');

test('w3195: a listener log says whether it holds a job: the newest job or idle line decides', () => {
  const l = listenerLog(BISCUIT_3);
  assert.equal(l.state, 'job');
  assert.equal(l.at, Date.parse('2026-11-06T15:06:11Z'));
  assert.match(holdsJob(l, PAUSED_AT) ?? '', /handed a job at 2026-11-06T15:06:11/);
  // the job ended moments ago: the queued one may be on its way
  const ended = listenerLog(BISCUIT_3.split('\n')[0]);
  assert.equal(ended.state, 'idle');
  assert.match(holdsJob(ended, Date.parse('2026-11-06T15:06:14Z')) ?? '', /ended moments ago/);
  assert.equal(holdsJob(ended, Date.parse('2026-11-06T15:06:11Z') + SETTLE_MS), undefined);
  // a job line past GitHub's 10-minute lock with no worker is gone; a tail with no job line has listened all along
  assert.equal(holdsJob(l, Date.parse('2026-11-06T15:19:00Z')), undefined);
  assert.deepEqual(listenerLog('[2026-11-06 15:06:11Z INFO ConfigurationStore] HasCredentials()\n'.padStart(64 * 1024, 'x')), { state: 'idle' });
  assert.equal(listenerLog(undefined).state, 'unknown');
  assert.match(holdsJob(listenerLog(undefined), PAUSED_AT) ?? '', /could not be read/);
  // a restarted runner says it listens
  assert.equal(listenerLog('[2026-11-02 20:29:52Z INFO Terminal] WRITE LINE: 2026-11-02 20:29:52Z: Listening for Jobs\n').state, 'idle');
});

test('w3195: a listener handed its next job (acknowledged, no worker yet) is not paused, and is paused once it is idle', async () => {
  const { s, r } = harness();
  s.procs = [...LISTENERS, ...OTHER]; // no Runner.Worker anywhere: the old census called all three idle
  s.diag['ffu-runner'] = BISCUIT_3;
  s.now = PAUSED_AT;
  s.holder = { ticket: 't00003111' };
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 503']);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 503]);
  assert.equal(s.log.filter((l) => /listener pid 502\) not paused yet: its log says it was handed a job/.test(l)).length, 1);
  // its worker starts and runs the job; the next looks leave it alone and say nothing more
  s.procs = [...LISTENERS, { pid: 630, ppid: 502, cmd: `${H}/ffu-runner/bin/Runner.Worker spawnclient 1 2` }];
  s.signals = [];
  await r.tick();
  assert.deepEqual(s.signals, []);
  // the job ends: not in the same breath (a queued one comes within a second), but once it has settled
  s.procs = [...LISTENERS, ...OTHER];
  s.now = Date.parse('2026-11-06T15:10:00Z');
  s.diag['ffu-runner'] = `${BISCUIT_3}[2026-11-06 15:09:58Z INFO Terminal] WRITE LINE: 2026-11-06 15:09:58Z: Job check completed with result: Succeeded\n`;
  await r.tick();
  assert.deepEqual(s.signals, []);
  s.now = Date.parse('2026-11-06T15:10:10Z');
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 502']);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 503, 502]);
});

test('w3195: a listener whose log took a job as the pause landed is continued at once', async () => {
  const { s, r } = harness();
  s.procs = [...LISTENERS, ...OTHER];
  s.diag['ffw/ffu-runners/ffu-m3-2'] = BISCUIT_3.split('\n')[0] + '\n'; // its job ended at 15:06:11 ...
  s.now = Date.parse('2026-11-06T15:06:30Z');
  s.diagAfterPause = { pid: 503, root: 'ffw/ffu-runners/ffu-m3-2', log: BISCUIT_3 }; // ... and it acknowledged the next one as it was paused
  s.holder = { ticket: 't00003111' };
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 502', 'SIGSTOP 503', 'SIGCONT 503']);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 502]);
  assert.ok(s.log.some((l) => /ffu-m3-2 \(listener pid 503\) took a job as it was paused: continued/.test(l)));
});

test('w3195: a listener whose log cannot be read is not paused (a job it holds cannot be ruled out)', async () => {
  const { s, r } = harness();
  s.procs = [...LISTENERS, ...OTHER];
  s.diag['actions-runner'] = null;
  s.holder = { ticket: 't00003111' };
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 502', 'SIGSTOP 503']);
  assert.ok(s.log.some((l) => /listener pid 501\) not paused yet: its _diag log could not be read/.test(l)));
});

test('w3195: readListenerLog reads the tail of the newest Runner_*.log in <root>/_diag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  assert.equal(readListenerLog(root), undefined);
  fs.mkdirSync(path.join(root, '_diag'));
  fs.writeFileSync(path.join(root, '_diag', 'Runner_20261104-060908-utc.log'), IDLE_LOG);
  fs.writeFileSync(path.join(root, '_diag', 'Runner_20261106-073706-utc.log'), 'x'.repeat(100 * 1024) + '\n' + BISCUIT_3);
  fs.writeFileSync(path.join(root, '_diag', 'Worker_20261106-150436-utc.log'), IDLE_LOG);
  const tail = readListenerLog(root) ?? '';
  assert.equal(tail.length, 64 * 1024);
  assert.equal(listenerLog(tail).state, 'job');
});

// biscuit, 2026-11-06: `~/ffu-runner/bin/Runner.Listener --version` at 16:30:34Z (w3202) wrote this log, newer by name than
// the live listener's; read by name it said idle, and at 17:08:50Z under t00003135 the listener was paused holding job bd216421
const VERSION_LOG = [
  "[2026-11-06 16:30:34Z INFO HostContext] Well known directory 'Root': '/home/ben-ryding/ffu-runner'",
  "[2026-11-06 16:30:34Z INFO CommandSettings] Flag 'version': 'True'",
  '[2026-11-06 16:30:34Z INFO Terminal] WRITE LINE: 2.338.2',
  '[2026-11-06 16:30:34Z INFO Listener] Runner execution has finished with return code 0',
  '',
].join('\n');
const FFU_RUNNER = [
  '[2026-11-06 17:08:49Z INFO Terminal] WRITE LINE: 2026-11-06 17:08:49Z: Job check completed with result: Succeeded',
  "[2026-11-06 17:08:49Z INFO BrokerMessageListener] Acknowledging runner request 'bd216421-e933-59fc-8e1a-12d1c3e62272'.",
  '[2026-11-06 17:08:50Z INFO GitHubActionsService] AAD Correlation ID for this token request: Unknown',
  '',
].join('\n');

test('w3195: the log read is the one the live listener writes, not a --version run newer by name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  const diag = path.join(root, '_diag');
  fs.mkdirSync(diag);
  const live = path.join(diag, 'Runner_20261106-084734-utc.log');
  const version = path.join(diag, 'Runner_20261106-163034-utc.log');
  fs.writeFileSync(live, 'x'.repeat(100 * 1024) + '\n' + FFU_RUNNER);
  fs.writeFileSync(version, VERSION_LOG);
  fs.utimesSync(version, new Date('2026-11-06T16:30:34Z'), new Date('2026-11-06T16:30:34Z'));
  fs.utimesSync(live, new Date('2026-11-06T17:08:50Z'), new Date('2026-11-06T17:08:50Z'));
  const l = listenerLog(readListenerLog(root));
  assert.equal(l.state, 'job');
  assert.match(holdsJob(l, Date.parse('2026-11-06T17:08:51Z')) ?? '', /handed a job at 2026-11-06T17:08:49/);
  // a whole log with no job or listening line is not a listener's: it holds like an unread one
  assert.equal(listenerLog(VERSION_LOG).state, 'unknown');
  assert.match(holdsJob(listenerLog(VERSION_LOG), Date.parse('2026-11-06T17:08:51Z')) ?? '', /not a listening runner's/);
});

test('w3424: an operations runner (ff-ops-runner in its root) is never paused for a turn; the others are, as before', async () => {
  const { s, r } = harness({ opsRunner: (root) => root === `${H}/ffw/ffu-runners/ffu-m3-2` });
  s.procs = [...LISTENERS, ...OTHER];
  s.holder = { ticket: 't00003511', ownerPid: 4000 };
  await r.tick();
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 502']);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 502]);
  assert.equal(s.log.filter((l) => /listener pid 503\) not paused: an operations runner \(ff-ops-runner, w3424\)/.test(l)).length, 1, 'said once, not every look');
  s.holder = undefined;
  s.signals = [];
  await release(r);
  assert.deepEqual(s.signals, ['SIGCONT 501', 'SIGCONT 502']);
});

test('w3424: isOpsRunner reads the mark file in the runner root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-runner-'));
  assert.equal(isOpsRunner(root), false);
  fs.writeFileSync(path.join(root, OPS_RUNNER_MARK), 'w3424: the shared FFU world deploy only\n');
  assert.equal(isOpsRunner(root), true);
});

// w3698: m3, 2026-11-08. Under exclusive ticket t00001186 (w3141's FFU timing) the ffu listeners 2208 and 2210 were
// continued at about 17:53Z and 17:58Z while the ticket still held, and CI builds ran beside the timed leg.
test('w3698: each runner is paused as it goes idle, one at a time, while the others still run jobs', async () => {
  const { s, r } = harness();
  const W = (pid: number, ppid: number, root: string): Proc => ({ pid, ppid, cmd: `${H}/${root}/bin/Runner.Worker spawnclient 1 2` });
  // both ffu runners run jobs back to back; the old runner is idle
  s.procs = [...LISTENERS, W(610, 502, 'ffu-runner'), W(611, 503, 'ffw/ffu-runners/ffu-m3-2')];
  s.holder = { ticket: 't00001184' };
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501']);
  // ffu-runner's job ends (its log settled), ffu-m3-2's goes on: ffu-runner is paused now, not when both are idle
  s.procs = [...LISTENERS, W(611, 503, 'ffw/ffu-runners/ffu-m3-2')];
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 502']);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 502]);
  // then ffu-m3-2's
  s.procs = [...LISTENERS];
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 502', 'SIGSTOP 503']);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 502, 503]);
});

test('w3698: a listener whose last log line is a job past STALE_JOB_MS stays paused (it was paused and continued every look)', async () => {
  const { s, r } = harness();
  s.procs = [...LISTENERS, ...OTHER];
  const ran = '[2026-11-08 17:40:00Z INFO Terminal] WRITE LINE: 2026-11-08 17:40:00Z: Running job: build (macos)\n';
  s.diag['ffu-runner'] = ran;
  s.now = Date.parse('2026-11-08T17:40:00Z') + STALE_JOB_MS + 1000;
  s.holder = { ticket: 't00001186' };
  for (let i = 0; i < 4; i++) await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 502', 'SIGSTOP 503'], 'paused once, never continued');
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 502, 503]);
  assert.ok(!s.log.some((l) => /took a job as it was paused/.test(l)));
});

test('w3698: nothing is continued while the ticket holds, even when one look misses it; all are once it is let go', async () => {
  const { s, r } = harness();
  s.procs = [...LISTENERS, ...OTHER];
  s.holder = { ticket: 't00001186' };
  await r.tick();
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 502, 503]);
  for (let look = 0; look < 30; look++) {
    // every third look reads the queue mid-rewrite and finds no holder
    s.holder = look % 3 === 1 ? undefined : { ticket: 't00001186' };
    await r.tick();
  }
  assert.ok(!s.signals.some((x) => x.startsWith('SIGCONT')), `continued during the turn: ${s.signals.join(', ')}`);
  assert.deepEqual(r.paused().map((p) => p.pid), [501, 502, 503]);
  s.holder = undefined;
  s.signals = [];
  await r.tick();
  await r.tick();
  assert.deepEqual(s.signals, [], `not on fewer than ${RELEASE_LOOKS} looks`);
  await r.tick();
  assert.deepEqual(s.signals, ['SIGCONT 501', 'SIGCONT 502', 'SIGCONT 503']);
});

test('w3698: a look whose listing never came back does not stop the later looks', async () => {
  const { s, r } = harness();
  s.procs = [...LISTENERS, ...OTHER];
  s.holder = { ticket: 't00001183' };
  const d = (r as unknown as { d: BenchRunnersDeps }).d;
  const real = d.procs;
  d.procs = () => new Promise(() => undefined); // ps hung
  void r.tick();
  d.procs = real;
  await r.tick();
  assert.deepEqual(s.signals, [], 'a look still running is not doubled');
  s.now += 3 * 60_000;
  await r.tick();
  assert.deepEqual(s.signals, ['SIGSTOP 501', 'SIGSTOP 502', 'SIGSTOP 503']);
});
