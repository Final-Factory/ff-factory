import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUILD, DEFAULT_LIVE, EVEN_MARGIN, buildLine, RAM_BUSY_PCT, busyReasons, capacityLines, hasRoom, liveLine, pickComputer, placementHint, preferLine, roomOf, type Computer, type PlacementPrefs } from './placement.ts';

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
  assert.match(hint ?? '', /Unless this work needs beast \(the review folder, ssh to the M5 from a computer that has its key, a brief that pins it, or a worker going on in its own sandbox\), put it there\.$/);
  assert.equal(placementHint('lothdesktop', [beast, loth]), undefined, 'placing on the next one says nothing');
  // And the other way round: LothDesktop busier, BEAST picked.
  assert.equal(pickComputer([idle('beast', 6), { ...loth, live: 4, freeSandboxes: 0, sandboxes: 5, memUsedBytes: 50 * GB }])!.pick.id, 'beast');
});

test('w416: BEAST full (the 05:22 numbers): busy, LothDesktop is next, and the capacity block shows both with their room', () => {
  assert.deepEqual(busyReasons(BEAST), ['7 live agents of 6', 'RAM 86% used', 'no free sandbox (5 of 5 made, all in use)']);
  assert.equal(roomOf(BEAST), 0);
  const lines = capacityLines([BEAST, LOTH]);
  assert.match(lines[0], /^## Capacity/);
  assert.equal(lines[1], '- beast: BUSY (7 live agents of 6; RAM 86% used; no free sandbox (5 of 5 made, all in use)): 7 live agents of 6 (5 mid-turn); 0 of 5 sandboxes free; RAM 86% used; editors 2 of 3; agent slot: free (5 of 6 mid-turn)');
  assert.match(lines[2], /^- lothdesktop: ROOM \d+%: 2 live agents of 5 \(1 mid-turn\); 2 of 5 sandboxes free \(2 more can be made\); RAM 47% used; editors 1 of 2; agent slot: free \(1 of 5 mid-turn\)$/);
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
  assert.equal(capacityLines([LOTH]).length, 3, 'its header, its line and the non-game line');
  assert.deepEqual(capacityLines([]), []);
});

// ---------------------------------------------------------------- w428: a recorded preference

/**
 * Ben, 2026-10-05: "favor using lothdesktop and the m5 and m3 because beast is having issues with its processor and keeps
 * crashing". The m5 and the m3 have no sandboxes, so since w536 they take no workers and are no computers here.
 */
const PREFS: PlacementPrefs = { prefer: ['lothdesktop', 'm5', 'm3'], avoid: { beast: 'BEAST unstable, 2026-10-05' } };

test('w428: with the preference set, LothDesktop first, and BEAST only when it is full', () => {
  // BEAST idle with the most room still comes last.
  const beast = idle('beast', 6);
  let cs = [beast, idle('lothdesktop', 5)];
  assert.ok(roomOf(beast) >= roomOf(cs[1]));
  const first = pickComputer(cs, undefined, PREFS)!;
  assert.equal(first.pick.id, 'lothdesktop');
  assert.match(first.why, /^first with room in placement\.prefer \(lothdesktop > m5 > m3\)$/);
  assert.match(preferLine(cs, undefined, PREFS)!, /^Next new game-repo work: lothdesktop \(first with room in placement\.prefer/);
  // LothDesktop full: BEAST, and the line says why.
  cs = [beast, { ...idle('lothdesktop', 5), live: 5 }];
  const last = pickComputer(cs, undefined, PREFS)!;
  assert.equal(last.pick.id, 'beast');
  assert.match(last.why, /^only avoided computers have room \(beast: BEAST unstable, 2026-10-05\)/);
});

test('w428: the capacity block tags each computer, and placing on an avoided BEAST says so', () => {
  const cs = [idle('beast', 6), idle('lothdesktop', 5)];
  const lines = capacityLines(cs, undefined, PREFS);
  assert.match(lines[0], /^## Capacity \(placement\.prefer first, avoided last, the rest spread by room;/);
  assert.match(lines[1], /^- beast \[avoided: BEAST unstable, 2026-10-05\]: ROOM \d+%: 0 live agents of 6/);
  assert.match(lines[2], /^- lothdesktop \[preferred #1\]: ROOM \d+%/);
  assert.match(lines[3], /^Next new game-repo work: lothdesktop \(first with room in placement\.prefer/);
  // BEAST avoided: Live view work does not override the avoid (w1600).
  assert.match(lines[4], /^Next Live view work \(game work whose worker streams a Live view, w1600\): lothdesktop \(Live view work, but beast is avoided \(BEAST unstable, 2026-10-05\); so the general placement: first with room in placement\.prefer/);
  assert.match(lines[5], /^Next release build work \(w1606; release builds only, w1628\): lothdesktop \(Release build work, but beast is avoided/);
  assert.match(lines[6], /^Next timed work \(benchmarks, perf A\/Bs and probes; on the platform it names, w1628\): lothdesktop /);
  assert.equal(lines.length, 8, "header, two computers, the next game line, the Live view, release build and timed lines and the non-game line");
  assert.match(placementHint('beast', cs, undefined, PREFS) ?? '', /^ Note: beast is avoided \(BEAST unstable, 2026-10-05\); the next new game-repo work goes to lothdesktop \(first with room in placement\.prefer/);
  assert.equal(placementHint('lothdesktop', cs, undefined, PREFS), undefined);
});

test('w428: avoid alone keeps BEAST last; "host" names this host\'s own pool', () => {
  const avoidOnly: PlacementPrefs = { avoid: { beast: 'unstable' } };
  const roomy = [idle('beast', 6), { ...idle('lothdesktop', 5), live: 3 }];
  assert.ok(roomOf(roomy[0]) > roomOf(roomy[1]), 'BEAST has more room');
  assert.equal(pickComputer(roomy, undefined, avoidOnly)!.pick.id, 'lothdesktop');
  assert.equal(pickComputer([roomy[0], { ...roomy[1], live: 5 }], undefined, avoidOnly)!.pick.id, 'beast');
  assert.equal(pickComputer([idle('this host', 6), idle('lothdesktop', 5)], undefined, { prefer: ['host'] })!.pick.id, 'this host');
});

test('w467: the note names the review folder where the portal runs, not BEAST\'s path', () => {
  const beast = { ...idle('beast', 6), live: 4, freeSandboxes: 0, sandboxes: 4, memUsedBytes: 44 * GB, editors: 2 };
  const hint = placementHint('beast', [beast, idle('lothdesktop', 5)], undefined, {}, '/srv/fff/review') ?? '';
  assert.match(hint, /the review folder \(\/srv\/fff\/review\), ssh to the M5 from a computer that has its key/);
  assert.doesNotMatch(hint, /F:\\ffsb|from BEAST/);
});

test('w615: a machine whose GPU Whisper is loaded says how much VRAM it holds; unloaded or unmeasured, nothing', async () => {
  const { voiceVram } = await import('./placement.ts');
  assert.deepEqual(voiceVram({ state: 'ready', vramMiB: 1161 }), { voiceVramMiB: 1161 });
  assert.deepEqual(voiceVram({ state: 'idle', vramMiB: 1161 }), {});
  assert.deepEqual(voiceVram({ state: 'ready' }), {});
  assert.deepEqual(voiceVram(undefined), {});
  const lines = capacityLines([{ ...BEAST, voiceVramMiB: 1161 }, LOTH]);
  assert.match(lines[1], /; editors 2 of 3; Whisper holds ~1\.1 GB VRAM \(unloaded for the editors when VRAM runs short\); agent slot: free \(5 of 6 mid-turn\)$/);
  assert.doesNotMatch(lines[2], /Whisper/);
});

/**
 * Live view work goes to BEAST first (w1600, Ben, 2026-10-19: "can you prioritize beast for stuff that needs live view? live
 * view is often too slow"), while every other piece of game work keeps the general preference (the m5 and lothdesktop first).
 */
const M5_FIRST: PlacementPrefs = { prefer: ['m5', 'lothdesktop'] };

test('w1600: Live view work goes to BEAST first when it has room; other game work keeps placement.prefer', () => {
  assert.deepEqual(DEFAULT_LIVE, ['beast']);
  const cs = [idle('beast', 6), idle('lothdesktop', 5), idle('m5', 3)];
  assert.equal(pickComputer(cs, undefined, M5_FIRST)!.pick.id, 'm5', 'game work: placement.prefer as before');
  const live = pickComputer(cs, undefined, M5_FIRST, 'game', false, true)!;
  assert.equal(live.pick.id, 'beast');
  assert.match(live.why, /^Live view work goes to the first with room in placement\.live \(beast; w1600/);
  // Work that needs no editor never streams a Live view: the flag changes nothing for it.
  assert.equal(pickComputer(cs, undefined, M5_FIRST, 'agent', false, true)!.pick.id, 'm5');
  // placement.live set: its order wins.
  assert.equal(pickComputer(cs, undefined, { ...M5_FIRST, live: ['LothDesktop', 'beast'] }, 'game', false, true)!.pick.id, 'lothdesktop');
});

test('w1600: BEAST full, held or avoided: Live view work falls back to the general placement, and says why', () => {
  const full: Computer = { ...idle('beast', 6), live: 6 };
  const cs = [full, idle('lothdesktop', 5), idle('m5', 3)];
  const p = pickComputer(cs, undefined, M5_FIRST, 'game', false, true)!;
  assert.equal(p.pick.id, 'm5');
  assert.match(p.why, /^Live view work, but beast is busy \(6 live agents of 6\); so the general placement: first with room in placement\.prefer \(m5 > lothdesktop\)/);
  const held = pickComputer([idle('beast', 6), idle('m5', 3)], undefined, { ...M5_FIRST, hold: { beast: 'Ben testing' } }, 'game', false, true)!;
  assert.equal(held.pick.id, 'm5');
  assert.match(held.why, /beast is held \(Ben testing\)/);
  const avoided = pickComputer([idle('beast', 6), idle('m5', 3)], undefined, { avoid: { beast: 'unstable' } }, 'game', false, true)!;
  assert.equal(avoided.pick.id, 'm5');
  assert.match(avoided.why, /beast is avoided \(unstable\)/);
  // Nothing has room at all: no pick, and the line says so.
  assert.equal(pickComputer([full], undefined, {}, 'game', false, true), undefined);
  assert.equal(liveLine([full, { ...idle('m5', 3), live: 3 }], undefined, {}), 'No computer has room for Live view work now.');
  assert.equal(liveLine([idle('beast', 6)], undefined, {}), undefined, 'one computer: no line, like preferLine');
});

test('w1600: the capacity block names where the next Live view work goes, with BEAST\'s bench lock when a timed run holds it', () => {
  const beast: Computer = { ...idle('beast', 6), benchLock: { owner: 'BEAST pid 4121 worker 21:04:10 probe A round 2 (/f/ffw/sandboxes/slot4)', since: '2026-10-19T21:04:10.000Z' } };
  const cs = [beast, idle('lothdesktop', 5), idle('m5', 3)];
  const lines = capacityLines(cs, undefined, M5_FIRST);
  assert.match(lines[1], /^- beast: ROOM \d+%: .*; its bench lock is held since 21:04Z \(BEAST pid 4121 .*probe A round 2 .*\): a timed run; agent slot/);
  assert.match(lines[4], /^Next new game-repo work: m5 \(first with room in placement\.prefer/);
  assert.match(lines[5], /^Next Live view work \(game work whose worker streams a Live view, w1600\): beast \(Live view work goes to the first with room in placement\.live \(beast; .*\); its bench lock is held since 21:04Z .*: its worker waits for it before it starts its editor\)\.$/);
  assert.match(lines[6], /^Next release build work \(w1606; release builds only, w1628\): beast \(Release build work goes to the first with room in placement\.build \(beast; w1606: builds run fastest there\); its bench lock is held since 21:04Z .*: its worker waits for it before it starts its build\)\.$/);
  assert.match(lines[7], /^Next timed work /);
  assert.match(lines[8], /^Next non-game work/);
  // start_agent's note for Live view work placed elsewhere names BEAST; for other game work, the m5.
  assert.match(placementHint('lothdesktop', cs, undefined, M5_FIRST, undefined, 'game', false, true) ?? '', /^ Note: lothdesktop has \d+% room; the next new Live view work goes to beast \(Live view work goes to/);
  assert.match(placementHint('lothdesktop', cs, undefined, M5_FIRST) ?? '', /the next new game-repo work goes to m5/);
  assert.equal(placementHint('beast', cs, undefined, M5_FIRST, undefined, 'game', false, true), undefined);
});

/**
 * Builds go to BEAST first too (w1606, Ben, 2026-10-20: "when you know builds are coming up, we also prioritize using beast for
 * builds because its faster"), by their own list (placement.build), and a computer a build is coming to is held for new work.
 */
test('w1606: build work goes to placement.build first (beast), falls back when it is held for a coming build, and says so', () => {
  assert.deepEqual(DEFAULT_BUILD, ['beast']);
  const cs = [idle('beast', 6), idle('lothdesktop', 5), idle('m5', 3)];
  const b = pickComputer(cs, undefined, M5_FIRST, 'game', false, 'build')!;
  assert.equal(b.pick.id, 'beast');
  assert.match(b.why, /^Release build work goes to the first with room in placement\.build \(beast; w1606: builds run fastest there\)/);
  assert.equal(pickComputer(cs, undefined, { ...M5_FIRST, build: ['m5'] }, 'game', false, 'build')!.pick.id, 'm5', 'placement.build set: its order wins');
  assert.equal(pickComputer(cs, undefined, { ...M5_FIRST, live: ['lothdesktop'] }, 'game', false, 'build')!.pick.id, 'beast', 'placement.live is the Live views\' list, not the builds\'');
  // A build coming to BEAST holds it (Agents.placement() adds BuildPlans.holds()): new build work goes elsewhere, saying why.
  const held = pickComputer(cs, undefined, { ...M5_FIRST, hold: { beast: 'a build is coming at 05:10Z (0.50.0.112, worker abc; w1606): no new work until it is done' } }, 'game', false, 'build')!;
  assert.equal(held.pick.id, 'm5');
  assert.match(held.why, /^Release build work, but beast is held \(a build is coming at 05:10Z/);
  assert.match(buildLine(cs, undefined, M5_FIRST) ?? '', /^Next release build work \(w1606; release builds only, w1628\): beast/);
  assert.match(placementHint('m5', cs, undefined, M5_FIRST, undefined, 'game', false, 'build') ?? '', /the next new release build work goes to beast/);
});
