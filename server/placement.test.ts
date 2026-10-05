import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVEN_MARGIN, RAM_BUSY_PCT, busyReasons, capacityLines, hasRoom, pickComputer, placementHint, preferLine, roomOf, type Computer, type PlacementPrefs } from './placement.ts';

/**
 * Where new work goes (w416): spread by room between the computers with sandboxes ("Game work should be spread between
 * LothDesktop and Beast, not just when BEAST is full", Lothsahn). The full case uses the dispatcher's own measurement
 * at ~05:22 UTC on 2026-10-05: BEAST with 7 live agents against 6, 55 of 64 GB, all 5 sandboxes in use; LothDesktop with
 * 2 of 5 agents, 30 of 64 GB, 2 sandboxes free.
 */

const GB = 1024 ** 3;
const BEAST: Computer = { id: 'beast', online: true, live: 7, midTurn: 5, maxAgents: 6, sandboxes: 5, maxSandboxes: 5, freeSandboxes: 0, memUsedBytes: 55 * GB, memTotalBytes: 64 * GB, editors: 2, maxEditors: 3 };
const LOTH: Computer = { id: 'lothdesktop', online: true, live: 2, midTurn: 1, maxAgents: 5, sandboxes: 3, maxSandboxes: 5, freeSandboxes: 2, memUsedBytes: 30 * GB, memTotalBytes: 64 * GB, editors: 1, maxEditors: 2 };
/** Both idle: no agents, sandboxes free, RAM mostly free. */
const idle = (id: string, maxAgents: number): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents, sandboxes: 2, maxSandboxes: 5, freeSandboxes: 2, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors: 2 });

/** Place one new worker on `id`: one more live agent, one free sandbox used (or one more made), an editor, 10 GB. */
function place(cs: Computer[], id: string): Computer[] {
  return cs.map((c) =>
    c.id !== id
      ? c
      : { ...c, live: c.live + 1, midTurn: c.midTurn + 1, ...(c.freeSandboxes ? { freeSandboxes: c.freeSandboxes - 1 } : { sandboxes: c.sandboxes + 1 }), editors: (c.editors ?? 0) + 1, memUsedBytes: (c.memUsedBytes ?? 0) + 10 * GB },
  );
}

test('w416: with both idle, placements spread evenly: one each in turn', () => {
  let cs = [idle('beast', 6), idle('lothdesktop', 6)];
  let last: string | undefined;
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    const p = pickComputer(cs, last)!;
    order.push(p.pick.id);
    cs = place(cs, p.pick.id);
    last = p.pick.id;
  }
  assert.deepEqual(order, ['beast', 'lothdesktop', 'beast', 'lothdesktop']);
  // Even room and the same live agents: the one that did not take the last.
  const tie = pickComputer([idle('beast', 6), idle('lothdesktop', 6)], 'beast')!;
  assert.equal(tie.pick.id, 'lothdesktop');
  assert.match(tie.why, /room about even \(beast \d+%, lothdesktop \d+%\), the same live agents; beast took the last one/);
});

test('w416: with different limits (BEAST 6 agents, LothDesktop 5), six placements still split three and three', () => {
  let cs = [idle('beast', 6), idle('lothdesktop', 5)];
  let last: string | undefined;
  const n: Record<string, number> = { beast: 0, lothdesktop: 0 };
  for (let i = 0; i < 6; i++) {
    const id = pickComputer(cs, last)!.pick.id;
    n[id]++;
    cs = place(cs, id);
    last = id;
  }
  assert.deepEqual(n, { beast: 3, lothdesktop: 3 });
});

