import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartStreak } from './startStreak.ts';

test('w6784: three failed child starts in a row log one early warning; a start clears it', () => {
  let t = 0;
  const s = new StartStreak(3, () => t);
  assert.equal(s.failed('agent host a', 'spawn timed out'), undefined);
  t = 155_000;
  assert.equal(s.failed('agent host b', 'spawn timed out'), undefined);
  t = 317_000;
  const w = s.failed('agent host a', 'its agent host wrote no heartbeat in 60 s');
  assert.match(w!, /early warning \(w6784, warn-only\): 3 child starts failed in a row over 317 s \(agent host a, agent host b\)/);
  assert.match(w!, /nothing was restarted/);
  // Not every further failure: the next line comes at the next multiple.
  assert.equal(s.failed('agent host c', 'x'), undefined);
  assert.equal(s.failed('agent host c', 'x'), undefined);
  assert.match(s.failed('agent host c', 'x')!, /6 child starts failed in a row/);
  assert.match(s.started('agent host d')!, /early warning cleared \(w6784\): agent host d started after 6 failed starts/);
});

test('w6784: a success between failures resets the count, and says nothing when it had not warned', () => {
  const s = new StartStreak(3);
  s.failed('a', 'x');
  s.failed('a', 'x');
  assert.equal(s.started('a'), undefined);
  assert.equal(s.failed('a', 'x'), undefined);
  assert.equal(s.failed('a', 'x'), undefined);
  assert.ok(s.failed('a', 'x'));
});
