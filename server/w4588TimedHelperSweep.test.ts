import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchTicket } from '../machine/benchQueue.ts';
import { LEFTOVER, LeftoverReaper, envFrom, macEnvLine, readEnvs, sessionVerdict, type LeftoverDeps } from '../machine/leftovers.ts';
import { timedRunEnv } from '../machine/timedRunner.ts';
import type { UnityPlatform } from '../machine/unity.ts';
import { movedRequestsOf } from './resumable.ts';

/**
 * w4588: the leftover sweep ended a live timed run's bench-queue helper. On lothdesktop, 2026-11-17, timed run
 * tr_6b6935944b (w4554's 16 against 20 UPS LifeSave legs), asked for by worker 974429a3, waited for exclusive ticket
 * t00007358 through a `bench_queue.py hold` child of the daemon. At 15:41:31Z w4554 moved to biscuit (a w2046 room move);
 * at 15:42:18Z the run failed with "the bench queue helper exited 1"; at 15:42:26Z the journal said the sweep had ended
 * "conhost pid 28400, python pid 26508" of worker 974429a3 because "its worker stopped 8 min ago and no request waits for
 * it". The helper carried FF_SESSION_ID=974429a3 (machine/daemon.ts gave it the asking worker's session for the queue's
 * order), and the sweep charges a process to the session in its environment.
 *
 * Here a real child process stands in for the helper (a fixture script, never bench_queue.py, never a real worker's
 * process), started by the real BenchTicket with the environment the daemon now gives it (timedRunEnv), read by the real
 * environment reader of this platform, and judged by the real LeftoverReaper on a fake clock. The only process it can
 * signal is that child.
 */

const MIN = 60_000;
const RUN = 'tr_6b6935944b';
const WORKER = '974429a3';
const MACHINE = 'lothdesktop';

/** The stand-in helper: writes a waiting line, and the granted line once `<status>.grant` exists; ends on `<status>.release`. */
const FAKE_HOLD = `
const a = process.argv.slice(2);
const status = a[a.indexOf('--status') + 1];
const fs = require('node:fs');
fs.writeFileSync(status, 'waiting t00007358: exclusive ticket, place 9\\n');
setInterval(() => {
  if (fs.existsSync(status + '.release')) process.exit(0);
  if (fs.existsSync(status + '.grant')) fs.writeFileSync(status, 'granted t00007358 exclusive\\n');
}, 50);
`;

async function scenario(o: { moved: string[]; runLive: () => boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4588-'));
  const script = path.join(dir, 'fake_hold.cjs');
  fs.writeFileSync(script, FAKE_HOLD);
  const env = { ...timedRunEnv(process.env, WORKER, RUN), FF_SANDBOX_ID: '', FF_MACHINE_ID: MACHINE, FF_WORKER_ROOT: dir };
  const ticket = new BenchTicket({ script, lock: path.join(dir, 'bench.lock'), mode: 'exclusive', what: `timed run ${RUN}`, reason: 'timing', python: process.execPath, env, tempDir: dir }).take();
  const child = (ticket as unknown as { child: { pid: number; exitCode: number | null; signalCode: string | null } }).child;
  const pid = child.pid;
  const platform = process.platform as UnityPlatform;
  let now = 1_000 * 60 * MIN;
  const events: string[] = [];
  const logs: string[] = [];
  const deps: LeftoverDeps = {
    platform,
    machineId: MACHINE,
    root: dir,
    // Only the fixture child is listed, so nothing else can be judged, let alone signalled.
    procs: async () => ((child.exitCode === null && child.signalCode === null) ? [{ pid, ppid: process.pid, cmd: `${process.execPath} ${script} --lock ${dir}/bench.lock hold --mode exclusive --reason timing` }] : []),
    envOf: (pids) => readEnvs(platform, pids.filter((p) => p === pid)),
    inspect: async (pids) => pids.filter((p) => p === pid).map((p) => ({ pid: p, startedAt: now - 9 * MIN, cpuMs: 0 })),
    sessionLive: () => false,
    sessionKnown: () => true,
    resumable: () => false,
    movedRequests: () => o.moved,
    timedRunLive: (id) => id === RUN && o.runLive(),
    wakeAt: () => undefined,
    liveSandboxes: () => new Set(),
    ready: () => true,
    slotRoots: () => [],
    tempRoot: () => path.join(dir, 'tmp'),
    leases: () => [],
    protectedPaths: () => [],
    places: () => [],
    self: () => [process.pid],
    host: os.hostname(),
    kill: (p, sig) => {
      if (p !== pid) throw new Error(`the sweep tried to signal pid ${p}, not the fixture's`);
      try {
        process.kill(p, sig);
      } catch {
        // already gone
      }
    },
    exists: (p) => fs.existsSync(p),
    remove: () => undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 200))),
    now: () => now,
    log: (l) => void logs.push(l),
    onEvent: (t) => void events.push(t),
  };
  const reaper = new LeftoverReaper(deps);
  const look = async (min = 1) => {
    now += min * MIN;
    return reaper.look();
  };
  const exited = async () => {
    for (let i = 0; i < 100 && (child.exitCode === null && child.signalCode === null); i++) await new Promise((r) => setTimeout(r, 50));
    return child.exitCode !== null || child.signalCode !== null;
  };
  const done = () => {
    ticket.release();
    try {
      if ((child.exitCode === null && child.signalCode === null)) process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ticket, child, pid, look, events, logs, exited, done, grant: () => fs.writeFileSync(`${ticket.status}.grant`, '') };
}

