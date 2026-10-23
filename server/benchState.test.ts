import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchLockDir } from '../machine/benchLock.ts';
import { BenchTicket, benchQueueDir, findBenchQueueScript } from '../machine/benchQueue.ts';
import { BENCH_STATE_MAX_RUNNING, readBenchState } from '../machine/benchState.ts';
import { benchGlance } from '../shared/benchGlance.ts';

/**
 * w1835 (lothsahn, 2026-10-23: "Please display on FF factory's webpage for the machine view whether each machine is in
 * shared or exclusive lock mode"): the daemon reads its bench queue's mode, holders and waiters (machine/benchState.ts),
 * and the machine view says them (shared/benchGlance.ts). The mode shown is the queue's: these build the queue's files as
 * bench_queue.py writes them, and with FF_GAME_REPO set, drive the real queue.
 */

const tmp = (t: { after(fn: () => void): void }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w1835-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const NOW = Date.parse('2026-10-23T08:00:00Z');
const sec = (minAgo: number) => (NOW - minAgo * 60_000) / 1000;

/** A ticket folder as bench_queue.py writes it; `granted` in seconds. */
function ticket(root: string, name: string, info: object, granted?: number, revoked = false) {
  const d = path.join(benchQueueDir(benchLockDir(root)), name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'info.json'), JSON.stringify({ ticket: name, pid: 555, created: new Date(NOW - 30 * 60_000).toISOString(), ...info }));
  if (granted) fs.writeFileSync(path.join(d, 'granted'), JSON.stringify({ at: new Date(granted * 1000).toISOString(), ts: granted }));
  if (revoked) fs.writeFileSync(path.join(d, 'revoked'), JSON.stringify({ at: 'x', why: 'preempted' }));
}

const alive = (pid: number) => pid === 555;

test('w1835: the mode shown is the queue\'s: Free, Shared while only shared tickets run, Exclusive while a timed leg holds it', (t) => {
  const root = tmp(t);
  assert.equal(readBenchState(undefined), undefined, 'no worker root: nothing to report');
  const free = readBenchState(root, NOW, alive)!;
  assert.deepEqual(free, { mode: 'free', running: [], runningCount: 0, waiting: 0 });
  assert.equal(benchGlance(free, NOW)!.label, 'Free');
  assert.equal(benchGlance(free, NOW)!.detail, '');

  // Two builds share it.
  ticket(root, 't00000001', { mode: 'shared', what: 'unity: build slot1', session: 'aaaa1111bbbb', requests: ['w1800'], max_min: 120 }, sec(5));
  ticket(root, 't00000002', { mode: 'shared', what: 'editor boot slot3', max_min: 30 }, sec(2));
  const shared = readBenchState(root, NOW, alive)!;
  assert.equal(shared.mode, 'shared');
  assert.equal(shared.runningCount, 2);
  const sg = benchGlance(shared, NOW)!;
  assert.equal(sg.label, 'Shared');
  assert.equal(sg.tone, 'blue');
  assert.equal(sg.detail, '2 tickets running');

  // A timed leg waits behind them: the next exclusive one, starting within the group's longest bound at the latest.
  ticket(root, 't00000003', { mode: 'exclusive', what: 'probe A round 2', session: 'cccc2222dddd', requests: ['w1243'], max_min: 30 });
  const waits = readBenchState(root, NOW, alive)!;
  assert.equal(waits.mode, 'shared', 'a waiting timed leg does not make it exclusive');
  assert.equal(waits.waiting, 1);
  assert.equal(waits.nextExclusive?.ticket, 't00000003');
  assert.equal(waits.nextExclusive?.ahead, 0);
  const wg = benchGlance(waits, NOW)!;
  assert.equal(wg.waiting, '1 waiting');
  // t00000001 granted 5 min ago with a 120 min bound: 115 min left; t00000002 28 min.
  assert.equal(wg.next, 'next timed: w1243 within 1h 55m');
  assert.match(wg.hint, /^Bench queue: Shared\n/);
  assert.match(wg.hint, /next: exclusive t00000003 · w1243 · worker cccc2222 · "probe A round 2" · waiting 30m/);

  // The builds end and the timed leg is granted: Exclusive, with its request, worker and times.
  for (const n of ['t00000001', 't00000002']) fs.rmSync(path.join(benchQueueDir(benchLockDir(root)), n), { recursive: true });
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 't00000003', 'granted'), JSON.stringify({ at: 'x', ts: sec(12) }));
  ticket(root, 't00000004', { mode: 'shared', what: 'unity: build slot2', pos: 3.5 });
  const ex = readBenchState(root, NOW, alive)!;
  assert.equal(ex.mode, 'exclusive');
  assert.equal(ex.running[0].ticket, 't00000003');
  assert.equal(ex.running[0].until, new Date(sec(12) * 1000 + 30 * 60_000).toISOString(), 'its hold bound from max_min');
  const eg = benchGlance(ex, NOW)!;
  assert.equal(eg.label, 'Exclusive');
  assert.equal(eg.tone, 'amber');
  assert.equal(eg.detail, 'w1243 · worker cccc2222');
  assert.equal(eg.times, 'held 12m, 18m left');
  assert.equal(eg.waiting, '1 waiting');
  assert.equal(eg.next, '', 'only a shared ticket waits');

  // Over its bound until the next waiter revokes it; a revoked one counts for nothing.
  assert.equal(benchGlance(readBenchState(root, NOW + 25 * 60_000, alive), NOW + 25 * 60_000)!.times, 'held 37m, 7m past its bound');
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 't00000003', 'revoked'), JSON.stringify({ at: 'x', why: 'preempted' }));
  assert.equal(readBenchState(root, NOW, alive)!.mode, 'free', 'revoked holder gone, the build not granted yet');
});

