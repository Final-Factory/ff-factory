// w1945 (lothsahn, 2026-10-23: "Can we make the dispatcher smart enough so it queues work properly that requires running
// together across multiple machines and doesn't waste slots?"): w665's worker held m3's only sandbox while the two-machine
// run of its PR #2340 (w1936) sat Queued, and w1940's client leg waited on w1898's host leg placed separately. A pair run is
// now one request whose legs start together, and it is room only where that many computers that fit have room at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairRoom, pairText, unfitWhy } from '../shared/capacity.ts';
import { workLive, type WorkLiveFacts } from '../shared/workState.ts';
import type { Requester, WorkItem } from '../shared/types.ts';
import { roomEnough, roomForWork, type RoomNow } from './placement.ts';

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const NOW = Date.parse('2026-10-23T23:00:00.000Z');

const item = (id: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: 'Pair run for w665: MP-lowore-pin-pair on PR #2340',
  brief: 'Run MP-lowore-pin-pair on branch w665-lowore-pin-no-collider.',
  priority: 'urgent',
  keys: [],
  requestedBy: BEN,
  requesters: [BEN],
  humanAsked: false,
  status: 'queued',
  queuedFor: { at: '2026-10-23T21:51:00.000Z' },
  createdAt: '2026-10-23T21:51:00.000Z',
  updatedAt: '2026-10-23T21:51:00.000Z',
  sessionIds: [],
  overlaps: [],
  asks: 0,
  log: [],
  pair: { legs: 2, for: 'w665' },
  ...extra,
});

const FIT = { beast: { platform: 'win32' }, lothdesktop: { platform: 'win32' }, biscuit: { platform: 'linux' }, m3: { platform: 'darwin' }, m5: { platform: 'darwin', noTimedRuns: "Ben's own Mac (w1861)" } };
const pair = item('w1936');

test('w1945: pairRoom picks one computer per leg, none a Mac; fewer than that is short, and says what has room', () => {
  assert.deepEqual(pairRoom(pair, ['beast', 'biscuit', 'lothdesktop'], FIT), { pick: ['beast', 'biscuit'] });
  assert.deepEqual(pairRoom(pair, ['biscuit'], FIT), { short: 'a pair run of 2 legs needs 2 computers with room at once, and only biscuit has room it fits' });
  assert.match(pairRoom(pair, [], FIT).short ?? '', /and no computer it fits has room$/);
  assert.match(pairRoom(pair, ['m3', 'biscuit'], FIT).short ?? '', /needs 2 computers with room at once/, 'a Mac is no leg of a pair that needs no cross-OS pair');
  assert.deepEqual(pairRoom(item('w1', { pair: { legs: 3 } }), ['beast', 'biscuit', 'lothdesktop'], FIT).pick, ['beast', 'biscuit', 'lothdesktop']);
  // Work that is no pair run fits on any one computer.
  assert.deepEqual(pairRoom(item('w2', { pair: undefined }), ['m3'], FIT), { pick: ['m3'] });
});

test('w1945: a cross-OS pair takes at most one Mac, as the host, and its legs on two operating systems', () => {
  const cross = item('w3', { pair: { legs: 2, crossOs: 'the desync hash differs between arm64 and x86_64' } });
  assert.deepEqual(pairRoom(cross, ['beast', 'm3', 'lothdesktop'], FIT).pick, ['m3', 'beast'], 'the Mac hosts');
  assert.deepEqual(pairRoom(cross, ['beast', 'lothdesktop', 'biscuit'], FIT).pick, ['beast', 'biscuit'], 'without a Mac: Windows and Linux');
  assert.match(pairRoom(cross, ['beast', 'lothdesktop'], FIT).short ?? '', /needs its legs on two operating systems, and the computers with room it fits \(beast, lothdesktop\) are all win32/);
  assert.match(pairRoom(cross, ['m3', 'm5'], FIT).short ?? '', /at most one of them a Mac \(the host\)/);
  assert.equal(pairText(cross.pair!), 'a pair run of 2 legs, cross-OS (the desync hash differs between arm64 and x86_64)');
});

