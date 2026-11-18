// w4710 (lothsahn, 2026-11-18: "Rename the "release" priority to frantic. Don't change any underlying logic, it should
// still be higher priority than any other task"): w4620's top priority `release` is `frantic` now. It still outranks urgent
// and every other level in every queue, and a `release` passed in or stored before the rename is read as frantic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capacityOrder, priorityThenAge } from './work.ts';
import { Store } from './store.ts';
import { WORK_PRIORITIES, asWorkPriority, atLeast, benchRank, priorityIndex, priorityRank, type WorkItem, type WorkPriority } from '../shared/types.ts';
import { admitsPriority, minPriorityText } from '../shared/capacity.ts';
import { ledgerOrder } from '../shared/workOrder.ts';
import { readSlotPriorities } from '../machine/unitySlots.ts';
import { benchLockDir } from '../machine/benchLock.ts';
import { benchQueueDir } from '../machine/benchQueue.ts';

const at = (h: number) => `2026-11-18T${String(h).padStart(2, '0')}:00:00.000Z`;
const BEN = { name: 'Ben' };
const w = (id: string, h: number, priority: string): WorkItem =>
  ({ id, title: 't', brief: 'b', keys: [], requestedBy: BEN, requesters: [BEN], createdAt: at(h), updatedAt: at(h), overlaps: [], asks: 0, log: [], priority, status: 'queued', sessionIds: [], queuedFor: { at: at(h) } }) as unknown as WorkItem;

test('w4710: frantic is the top priority, above urgent and every other level, with nothing named release left', () => {
  assert.deepEqual(WORK_PRIORITIES, ['low', 'normal', 'high', 'urgent', 'frantic']);
  for (const p of WORK_PRIORITIES.filter((x) => x !== 'frantic')) {
    assert.ok(priorityRank('frantic') > priorityRank(p), `frantic outranks ${p}`);
    assert.ok(atLeast('frantic', p));
    assert.ok(!atLeast(p, 'frantic'), `${p} is not at least frantic`);
  }
  // the newest frantic request goes ahead of older ones at every other level, in the capacity order and the resume order
  const q = [w('urgent', 1, 'urgent'), w('high', 2, 'high'), w('normal', 3, 'normal'), w('low', 4, 'low'), w('frantic', 5, 'frantic')];
  assert.deepEqual([...q].sort(capacityOrder).map((x) => x.id), ['frantic', 'urgent', 'high', 'normal', 'low']);
  assert.deepEqual([...q].sort(priorityThenAge).map((x) => x.id), ['frantic', 'urgent', 'high', 'normal', 'low']);
  // a computer reserved for urgent work (placement.minPriority) takes frantic work, and says so
  assert.ok(admitsPriority('urgent', 'frantic'));
  assert.equal(minPriorityText('urgent'), 'urgent and frantic work only');
  // the bench queue's wire keeps the name the game repo's bench_queue.py knows: urgent with level release
  assert.deepEqual(benchRank('frantic'), { priority: 'urgent', level: 'release' });
});

test('w4710: a passed or stored "release" is frantic: same rank, same place in every queue', () => {
  assert.equal(asWorkPriority('release'), 'frantic');
  assert.equal(asWorkPriority('frantic'), 'frantic');
  assert.equal(asWorkPriority('urgent'), 'urgent');
  assert.equal(asWorkPriority('bogus'), undefined);
  assert.equal(priorityRank('release'), priorityRank('frantic'));
  assert.equal(priorityIndex('release'), priorityIndex('frantic'));
  assert.ok(atLeast('release', 'urgent') && atLeast('release', 'frantic'));
  assert.ok(admitsPriority('urgent', 'release'));
  assert.deepEqual(benchRank('release' as WorkPriority), { priority: 'urgent', level: 'release' });
  const q = [w('urgent', 1, 'urgent'), w('normal', 2, 'normal'), w('old', 3, 'release')];
  assert.deepEqual([...q].sort(capacityOrder).map((x) => x.id), ['old', 'urgent', 'normal']);
  assert.deepEqual([...q].sort(priorityThenAge).map((x) => x.id), ['old', 'urgent', 'normal']);
  assert.deepEqual(ledgerOrder(q, undefined).map((x) => x.id).slice(0, 2), ['old', 'urgent'], 'the Dispatcher page sorts it first too');
});

test('w4710: the daemon reads a bench mark of level release (the wire name) as frantic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w4710-slots-'));
  try {
    const dir = benchQueueDir(benchLockDir(root));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'priorities.json'), JSON.stringify({ sessions: { rel: { priority: 'urgent', level: 'release' }, fr: { priority: 'frantic' }, urg: { priority: 'urgent' } } }));
    const of = readSlotPriorities(root);
    assert.deepEqual(['rel', 'fr', 'urg'].map((s) => of(s)), ['frantic', 'frantic', 'urgent']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('w4710: a request stored at "release" before the rename loads as frantic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4710-store-'));
  try {
    fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({ seq: 3, items: [w('w1', 1, 'release'), w('w2', 2, 'urgent'), w('w3', 3, 'normal')] }));
    const store = new Store(dir);
    assert.equal(store.work.get('w1')!.priority, 'frantic');
    assert.equal(store.work.get('w2')!.priority, 'urgent');
    assert.deepEqual([...store.work.values()].sort(capacityOrder).map((x) => x.id), ['w1', 'w2', 'w3']);
    store.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