test('w1835: the queue\'s order picks the next timed leg (priority, then place), dead helpers drop out, a big group is a count', (t) => {
  const root = tmp(t);
  ticket(root, 't00000001', { mode: 'exclusive', what: 'held', max_min: 60 }, sec(1));
  ticket(root, 't00000002', { mode: 'exclusive', what: 'normal leg', session: 'normal-s' });
  ticket(root, 't00000003', { mode: 'exclusive', what: 'urgent leg', session: 'urgent-s' });
  ticket(root, 't00000004', { mode: 'exclusive', what: 'dead', pid: 999 }, sec(1));
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 'priorities.json'), JSON.stringify({ at: 'x', sessions: { 'urgent-s': { priority: 'urgent', requests: ['w1'] } } }));
  const s = readBenchState(root, NOW, alive)!;
  assert.equal(s.mode, 'exclusive');
  assert.equal(s.runningCount, 1, 'a ticket whose helper is gone is not listed');
  assert.equal(s.nextExclusive?.what, 'urgent leg', 'an urgent worker\'s leg goes first');
  assert.equal(s.nextExclusive?.ahead, 0);
  assert.equal(benchGlance(s, NOW)!.next, 'next timed: urgent leg within 59m');
  // Behind a waiting shared group: its tickets, counted (review of #549).
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 'priorities.json'), JSON.stringify({ at: 'x', sessions: {} }));
  ticket(root, 't00000005', { mode: 'shared', what: 'build a', pos: 1.5 });
  ticket(root, 't00000006', { mode: 'shared', what: 'build b', pos: 1.5 });
  assert.equal(benchGlance(readBenchState(root, NOW, alive), NOW)!.next, 'next timed: normal leg after 2 tickets ahead');

  const big = tmp(t);
  for (let i = 1; i <= BENCH_STATE_MAX_RUNNING + 2; i++) ticket(big, `t0000000${i}`, { mode: 'shared', what: `build ${i}` }, sec(1));
  const b = readBenchState(big, NOW, alive)!;
  assert.equal(b.running.length, BENCH_STATE_MAX_RUNNING);
  assert.equal(b.runningCount, BENCH_STATE_MAX_RUNNING + 2);
  assert.equal(benchGlance(b, NOW)!.detail, `${BENCH_STATE_MAX_RUNNING + 2} tickets running`);
  assert.match(benchGlance(b, NOW)!.hint, /and 2 more running/);
});

