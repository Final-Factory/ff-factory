import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityLines, forPriority, holdReason, lowestPriority, pickComputer, placementHint, preferLine, reservedReason, roomIds, roomNow, unusableText, type Computer, type PlacementPrefs } from './placement.ts';
import type { WorkPriority } from '../shared/types.ts';

/**
 * A computer's lowest priority of work (w1643, config placement.minPriority). lothsahn, 2026-10-20: "Instead of a single
 * setting, let's make the setting the minimum priority work that can go to a machine. If normal (all work), if high, high and
 * urgent, if urgent, urgent only".
 */

const GB = 1024 ** 3;
/** Idle: no agents, sandboxes free, RAM mostly free. BEAST is the bigger one, so it has the most room. */
const idle = (id: string, maxAgents: number): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents, sandboxes: 2, maxSandboxes: 5, freeSandboxes: 2, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors: 2, agentSeats: 6 });
/** Full: as many live agents as its limit, no free sandbox. */
const full = (id: string): Computer => ({ ...idle(id, 5), live: 5, midTurn: 5, freeSandboxes: 0, sandboxes: 5, agentSeats: 0 });

const PRIORITIES: WorkPriority[] = ['low', 'normal', 'high', 'urgent'];
const pick = (cs: Computer[], prefs: PlacementPrefs, p: WorkPriority, kind: 'game' | 'agent' = 'game') => pickComputer(cs, undefined, forPriority(prefs, p), kind)?.pick.id;

test('w1643: each level lets in what lothsahn said: normal all work (low included), high high and urgent, urgent urgent only; for game and non-game work', () => {
  // BEAST alone has room: whether it takes the work is the level alone.
  const cs = [idle('beast', 10), full('lothdesktop')];
  const expect: Record<string, WorkPriority[]> = { normal: ['low', 'normal', 'high', 'urgent'], high: ['high', 'urgent'], urgent: ['urgent'] };
  for (const [level, takes] of Object.entries(expect)) {
    const prefs: PlacementPrefs = { minPriority: { beast: level as 'normal' | 'high' | 'urgent' } };
    for (const kind of ['game', 'agent'] as const) {
      const got = PRIORITIES.filter((p) => pick(cs, prefs, p, kind) === 'beast');
      assert.deepEqual(got, takes, `${level}, ${kind} work`);
    }
  }
  // No setting at all is normal.
  assert.deepEqual(PRIORITIES.map((p) => pick(cs, {}, p)), ['beast', 'beast', 'beast', 'beast']);
});

test('w1643: work below the level never overflows onto the reserved computer (like a hold, not an avoid): it goes to another with room, else nowhere', () => {
  const prefs: PlacementPrefs = { minPriority: { beast: 'urgent' }, avoid: { lothdesktop: 'flaky' } };
  // BEAST has the most room, LothDesktop is avoided: normal work still goes to LothDesktop, the avoided one, not to BEAST.
  const both = [idle('beast', 10), idle('lothdesktop', 5)];
  const normal = pickComputer(both, undefined, forPriority(prefs, 'normal'))!;
  assert.equal(normal.pick.id, 'lothdesktop');
  assert.match(normal.why, /only avoided computers have room .*; beast is held \(reserved for urgent work only \(placement\.minPriority urgent; this work is normal\)\)/);
  assert.equal(pick(both, prefs, 'urgent'), 'beast', 'urgent work takes the most room, BEAST');
  // Nothing else has room: normal work waits; the line says why.
  const only = [idle('beast', 10), full('lothdesktop')];
  assert.equal(pick(only, prefs, 'normal'), undefined);
  assert.equal(preferLine(only, undefined, prefs), 'No computer has room for new work now (beast has room but takes urgent work only (placement.minPriority; this is normal)).');
  // placement.prefer does not get past it either.
  assert.equal(pick(both, { ...prefs, prefer: ['beast'] }, 'high'), 'lothdesktop');
});

test('w1643: a request\'s priority is the one it has now: raised to the level, the reserved computer is room for it at once', () => {
  const cs = [idle('beast', 10), full('lothdesktop')];
  const prefs: PlacementPrefs = { minPriority: { beast: 'high' } };
  const w = { priority: 'normal' as WorkPriority };
  const r = roomNow(cs, prefs);
  assert.deepEqual([r.game, r.agent], [[], []], 'not room for low and normal work');
  assert.deepEqual(r.reserved, [{ id: 'beast', min: 'high', for: ['game', 'agent'] }]);
  assert.deepEqual(roomIds(r, 'game', w.priority), []);
  assert.equal(unusableText(r, 'game', w.priority), 'beast has room but takes high and urgent work only (placement.minPriority; this is normal)');
  assert.equal(pick(cs, prefs, w.priority), undefined);
  w.priority = 'high';
  assert.deepEqual(roomIds(r, 'game', w.priority), ['beast']);
  assert.deepEqual(roomIds(r, 'agent', w.priority), ['beast']);
  assert.equal(unusableText(r, 'game', w.priority), '');
  assert.equal(pick(cs, prefs, w.priority), 'beast');
  // A hold wins over a reservation: a held computer takes nothing, whatever the work.
  const held = roomNow(cs, { ...prefs, hold: { beast: 'Ben testing' } });
  assert.deepEqual([held.reserved, roomIds(held, 'game', 'urgent')], [[], []]);
});

