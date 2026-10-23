// w1944 (lothsahn, 2026-10-23: "Dispatcher leaves 21 requests queued while biscuit and m5 have room"): list_work flagged
// w1941 and w1942, two urgent MP scenario fixes, "Queued [WRONG: biscuit, m5 have room]" while the m5, a Mac that takes no
// timed runs, could never run them (a Mac refuses a multiplayer client, w665), and flagged every queued request WRONG within
// seconds of three sandboxes freeing at 22:13:31 UTC, before the capacity ping had reached the dispatcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsMpPeers, unfitWhy, ROOM_STAND_MS } from '../shared/capacity.ts';
import { workLive, type WorkLiveFacts } from '../shared/workState.ts';
import type { Requester, WorkItem } from '../shared/types.ts';
import { roomForWork, roomNow, roomStood, type Computer, type RoomNow } from './placement.ts';

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const T0 = '2026-10-23T22:13:31.000Z';
const NOW = Date.parse(T0);

const item = (id: string, title: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title,
  brief: 'Do it.',
  priority: 'urgent',
  keys: [],
  requestedBy: LOTH,
  requesters: [LOTH],
  humanAsked: true,
  status: 'queued',
  queuedFor: { at: '2026-10-23T22:11:00.000Z' },
  createdAt: '2026-10-23T22:11:00.000Z',
  updatedAt: '2026-10-23T22:11:00.000Z',
  sessionIds: [],
  overlaps: [],
  asks: 0,
  log: [],
  ...extra,
});

const w1941 = item('w1941', 'Nightly 2026-10-23: fix the MP-W1020-camps-settle-join desync (belt items + census)');
const w1942 = item('w1942', 'Nightly 2026-10-23: fix MP-tutorial-e2e-loth (tutorial step 8 completes 0.76 s after its card)');
const plain = item('w1939', 'Blueprint paste keeps the filter', { priority: 'normal' });
const timed = item('w1891', 'Just Play perf: RoundRobin belt output', { brief: 'Measure it with a benchmark before and after.' });

const M5 = { platform: 'darwin', noTimedRuns: "Ben's own Mac (w1861)" };
const BISCUIT = { platform: 'win32' };

test('w1944: an MP scenario needs a computer that is not a Mac; agent-only work that names one does not', () => {
  assert.equal(needsMpPeers(w1941), true);
  assert.equal(needsMpPeers(w1942), true);
  assert.equal(needsMpPeers(plain), false);
  assert.equal(needsMpPeers({ ...w1941, needs: 'agent' }), false, 'a portal request (w1944 itself) names the scenarios as examples');
  assert.equal(needsMpPeers(item('w1', 'Fix the MP- prefix parser')), false, 'a bare "MP-" is no scenario name');
});

test('w1944: unfitWhy names the computer a request cannot run on, and why; unknown facts fit', () => {
  const fit = { m5: M5, biscuit: BISCUIT, m3: { platform: 'darwin' } };
  assert.match(unfitWhy(w1941, 'm5', fit) ?? '', /^m5 takes no timed runs|^m5 is a Mac, which refuses the multiplayer client its MP scenario starts \(w665\)$/);
  assert.equal(unfitWhy(w1941, 'm3', fit), 'm3 is a Mac, which refuses the multiplayer client its MP scenario starts (w665)');
  assert.equal(unfitWhy(w1941, 'biscuit', fit), undefined);
  assert.equal(unfitWhy(w1941, 'lothlaptop', fit), undefined, 'a computer nobody described is not ruled out');
  assert.equal(unfitWhy(plain, 'm5', fit), undefined, 'ordinary game work runs on a Mac');
  assert.equal(unfitWhy(timed, 'm5', fit), "m5 takes no timed runs (Ben's own Mac (w1861))");
  assert.equal(unfitWhy(timed, 'm3', fit), undefined, 'm3 is the Mac that takes timed runs');
  const winTimed = item('w2', 'Windows player benchmark');
  assert.equal(unfitWhy(winTimed, 'm3', fit), 'm3 is not on Windows, which its timed work names');
});

