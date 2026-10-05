import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVEN_MARGIN, RAM_BUSY_PCT, busyReasons, capacityLines, hasRoom, pickComputer, placementHint, preferLine, roomOf, type Computer } from './placement.ts';

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
  assert.match(hint ?? '', /^ Note: beast has \d+% room; to spread game-repo work, the next goes to lothdesktop \(most room/);
  assert.match(hint ?? '', /Unless this work needs beast \(FF Factory's own repo or its deploys, ssh to the M5, a brief that pins it, Max posting, which only LothDesktop has, or a worker going on in its own sandbox\), put new game-repo work on lothdesktop\.$/);
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
  assert.equal(lines[3], 'Next new game-repo work: lothdesktop (the only computer with room (beast is busy)).');
  assert.match(placementHint('beast', [BEAST, LOTH]) ?? '', /^ Note: beast is busy \(7 live agents of 6; RAM 86% used; no free sandbox .*\); to spread game-repo work, the next goes to lothdesktop/);
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