test('w1643: the workers already on a reserved computer go on: resumes read holds only, not the reservation', () => {
  const prefs: PlacementPrefs = { minPriority: { beast: 'urgent' } };
  assert.equal(holdReason('beast', prefs), undefined);
  assert.match(holdReason('beast', { ...prefs, hold: { beast: 'Ben testing' } })!, /beast is on hold \(Ben testing\)/);
  assert.equal(reservedReason('beast', prefs, 'high'), 'reserved for urgent work only (placement.minPriority urgent; this work is high)');
  assert.equal(reservedReason('beast', prefs, 'urgent'), undefined);
  assert.equal(reservedReason('lothdesktop', prefs, 'low'), undefined);
  // A move must let in every request the worker serves: the lowest of them.
  assert.equal(lowestPriority([{ priority: 'urgent' }, { priority: 'low' }, { priority: 'high' }]), 'low');
  assert.equal(lowestPriority([]), undefined);
});

test('w1643: the Capacity block says which computer is reserved and at what level, the Next lines are for low and normal work, and a last line says where high and urgent work goes', () => {
  const cs = [idle('beast', 10), idle('lothdesktop', 5)];
  const lines = capacityLines(cs, undefined, { minPriority: { beast: 'urgent' } });
  assert.match(lines[0], /^## Capacity \(placement\.prefer first, avoided last, reserved only for the work they take, the rest spread by room;/);
  const beast = lines.find((l) => l.startsWith('- beast'))!;
  assert.match(beast, /^- beast \[reserved: urgent work only\]: ROOM \d+% but RESERVED for urgent work only \(placement\.minPriority urgent\): low, normal and high work does not go there: /);
  assert.match(beast, /agent slot: free \(0 of 10 mid-turn\), urgent work only$/);
  assert.match(lines.find((l) => l.startsWith('- lothdesktop'))!, /^- lothdesktop: ROOM \d+%: /);
  assert.match(lines.find((l) => l.startsWith('Next new game-repo work'))!, /^Next new game-repo work: lothdesktop \(the only one with room; beast is held \(reserved for urgent work only/);
  assert.match(lines.find((l) => l.startsWith('Next non-game work'))!, /: lothdesktop \(/);
  const reserved = lines.at(-1)!;
  assert.match(reserved, /^Reserved by priority \(placement\.minPriority, w1643\): beast urgent work only\. The Next lines above are for low and normal work;/);
  assert.match(reserved, /Next urgent work: game beast \(.*\); non-game beast \(/);
  assert.doesNotMatch(reserved, /Next high work/, 'no computer is reserved for high work, so high work goes as normal work does');
  // high: both levels named.
  const high = capacityLines(cs, undefined, { minPriority: { beast: 'high' } }).at(-1)!;
  assert.match(high, /beast high and urgent work only\. .*Next high work: game beast .*Next urgent work: game beast/);
  // Nothing reserved: no such line, and the block reads as before.
  assert.doesNotMatch(capacityLines(cs).join('\n'), /Reserved|RESERVED/);
});

test('w1643: start_agent\'s note for new work on a reserved computer names the reservation and where it goes instead; release builds count as urgent', () => {
  const cs = [idle('beast', 10), idle('lothdesktop', 5)];
  const prefs: PlacementPrefs = { minPriority: { beast: 'urgent' } };
  assert.match(placementHint('beast', cs, undefined, forPriority(prefs, 'normal'))!, /^ Note: beast is held \(reserved for urgent work only \(placement\.minPriority urgent; this work is normal\)\); the next new game-repo work goes to lothdesktop/);
  assert.equal(placementHint('beast', cs, undefined, forPriority(prefs, 'urgent')), undefined, 'urgent work: BEAST is next');
  // Live view and release build work keep their first lists among the computers the work may use (placement.live: beast).
  assert.match(pickComputer(cs, undefined, forPriority(prefs, 'normal'), 'game', false, 'live')!.why, /beast is held \(reserved for urgent work only/);
  assert.equal(pickComputer(cs, undefined, forPriority(prefs, 'urgent'), 'game', false, 'build')!.pick.id, 'beast');
});
