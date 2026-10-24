// w2055: where a Queued timed leg goes (server/timedLegPlace.ts). lothsahn, 2026-10-24: "Small:1 slot, medium:2-3 slots.
// Large:4-6 slots. Xlarge:7+"; "Timing should prefer small, then medium, etc. if machines are all busy, queue timing runs up
// on small machines and make them wait vs scheduling them on shared boxes, unless high or urgent priority"; "If all small
// machines are offline, don't wait for them to come online."; "By free machine you mean idle... Doing no other work. Free
// might imply an empty slot."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classOf, classText, sizeClass, timedLine, type Computer } from './placement.ts';
import { notIdle, timedLegStep, type LegInput, type Occupant } from './timedLegPlace.ts';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-10-24T16:00:00Z');
const BLIP = 5 * 60_000;
const NO = 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"';
const box = (id: string, maxAgents: number, o: Partial<Computer> = {}): Computer => ({
  id,
  online: true,
  live: 0,
  midTurn: 0,
  maxAgents,
  sandboxes: 1,
  maxSandboxes: 3,
  freeSandboxes: 1,
  memUsedBytes: 16 * GB,
  memTotalBytes: 64 * GB,
  editors: 0,
  maxEditors: 2,
  platform: 'win32',
  ...o,
});
const busy = { live: 1, midTurn: 1 };
const off = (min: number): Partial<Computer> => ({ online: false, offlineSince: new Date(NOW - min * 60_000).toISOString() });
// The fleet as the journal had it on 2026-10-24: LothLaptop 1 slot, m3 2-3, biscuit 4, BEAST 6, LothDesktop 10, m5 (none).
const fleet = (o: Record<string, Partial<Computer>> = {}) => [
  box('lothlaptop', 1, o.lothlaptop),
  box('m3', 3, { platform: 'darwin', ...o.m3 }),
  box('biscuit', 4, { platform: 'linux', ...o.biscuit }),
  box('beast', 6, o.beast),
  box('lothdesktop', 10, o.lothdesktop),
  box('m5', 4, { platform: 'darwin', noTimedRuns: NO, ...o.m5 }),
];
const allBusy = (more: Record<string, Partial<Computer>> = {}) =>
  fleet(Object.fromEntries(['lothlaptop', 'm3', 'biscuit', 'beast', 'lothdesktop'].map((id) => [id, { ...busy, ...more[id] }])));
const step = (a: Partial<LegInput> & { places: Computer[] }) => timedLegStep({ id: 'w9', priority: 'normal', occupants: {}, now: NOW, blipMs: BLIP, ...a });
const mover = (session: string, to: string, requests = ['w1']): Occupant => ({ session, requests, move: to });