test('w416: with one busier, the other is picked, and placing on the busier one says so', () => {
  const beast: Computer = { ...idle('beast', 6), live: 4, midTurn: 3, freeSandboxes: 0, sandboxes: 4, memUsedBytes: 44 * GB, editors: 2 };
  const loth = idle('lothdesktop', 5);
  assert.equal(hasRoom(beast), true, 'busier, not busy');
  assert.ok(roomOf(loth) - roomOf(beast) >= EVEN_MARGIN);
  const p = pickComputer([beast, loth])!;
  assert.equal(p.pick.id, 'lothdesktop');
  assert.match(p.why, /^most room \(\d+% vs \d+% on beast\)$/);
  assert.equal(preferLine([beast, loth]), `Next new game-repo work: lothdesktop (${p.why}).`);
  const hint = placementHint('beast', [beast, loth]);
  assert.match(hint ?? '', /^ Note: beast has \d+% room; the next new game-repo work goes to lothdesktop \(most room/);
  assert.match(hint ?? '', /Unless this work needs beast \(FF Factory's own repo or its deploys, the review folder, ssh to the M5 from a computer that has its key, a brief that pins it, Max posting, which only LothDesktop has, or a worker going on in its own sandbox\), put it there\.$/);
  assert.equal(placementHint('lothdesktop', [beast, loth]), undefined, 'placing on the next one says nothing');
  // And the other way round: LothDesktop busier, BEAST picked.
  assert.equal(pickComputer([idle('beast', 6), { ...loth, live: 4, freeSandboxes: 0, sandboxes: 5, memUsedBytes: 50 * GB }])!.pick.id, 'beast');
});

test('w416: BEAST full (the 05:22 numbers): busy, LothDesktop is next, and the capacity block shows both with their room', () => {
  assert.deepEqual(busyReasons(BEAST), ['7 live agents of 6', 'RAM 86% used', 'no free sandbox (5 of 5 made, all in use)']);
  assert.equal(roomOf(BEAST), 0);
  const lines = capacityLines([BEAST, LOTH]);
  assert.match(lines[0], /^## Capacity/);
  assert.equal(lines[1], '- beast: BUSY (7 live agents of 6; RAM 86% used; no free sandbox (5 of 5 made, all in use)): 7 live agents of 6 (5 mid-turn); 0 of 5 sandboxes free; RAM 86% used; editors 2 of 3');
  assert.match(lines[2], /^- lothdesktop: ROOM \d+%: 2 live agents of 5 \(1 mid-turn\); 2 of 5 sandboxes free \(2 more can be made\); RAM 47% used; editors 1 of 2$/);
  assert.equal(lines[3], 'Next new game-repo work: lothdesktop (the only one with room; beast is busy).');
  assert.match(placementHint('beast', [BEAST, LOTH]) ?? '', /^ Note: beast is busy \(7 live agents of 6; RAM 86% used; no free sandbox .*\); the next new game-repo work goes to lothdesktop/);
});

test('w416: each reason alone makes a computer busy: its agent limit, RAM at the line, no sandbox to use or make', () => {
  const ok: Computer = { ...BEAST, live: 3, memUsedBytes: 40 * GB, freeSandboxes: 1 };
  assert.equal(hasRoom(ok), true);
  assert.deepEqual(busyReasons({ ...ok, live: 6 }), ['6 live agents of 6'], 'at the limit is busy');
  assert.deepEqual(busyReasons({ ...ok, memUsedBytes: (RAM_BUSY_PCT / 100) * 64 * GB }), [`RAM ${RAM_BUSY_PCT}% used`]);
  assert.deepEqual(busyReasons({ ...ok, memUsedBytes: 0.84 * 64 * GB }), [], 'under the line');
  assert.deepEqual(busyReasons({ ...ok, freeSandboxes: 0, sandboxes: 4 }), [], 'none free, but one more can be made');
  assert.deepEqual(busyReasons({ ...ok, online: false }), ['offline']);
});

test('w416: no note on the next one, none when nothing has room, and one computer alone gets no "next" line', () => {
  const lothOff: Computer = { ...LOTH, online: false };
  assert.equal(placementHint('beast', [BEAST, lothOff]), undefined, 'nothing has room: nowhere better to point');
  assert.equal(preferLine([BEAST, lothOff]), 'No computer has room for new work now.');
  assert.equal(preferLine([LOTH]), undefined);
  assert.equal(capacityLines([LOTH]).length, 2);
  assert.deepEqual(capacityLines([]), []);
});

// ---------------------------------------------------------------- w428: a recorded preference

/** Ben, 2026-10-05: "favor using lothdesktop and the m5 and m3 because beast is having issues with its processor and keeps crashing". */
const PREFS: PlacementPrefs = { prefer: ['lothdesktop', 'm5', 'm3'], avoid: { beast: 'BEAST unstable, 2026-10-05' } };
const main = (id: string, live = 0): Computer => ({ id, online: true, mainClone: true, live, midTurn: 0, maxAgents: 3, sandboxes: 0, maxSandboxes: 0, freeSandboxes: 0, memUsedBytes: 12 * GB, memTotalBytes: 64 * GB });

test('w428: with the preference set, LothDesktop first, then the m5, then the m3, and BEAST only when they are all full', () => {
  // BEAST idle with the most room still comes last.
  const beast = idle('beast', 6);
  let cs = [beast, idle('lothdesktop', 5), main('m5'), main('m3')];
  assert.ok(roomOf(beast) >= roomOf(cs[1]));
  const first = pickComputer(cs, undefined, PREFS)!;
  assert.equal(first.pick.id, 'lothdesktop');
  assert.match(first.why, /^first with room in placement\.prefer \(lothdesktop > m5 > m3\)$/);
  // LothDesktop full: the m5's main clone, then the m3's.
  cs = [beast, { ...idle('lothdesktop', 5), live: 5 }, main('m5'), main('m3')];
  assert.equal(pickComputer(cs, undefined, PREFS)!.pick.id, 'm5');
  assert.match(preferLine(cs, undefined, PREFS)!, /^Next new game-repo work: m5's main clone: start_agent with machine "m5"; its worker backs up the owner's uncommitted work \(ff-local-backups\) before it sets any aside \(first with room in placement\.prefer .*lothdesktop is busy\)\.$/);
  cs = [beast, { ...idle('lothdesktop', 5), live: 5 }, main('m5', 3), main('m3')];
  assert.equal(pickComputer(cs, undefined, PREFS)!.pick.id, 'm3');
  // All three full: BEAST, and the line says why.
  cs = [beast, { ...idle('lothdesktop', 5), live: 5 }, main('m5', 3), { ...main('m3'), online: false }];
  const last = pickComputer(cs, undefined, PREFS)!;
  assert.equal(last.pick.id, 'beast');
  assert.match(last.why, /^only avoided computers have room \(beast: BEAST unstable, 2026-10-05\)/);
});

test('w428: the capacity block tags each computer, and placing on an avoided BEAST says so', () => {
  const cs = [idle('beast', 6), idle('lothdesktop', 5), main('m5'), main('m3')];
  const lines = capacityLines(cs, undefined, PREFS);
  assert.match(lines[0], /^## Capacity \(placement\.prefer first, avoided last, the rest spread by room;/);
  assert.match(lines[1], /^- beast \[avoided: BEAST unstable, 2026-10-05\]: ROOM \d+%: 0 live agents of 6/);
  assert.match(lines[2], /^- lothdesktop \[preferred #1\]: ROOM \d+%/);
  assert.match(lines[3], /^- m5 \[main clone; preferred #2\]: ROOM \d+%: 0 live agents of 3 \(0 mid-turn\) in its main clone; RAM 19% used$/);
  assert.match(lines[4], /^- m3 \[main clone; preferred #3\]: ROOM/);
  assert.match(lines[5], /^Next new game-repo work: lothdesktop \(first with room in placement\.prefer/);
  assert.match(placementHint('beast', cs, undefined, PREFS) ?? '', /^ Note: beast is avoided \(BEAST unstable, 2026-10-05\); the next new game-repo work goes to lothdesktop \(first with room in placement\.prefer/);
  assert.equal(placementHint('lothdesktop', cs, undefined, PREFS), undefined);
  assert.match(placementHint('m5', cs, undefined, PREFS) ?? '', /^ Note: m5 has \d+% room; the next new game-repo work goes to lothdesktop/);
});

test('w428: without a preference, main clones come after the sandbox computers; avoid alone keeps BEAST last', () => {
  const cs = [{ ...idle('beast', 6), live: 2 }, { ...idle('lothdesktop', 5), live: 1 }, main('m5')];
  assert.ok(roomOf(cs[2]) > roomOf(cs[1]), 'the m5 has the most room');
  assert.equal(pickComputer(cs)!.pick.id, 'lothdesktop', 'a sandbox computer still goes first');
  assert.equal(pickComputer([cs[0], { ...cs[1], live: 5 }, cs[2]])!.pick.id, 'beast');
  assert.equal(pickComputer([cs[0], { ...cs[1], live: 5, online: false }, cs[2]], undefined, {})!.pick.id, 'beast');
  // Avoid alone: BEAST, with more room, waits behind LothDesktop and the m5.
  const avoidOnly: PlacementPrefs = { avoid: { beast: 'unstable' } };
  const roomy = [idle('beast', 6), { ...idle('lothdesktop', 5), live: 3 }, main('m5')];
  assert.equal(pickComputer(roomy, undefined, avoidOnly)!.pick.id, 'lothdesktop');
  assert.equal(pickComputer([roomy[0], { ...roomy[1], live: 5 }, roomy[2]], undefined, avoidOnly)!.pick.id, 'm5');
  // "host" names this host's own pool.
  assert.equal(pickComputer([idle('this host', 6), idle('lothdesktop', 5)], undefined, { prefer: ['host'] })!.pick.id, 'this host');
});

test('w467: the note names the review folder where the portal runs, not BEAST\'s path', () => {
  const beast = { ...idle('beast', 6), live: 4, freeSandboxes: 0, sandboxes: 4, memUsedBytes: 44 * GB, editors: 2 };
  const hint = placementHint('beast', [beast, idle('lothdesktop', 5)], undefined, {}, '/srv/fff/review') ?? '';
  assert.match(hint, /the review folder \(\/srv\/fff\/review\), ssh to the M5 from a computer that has its key/);
  assert.doesNotMatch(hint, /F:\\ffsb|from BEAST/);
});
