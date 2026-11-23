import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnitySlots, assess, readSlotPriorities, reqFile, grantFile, type SlotRequest } from '../machine/unitySlots.ts';
import { benchLockDir } from '../machine/benchLock.ts';
import { benchQueueDir } from '../machine/benchQueue.ts';
import type { WorkPriority } from '../shared/types.ts';

/*
 * w4620 (lothsahn, 2026-11-17: "Why is urgent work in a queue behind non urgent work? ... The factory should be using
 * strict priority queues"): the Unity slot queue serves release > urgent > high > normal > low, first come first served
 * within one priority, a priority read live from the session's mark; holders keep their place first.
 */

const T0 = Date.parse('2026-11-17T12:00:00Z');
let nextPid = 7000;
/** A waiting request whose session is "s-<id>"; `at` seconds after T0 is when it was queued. */
const waiter = (id: string, at: number, over: Partial<SlotRequest> = {}): SlotRequest => ({ id, holder: `pid:${id}`, count: 1, pid: nextPid++, label: id, session: `s-${id}`, createdAt: T0 + at * 1000, ...over });
/** A request already granted: it holds one slot until it is left out of the next look. */
const holder = (id: string): SlotRequest => waiter(id, -60, { grantedAt: T0 - 59_000 });

/** Priorities by request id (sessions are "s-<id>"); a session not listed counts as low. */
const marks = (m: Record<string, WorkPriority>) => (session?: string) => m[session?.replace(/^s-/, '') ?? ''] ?? 'low';
const look = (requests: SlotRequest[], priorityOf?: (s?: string) => WorkPriority, limit = 1) => assess({ platform: 'win32', procs: [], requests, places: [], limit, now: T0 + 3600_000, ...(priorityOf ? { priorityOf } : {}) });

test('w4620: an urgent request queued behind three normal and low ones is granted next when a slot frees', () => {
  const queued = [waiter('n1', 1), waiter('l2', 2), waiter('n3', 3), waiter('u4', 4)];
  const priorityOf = marks({ n1: 'normal', l2: 'low', n3: 'normal', u4: 'urgent' });
  const full = look([holder('h'), ...queued], priorityOf);
  assert.deepEqual(full.grant, []);
  assert.deepEqual(full.waiting.map((w) => w.id), ['u4', 'n1', 'n3', 'l2'], 'urgent first, then normal first come first served, then low');
  assert.deepEqual(full.waiting.map((w) => full.priorities.get(w.id)), ['urgent', 'normal', 'normal', 'low']);
  const freed = look(queued, priorityOf);
  assert.deepEqual(freed.grant, ['u4']);
  assert.deepEqual(freed.waiting.map((w) => w.id), ['n1', 'n3', 'l2']);
  assert.deepEqual(freed.jumps.map((j) => [j.id, j.priority, j.over, j.overPriority]), [['u4', 'urgent', 'n1', 'normal']], 'it went ahead of the oldest waiter it passed');
});

test('w4620: raising a waiting request reorders it ahead at the next look (priority is read live)', () => {
  const queued = [waiter('a', 1), waiter('b', 2), waiter('c', 3)];
  const m: Record<string, WorkPriority> = { a: 'normal', b: 'normal', c: 'normal' };
  assert.deepEqual(look([holder('h'), ...queued], marks(m)).waiting.map((w) => w.id), ['a', 'b', 'c']);
  m.c = 'high';
  assert.deepEqual(look([holder('h'), ...queued], marks(m)).waiting.map((w) => w.id), ['c', 'a', 'b']);
  assert.deepEqual(look(queued, marks(m)).grant, ['c']);
  m.c = 'normal';
  assert.deepEqual(look(queued, marks(m)).grant, ['a'], 'lowered again: first come first served');
});