for (const c of [
  { name: 'its worker stops', moved: [] as string[] },
  { name: 'its request moves to another worker (w2046)', moved: ['w4554'] },
]) {
  test(`lothdesktop, 2026-11-17: a timed run's bench-queue helper outlives the sweep while ${c.name} and the run waits for its ticket; then the run gets it`, async () => {
    const s = await scenario({ moved: c.moved, runLive: () => true });
    try {
      assert.equal((await s.ticket.wait(5_000)).kind, 'waiting', 'the helper started and waits for its ticket');
      // 13 looks a minute apart: past the 2 min of a finished worker and the 10 min of a waited-for one.
      for (let i = 0; i < 13; i++) assert.deepEqual(await s.look(1), [], `minute ${i + 1}: nothing ended`);
      assert.ok(s.child.exitCode === null && s.child.signalCode === null, 'the helper still runs');
      assert.deepEqual(s.events, []);
      assert.match(s.logs.join('\n'), new RegExp(`spared pid ${s.pid}, serving the live timed run ${RUN} \\(asked for by worker ${WORKER}\\)`));
      s.grant();
      const st = await s.ticket.wait(5_000);
      assert.equal(st.kind, 'granted');
      assert.equal(st.kind === 'granted' && st.ticket, 't00007358');
    } finally {
      s.done();
    }
  });
}

test('once the timed run is over, what is left of its helper is judged by its session as before, and ended', async () => {
  let live = true;
  const s = await scenario({ moved: [], runLive: () => live });
  try {
    assert.equal((await s.ticket.wait(5_000)).kind, 'waiting');
    for (let i = 0; i < 5; i++) assert.deepEqual(await s.look(1), []);
    live = false;
    let ended = 0;
    for (let i = 0; i < 4 && !ended; i++) ended = (await s.look(1)).length;
    assert.equal(ended, 1, 'ended once the run was over');
    assert.ok(await s.exited(), 'the helper is gone');
    assert.match(s.events.join('\n'), new RegExp(`left by worker ${WORKER}.*no request waits for it`));
  } finally {
    s.done();
  }
});

test('a session whose open request moved to another worker keeps its leftovers the grace of a waited-for worker, and says why', () => {
  const t0 = 1_000 * MIN;
  const kept = sessionVerdict({ live: false, resumable: false, moved: ['w4554'], stoppedSince: t0, now: t0 + 8 * MIN });
  assert.equal(kept.end, false, 'kept 8 min after: the sweep of 15:42:26Z ended them here');
  assert.match(kept.why, /its request w4554 moved to another worker and still waits/);
  const after = sessionVerdict({ live: false, resumable: false, moved: ['w4554'], stoppedSince: t0, now: t0 + LEFTOVER.STOPPED_GRACE_MS });
  assert.equal(after.end, true);
  assert.match(after.why, /w4554 moved to another worker and still waits, with no check-in pending/);
  assert.doesNotMatch(after.why, /no request waits for it/);
  // Unchanged: a worker with nothing open anywhere.
  assert.match(sessionVerdict({ live: false, resumable: false, moved: [], stoppedSince: t0, now: t0 + LEFTOVER.DONE_GRACE_MS }).why, /no request waits for it/);
});

test('movedRequestsOf: open and stalled requests with another worker now, never closed ones or its own', () => {
  assert.deepEqual(movedRequestsOf(undefined), []);
  assert.deepEqual(
    movedRequestsOf({
      requests: [
        { id: 'w4554', status: 'blocked', with: false },
        { id: 'w4000', status: 'stalled', with: false },
        { id: 'w4001', status: 'done', with: false },
        { id: 'w4002', status: 'merged', with: false },
        { id: 'w4003', status: 'active', with: true },
      ],
    }),
    ['w4554', 'w4000'],
  );
});

test('FF_TIMED_RUN is read from every platform form of an environment', () => {
  assert.deepEqual(envFrom([`FF_SESSION_ID=${WORKER}`, `FF_TIMED_RUN=${RUN}`]), { session: WORKER, run: RUN });
  assert.deepEqual(macEnvLine(`26508 python3 bench_queue.py hold FF_SESSION_ID=${WORKER} FF_TIMED_RUN=${RUN}`)?.env, { session: WORKER, run: RUN });
  assert.deepEqual(timedRunEnv({ PATH: '/bin' }, WORKER, RUN), { PATH: '/bin', FF_SESSION_ID: WORKER, FF_TIMED_RUN: RUN });
});
