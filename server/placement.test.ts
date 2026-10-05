import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RAM_BUSY_PCT, busyReasons, capacityLines, hasRoom, placementHint, preferLine, type Computer } from './placement.ts';

/**
 * Where new work has room (w416). The numbers are the dispatcher's own measurement at ~05:22 UTC on 2026-10-05: BEAST
 * with 7 live agents against 6, 55 of 64 GB of RAM, all 5 sandboxes in use; LothDesktop with 2 of 5 agents (1 running,
 * 1 idle), 30 of 64 GB, 2 sandboxes free.
 */

const GB = 1024 ** 3;
const BEAST: Computer = { id: 'beast', online: true, live: 7, midTurn: 5, maxAgents: 6, sandboxes: 5, maxSandboxes: 5, freeSandboxes: 0, memUsedBytes: 55 * GB, memTotalBytes: 64 * GB };
const LOTH: Computer = { id: 'lothdesktop', online: true, live: 2, midTurn: 1, maxAgents: 5, sandboxes: 3, maxSandboxes: 5, freeSandboxes: 2, memUsedBytes: 30 * GB, memTotalBytes: 64 * GB };

test('w416: BEAST full and LothDesktop free: LothDesktop is preferred, and placing on BEAST says so', () => {
  assert.deepEqual(busyReasons(BEAST), ['7 live agents of 6', 'RAM 86% used', 'no free sandbox (5 of 5 made, all in use)']);
  assert.equal(hasRoom(LOTH), true);
  const lines = capacityLines([BEAST, LOTH]);
  assert.match(lines[0], /^## Capacity/);
  assert.equal(lines[1], '- beast: BUSY (7 live agents of 6; RAM 86% used; no free sandbox (5 of 5 made, all in use)): 7 live agents of 6 (5 mid-turn); 0 of 5 sandboxes free; RAM 86% used');
  assert.equal(lines[2], '- lothdesktop: ROOM: 2 live agents of 5 (1 mid-turn); 2 of 5 sandboxes free (2 more can be made); RAM 47% used');
  assert.equal(lines[3], 'Prefer lothdesktop for new game-repo work: beast is busy.');
  const hint = placementHint('beast', [BEAST, LOTH]);
  assert.match(hint ?? '', /^ Note: beast is busy \(7 live agents of 6; RAM 86% used; no free sandbox .*\) while lothdesktop has room \(2 live agents of 5/);
  assert.match(hint ?? '', /Unless this work needs beast \(FF Factory's own repo or its deploys, ssh to the M5, a brief that pins it, or a worker going on in its own sandbox\), put new game-repo work on lothdesktop\.$/);
  assert.equal(placementHint('lothdesktop', [BEAST, LOTH]), undefined, 'placing where there is room says nothing');
});

test('w416: each reason alone makes a computer busy: its agent limit, RAM at the line, no sandbox to use or make', () => {
  const ok: Computer = { ...BEAST, live: 3, memUsedBytes: 40 * GB, freeSandboxes: 1 };
  assert.equal(hasRoom(ok), true);
  assert.deepEqual(busyReasons({ ...ok, live: 6 }), ['6 live agents of 6'], 'at the limit is busy');
  assert.deepEqual(busyReasons({ ...ok, memUsedBytes: (RAM_BUSY_PCT / 100) * 64 * GB }), [`RAM ${RAM_BUSY_PCT}% used`]);
  assert.deepEqual(busyReasons({ ...ok, memUsedBytes: 0.84 * 64 * GB }), [], 'under the line');
  assert.deepEqual(busyReasons({ ...ok, freeSandboxes: 0, sandboxes: 4 }), [], 'none free, but one more can be made');
  assert.deepEqual(busyReasons({ ...ok, online: false }), ['offline']);
  assert.deepEqual(busyReasons({ ...ok, memUsedBytes: undefined, memTotalBytes: undefined }), [], 'no load reported: judged by its counts');
});

test('w416: no hint and no preference when every computer has room, or when nothing else has room', () => {
  const calm: Computer = { ...BEAST, live: 2, memUsedBytes: 30 * GB, freeSandboxes: 2 };
  assert.equal(preferLine([calm, LOTH]), undefined);
  assert.equal(placementHint('beast', [calm, LOTH]), undefined);
  assert.equal(capacityLines([calm, LOTH]).length, 3, 'header and two lines, no preference');
  const lothOff: Computer = { ...LOTH, online: false };
  assert.equal(placementHint('beast', [BEAST, lothOff]), undefined, 'an offline machine has no room');
  assert.equal(preferLine([BEAST, lothOff]), undefined);
  assert.equal(placementHint('beast', [BEAST, { ...LOTH, live: 5 }]), undefined, 'LothDesktop full too');
  assert.deepEqual(capacityLines([]), []);
});