test('w4620: release goes ahead of urgent', () => {
  const queued = [waiter('u1', 1), waiter('u2', 2), waiter('r3', 3), waiter('h4', 4)];
  const priorityOf = marks({ u1: 'urgent', u2: 'urgent', r3: 'frantic', h4: 'high' });
  assert.deepEqual(look([holder('h'), ...queued], priorityOf).waiting.map((w) => w.id), ['r3', 'u1', 'u2', 'h4']);
  assert.deepEqual(look(queued, priorityOf).grant, ['r3']);
});

test('w4620: within one priority the queue stays first come first served, and the id breaks a tie', () => {
  const queued = [waiter('b', 5), waiter('c', 3), waiter('a', 5), waiter('d', 1)];
  const priorityOf = marks({ a: 'high', b: 'high', c: 'high', d: 'high' });
  assert.deepEqual(look([holder('h'), ...queued], priorityOf).waiting.map((w) => w.id), ['d', 'c', 'a', 'b']);
  assert.deepEqual(look(queued, priorityOf).jumps, [], 'no jump without a priority difference');
});

test('w4620: with no priorities every request counts as low and the order is first come first served', () => {
  const queued = [waiter('x', 2), waiter('y', 1), waiter('z', 3, { session: undefined })];
  const none = look([holder('h'), ...queued]);
  assert.deepEqual(none.waiting.map((w) => w.id), ['y', 'x', 'z']);
  assert.deepEqual(none.waiting.map((w) => none.priorities.get(w.id)), ['low', 'low', 'low']);
  // The default reader with no priorities.json (and with no root at all) fails open the same way.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4620-'));
  try {
    assert.equal(readSlotPriorities(root)('s-x'), 'low');
    assert.equal(readSlotPriorities(undefined)('s-x'), 'low');
    fs.mkdirSync(benchQueueDir(benchLockDir(root)), { recursive: true });
    fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), 'priorities.json'), '{ not json');
    assert.equal(readSlotPriorities(root)('s-x'), 'low', 'an unreadable file too');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('w4620: the priorities.json reader takes level (release) over priority, and an unmarked session is low', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4620-'));
  try {
    const dir = benchQueueDir(benchLockDir(root));
    fs.mkdirSync(dir, { recursive: true });
    const sessions = { rel: { priority: 'urgent', level: 'release', requests: [] }, urg: { priority: 'urgent', requests: [] }, nrm: { priority: 'normal', requests: [] }, odd: { priority: 'bogus', requests: [] } };
    fs.writeFileSync(path.join(dir, 'priorities.json'), JSON.stringify({ sessions }));
    const of = readSlotPriorities(root);
    assert.deepEqual(['rel', 'urg', 'nrm', 'odd', 'none', undefined].map((s) => of(s)), ['frantic', 'urgent', 'normal', 'low', 'low', 'low']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('w4620: priority goes ahead of a holder whose editor runs (w5324), and the head blocks lower waiters it cannot fit behind', () => {
  // w5324 reversed w4620's holders first: a low sandbox whose editor runs no longer goes ahead of an urgent newcomer
  // (w5291, frantic, waited about 2 h on LothDesktop behind lower holders). Within one priority holders still go first.
  const places = [{ holder: 'sandbox:a', path: 'D:\\work\\ffsb\\a', editorUp: true }];
  const queued = [waiter('own', 9, { holder: 'sandbox:a' }), waiter('u', 1)];
  const a = assess({ platform: 'win32', procs: [], requests: [holder('h'), holder('h2'), ...queued], places, limit: 3, now: T0 + 60_000, priorityOf: marks({ own: 'low', u: 'urgent' }) });
  assert.deepEqual(a.waiting.map((w) => w.id), ['u', 'own'], 'priority first, then the sandbox with an editor');
  // A big urgent request that does not fit holds the line: the smaller low one behind it does not slip past.
  const big = [waiter('big', 5, { count: 2 }), waiter('small', 1)];
  const blocked = look([holder('h'), ...big], marks({ big: 'urgent' }), 2);
  assert.deepEqual(blocked.grant, []);
  assert.deepEqual(blocked.waiting.map((w) => w.id), ['big', 'small']);
});

// ---------------------------------------------------------------- the arbiter: priorities.json and the jump log

function mailbox(t: { after: (fn: () => void) => void }, over: { priorityOf?: (s?: string) => WorkPriority; root?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4620-slots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const log: string[] = [];
  const slots = new UnitySlots({ dir, platform: 'win32', procs: async () => [], alive: () => true, now: () => Date.now(), limit: () => 1, places: () => [], ramPct: () => undefined, log: (l) => log.push(l), ...over });
  const file = (id: string, at: number, session: string, granted = false) => {
    fs.writeFileSync(reqFile(dir, id), JSON.stringify({ v: 1, id, pid: nextPid++, holder: `pid:${id}`, count: 1, label: `build ${id}`, session, createdAt: new Date(Date.now() - 10_000 + at * 1000).toISOString() }));
    if (granted) fs.writeFileSync(grantFile(dir, id), JSON.stringify({ id, grantedAt: new Date(Date.now() - 20_000).toISOString() }));
  };
  const drop = (id: string) => {
    fs.rmSync(reqFile(dir, id), { force: true });
    fs.rmSync(grantFile(dir, id), { force: true });
  };
  return { dir, slots, log, file, drop };
}

test('w4620: the arbiter grants the urgent session first, logs the jump once, and reports the priority', async (t) => {
  const m = mailbox(t, { priorityOf: (s) => ({ 's-olda1234': 'normal', 's-oldb': 'low', 's-fast12345': 'urgent' })[s ?? ''] as WorkPriority ?? 'low' });
  m.file('held', -5, 's-held', true);
  m.file('olda', 1, 's-olda1234');
  m.file('oldb', 2, 's-oldb');
  m.file('fast', 3, 's-fast12345');
  await m.slots.tick();
  const waiting = m.slots.report()!.waiting;
  assert.deepEqual(waiting.map((w) => w.label), ['build fast', 'build olda', 'build oldb']);
  assert.deepEqual(waiting.map((w) => w.position), [1, 2, 3]);
  assert.match(waiting[0].why, /; priority urgent$/);
  assert.match(waiting[2].why, /^behind 2 earlier requests; priority low$/);
  m.drop('held');
  await m.slots.tick();
  assert.deepEqual(m.slots.report()!.granted.map((g) => g.label), ['build fast']);
  await m.slots.tick();
  await m.slots.tick();
  const jumps = m.log.filter((l) => l.startsWith('unity slot: '));
  assert.equal(jumps.length, 1, `one line for the pair, not one per look: ${jumps.join(' | ')}`);
  assert.match(jumps[0], /^unity slot: build fast \(s-fast12, urgent\) goes ahead of build olda \(s-olda12, normal\), queued since \d{4}-\d\d-\d\dT[\d:.]+Z: strict priority \(w4620\)$/);
});

test('w4620: the arbiter reads priorities.json at each look, so raising a waiting request reorders it at once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4620-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const m = mailbox(t, { root });
  const write = (sessions: object) => {
    const dir = benchQueueDir(benchLockDir(root));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'priorities.json'), JSON.stringify({ sessions }));
  };
  m.file('held', -5, 's-held', true);
  m.file('first', 1, 's-first');
  m.file('second', 2, 's-second');
  await m.slots.tick();
  assert.deepEqual(m.slots.report()!.waiting.map((w) => w.label), ['build first', 'build second'], 'no priorities.json: first come first served');
  write({ 's-second': { priority: 'urgent', level: 'release', requests: [] } });
  await m.slots.tick();
  assert.deepEqual(m.slots.report()!.waiting.map((w) => w.label), ['build second', 'build first']);
  assert.match(m.slots.report()!.waiting[0].why, /priority frantic$/);
});
