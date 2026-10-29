// w2521: a timed leg that must run on one named computer (LothLaptop, the only G-SYNC/VRR screen) runs there or waits there,
// and never falls back to an idle or bigger one. lothsahn, 2026-10-29: "the placement queues it on that machine only. It never
// falls back to an idle or big computer, and it says plainly that it is waiting on that machine."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machinePinOf, pinFromText, pinRefusal } from './machinePin.ts';
import { decideTimedPlace } from './timedAsk.ts';
import { pinnedLegStep, timedLegStep, type LegInput } from './timedLegPlace.ts';
import { moveDecision, type MoveFacts } from './resumeMove.ts';
import type { Computer } from './placement.ts';

const GB = 1024 ** 3;
const box = (id: string, maxAgents: number, platform: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents, sandboxes: 1, maxSandboxes: Math.max(1, Math.ceil(maxAgents / 2)), freeSandboxes: 1, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors: 2, platform, ...o });
const KNOWN = ['beast', 'lothdesktop', 'lothlaptop', 'm3', 'm5', 'biscuit'];
// 2026-10-29 05:49Z: BEAST idle but for worker 9bdafcfe, LothLaptop busy with another leg (its one slot taken).
const busyLaptop = box('lothlaptop', 1, 'win32', { live: 1, midTurn: 1, freeSandboxes: 0 });
const fleet = () => [box('beast', 6, 'win32', { live: 1 }), box('lothdesktop', 10, 'win32', { live: 9 }), busyLaptop, box('m3', 2, 'darwin'), box('biscuit', 4, 'linux'), box('m5', 4, 'darwin', { noTimedRuns: 'Ben runs stuff on it personally' })];
const at = (id: string) => fleet().find((c) => c.id === id)!;

// The words of the three misses, as the ledger and the portal journal hold them.
const W2499_CONSTRAINTS = 'Must run on LothLaptop (its RTX 4070 and the 240 Hz panel); no other machine. Timed work: hold the bench lock briefly, in one session.';
const W2520_CONSTRAINTS = 'Must run on LothLaptop (lothlaptop) only: it is the only G-SYNC screen. Never place it on BEAST or any other machine.';
const CASE1_WHAT = "w2501 G-SYNC A/B on PR #2795: needs LothLaptop's G-SYNC panel (BEAST is 60 Hz, no G-SYNC)";
const CASE3_SAME = 'Must run on LothLaptop (RTX 4070 dGPU, 240 Hz G-SYNC panel): the reporter\'s machine and the only one showing the judder; earlier w2448 traces came from it.';

test('w2521: the words of each miss pin LothLaptop; a leg\'s own "runs on" line, two machines or an unknown name pin nothing', () => {
  assert.deepEqual(pinFromText(W2499_CONSTRAINTS, KNOWN), ['lothlaptop']);
  assert.deepEqual(pinFromText(W2520_CONSTRAINTS, KNOWN), ['lothlaptop']);
  assert.deepEqual(pinFromText(CASE1_WHAT, KNOWN), ['lothlaptop']);
  assert.deepEqual(pinFromText(CASE3_SAME, KNOWN), ['lothlaptop']);
  assert.deepEqual(pinFromText('Run only on m3, a Mac.', KNOWN), ['m3']);
  assert.deepEqual(pinFromText('a timed leg (w1969): runs on lothlaptop or m3', KNOWN), [], 'the w1969 leg line is a queue, not a pin');
  assert.deepEqual(pinFromText('must run on lothlaptop or must run on m3', KNOWN), [], 'two pins are not clear words');
  assert.deepEqual(pinFromText('must run on the GPU box', KNOWN), []);
  assert.deepEqual(pinFromText('the base side ran here at 01:10Z', KNOWN), []);
  assert.equal(machinePinOf({ constraints: W2499_CONSTRAINTS }, KNOWN)?.ids[0], 'lothlaptop');
  assert.deepEqual(machinePinOf({ machinePin: { ids: ['LothLaptop'], why: 'named' } }, KNOWN), { ids: ['lothlaptop'], why: 'named' });
  assert.equal(machinePinOf({ constraints: 'Timed work.' }, KNOWN), undefined);
});

