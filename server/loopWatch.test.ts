import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOP_BEAT_MS, LoopWatch, beatWasLate } from './loopWatch.ts';

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
