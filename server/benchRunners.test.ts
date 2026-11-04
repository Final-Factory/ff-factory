import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BenchRunners, runnerCensus, type BenchRunnersDeps, type RunnersState } from '../machine/benchRunners.ts';
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

function harness(o: { platform?: NodeJS.Platform; state?: RunnersState } = {}) {
  const s = {
    holder: undefined as { ticket: string; ownerPid?: number } | undefined,
    procs: [...LISTENERS, ...JOB, LEFTOVER, ...OTHER] as Proc[],
    /** A listing to give right after the next pause (a job taken in that instant). */
    afterPause: undefined as Proc[] | undefined,
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
    read: () => o.state,
    write: (st) => s.written.push(JSON.parse(JSON.stringify(st))),
    log: (t) => s.log.push(t),
    now: () => Date.parse('2026-11-04T15:35:00Z'),
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
