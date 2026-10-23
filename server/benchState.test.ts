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

/** A holder's limit.json as bench_queue.py writes it (w1832); times in seconds. */
function limit(root: string, name: string, lim: object) {
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), name, 'limit.json'), JSON.stringify(lim));
}

/** priorities.json as the daemon writes it (machine/benchLock.ts writeBenchPriorities). */
function prios(root: string, f: object) {
  fs.mkdirSync(benchQueueDir(benchLockDir(root)), { recursive: true });
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 'priorities.json'), JSON.stringify({ at: 'x', ...f }));
}

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
  // No deadline on the group yet (the queue sets one at the waiter's first look, w1832): it waits for the group.
  assert.equal(wg.next, 'next timed: w1243 after the running group');
  // The queue's deadline on the group, the same on each holder: the leg starts by then.
  for (const n of ['t00000001', 't00000002']) limit(root, n, { deadline: sec(-55), why: 'the shared group turn' });
  const wl = benchGlance(readBenchState(root, NOW, alive), NOW)!;
  assert.equal(wl.next, 'next timed: w1243 within 55m');
  assert.equal(wl.times, 'the group ends in 55m');
  assert.equal(wl.warned, false);
  assert.match(wg.hint, /^Bench queue: Shared\n/);
  assert.match(wg.hint, /next: exclusive t00000003 · w1243 · worker cccc2222 · "probe A round 2" · waiting 30m/);

  // The builds end and the timed leg is granted: Exclusive, with its request, worker and times.
  for (const n of ['t00000001', 't00000002']) fs.rmSync(path.join(benchQueueDir(benchLockDir(root)), n), { recursive: true });
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 't00000003', 'granted'), JSON.stringify({ at: 'x', ts: sec(12) }));
  ticket(root, 't00000004', { mode: 'shared', what: 'unity: build slot2', pos: 3.5 });
  const ex = readBenchState(root, NOW, alive)!;
  assert.equal(ex.mode, 'exclusive');
  assert.equal(ex.running[0].ticket, 't00000003');
  assert.equal(ex.running[0].until, new Date(sec(12) * 1000 + 30 * 60_000).toISOString(), 'its turn: a ticket with no turn_min keeps its max_min');
  assert.equal(ex.running[0].turnMin, 30);
  const eg = benchGlance(ex, NOW)!;
  assert.equal(eg.label, 'Exclusive');
  assert.equal(eg.tone, 'amber');
  assert.equal(eg.detail, 'w1243 · worker cccc2222');
  assert.equal(eg.times, 'held 12m, 18m left of its 30m turn');
  assert.equal(eg.waiting, '1 waiting');
  assert.equal(eg.next, '', 'only a shared ticket waits');

  // Past its turn it goes on while nobody waits (w1832); a revoked one counts for nothing.
  assert.equal(benchGlance(readBenchState(root, NOW + 25 * 60_000, alive), NOW + 25 * 60_000)!.times, 'held 37m, past its 30m turn: nobody waits');
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
  assert.equal(benchGlance(s, NOW)!.next, 'next timed: urgent leg after the running group', 'no deadline on the holder yet');
  limit(root, 't00000001', { deadline: sec(-59) });
  assert.equal(benchGlance(readBenchState(root, NOW, alive), NOW)!.next, 'next timed: urgent leg within 59m');
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