test('w2055: size classes come from the agent slots: small 1, medium 2-3, large 4-6, xlarge 7+, shown in the logs and the Capacity timed line', () => {
  assert.deepEqual([1, 2, 3, 4, 6, 7, 16].map(sizeClass), ['small', 'medium', 'medium', 'large', 'large', 'xlarge', 'xlarge']);
  assert.equal(sizeClass(0), 'small');
  assert.equal(classOf(box('biscuit', 4)), 'large', 'biscuit (4 slots) is large, not small');
  assert.equal(classText(box('lothlaptop', 1)), 'lothlaptop (small, 1 agent slot)');
  assert.equal(classText(box('lothdesktop', 10)), 'lothdesktop (xlarge, 10 agent slots)');
  const line = timedLine(fleet());
  assert.match(line ?? '', /lothlaptop \(small, 1 agent slot/);
  assert.match(line ?? '', /beast \(large, 6 agent slots/);
});

test('w2055: step 1 takes an idle computer, smallest class first; an empty slot on a busy one is not idle', () => {
  // All idle: the small one.
  assert.deepEqual(step({ places: fleet() }), { start: 'lothlaptop', why: step({ places: fleet() }).why });
  assert.match(step({ places: fleet() }).why, /^lothlaptop \(small, 1 agent slot\) is idle \(no other work on it\)/);
  // Small busy, medium idle: the medium one (on its platform: m3 is a Mac, so a Windows leg skips it).
  assert.equal((step({ places: fleet({ lothlaptop: busy }) }) as { start: string }).start, 'm3');
  assert.equal((step({ places: fleet({ lothlaptop: busy }), platform: 'win32' }) as { start: string }).start, 'beast');
  // lothsahn's case: a large computer with an empty slot but other work running must not take it in step 1.
  const lb = fleet({ lothlaptop: busy, m3: busy, biscuit: busy, beast: { live: 3, midTurn: 2, freeSandboxes: 2 }, lothdesktop: { live: 5, midTurn: 4, freeSandboxes: 1 } });
  const s = step({ places: lb });
  assert.ok(!('start' in s), `a busy big computer with room is not idle: ${JSON.stringify(s)}`);
  assert.match(notIdle(lb[3])!, /^beast runs other work \(3 agents live\)/);
  // An idle big one does take it once every smaller one is busy.
  assert.equal((step({ places: fleet({ lothlaptop: busy, m3: busy, biscuit: busy }) }) as { start: string }).start, 'beast');
  // Editors left open in sandboxes no worker holds do not count as work; one a worker uses does.
  assert.equal(notIdle(box('lothlaptop', 1, { editors: 1, idleEditors: 1 })), undefined);
  assert.match(notIdle(box('lothlaptop', 1, { editors: 1, idleEditors: 0 }))!, /1 Unity process in use/);
  // A bench lock, a timed wait on the bench, a released worker coming back, a leg already held: not idle.
  assert.match(notIdle(box('x', 1, { benchLock: { owner: 'w5', since: '' } as Computer['benchLock'] }))!, /bench lock/);
  assert.match(notIdle(box('x', 1, { resumesWaiting: 1 }))!, /released worker/);
  // m5 never takes one, idle or not.
  assert.notEqual((step({ places: fleet({ lothlaptop: busy, m3: busy, biscuit: busy, beast: busy, lothdesktop: busy }), platform: 'darwin' }) as { start?: string }).start, 'm5');
});

test('w2055: step 2 pre-empts movable work off a small computer, even with an empty slot on a busy big one; unmovable work is not moved', () => {
  const places = allBusy({ beast: { freeSandboxes: 2 } });
  const s = step({ places, occupants: { lothlaptop: [mover('aaaaaaaa1111', 'beast')] } });
  assert.ok('preempt' in s, JSON.stringify(s));
  assert.equal(s.preempt, 'lothlaptop');
  assert.deepEqual(s.moves.map((m) => m.move), ['beast']);
  assert.match(s.why, /lothlaptop \(small, 1 agent slot\) is the first small one whose work can move: worker aaaaaaaa \(w1\) moves to beast/);
  // A worker that serves no open request is released, not moved.
  const r = step({ places, occupants: { lothlaptop: [{ session: 'bbbbbbbb', requests: [], release: true }] } });
  assert.ok('preempt' in r && /is released \(it serves no open request\)/.test(r.why));
  // Unmovable (uncommitted work, a build in flight): it waits on the small computer, never the big one's slot.
  for (const stays of ['its sandbox has uncommitted work (2 file(s))', 'its check-in is set and its editor runs: a build, import or test run may be in flight']) {
    const w = step({ places, occupants: { lothlaptop: [{ session: 'cccccccc', requests: ['w1'], stays }] } });
    assert.ok('wait' in w, JSON.stringify(w));
    assert.deepEqual(w.wait, ['lothlaptop']);
    assert.ok(w.why.includes(stays), w.why);
  }
  // No room for it elsewhere (moveDecision none): waits.
  const n = step({ places, occupants: { lothlaptop: [{ session: 'dddddddd', requests: ['w1'], stays: 'no other computer that could take it has room now' }] } });
  assert.ok('wait' in n);
  // Only the base class is pre-empted: a movable worker on a large computer is left alone.
  const big = step({ places, occupants: { beast: [mover('eeeeeeee', 'lothdesktop')] } });
  assert.ok('wait' in big, JSON.stringify(big));
  // Agents live there that hold no sandbox (an ops worker): not freeable.
  const ops = step({ places: allBusy({ lothlaptop: { live: 2 } }), occupants: { lothlaptop: [mover('ffffffff', 'beast')] } });
  assert.ok('wait' in ops && /runs agents outside its sandboxes/.test(ops.why));
});

test('w2055: step 3 splits by priority: normal and low wait on the small computers, high and urgent go to a big one at once', () => {
  const places = allBusy();
  const stuck = { lothlaptop: [{ session: 'cccccccc', requests: ['w1'], stays: 'it is mid-turn' }] };
  for (const priority of ['low', 'normal'] as const) {
    const w = step({ places, priority, occupants: stuck });
    assert.ok('wait' in w, `${priority}: ${JSON.stringify(w)}`);
    assert.deepEqual(w.wait, ['lothlaptop']);
    assert.match(w.why, new RegExp(`at ${priority} priority it waits Queued on the small computers \\(lothlaptop\\), not on a busy shared one`));
  }
  for (const priority of ['high', 'urgent'] as const) {
    const w = step({ places, priority, occupants: stuck });
    assert.ok('widen' in w, `${priority}: ${JSON.stringify(w)}`);
    assert.deepEqual(w.widen, ['lothlaptop', 'm3', 'biscuit', 'beast', 'lothdesktop'], 'never m5');
    assert.match(w.why, /w2048 fallback/);
  }
});

test('w2055: every small computer offline: the next class is used at once, a blip still counts, and a small one back is used again', () => {
  // lothlaptop gone 20 min: medium (m3) is the base class, so a mac leg pre-empts or waits there, a Windows one waits on the large class (beast; lothdesktop is xlarge).
  const gone = allBusy({ lothlaptop: off(20) });
  const w = step({ places: gone, occupants: {} });
  assert.ok('wait' in w, JSON.stringify(w));
  assert.deepEqual(w.wait, ['m3']);
  assert.match(w.why, /every small computer is offline \(lothlaptop\), so the next class is used \(w2055: "If all small machines are offline, don't wait for them"\)/);
  const pre = step({ places: gone, occupants: { m3: [mover('aaaaaaaa', 'lothdesktop')] } });
  assert.ok('preempt' in pre && pre.preempt === 'm3', JSON.stringify(pre));
  const win = step({ places: gone, platform: 'win32' });
  assert.ok('wait' in win && win.wait.join() === 'beast', JSON.stringify(win));
  // An idle large one with the small one offline starts at once.
  assert.equal((step({ places: fleet({ lothlaptop: off(20), m3: busy, biscuit: busy }) }) as { start: string }).start, 'beast');
  // A 30 s drop is a blip: lothlaptop stays the base class.
  const blip = step({ places: allBusy({ lothlaptop: off(0.5) }) });
  assert.ok('wait' in blip && blip.wait.join() === 'lothlaptop', JSON.stringify(blip));
  // Back online: it is the base class again (each pass re-checks).
  const back = step({ places: allBusy() });
  assert.ok('wait' in back && back.wait.join() === 'lothlaptop');
  // Nothing that takes timed runs up: it waits for any to come back.
  const none = step({ places: fleet({ lothlaptop: off(60), m3: off(60), biscuit: off(60), beast: off(60), lothdesktop: off(60) }) });
  assert.ok('wait' in none && none.wait.length === 0 && /no computer that takes timed runs is up \(never m5\)/.test(none.why), JSON.stringify(none));
});
