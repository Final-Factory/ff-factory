import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costMark, costSince, newCost, timedCost } from './placeCost.ts';

test('w6428: a Cost counts outermost calls only, and costSince names what a build added', () => {
  const c = newCost();
  const was = costMark(c);
  assert.equal(costSince('free', c, was), '');
  const v = timedCost(c, () => timedCost(c, () => 7));
  assert.equal(v, 7);
  assert.equal(c.n, 1);
  assert.equal(c.depth, 0);
  assert.throws(() => timedCost(c, () => timedCost(c, () => { throw new Error('x'); })));
  assert.equal(c.n, 2);
  assert.equal(c.depth, 0);
  assert.match(costSince('free', c, was), /^ free \d+ms x2$/);
  assert.equal(costSince('free', c, costMark(c)), '');
});