test('w1835 after w1832: a warned turn, an urgent release holding, the nightly in a shared group, a single-worker machine', (t) => {
  // A holder another worker waits behind: the queue set its deadline and warned it 5 minutes before (limit.json).
  const warned = tmp(t);
  ticket(warned, 't00000001', { mode: 'exclusive', what: 'probe A', session: 'aaaa1111', requests: ['w1243'], max_min: 60, turn_min: 30 }, sec(26));
  ticket(warned, 't00000002', { mode: 'exclusive', what: 'probe B', session: 'bbbb2222', requests: ['w1785'] });
  limit(warned, 't00000001', { deadline: sec(-4), set: sec(10), warned: sec(1), why: 'the 30-minute exclusive turn', by: 't00000002' });
  const w = readBenchState(warned, NOW, alive)!;
  assert.equal(w.running[0].deadline, new Date(sec(-4) * 1000).toISOString());
  assert.equal(w.running[0].until, w.running[0].deadline, 'the deadline is its end');
  const wg = benchGlance(w, NOW)!;
  assert.equal(wg.times, 'held 26m, warned: ends in 4m');
  assert.equal(wg.warned, true);
  assert.equal(wg.next, 'next timed: w1785 within 4m');
  assert.match(wg.hint, /held 26m, warned: ends in 4m · \(the 30-minute exclusive turn\)/);
  assert.equal(benchGlance(readBenchState(warned, NOW + 5 * 60_000, alive), NOW + 5 * 60_000)!.next, 'next timed: w1785 at the next look', 'past the deadline: revoked at the queue\'s next look');

  // An urgent release waits behind it: its notice ends the turn in 5 minutes.
  limit(warned, 't00000001', { deadline: sec(-5), warned: sec(0), release: 't00000009', why: 'an urgent release takes the machine: urgent release 1.0.0.4' });
  assert.equal(benchGlance(readBenchState(warned, NOW, alive), NOW)!.times, 'held 26m, warned: ends in 5m for an urgent release');

  // The urgent release holds the machine: its pre-empt ticket, its builder marked release (priorities.json v 2).
  const rel = tmp(t);
  prios(rel, { v: 2, single_worker: false, sessions: { rrrr9999: { priority: 'urgent', requests: ['w1900'], exempt: 'release' } } });
  ticket(rel, 't00000001', { mode: 'exclusive', what: 'urgent release 1.0.0.4', session: 'rrrr9999', requests: ['w1900'], preempt: true, turn_min: 30 }, sec(2));
  ticket(rel, 't00000002', { mode: 'exclusive', what: 'probe B', session: 'bbbb2222', requests: ['w1785'] });
  const r = readBenchState(rel, NOW, alive)!;
  assert.equal(r.running[0].preempt, true);
  assert.equal(r.running[0].exempt, 'release');
  assert.equal(r.running[0].until, undefined, 'no turn limit ends it');
  const rg = benchGlance(r, NOW)!;
  assert.equal(rg.detail, 'urgent release · w1900 · worker rrrr9999');
  assert.equal(rg.times, 'held 2m, no turn limit');
  assert.equal(rg.next, 'next timed: w1785 after the urgent release');

  // The nightly's shared ticket: exempt, so a timed leg waits for it; an older daemon's file (no v 2) marks nothing.
  const night = tmp(t);
  prios(night, { v: 2, single_worker: false, sessions: { nnnn7777: { priority: 'normal', requests: [], exempt: 'nightly' } } });
  ticket(night, 't00000001', { mode: 'shared', what: 'nightly e2e: Windows leg', session: 'nnnn7777', max_min: 120 }, sec(40));
  ticket(night, 't00000002', { mode: 'exclusive', what: 'probe B', session: 'bbbb2222', requests: ['w1785'] });
  const ng = benchGlance(readBenchState(night, NOW, alive), NOW)!;
  assert.equal(ng.detail, '1 ticket running: the nightly');
  assert.equal(ng.next, 'next timed: w1785 after the nightly');
  assert.match(ng.hint, /shared t00000001 · nightly · worker nnnn7777/);
  ticket(night, 't00000003', { mode: 'shared', what: 'unity: build slot1' }, sec(5));
  assert.equal(benchGlance(readBenchState(night, NOW, alive), NOW)!.detail, '2 tickets running, the nightly among them');
  prios(night, { sessions: { nnnn7777: { priority: 'normal', exempt: 'nightly' } } });
  assert.equal(readBenchState(night, NOW, alive)!.running.find((x) => x.ticket === 't00000001')?.exempt, undefined, 'v 1: the marks are not this daemon\'s');

  // A warned shared group: one deadline on every holder.
  limit(night, 't00000003', { deadline: sec(-3), warned: sec(2), why: 'the shared group turn' });
  assert.equal(benchGlance(readBenchState(night, NOW, alive), NOW)!.times, 'warned: the group ends in 3m');

  // One worker on the machine: no turn limits at all.
  const one = tmp(t);
  prios(one, { v: 2, single_worker: true, sessions: {} });
  ticket(one, 't00000001', { mode: 'exclusive', what: 'probe A', session: 'aaaa1111', requests: ['w1243'], turn_min: 30 }, sec(45));
  const og = benchGlance(readBenchState(one, NOW, alive), NOW)!;
  assert.equal(og.times, 'held 45m, no turn limit');
  assert.match(og.hint, /one worker on this machine: no turn limits/);
});

