// w2168: timed work follows the timing order when it is first placed and while it waits (server/timedLegPlace.ts).
// lothsahn, 2026-10-25: "Please file a fix to understand and fix why this got placed as ordinary work, as BEAST was about to
// start doing exclusive runs which really lowers our ability to develop"; on w2157: "(or if that needed to go to LothLaptop,
// why is beast handling the other timing run and not sending it to LothLaptop?)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Computer } from './placement.ts';
import { timedRelocateStep, timedStartProblem } from './timedLegPlace.ts';

const GB = 1024 ** 3;
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
// The fleet at 18:43Z on 2026-10-25, when w2163 went to lothdesktop/slot3: LothLaptop idle, BEAST and LothDesktop at work.
const fleet = (o: Record<string, Partial<Computer>> = {}) => [
  box('lothlaptop', 1, o.lothlaptop),
  box('m3', 3, { platform: 'darwin', ...o.m3 }),
  box('beast', 6, { live: 3, midTurn: 2, ...o.beast }),
  box('lothdesktop', 10, { live: 4, midTurn: 1, ...o.lothdesktop }),
  box('m5', 4, { platform: 'darwin', noTimedRuns: 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs"', ...o.m5 }),
];
// placement.prefer as config has it: LothLaptop is left out on purpose, and that must not drop it from timed placement.
const PREFS = { prefer: ['lothdesktop', 'beast', 'biscuit'] };

test('w2168: a timed request started on a busy big computer while a small one is idle is refused, naming the small one', () => {
  for (const target of ['lothdesktop', 'beast']) {
    const p = timedStartProblem('w2163', target, fleet(), PREFS, 'win32');
    assert.ok(p, target);
    assert.match(p!, /w2163 is timed work, and lothlaptop \(small, 1 agent slot\) is idle/);
    assert.match(p!, /start_agent with machine "lothlaptop"/);
    assert.match(p!, new RegExp(`not on ${target}`));
  }
  // The small idle computer itself passes, prefer or not.
  assert.equal(timedStartProblem('w2163', 'lothlaptop', fleet(), PREFS, 'win32'), undefined);
  assert.equal(timedStartProblem('w2163', 'lothlaptop', fleet(), {}, 'win32'), undefined);
});

test('w2168: with no idle computer, or with the target idle and as small as the first idle one, start_agent is not refused', () => {
  assert.equal(timedStartProblem('w9', 'beast', fleet({ lothlaptop: busy, m3: busy }), PREFS, 'win32'), undefined);
  assert.equal(timedStartProblem('w9', 'beast', fleet({ lothlaptop: { online: false, offlineSince: '2026-10-25T05:50:51Z' }, m3: busy }), PREFS, 'win32'), undefined);
  // An idle big computer while the small one is idle too: the small one first.
  assert.ok(timedStartProblem('w9', 'beast', fleet({ beast: { live: 0, midTurn: 0 } }), PREFS, 'win32'));
  // A macOS leg: m3 (medium, idle) is the first for it; lothlaptop does not run it.
  assert.equal(timedStartProblem('w9', 'm3', fleet(), PREFS, 'darwin'), undefined);
  assert.match(timedStartProblem('w9', 'beast', fleet(), PREFS, 'darwin') ?? '', /m3 \(medium/);
  // A computer that takes no timed runs is never offered.
  assert.doesNotMatch(timedStartProblem('w9', 'beast', fleet({ lothlaptop: busy, m3: busy, m5: { live: 0 } }), PREFS, 'darwin') ?? '', /m5/);
});

test('w2168: a leg waiting for an exclusive ticket on a big computer moves to a small computer that has become idle; never from a small one', () => {
  // w2157: lothlaptop came back at 18:33:40Z while the leg waited on beast for ticket t00001507.
  const r = timedRelocateStep('beast', fleet(), PREFS, 'win32');
  assert.equal(r?.to, 'lothlaptop');
  assert.match(r!.why, /lothlaptop \(small, 1 agent slot\) became idle while it waited on beast/);
  assert.equal(timedRelocateStep('lothdesktop', fleet(), {}, 'win32')?.to, 'lothlaptop');
  // Still offline, or busy: it stays.
  assert.equal(timedRelocateStep('beast', fleet({ lothlaptop: { online: false, offlineSince: '2026-10-25T05:50:51Z' } }), PREFS, 'win32'), undefined);
  assert.equal(timedRelocateStep('beast', fleet({ lothlaptop: busy }), PREFS, 'win32'), undefined);
  // Already small or medium: nothing to gain.
  assert.equal(timedRelocateStep('lothlaptop', fleet(), PREFS, 'win32'), undefined);
  assert.equal(timedRelocateStep('m3', fleet(), PREFS, 'darwin'), undefined);
  // Held computers are not offered.
  assert.equal(timedRelocateStep('beast', fleet(), { ...PREFS, hold: { lothlaptop: 'Ben testing' } }, 'win32'), undefined);
});
