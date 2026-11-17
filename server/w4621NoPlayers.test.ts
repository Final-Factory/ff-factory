// w4621: a computer that runs no game players (the m3: Ben's w3740 hold, "m3 crashed again. you really need to stop crashin
// git") never gets a timed leg or a pair-run leg. w4584 (a timed A/B of game PR #3811) was filed for m3, its players were
// built on LothDesktop, and timed_place sent it back to m3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTimedPlace, smallTimedRank, ownLegTargets, TIMED_WAIT_IDLE_MIN } from './timedAsk.ts';
import { timedLegStep } from './timedLegPlace.ts';
import { NO_PLAYERS, noPlayersOf, timedPlacementRefusalOf } from './machines.ts';
import { pairCanFinish, type Computer } from './placement.ts';
import { unfitWhy } from '../shared/capacity.ts';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-11-17T14:00:00Z');
const NO5 = 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"';
const M3 = { noTimedRuns: timedPlacementRefusalOf({ id: 'm3' }), noPlayers: noPlayersOf({ id: 'm3' }) };
const box = (id: string, maxAgents: number, platform: string, o: Partial<Computer> = {}): Computer => ({
  id,
  online: true,
  live: 1,
  midTurn: 0,
  maxAgents,
  sandboxes: 1,
  maxSandboxes: Math.max(1, Math.ceil(maxAgents / 2)),
  freeSandboxes: 1,
  memUsedBytes: 16 * GB,
  memTotalBytes: 64 * GB,
  editors: 0,
  maxEditors: 2,
  platform,
  ...o,
});
const fleet = (o: Record<string, Partial<Computer>> = {}): Computer[] =>
  [
    box('beast', 6, 'win32', { live: 6, midTurn: 5 }),
    box('lothdesktop', 10, 'win32', { live: 4, midTurn: 4 }),
    box('lothlaptop', 1, 'win32', { live: 0 }),
    box('biscuit', 4, 'linux', { live: 3, midTurn: 2 }),
    box('m3', 3, 'darwin', { live: 0, ...M3 }),
    box('m5', 4, 'darwin', { noTimedRuns: NO5 }),
  ].map((c) => ({ ...c, ...o[c.id] }));
const WAIT = TIMED_WAIT_IDLE_MIN * 60_000;
const ask = (here: string, places: Computer[], ownLeg?: { id: string; small: string[] }, platform?: string) =>
  decideTimedPlace({ here: places.find((c) => c.id === here), places, platform, now: NOW, waitMs: WAIT, waitWhy: '5 min', ownLeg });

test('w4621: m3 runs no game players by default, quoting Ben; its record overrides or clears that', () => {
  assert.match(NO_PLAYERS.m3, /m3 crashed again/);
  assert.equal(noPlayersOf({ id: 'm3' }), NO_PLAYERS.m3);
  assert.equal(noPlayersOf({ id: 'm3', noPlayers: '' }), undefined);
  assert.equal(noPlayersOf({ id: 'm3', noPlayers: 'Ben: still no' }), 'Ben: still no');
  assert.equal(noPlayersOf({ id: 'biscuit' }), undefined);
  assert.equal(noPlayersOf({ id: 'biscuit', noPlayers: 'x' }), 'x');
});

test('w4621: timed placement refuses a no-players computer, saying why; a no-timed-runs reason wins', () => {
  assert.match(timedPlacementRefusalOf({ id: 'm3' }) ?? '', /runs no game players, and a timed leg runs them: .*w3740.*w4621/);
  assert.equal(timedPlacementRefusalOf({ id: 'm3', noPlayers: '' }), undefined);
  assert.equal(timedPlacementRefusalOf({ id: 'm5', noTimedRuns: NO5 }), NO5);
  assert.equal(timedPlacementRefusalOf({ id: 'lothdesktop' }), undefined);
});

