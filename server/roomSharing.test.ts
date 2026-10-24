import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentBusyReasons, busyReasons, capacityLines, hasAgentRoom, hasRoom, heldText, nonGameLine, pickComputer, placementHint, preferLine, roomIds, roomNow, type Computer, type PlacementPrefs } from './placement.ts';

/**
 * w1089 and w1098 (lothsahn, 2026-10-12): one room test behind the Capacity block, decide_work queue, the Queued WRONG flag
 * and the page; holds; and agent-slot room for work that needs no editor ("FFBox and FF Factory updates don't need unity
 * editors").
 */

const GB = 1024 ** 3;
/**
 * 2026-10-12 04:47 UTC, system_status: LothDesktop "BUSY: 0 of 6 sandboxes free, 4 of 4 editors, RAM at 91% (new launches
 * wait until it drops below 85%), 6 of 10 agents" while the ledger said "but lothdesktop has room" (lothsahn: "(and I don't
 * see any room on LothDesktop)").
 */
const LOTH_0447: Computer = { id: 'lothdesktop', online: true, live: 6, midTurn: 5, maxAgents: 10, sandboxes: 6, maxSandboxes: 6, freeSandboxes: 0, memUsedBytes: Math.round(0.91 * 64 * GB), memTotalBytes: 64 * GB, editors: 4, maxEditors: 4, agentSeats: 3 };
const M5: Computer = { id: 'm5', online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, memUsedBytes: 20 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors: 2, agentSeats: 6 };

/** The ids a Capacity block line calls ROOM (a held one too: "ROOM n% but HELD"), read back from the block's text. */
const roomLines = (cs: Computer[], prefs: PlacementPrefs = {}) =>
  capacityLines(cs, undefined, prefs)
    .filter((l) => l.startsWith('- ') && /: ROOM \d+%/.test(l))
    .map((l) => l.slice(2).split(/[ :]/)[0]);

test('w1089: one room test: the Capacity block and roomNow (decide_work queue, the WRONG flag, the page) never disagree; BUSY never meets "has room"', () => {
  // The 04:47 numbers: BUSY by RAM and by no sandbox, whatever the editors say; no game room anywhere.
  assert.deepEqual(busyReasons(LOTH_0447), ['RAM 91% used', 'no free sandbox (6 of 6 made, all in use)']);
  const alone = roomNow([LOTH_0447]);
  assert.deepEqual([alone.game, alone.agent, alone.held], [[], ['lothdesktop'], []], 'game work has no room; an agent slot is another matter (w1098)');
  const mixes: Computer[][] = [
    [LOTH_0447, M5],
    [{ ...LOTH_0447, memUsedBytes: 40 * GB }, M5],
    [{ ...LOTH_0447, freeSandboxes: 1 }, { ...M5, online: false }],
    [{ ...LOTH_0447, live: 10, memUsedBytes: 10 * GB }, { ...M5, live: 6 }],
    [{ ...LOTH_0447, sandboxes: 4, memUsedBytes: 10 * GB }, M5],
  ];
  for (const cs of mixes) {
    for (const prefs of [{}, { hold: { m5: 'Ben testing' } }, { avoid: { lothdesktop: 'busy' } }] as PlacementPrefs[]) {
      const r = roomNow(cs, prefs);
      const label = JSON.stringify([cs.map((c) => [c.id, hasRoom(c)]), prefs]);
      assert.deepEqual(roomLines(cs, prefs).sort(), [...r.game, ...r.held.filter((h) => h.for.includes('game')).map((h) => h.id)].sort(), label);
      assert.deepEqual([...r.game].sort(), cs.filter((c) => hasRoom(c) && !(prefs.hold ?? {})[c.id]).map((c) => c.id).sort(), label);
    }
  }
});