test('w1835: an old-style lock (no ticket in its owner line) is Exclusive; a queue holder\'s lock dir is not counted twice', (t) => {
  const root = tmp(t);
  const lock = benchLockDir(root);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), 'BEAST pid 4121 worker 21:04:10 probe A (/f/ffw/sandboxes/slot4)\n');
  const now = fs.statSync(lock).mtimeMs + 5 * 60_000;
  const s = readBenchState(root, now, alive)!;
  assert.equal(s.mode, 'exclusive');
  assert.equal(s.legacy?.owner, 'BEAST pid 4121 worker 21:04:10 probe A (/f/ffw/sandboxes/slot4)');
  assert.equal(benchGlance(s, now)!.detail, 'old-style lock');
  assert.equal(benchGlance(s, now)!.times, 'held 5m');

  // A timed leg waits for it: no bound to count down from (review of #549).
  ticket(root, 't00000005', { mode: 'exclusive', what: 'probe B', requests: ['w1300'] });
  assert.equal(benchGlance(readBenchState(root, now, alive), now)!.next, 'next timed: w1300 after the old-style lock');
  fs.rmSync(path.join(benchQueueDir(lock), 't00000005'), { recursive: true });

  fs.writeFileSync(path.join(lock, 'owner'), 'BEAST pid 4121 worker 21:04:10 probe A [t00000001] (/f/ffw/sandboxes/slot4)\n');
  assert.equal(readBenchState(root, now, alive)!.mode, 'free', 'a ticket line without its live ticket: nobody holds it');
  ticket(root, 't00000001', { mode: 'exclusive', what: 'probe A' }, now / 1000 - 60);
  const q = readBenchState(root, now, alive)!;
  assert.equal(q.mode, 'exclusive');
  assert.equal(q.legacy, undefined);
  assert.equal(q.runningCount, 1);
});

test('w1835: a daemon before it reports no queue: the view shows no bench line', () => {
  assert.equal(benchGlance(undefined, NOW), undefined);
});

const GAME = process.env.FF_GAME_REPO;
test('w1835: against the real bench_queue.py, the mode follows the queue: Exclusive, then Shared when the timed leg lets go, then Free', { skip: !GAME || !findBenchQueueScript([GAME]) ? 'FF_GAME_REPO not set to a checkout with scripts/bench/bench_queue.py' : false }, async (t) => {
  const root = tmp(t);
  const lock = benchLockDir(root);
  const script = findBenchQueueScript([GAME])!;
  const env: NodeJS.ProcessEnv = { ...process.env, BENCH_POLL_S: '0.1', BENCH_LEGACY_GRACE_S: '0' };
  delete env.FF_BENCH_TICKET;
  assert.equal(readBenchState(root)!.mode, 'free');
  const ex = new BenchTicket({ script, lock, mode: 'exclusive', what: 'probe A', tempDir: root, env }).take();
  assert.equal((await ex.wait(15_000)).kind, 'granted');
  const sh = new BenchTicket({ script, lock, mode: 'shared', what: 'unity: build', tempDir: root, env }).take();
  assert.equal((await sh.wait(1500)).kind, 'waiting');
  const held = readBenchState(root)!;
  assert.equal(held.mode, 'exclusive');
  assert.equal(held.legacy, undefined, 'the holder\'s own lock dir carries its ticket');
  assert.equal(held.waiting, 1);
  assert.equal(benchGlance(held, Date.now())!.label, 'Exclusive');
  ex.release();
  assert.equal((await sh.wait(15_000)).kind, 'granted');
  const until = Date.now() + 10_000;
  while (readBenchState(root)!.mode !== 'shared' && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.equal(benchGlance(readBenchState(root), Date.now())!.label, 'Shared');
  sh.release();
  const gone = Date.now() + 15_000;
  while (readBenchState(root)!.mode !== 'free' && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readBenchState(root)!.mode, 'free');
});