test('w4621: timed_place never ranks or picks m3, even idle and on its own platform', () => {
  const places = fleet({ lothlaptop: { live: 1, midTurn: 1 } });
  assert.ok(!smallTimedRank(places, {}, undefined, 'lothdesktop', NOW, WAIT).some((c) => c.id === 'm3'));
  const d = ask('lothdesktop', places, undefined, 'darwin');
  assert.ok(!(d.needs ?? []).includes('m3'), JSON.stringify(d));
  assert.notEqual(ask('m3', places).verdict, 'here');
});

test('w4621: w4584, filed for m3 and asked from LothDesktop, moves to the next small computer that takes timed runs, not m3', () => {
  const d = ask('lothdesktop', fleet(), { id: 'w4584', small: ['m3'] });
  assert.equal(d.verdict, 'elsewhere');
  assert.ok(d.needs?.length, JSON.stringify(d));
  assert.ok(!d.needs!.includes('m3') && !d.needs!.includes('m5'), JSON.stringify(d));
  assert.ok(d.needs!.includes('lothlaptop'), JSON.stringify(d));
  assert.match(d.why, /none of them can take it \(m3 takes no timed runs .*w4621\)/);
});

test('w4621: w4584 with no other small computer up times here on the big computer (w2048), never back to m3', () => {
  const off = { online: false, offlineSince: new Date(NOW - 120 * 60_000).toISOString() };
  const d = ask('lothdesktop', fleet({ lothlaptop: off, biscuit: off }), { id: 'w4584', small: ['m3'] });
  assert.equal(d.verdict, 'here', JSON.stringify(d));
  assert.match(d.bigFallback ?? '', /m3 takes no timed runs/);
  assert.ok(!(d.needs ?? []).includes('m3'));
});

test('w4621: a leg filed for m3 and biscuit keeps biscuit only', () => {
  const d = ask('lothdesktop', fleet(), { id: 'w4584', small: ['m3', 'biscuit'] });
  assert.equal(d.verdict, 'elsewhere');
  assert.deepEqual(d.needs, ['biscuit']);
  assert.deepEqual(ownLegTargets(['m3', 'biscuit', 'gone'], fleet()).ok, ['biscuit', 'gone']);
});

test('w4621: m3 asking about its own leg sends it to the next eligible small computer', () => {
  const d = ask('m3', fleet(), { id: 'w4584', small: ['m3'] });
  assert.equal(d.verdict, 'elsewhere');
  assert.ok(d.needs?.length && !d.needs.includes('m3'), JSON.stringify(d));
});

test('w4621: the timing order (w2055) starts no leg on an idle m3', () => {
  const places = fleet({ lothlaptop: { live: 1, midTurn: 1 } });
  const s = timedLegStep({ id: 'w9', priority: 'normal', places, occupants: {}, now: NOW, blipMs: 60_000 });
  assert.ok(!('start' in s && s.start === 'm3'), JSON.stringify(s));
  if ('wait' in s) assert.ok(!s.wait.includes('m3'));
  if ('widen' in s) assert.ok(!s.widen.includes('m3'));
});

test('w4621: pair and capacity placement give no pair leg to a no-players computer, and still fit its other work there', () => {
  const fit = { m3: { platform: 'darwin', noPlayers: NO_PLAYERS.m3 }, biscuit: { platform: 'linux' } };
  const pair = { title: 'pair check', brief: '', pair: { legs: 2, for: 'w1' } };
  assert.match(unfitWhy(pair, 'm3', fit) ?? '', /m3 runs no game players .*every leg of a pair run runs one/);
  assert.equal(unfitWhy(pair, 'biscuit', fit), undefined);
  assert.equal(unfitWhy({ title: 'editor work', brief: '' }, 'm3', fit), undefined);
  // Only m3 and one other computer up: a two-leg pair can never finish.
  const places = [box('m3', 3, 'darwin', M3), box('biscuit', 4, 'linux')];
  assert.equal(pairCanFinish(places, {}, pair), false);
  assert.equal(pairCanFinish([...places, box('lothlaptop', 1, 'win32')], {}, pair), true);
});
