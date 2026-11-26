import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOP_BEAT_MS, LOOP_SUMMARY_MS, LoopWatch, beatWasLate, linkBeat, loopLabel, loopRun } from './loopWatch.ts';

test('w1377: beatWasLate tells a timer the event loop held up from one on time', () => {
  assert.equal(beatWasLate(20_000, 0, 20_000), false, 'on time');
  assert.equal(beatWasLate(29_000, 0, 20_000), false, 'within the slack');
  assert.equal(beatWasLate(70_000, 0, 20_000), true, 'the 2026-10-15 case: a 50 s block');
});

test('w1377: the loop watch logs a stall once, with its length, and /api/health reads the last minute\'s worst lag', () => {
  let t = 0;
  const lines: string[] = [];
  const w = new LoopWatch({ now: () => t, log: (l) => lines.push(l) });
  const beat = (ms: number) => {
    t += ms;
    w.beat();
  };
  for (let i = 0; i < 5; i++) beat(LOOP_BEAT_MS);
  assert.equal(w.lagMs(), 0);
  assert.deepEqual(lines, []);
  beat(LOOP_BEAT_MS + 48_000);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^event loop: blocked for 48\.0 s/);
  assert.equal(w.lagMs(), 48_000);
  // Another stall within 10 s of the line waits for the next line, which carries the longest one.
  beat(LOOP_BEAT_MS + 3000);
  assert.equal(lines.length, 1);
  for (let i = 0; i < 10; i++) beat(LOOP_BEAT_MS);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^event loop: blocked for 3\.0 s/);
  // A minute later the lag is gone from the health answer.
  for (let i = 0; i < 61; i++) beat(LOOP_BEAT_MS);
  assert.equal(w.lagMs(), 0);
  assert.equal(lines.length, 2, 'nothing more to say');
});

test('w2044: a block of 1 s is logged, and every 10 minutes a line says the worst block, stall or not', () => {
  let t = 0;
  const lines: string[] = [];
  const w = new LoopWatch({ now: () => t, log: (l) => lines.push(l) });
  const beat = (ms: number) => {
    t += ms;
    w.beat();
  };
  beat(LOOP_BEAT_MS + 400);
  for (let i = 0; i < 20; i++) beat(LOOP_BEAT_MS);
  assert.deepEqual(lines, [], 'a 0.4 s block is under the target');
  beat(LOOP_BEAT_MS + 1200);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^event loop: blocked for 1\.2 s/);
  while (t < LOOP_SUMMARY_MS) beat(LOOP_BEAT_MS);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^event loop: worst block 1\.2 s in the last 10 min; 1 of 1 s or more$/);
  // The next ten minutes start over: a quiet stretch says so.
  const next = t + LOOP_SUMMARY_MS;
  while (t < next) beat(LOOP_BEAT_MS);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^event loop: worst block 0\.0 s in the last 10 min; 0 of 1 s or more$/);
});

test('w3855: the start before the portal listens gets its own line, not "blocked"; a block after it still does', () => {
  let t = 100_000;
  const lines: string[] = [];
  const w = new LoopWatch({ now: () => t, log: (l) => lines.push(l) });
  // the module's one synchronous run: 1.6 s from the watch to listening (37afae31's start, 2026-11-09 15:10:59)
  t += 1600;
  w.started();
  assert.deepEqual(lines, ['startup: 1.6 s from the loop watch to listening (w3855)']);
  t += LOOP_BEAT_MS;
  w.beat();
  assert.equal(w.lagMs(), 0, 'the start is not a lag of the running portal');
  t += LOOP_BEAT_MS + 1200;
  w.beat();
  assert.match(lines[1], /^event loop: blocked for 1\.2 s/);
});

test('w4926: the daemon judges the portal only on a beat that came on time, so its own stall is not the portal\'s silence', () => {
  // BEAST 2026-11-20 05:25Z: a daemon blocked 50 s runs its 20 s beat late, before the pong it holds unread.
  assert.equal(linkBeat(70_000, 20_000, 15_000, 20_000, 45_000), 'late', 'a 50 s gap since the last beat: no drop');
  assert.equal(linkBeat(90_000, 70_000, 89_000, 20_000, 45_000), 'ping', 'the pong read after the block keeps the link');
  assert.equal(linkBeat(90_000, 70_000, 40_000, 20_000, 45_000), 'dead', 'an on-time beat with 50 s of silence drops it');
  assert.equal(linkBeat(90_000, 0, 40_000, 20_000, 45_000), 'dead', 'the first beat has no last beat to be late after');
  assert.equal(linkBeat(40_000, 20_000, 39_000, 20_000, 45_000), 'ping');
});

test('w4926: the daemon\'s loop watch names the daemon and logs only blocks of its own threshold', () => {
  let t = 0;
  const lines: string[] = [];
  const w = new LoopWatch({ now: () => t, log: (l) => lines.push(l), who: 'the daemon', stallLogMs: 5000 });
  t += LOOP_BEAT_MS + 3000;
  w.beat();
  assert.deepEqual(lines, [], 'a 3 s block is under the 5 s line');
  t += LOOP_BEAT_MS + 50_000;
  w.beat();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^event loop: blocked for 50\.0 s .*: the daemon answered nothing meanwhile$/);
});

test('w5973: the stall line names the labelled run that held the loop longest, else the last one that ran', () => {
  let t = 0;
  let clock = 0;
  const lines: string[] = [];
  const w = new LoopWatch({ now: () => t, log: (l) => lines.push(l), who: 'the daemon', stallLogMs: 5000 });
  // A quick timer, then the 30 s gh fetch, then another quick one: the line names the long one, with its own time.
  loopRun('timer pool.tick', () => (clock += 20), () => clock);
  loopRun('link bench_ticket', () => (clock += 30_000), () => clock);
  loopRun('timer slotTick', () => (clock += 5), () => clock);
  t += LOOP_BEAT_MS + 30_100;
  w.beat();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^event loop: blocked for 30\.1 s .*: the daemon answered nothing meanwhile; longest labelled run: link bench_ticket 30\.0 s$/);
  // A block no labelled run accounts for (time after an await): the line names what ran last.
  loopLabel('timer reaper.tick', () => undefined)();
  for (let i = 0; i < 11; i++) {
    t += LOOP_BEAT_MS;
    w.beat();
  }
  t += LOOP_BEAT_MS + 8000;
  w.beat();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^event loop: blocked for 8\.0 s .*; last ran: timer reaper\.tick$/);
  // The record is per beat: a long run before an on-time beat is not blamed for a later block.
  loopRun('timer long', () => (clock += 9000), () => clock);
  t += LOOP_BEAT_MS;
  w.beat();
  for (let i = 0; i < 11; i++) {
    t += LOOP_BEAT_MS;
    w.beat();
  }
  t += LOOP_BEAT_MS + 6000;
  w.beat();
  assert.match(lines[2], /; last ran: timer long$/);
});
