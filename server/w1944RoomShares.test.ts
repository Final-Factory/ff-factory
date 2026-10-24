// w1944 (lothsahn, 2026-10-24 01:22Z: "Why does the dispatcher say biscuit has room when it's full?"): at 01:15:09Z
// biscuit/slot3 freed, its one free sandbox, while 19 queued requests could use it. Every one read "Queued [WRONG: biscuit
// has room]", and decide_work queue refused w1961 ("biscuit has room for w1961 now") though the sandbox went to w1917, older
// in the queue, at 01:16Z. One free sandbox is room for the first request in the queue that fits it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_STAND_MS } from '../shared/capacity.ts';
import { roomShares, workLiveAll, type WorkLiveFacts } from '../shared/workState.ts';
import type { Requester, WorkItem } from '../shared/types.ts';
import { roomNow, slotsOf, type Computer } from './placement.ts';

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const NOW = Date.parse('2026-10-24T01:16:00.000Z');

const item = (id: string, createdAt: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `${id}: a UI fix`,
  brief: 'Do it.',
  priority: 'normal',
  keys: [],
  requestedBy: BEN,
  requesters: [BEN],
  humanAsked: true,
  status: 'queued',
  queuedFor: { at: createdAt },
  createdAt,
  updatedAt: createdAt,
  sessionIds: [],
  overlaps: [],
  asks: 0,
  log: [],
  ...extra,
});

const pc = (id: string, extra: Partial<Computer> = {}): Computer => ({ id, online: true, live: 2, midTurn: 2, maxAgents: 4, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 1, agentSeats: 4, platform: 'win32', ...extra });

test('w1944: roomNow counts how many more workers each computer with room takes, by kind', () => {
  assert.equal(slotsOf(pc('biscuit'), 'game'), 1, 'one free sandbox');
  assert.equal(slotsOf(pc('biscuit', { freeSandboxes: 2, sandboxes: 2 }), 'game'), 2, 'its last free sandbox and one to make, up to 2 agents more');
  assert.equal(slotsOf(pc('biscuit', { freeSandboxes: 3, live: 2 }), 'game'), 2, 'its agent limit');
  assert.equal(slotsOf(pc('biscuit'), 'agent'), 2, 'agent seats up to the agent cap');
  const r = roomNow([pc('biscuit'), pc('beast', { freeSandboxes: 0, live: 0, midTurn: 0 })]);
  assert.deepEqual(r.slots, { 'game:biscuit': 1, 'agent:biscuit': 2, 'agent:beast': 4 });
});

test('w1944: one free sandbox goes to the first queued request that fits it (urgent first, then the oldest); the rest wait rightly, and say for whom', () => {
  const w1911 = item('w1911', '2026-10-23T20:11:00.000Z');
  const w1917 = item('w1917', '2026-10-23T20:21:00.000Z');
  const w1961 = item('w1961', '2026-10-24T01:15:00.000Z');
  const w1942 = item('w1942', '2026-10-23T22:00:00.000Z', { priority: 'urgent', queuedFor: { at: '2026-10-23T22:00:00.000Z', needs: ['lothdesktop'] } });
  const items = [w1961, w1917, w1911, w1942];
  const f = { room: ['biscuit'], agentRoom: ['biscuit'], roomSlots: { 'game:biscuit': 1, 'agent:biscuit': 2 }, roomSince: { 'game:biscuit': NOW - ROOM_STAND_MS }, now: NOW };
  const shares = roomShares(items, f)!;
  assert.deepEqual(shares.get('w1911'), { gets: 'biscuit', ahead: [] });
  assert.deepEqual(shares.get('w1917'), { ahead: ['w1911'] });
  assert.deepEqual(shares.get('w1961'), { ahead: ['w1911'] });
  assert.deepEqual(shares.get('w1942'), { ahead: [] }, 'urgent, but it needs lothdesktop: it takes nothing on biscuit');
  // A request about to be queued, in its place in the queue.
  assert.deepEqual(roomShares([w1917], f, { w: w1961 })!.get('w1961'), { ahead: ['w1917'] });
  assert.deepEqual(roomShares([w1917], { ...f, roomSlots: { 'game:biscuit': 2 } }, { w: w1961 })!.get('w1961'), { gets: 'biscuit', ahead: [] });
  // An urgent request takes it ahead of older normal work.
  const urgent = item('w1970', '2026-10-24T01:15:30.000Z', { priority: 'urgent' });
  assert.deepEqual(roomShares([...items, urgent], f)!.get('w1970'), { gets: 'biscuit', ahead: [] });
  assert.deepEqual(roomShares([...items, urgent], f)!.get('w1911'), { ahead: ['w1970'] });
  // A leg of an active request held for biscuit (w1863) is in the queue too.
  const leg = item('w1782', '2026-10-23T19:00:00.000Z', { status: 'active', queuedFor: undefined, legs: [{ at: '2026-10-23T23:00:00.000Z', needs: ['biscuit'], what: 'the pair leg' }] });
  assert.deepEqual(roomShares([...items, leg], f)!.get('w1782:leg'), { gets: 'biscuit', ahead: [] });
  assert.deepEqual(roomShares([...items, leg], f)!.get('w1911'), { ahead: ['w1782'] });
  // Without counts (an older server, or a test's room list) every request has the room, as before.
  assert.equal(roomShares(items, { room: ['biscuit'] }), undefined);

  const live = workLiveAll(items, { session: () => undefined, ...f } as Omit<WorkLiveFacts, 'items'>);
  assert.deepEqual(live.get('w1911')!.roomOn, ['biscuit'], 'the first in line is WRONG to wait');
  assert.equal(live.get('w1917')!.roomOn, undefined);
  assert.equal(live.get('w1917')!.why, 'queued for capacity; biscuit has room, but it goes first to w1911, ahead in the queue (urgent first, then the oldest): it starts when more frees');
  assert.equal(live.get('w1961')!.roomOn, undefined);
  const old = workLiveAll(items, { session: () => undefined, room: ['biscuit'], roomSince: f.roomSince, now: NOW });
  assert.deepEqual([...old.values()].filter((l) => l.roomOn).length, 3, 'without counts: all three that fit biscuit read WRONG');
});