test('w1835 after w1829: an exclusive turn says what it closed, the editors (closed.json) and the players asked to quit', (t) => {
  const root = tmp(t);
  ticket(root, 't00000001', { mode: 'exclusive', what: 'probe A', session: 'aaaa1111', requests: ['w1243'], sandbox: 'slot1', turn_min: 30 }, sec(3));
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 'closed.json'), JSON.stringify({ slot3: 'closed for w1243', slot2: 'closed for w1243' }));
  const s = readBenchState(root, NOW, alive, 1)!;
  assert.deepEqual(s.closed, { editors: ['slot2', 'slot3'], players: 1 });
  const g = benchGlance(s, NOW)!;
  assert.equal(g.closed, 'closed for it: 2 editors, 1 player');
  assert.match(g.hint, /editors closed for the turn: slot2, slot3\ngame players asked to quit: 1/);
  assert.equal(benchGlance(readBenchState(root, NOW, alive, 0), NOW)!.closed, 'closed for it: 2 editors');
  // Shared: no turn closes anything, whatever a stale file says.
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 't00000001', 'info.json'), JSON.stringify({ ticket: 't00000001', pid: 555, mode: 'shared', what: 'build' }));
  assert.equal(readBenchState(root, NOW, alive, 1)!.closed, undefined);
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
  const tickets: BenchTicket[] = [];
  // Every helper lets go however the test ends: a live one keeps this process running.
  const take = (o: ConstructorParameters<typeof BenchTicket>[0]) => {
    const k = new BenchTicket(o).take();
    tickets.push(k);
    return k;
  };
  try {
  const ex = take({ script, lock, mode: 'exclusive', what: 'probe A', tempDir: root, env });
  assert.equal((await ex.wait(15_000)).kind, 'granted');
  const sh = take({ script, lock, mode: 'shared', what: 'unity: build', tempDir: root, env });
  assert.equal((await sh.wait(1500)).kind, 'waiting');
  const held = readBenchState(root)!;
  assert.equal(held.mode, 'exclusive');
  assert.equal(held.legacy, undefined, 'the holder\'s own lock dir carries its ticket');
  assert.equal(held.waiting, 1);
  assert.equal(benchGlance(held, Date.now())!.label, 'Exclusive');
  // w1832's turn rules (a copy with turn_min): another worker's timed leg waits, and the queue sets the holder's deadline,
  // the end of its 30-minute turn, which the view counts down.
  const turns = held.running[0].turnMin !== undefined && held.running[0].turnMin < 60;
  if (turns) {
    const ex2 = take({ script, lock, mode: 'exclusive', what: 'probe B', tempDir: root, env: { ...env, FF_SESSION_ID: 'w1835-other-worker' } });
    assert.equal((await ex2.wait(1500)).kind, 'waiting');
    const by = Date.now() + 10_000;
    while (!readBenchState(root)!.running[0]?.deadline && Date.now() < by) await new Promise((r) => setTimeout(r, 100));
    const lim = readBenchState(root)!;
    assert.ok(lim.running[0].deadline, 'the queue set the holder a deadline');
    const lg = benchGlance(lim, Date.now())!;
    assert.match(lg.times, /^held 0m, ends in (29|30)m$/);
    // The build waits ahead of it (an older ticket); the deadline is what frees the machine for both.
    assert.equal(lg.next, 'next timed: probe B after 1 ticket ahead');
    ex2.release();
    const left = Date.now() + 15_000;
    while (readBenchState(root)!.waiting > 1 && Date.now() < left) await new Promise((r) => setTimeout(r, 100));
  }
  ex.release();
  assert.equal((await sh.wait(15_000)).kind, 'granted');
  const until = Date.now() + 10_000;
  while (readBenchState(root)!.mode !== 'shared' && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.equal(benchGlance(readBenchState(root), Date.now())!.label, 'Shared');
  sh.release();
  const gone = Date.now() + 15_000;
  while (readBenchState(root)!.mode !== 'free' && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readBenchState(root)!.mode, 'free');
  } finally {
    for (const k of tickets) k.release();
  }
});