test('w1945: unfitWhy keeps a pair off Macs unless it is cross-OS, and timed legs off the m5', () => {
  assert.match(unfitWhy(pair, 'm3', FIT) ?? '', /^m3 is a Mac: a pair run's legs go on computers that are not Macs/);
  assert.equal(unfitWhy(pair, 'biscuit', FIT), undefined);
  assert.equal(unfitWhy(item('w3', { pair: { legs: 2, crossOs: 'Burst codegen' } }), 'm3', FIT), undefined, 'a cross-OS pair may host on a Mac, its MP- scenario name notwithstanding');
  assert.equal(unfitWhy(item('w4', { pair: { legs: 2, crossOs: 'Burst codegen', timed: true } }), 'm5', FIT), "m5 takes no timed runs (Ben's own Mac (w1861))");
});

test('w1945: roomForWork counts a pair as room only with a computer per leg; roomEnough re-reads it on the room that has stood', () => {
  const r: RoomNow = { game: ['biscuit', 'm3'], agent: [], held: [], fit: FIT };
  const one = roomForWork(r, pair);
  assert.deepEqual(one.ids, [], 'one computer it fits is no room for two legs');
  assert.match(one.short ?? '', /only biscuit has room it fits/);
  assert.deepEqual(one.unfit.map((u) => u.id), ['m3']);
  const two = roomForWork({ ...r, game: ['biscuit', 'beast'] }, pair);
  assert.deepEqual(two, { ids: ['biscuit', 'beast'], unfit: [] });
  assert.equal(roomEnough(r, pair, ['biscuit']), false);
  assert.equal(roomEnough(r, pair, ['biscuit', 'beast']), true);
  assert.equal(roomEnough(r, item('w5', { pair: undefined }), ['biscuit']), true);
});

const facts = (over: Partial<WorkLiveFacts> = {}): WorkLiveFacts => ({
  session: () => undefined,
  items: [pair],
  room: ['biscuit', 'm3'],
  agentRoom: ['biscuit', 'm3'],
  roomFit: FIT,
  roomSince: { 'game:biscuit': NOW - 30 * 60_000, 'game:m3': NOW - 30 * 60_000, 'game:beast': NOW - 30 * 60_000 },
  now: NOW,
  ...over,
});

test('w1945 as it happened: w1936 beside one free Windows or Linux computer is Queued, not WRONG, and says it needs two at once; with two it is WRONG', () => {
  // 22:14 UTC on 2026-10-23 the flag read "queued for capacity while biscuit has room" for the two-machine run: one computer.
  const one = workLive(pair, facts())!;
  assert.equal(one.state, 'queued');
  assert.equal(one.roomOn, undefined);
  assert.match(one.why, /^queued for capacity \(a pair run of 2 legs, on computers that are not Macs\): a pair run of 2 legs needs 2 computers with room at once, and only biscuit has room it fits; m3 has room but cannot take it: m3 is a Mac/);
  const two = workLive(pair, facts({ room: ['biscuit', 'beast'] }))!;
  assert.deepEqual(two.roomOn, ['biscuit', 'beast']);
  assert.match(two.why, /the dispatcher should start its 2 legs together \(start_agent with pair_sandboxes\)$/);
  // Two computers, one of them freed a minute ago: the ping's to bring, not yet WRONG.
  const fresh = workLive(pair, facts({ room: ['biscuit', 'beast'], roomSince: { 'game:biscuit': NOW - 30 * 60_000, 'game:beast': NOW - 60_000 } }))!;
  assert.equal(fresh.roomOn, undefined);
  assert.match(fresh.why, /since 1 min ago: the capacity ping brings it to the dispatcher$/);
});