test('w2521 case 1: the 05:49Z call shape from an idle BEAST, pinned to a busy LothLaptop, is queued on LothLaptop alone', () => {
  // Before: w2055's idle rule answered "here" on BEAST, the 60 Hz screen with no G-SYNC.
  const before = decideTimedPlace({ here: at('beast'), places: fleet(), platform: 'win32' });
  assert.equal(before.verdict, 'here');
  assert.match(before.why, /beast \(large, 6 agent slots\) is idle but for this worker/);
  const d = decideTimedPlace({ here: at('beast'), places: fleet(), platform: 'win32', pinned: { id: 'lothlaptop', why: `its what: "${CASE1_WHAT}"` } });
  assert.equal(d.verdict, 'elsewhere');
  assert.deepEqual(d.needs, ['lothlaptop']);
  assert.equal(d.pinned, true);
  assert.equal(d.timedRun, undefined);
  assert.match(d.why, /^it must run on lothlaptop only \(its what: .*\): the leg waits on lothlaptop, which is busy now \(1 of 1 agent slot live\), and starts there by itself when lothlaptop can take it; it never falls back to another computer, however idle \(w2521\)$/);
  // Even with same_machine and a timed_run computer up, the pin wins.
  const same = decideTimedPlace({ here: at('beast'), places: fleet(), sameMachine: 'the base ran here', timedRun: ['beast', 'lothlaptop'], pinned: { id: 'lothlaptop', why: 'G-SYNC' } });
  assert.deepEqual([same.verdict, same.needs], ['elsewhere', ['lothlaptop']]);
  // On LothLaptop itself: here.
  const home = decideTimedPlace({ here: busyLaptop, places: fleet(), pinned: { id: 'lothlaptop', why: 'G-SYNC' } });
  assert.deepEqual([home.verdict, home.pinned], ['here', true]);
  // Offline: still LothLaptop, said plainly.
  const off = decideTimedPlace({ here: at('biscuit'), places: fleet().map((c) => (c.id === 'lothlaptop' ? { ...c, online: false } : c)), pinned: { id: 'lothlaptop', why: 'G-SYNC' } });
  assert.deepEqual(off.needs, ['lothlaptop']);
  assert.match(off.why, /waits on lothlaptop, which is offline now/);
});

test('w2521: a Queued leg pinned to a busy LothLaptop waits there while BEAST and biscuit are idle; it starts there once LothLaptop is idle', () => {
  const input = (places: Computer[]): LegInput => ({ id: 'w2520', priority: 'high', platform: 'win32', places, occupants: { lothlaptop: [{ session: 'e2113a5c', requests: ['w2499'], stays: 'it is mid-turn' }] }, now: Date.now(), blipMs: 60_000 });
  const idleBig = fleet().map((c) => (c.id === 'beast' ? { ...c, live: 0 } : c));
  // Unpinned, a high leg goes to the idle BEAST.
  assert.deepEqual(timedLegStep(input(idleBig)), { start: 'beast', why: (timedLegStep(input(idleBig)) as { why: string }).why });
  const pin = { ids: ['lothlaptop'], why: 'its constraints: "Must run on LothLaptop"' };
  const step = pinnedLegStep(input(idleBig), pin);
  assert.ok('wait' in step, JSON.stringify(step));
  assert.deepEqual((step as { wait: string[] }).wait, ['lothlaptop']);
  assert.match(step.why, /^it must run on lothlaptop only \(its constraints: "Must run on LothLaptop"\): it waits Queued on lothlaptop and starts there by itself when it can take it, never on another computer, however idle \(w2521\)/);
  // Offline LothLaptop: still waits there, never widens.
  const gone = pinnedLegStep(input(idleBig.map((c) => (c.id === 'lothlaptop' ? { ...c, online: false, lastSeenAt: undefined } : c))), pin);
  assert.deepEqual('wait' in gone ? gone.wait : gone, ['lothlaptop']);
  // LothLaptop idle: it starts there.
  const free = pinnedLegStep({ ...input(idleBig.map((c) => (c.id === 'lothlaptop' ? { ...c, live: 0, midTurn: 0, freeSandboxes: 1 } : c))), occupants: {} }, pin);
  assert.equal('start' in free && free.start, 'lothlaptop');
});

test('w2521 case 2: w2499 waiting for room on LothLaptop stays there (its constraints pin it), and start_agent refuses m3', () => {
  const pinned = machinePinOf({ constraints: W2499_CONSTRAINTS }, KNOWN)!.ids;
  const facts: MoveFacts = {
    machine: 'lothlaptop',
    released: true,
    branch: 'sandbox/slot1-w2482',
    canSave: true,
    requests: [{ id: 'w2499', priority: 'high', kind: 'game', first: 'timed', pinned }],
    places: [busyLaptop, box('m3', 2, 'darwin'), box('beast', 6, 'win32')],
    prefs: {},
  };
  const d = moveDecision(facts);
  assert.deepEqual(d, { stay: 'w2499 is pinned to lothlaptop' });
  // Before: no pin, and the 02:48Z move went to m3 (or any computer with room).
  const { pinned: _p, ...unpinned } = facts.requests[0];
  assert.ok('move' in moveDecision({ ...facts, requests: [unpinned] }));
  const pin = machinePinOf({ constraints: W2499_CONSTRAINTS }, KNOWN);
  assert.match(pinRefusal('w2499', pin, 'm3')!, /^w2499 must run on lothlaptop only \(w2521: its constraints: "Must run on LothLaptop .*\), never on m3 or any other computer, however idle\. Start it on lothlaptop when a sandbox there is free, or queue it for capacity with machines \["lothlaptop"\]/);
  assert.equal(pinRefusal('w2499', pin, 'LothLaptop'), undefined);
  assert.equal(pinRefusal('w2499', undefined, 'm3'), undefined);
});