test('w1944: roomNow carries each computer’s fit, and roomForWork keeps only the computers a request can run on', () => {
  const pc = (id: string, platform: string, extra: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 4, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 1, platform, ...extra });
  const r = roomNow([pc('biscuit', 'win32'), pc('m5', 'darwin', { noTimedRuns: M5.noTimedRuns })]);
  assert.deepEqual(r.game, ['biscuit', 'm5']);
  assert.deepEqual(r.fit, { biscuit: { platform: 'win32' }, m5: M5 });
  assert.deepEqual(roomForWork(r, w1941), { ids: ['biscuit'], unfit: [{ id: 'm5', why: unfitWhy(w1941, 'm5', r.fit)! }] });
  assert.deepEqual(roomForWork(r, plain).ids, ['biscuit', 'm5']);
  assert.deepEqual(roomForWork(r, plain, ['M5']).ids, ['m5'], 'needs, any case');
  assert.deepEqual(roomForWork(r, w1941, ['m5']).ids, [], 'a Mac named in its needs is still no room for an MP scenario');
});

test('w1944: room counts toward WRONG only once it has stood ROOM_STAND_MS; untracked room counts at once', () => {
  const r: Pick<RoomNow, 'since'> = { since: { 'game:biscuit': NOW - ROOM_STAND_MS, 'game:m5': NOW - 60_000 } };
  assert.deepEqual(roomStood(r, 'game', ['biscuit', 'm5', 'beast'], NOW), ['biscuit']);
  assert.deepEqual(roomStood({}, 'game', ['biscuit', 'm5'], NOW), ['biscuit', 'm5']);
});

const facts = (over: Partial<WorkLiveFacts> = {}): WorkLiveFacts => ({
  session: () => undefined,
  items: [w1941, w1942, plain],
  room: ['biscuit', 'm5'],
  agentRoom: ['biscuit', 'm5'],
  roomFit: { m5: M5, biscuit: BISCUIT },
  roomSince: { 'game:biscuit': NOW - 10 * 60_000, 'game:m5': NOW - 10 * 60_000 },
  now: NOW,
  ...over,
});

test('w1944 as it happened: w1941 beside a free m5 and a free biscuit is WRONG on biscuit only; with only the m5 free it says why it waits', () => {
  const both = workLive(w1941, facts())!;
  assert.deepEqual(both.roomOn, ['biscuit']);
  assert.match(both.why, /^queued for capacity, but biscuit has room: the dispatcher should start it/);
  const onlyM5 = workLive(w1941, facts({ room: ['m5'], agentRoom: ['m5'] }))!;
  assert.equal(onlyM5.state, 'queued');
  assert.equal(onlyM5.roomOn, undefined);
  assert.match(onlyM5.why, /^queued for capacity: no computer that could take it has room; m5 has room but cannot take it: m5 (takes no timed runs|is a Mac, which refuses the multiplayer client its MP scenario starts)/);
  // Ordinary game work on the same free m5 is WRONG: the Mac can take it.
  assert.deepEqual(workLive(plain, facts({ room: ['m5'], agentRoom: ['m5'] }))!.roomOn, ['m5']);
});

test('w1944 as it happened: room that freed seconds ago is the capacity ping’s, not yet WRONG', () => {
  const fresh = facts({ roomSince: { 'game:biscuit': NOW - 20_000, 'game:m5': NOW - 20_000 } });
  const l = workLive(plain, fresh)!;
  assert.equal(l.roomOn, undefined);
  assert.equal(l.why, 'queued for capacity; biscuit, m5 have room since 0 min ago: the capacity ping brings it to the dispatcher');
  // Five minutes on, nobody has started it: WRONG.
  assert.deepEqual(workLive(plain, { ...fresh, now: NOW - 20_000 + ROOM_STAND_MS })!.roomOn, ['biscuit', 'm5']);
  // A page from a server without the field: as before, WRONG at once.
  assert.deepEqual(workLive(plain, facts({ roomSince: undefined }))!.roomOn, ['biscuit', 'm5']);
});
