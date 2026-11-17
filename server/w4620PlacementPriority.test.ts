// w4620: placement (the capacity order free room goes in, and released workers' resumes) is strict priority, with release
// above urgent. lothsahn, 2026-11-17: "Why is urgent work in a queue behind non urgent work? ... The factory should be using
// strict priority queues", and "Let's add a new priority called release that's above urgent and not have special handling
// for releases... Let it go through the priority process being built".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityOrder, priorityJumps, priorityThenAge } from './work.ts';
import { WORK_PRIORITIES, atLeast, benchRank, priorityRank, type WorkItem, type WorkPriority } from '../shared/types.ts';
import { minPriorityText } from '../shared/capacity.ts';

const at = (h: number) => `2026-11-17T${String(h).padStart(2, '0')}:00:00.000Z`;
const BEN = { name: 'Ben' };
const w = (id: string, h: number, priority: WorkPriority): WorkItem =>
  ({ id, title: 't', brief: 'b', keys: [], requestedBy: BEN, requesters: [BEN], createdAt: at(h), updatedAt: at(h), overlaps: [], asks: 0, log: [], priority, status: 'queued', sessionIds: [], queuedFor: { at: at(h) } }) as unknown as WorkItem;

test('w4620: an urgent request queued behind 3 normal and low ones takes the next free room; the jump is named', () => {
  const q = [w('w1', 1, 'normal'), w('w2', 2, 'low'), w('w3', 3, 'normal'), w('w4', 4, 'urgent')];
  const sorted = [...q].sort(capacityOrder);
  assert.deepEqual(sorted.map((x) => x.id), ['w4', 'w1', 'w3', 'w2']);
  assert.deepEqual(priorityJumps(sorted), ['w4 (urgent) goes ahead of w1 (normal, queued earlier)', 'w3 (normal) goes ahead of w2 (low, queued earlier)']);
  // the resume order of released workers goes the same way
  assert.deepEqual([...q].sort(priorityThenAge).map((x) => x.id), ['w4', 'w1', 'w3', 'w2']);
});

test('w4620: raising a queued request reorders it at once, and lowering it puts it back', () => {
  const q = [w('w1', 1, 'normal'), w('w2', 2, 'normal'), w('w3', 3, 'normal')];
  assert.deepEqual([...q].sort(capacityOrder).map((x) => x.id), ['w1', 'w2', 'w3'], 'one priority: first come, first served');
  assert.deepEqual(priorityJumps([...q].sort(capacityOrder)), [], 'and nothing jumps');
  q[2].priority = 'high';
  assert.deepEqual([...q].sort(capacityOrder).map((x) => x.id), ['w3', 'w1', 'w2']);
  q[2].priority = 'normal';
  assert.deepEqual([...q].sort(capacityOrder).map((x) => x.id), ['w1', 'w2', 'w3']);
});

test('w4620: release goes ahead of urgent everywhere a priority ranks, with no shortcut of its own', () => {
  assert.deepEqual(WORK_PRIORITIES, ['low', 'normal', 'high', 'urgent', 'release']);
  const q = [w('urgentOld', 1, 'urgent'), w('normal', 2, 'normal'), w('release', 3, 'release')];
  assert.deepEqual([...q].sort(capacityOrder).map((x) => x.id), ['release', 'urgentOld', 'normal']);
  assert.deepEqual([...q].sort(priorityThenAge).map((x) => x.id), ['release', 'urgentOld', 'normal']);
  assert.ok(priorityRank('release') > priorityRank('urgent'));
  assert.equal(priorityRank('nonsense'), 0, 'an unknown priority ranks as low');
  assert.equal(priorityRank(undefined), 0, 'no priority ranks as low');
  assert.ok(atLeast('release', 'urgent') && !atLeast('high', 'urgent'));
  // old bench_queue.py copies know only urgent..low: a release session reads as urgent there, with level release for new ones
  assert.deepEqual(benchRank('release'), { priority: 'urgent', level: 'release' });
  assert.deepEqual(benchRank('urgent'), { priority: 'urgent' });
  assert.match(minPriorityText('urgent'), /release/, 'a computer reserved for urgent work takes release work too');
});
