// w1945 (lothsahn, 2026-10-23: "Can we make the dispatcher smart enough so it queues work properly that requires running
// together across multiple machines and doesn't waste slots?"): w665's worker held m3's only sandbox while the two-machine
// run of its PR #2340 (w1936) sat Queued, and w1940's client leg waited on w1898's host leg placed separately. A pair run is
// now one request whose legs start together, and it is room only where that many computers that fit have room at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairRoom, pairText, repairText, unfitWhy } from '../shared/capacity.ts';
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

test('w1945: pairRoom picks one computer per leg, at most one Mac (the host); fewer than that is short, and says what has room', () => {
  assert.deepEqual(pairRoom(pair, ['beast', 'biscuit', 'lothdesktop'], FIT), { pick: ['beast', 'biscuit'] });
  assert.deepEqual(pairRoom(pair, ['biscuit'], FIT), { short: 'a pair run of 2 legs needs 2 computers with room at once, at most one of them a Mac (the host), and only biscuit has room it fits' });
  assert.match(pairRoom(pair, [], FIT).short ?? '', /and no computer it fits has room$/);
  assert.deepEqual(pairRoom(pair, ['biscuit', 'm3'], FIT).pick, ['m3', 'biscuit'], 'w2282: a Mac hosts a pair that needs no cross-OS pair');
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

test('w1945: unfitWhy lets a Mac take a pair (pairRoom keeps it to the host), and keeps timed legs off the m5', () => {
  assert.equal(unfitWhy(pair, 'm3', FIT), undefined, 'w2282: a Mac may host a pair, its MP- scenario name notwithstanding');
  assert.equal(unfitWhy(pair, 'm5', FIT), undefined, 'the m5 takes a pair that is not timed');
  assert.match(unfitWhy(item('w6', { pair: { legs: 2, timed: true } }), 'm5', FIT) ?? '', /^m5 takes no timed runs/);
  assert.equal(unfitWhy(pair, 'biscuit', FIT), undefined);
  assert.equal(unfitWhy(item('w3', { pair: { legs: 2, crossOs: 'Burst codegen' } }), 'm3', FIT), undefined, 'a cross-OS pair may host on a Mac, its MP- scenario name notwithstanding');
  assert.equal(unfitWhy(item('w4', { pair: { legs: 2, crossOs: 'Burst codegen', timed: true } }), 'm5', FIT), "m5 takes no timed runs (Ben's own Mac (w1861))");
});

test('w1945: roomForWork counts a pair as room only with a computer per leg; roomEnough re-reads it on the room that has stood', () => {
  const r: RoomNow = { game: ['m3', 'm5'], agent: [], held: [], fit: FIT };
  const one = roomForWork(r, pair);
  assert.deepEqual(one.ids, [], 'two Macs are no room for two legs: a Mac is never a client');
  assert.match(one.short ?? '', /at most one of them a Mac \(the host\), and only m3, m5 have room it fits/);
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
  // Since w2282 a Mac with room hosts, so the room that is short is two Macs, which can only be one leg.
  const one = workLive(pair, facts({ room: ['m3', 'm5'], agentRoom: ['m3', 'm5'] }))!;
  assert.equal(one.state, 'queued');
  assert.equal(one.roomOn, undefined);
  assert.match(one.why, /^queued for capacity \(a pair run of 2 legs, on any computers, any OS \(a Mac only as the host, leg 1\)\): a pair run of 2 legs needs 2 computers with room at once, at most one of them a Mac \(the host\), and only m3, m5 have room it fits/);
  const two = workLive(pair, facts({ room: ['biscuit', 'beast'] }))!;
  assert.deepEqual(two.roomOn, ['biscuit', 'beast']);
  assert.match(two.why, /the dispatcher should start its 2 legs together \(start_agent with pair_sandboxes\)$/);
  // Two computers, one of them freed a minute ago: the ping's to bring, not yet WRONG.
  const fresh = workLive(pair, facts({ room: ['biscuit', 'beast'], roomSince: { 'game:biscuit': NOW - 30 * 60_000, 'game:beast': NOW - 60_000 } }))!;
  assert.equal(fresh.roomOn, undefined);
  assert.match(fresh.why, /since 1 min ago: the capacity ping brings it to the dispatcher$/);
});

// w2282 (lothsahn: "Not windows by default, any OS.  Being particular about a machine or OS limits the fleet we can use."):
// pair runs were filed "on computers that are not Macs" for every leg, so five sat Queued for beast, lothdesktop, lothlaptop
// and biscuit while m3 had room. A Mac may host; only a Mac client is refused (w665).
test('w2282: one free Mac and one free Windows computer place a pair, the Mac as host and Windows as client', () => {
  const r: RoomNow = { game: ['lothdesktop', 'm3'], agent: [], held: [], fit: FIT };
  const room = roomForWork(r, pair);
  assert.deepEqual(room.unfit, []);
  assert.equal(room.short, undefined);
  assert.deepEqual(pairRoom(pair, room.ids, FIT).pick, ['m3', 'lothdesktop'], 'leg 1 (the host) on the Mac');
  assert.equal(roomEnough(r, pair, ['lothdesktop', 'm3']), true);
});

test('w2282: two free Macs and no free other computer are no room for a pair (a Mac is never a client)', () => {
  const r: RoomNow = { game: ['m3', 'm5'], agent: [], held: [], fit: FIT };
  const room = roomForWork(r, pair);
  assert.deepEqual(room.ids, []);
  assert.match(room.short ?? '', /at most one of them a Mac \(the host\)/);
  assert.equal(roomEnough(r, pair, ['m3', 'm5']), false);
  assert.match(pairRoom(item('w7', { pair: { legs: 3 } }), ['m3', 'm5', 'beast'], FIT).short ?? '', /needs 3 computers/, 'three legs need two computers that are not Macs');
});

test('w2282: a pair filed before it says the new rule once loaded; a cross-OS one is left alone', () => {
  const old = item('w8', { constraints: 'a pair run of 2 legs, on computers that are not Macs', brief: 'x\n\nFF Factory filed this (w1945, request_pair): a pair run of 2 legs, on computers that are not Macs. Its legs start together.' });
  assert.equal(repairText(old), true);
  assert.equal(old.constraints, pairText(old.pair!));
  assert.match(old.brief, /request_pair\): a pair run of 2 legs, on any computers, any OS \(a Mac only as the host, leg 1\)\. Its legs/);
  assert.equal(repairText(old), false, 'once');
  assert.equal(repairText(item('w9', { pair: { legs: 2, crossOs: 'Burst' }, constraints: 'a pair run of 2 legs, cross-OS (Burst)' })), false);
});

test('w2282: a queued request_pair run loaded from an older ledger says the new rule and is no longer queued only for non-Macs', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Store } = await import('./store.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2282-'));
  const old = 'a pair run of 2 legs, on computers that are not Macs';
  const items = [
    item('w10', { constraints: old, pair: { legs: 2, for: 'w2208' }, queuedFor: { at: '2026-10-26T05:01:00.000Z', needs: ['beast', 'lothdesktop', 'lothlaptop'] } }),
    item('w11', { constraints: old, pair: { legs: 2 }, queuedFor: { at: '2026-10-26T05:01:00.000Z', needs: ['beast'] } }),
  ];
  fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({ seq: 11, items }));
  const store = new Store(dir);
  const w10 = store.work.get('w10')!;
  assert.equal(w10.constraints, pairText(w10.pair!));
  assert.deepEqual(w10.queuedFor, { at: '2026-10-26T05:01:00.000Z' }, 'the dispatcher chose those computers by the old rule');
  assert.match(w10.log.at(-1)!, /a Mac may host \(w2282\); no longer queued only for beast or lothdesktop or lothlaptop$/);
  assert.deepEqual(store.work.get('w11')!.queuedFor?.needs, ['beast'], 'a pair the dispatcher marked by hand keeps the computers it named');
});