test("w1089: a held computer (the m5 held for Ben's testing) takes no work, game or not, and says who holds it", () => {
  const prefs: PlacementPrefs = { hold: { m5: "Ben's testing, 2026-10-12" } };
  const cs = [LOTH_0447, M5];
  const r = roomNow(cs, prefs);
  assert.deepEqual(r.game, []);
  assert.deepEqual(r.held.map((h) => [h.id, h.why, h.for]), [['m5', "Ben's testing, 2026-10-12", ['game', 'agent']]]);
  assert.deepEqual(roomIds(r, 'agent'), ['lothdesktop'], 'LothDesktop still has an agent slot; the m5 does not count');
  assert.equal(pickComputer(cs, undefined, prefs), undefined, 'never picked, even with every other computer busy');
  assert.equal(pickComputer([M5], undefined, prefs, 'agent'), undefined);
  assert.equal(heldText(r.held), "m5 has room but is held (Ben's testing, 2026-10-12)");
  assert.equal(preferLine(cs, undefined, prefs), "No computer has room for new work now (m5 has room but is held (Ben's testing, 2026-10-12)).");
  const block = capacityLines(cs, undefined, prefs);
  assert.match(block.find((l) => l.startsWith('- m5'))!, /^- m5 \[held: Ben's testing, 2026-10-12\]: ROOM \d+% but HELD \(Ben's testing, 2026-10-12\): no new work goes there:/);
  assert.match(block.find((l) => l.startsWith('- lothdesktop'))!, /^- lothdesktop: BUSY \(RAM 91% used; no free sandbox/);
  assert.match(block[0], /held never/);
  // Without the hold, the m5 is where the next goes.
  assert.equal(pickComputer(cs)!.pick.id, 'm5');
});

test('w1089: a flag explains itself hours later: roomNow keeps each computer\'s numbers at that moment', () => {
  const r = roomNow([{ ...LOTH_0447, memUsedBytes: 40 * GB, freeSandboxes: 2 }]);
  assert.equal(r.detail?.lothdesktop, '2 of 6 sandboxes free, 5 agents mid-turn of 10 (6 live), RAM 63%');
});

test('w1098: work that needs no editor goes by agent slot alone: no free game sandbox, no editor and high RAM do not matter; the agent cap, seats, holds and avoids do', () => {
  // LothDesktop at 04:47: BUSY for game work, an agent slot free (5 of 10 mid-turn, 3 seats left).
  assert.equal(hasRoom(LOTH_0447), false);
  assert.equal(hasAgentRoom(LOTH_0447), true);
  assert.deepEqual(agentBusyReasons({ ...LOTH_0447, midTurn: 10 }), ['10 agents mid-turn of 10']);
  assert.deepEqual(agentBusyReasons({ ...LOTH_0447, agentSeats: 0 }), ['no agent seat in any sandbox']);
  assert.deepEqual(agentBusyReasons({ ...LOTH_0447, online: false }), ['offline']);
  assert.equal(hasAgentRoom({ ...LOTH_0447, agentSeats: undefined }), true, 'seats unknown: a seat');
  // Idle live agents make game work busy (the live count); the agent cap counts agents mid-turn, as start_agent's queue does.
  assert.equal(hasAgentRoom({ ...LOTH_0447, live: 12, midTurn: 4 }), true);
  assert.match(nonGameLine([LOTH_0447]), /^Next non-game work \(needs only an agent slot, no editor, no free game sandbox\): lothdesktop \(the only one with room\)\.$/);
  const both = [LOTH_0447, M5];
  assert.match(nonGameLine(both), /^Next non-game work .*: m5 \(most room/);
  assert.match(nonGameLine(both, undefined, { hold: { m5: 'Ben testing' } }), /: lothdesktop \(the only one with room; m5 is held \(Ben testing\)\)/);
  assert.match(nonGameLine(both, undefined, { avoid: { m5: 'Ben tests there' } }), /: lothdesktop \(/);
  assert.match(nonGameLine(both, undefined, { prefer: ['m5'] }), /: m5 \(first with room in placement\.prefer/);
  assert.equal(nonGameLine([{ ...LOTH_0447, midTurn: 10 }]), 'No computer has an agent slot for non-game work now.');
  assert.equal(nonGameLine([M5], undefined, { hold: { m5: 'Ben testing' } }), 'No computer has an agent slot for non-game work now (m5 has room but is held (Ben testing)).');
  // The capacity block says it beside the game verdict, on the same line, and ends with the non-game line.
  const block = capacityLines(both);
  assert.match(block.find((l) => l.startsWith('- lothdesktop'))!, /BUSY \(RAM 91% used.*; agent slot: free \(5 of 10 mid-turn\)$/);
  assert.match(block.at(-1)!, /^Next non-game work /);
  assert.match(placementHint('lothdesktop', both, undefined, {}, undefined, 'agent') ?? '', /^ Note: lothdesktop has \d+% room; the next new non-game work goes to m5/);
});
