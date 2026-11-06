import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchRunners, holdsJob, listenerLog, readListenerLog, runnerCensus, SETTLE_MS, type BenchRunnersDeps, type RunnersState } from '../machine/benchRunners.ts';
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

function harness(o: { platform?: NodeJS.Platform; state?: RunnersState } = {}) {
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
  };
  return { s, r: new BenchRunners(d) };
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
  // the ticket is released: every paused listener is continued, and the file emptied
  s.holder = undefined;
  s.signals = [];
  await r.tick();
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
  await r.tick();
  assert.deepEqual(s.signals, ['SIGCONT 501']);
  assert.deepEqual(s.written.at(-1), { paused: [], ended: [] });
});

test('w3112: Windows runners are not paused (no SIGSTOP): the turn says so once', async () => {
  const { s, r } = harness({ platform: 'win32' });
  s.holder = { ticket: 't00001116' };
  await r.tick();
  await r.tick();
  assert.deepEqual(s.signals, []);
  assert.equal(s.listings, 0);
  assert.equal(s.log.filter((l) => /Windows has no SIGSTOP/.test(l)).length, 1);
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
  assert.deepEqual(listenerLog('[2026-11-06 15:06:11Z INFO ConfigurationStore] HasCredentials()\n'), { state: 'idle' });
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
