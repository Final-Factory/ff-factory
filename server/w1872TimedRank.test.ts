// w1872: timed and exclusive-lock work goes to the smallest computer by default. lothsahn, 2026-10-23: "I think the rules
// of the dispatcher favors placing jobs that need an exclusive lock or timing runs on machines that have a smaller number
// of editors or slots. This is to avoid locking out work because a machine that can handle a bunch of things but is
// locked down to one is less efficient"; then "This shouldn't be a complete hard rule. If a worker requests a specific
// machine for a reason, it does need to follow the workers request or the orchestrator's request for that placement. In
// absence of any preference, it should use this list"; and "If an orchestrator or worker requests to be on a machine that
// disallows timing runs and it needs to do an exclusive lock, that should go back to the orchestrator or worker".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsTimed } from '../shared/capacity.ts';
import { pickComputer, pickTimed, placementHint, timedFacts, timedLine, timedPinRefusal, timedRank, type Computer } from './placement.ts';
import type { WorkItem } from '../shared/types.ts';

const GB = 1024 ** 3;
// maxAgents as agentCap gives it: max_sandboxes x max_agents_per_sandbox (2) unless set.
const box = (id: string, maxSandboxes: number, maxEditors: number, platform: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 1, midTurn: 0, maxAgents: 2 * maxSandboxes, sandboxes: 1, maxSandboxes, freeSandboxes: 1, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors, platform, ...o });
const NO = 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"';
const fleet = () => [box('beast', 6, 3, 'win32', { live: 0 }), box('lothdesktop', 4, 3, 'win32', { live: 2 }), box('m3', 2, 2, 'darwin', { live: 1 }), box('m5', 2, 2, 'darwin', { live: 0, noTimedRuns: NO })];
const ids = (cs: Computer[]) => cs.map((c) => c.id);
const work = (title: string, brief = ''): WorkItem => ({ title, brief, notes: [], needs: 'game' }) as unknown as WorkItem;

test('w1872: a small computer beats a big one, BEAST last, whatever their live agents', () => {
  assert.deepEqual(ids(timedRank(fleet())), ['m3', 'lothdesktop', 'beast']);
  const p = pickTimed(fleet(), {}, 'timed')!;
  assert.equal(p.pick.id, 'm3');
  assert.match(p.why, /: m3 \(4 agent slots, 2 editors, 1 live\) > lothdesktop \(8 agent slots, 3 editors, 2 live\) > beast \(12 agent slots, 3 editors, 0 live\); never m5 /);
  // Agent slots first, the editor limit breaks a tie; a one-worker computer is the ideal (its queue never cuts a turn, w1832).
  const one = box('solo', 4, 4, 'win32', { maxAgents: 1, live: 0 });
  assert.deepEqual(ids(timedRank([box('a', 2, 3, 'win32'), box('b', 2, 1, 'win32'), one])), ['solo', 'b', 'a']);
});

test('w1872: m5 is never picked, not for Mac work, not when it is the only one with room', () => {
  assert.equal(pickTimed(fleet(), {}, 'timed:darwin')!.pick.id, 'm3');
  const full = (c: Computer) => ({ ...c, freeSandboxes: 0, sandboxes: c.maxSandboxes });
  const [beast, loth, m3, m5] = fleet();
  assert.equal(pickTimed([beast, loth, full(m3), m5], {}, 'timed:darwin'), undefined);
  assert.equal(pickComputer([full(beast), full(loth), full(m3), m5], undefined, {}, 'game', false, 'timed'), undefined);
  assert.ok(!timedRank(fleet()).some((c) => c.id === 'm5'));
});

test('w1872: a tie goes to the computer with fewer live workers (the ones its turn would pause), then the fewest queued legs, then placement.prefer', () => {
  const a = box('a', 2, 2, 'win32', { live: 2 });
  const b = box('b', 2, 2, 'win32', { live: 1 });
  assert.deepEqual(ids(timedRank([a, b])), ['b', 'a']);
  const c = box('c', 2, 2, 'win32', { live: 1, benchQueue: { timed: 1 } });
  assert.deepEqual(ids(timedRank([c, b])), ['b', 'c']);
  assert.deepEqual(ids(timedRank([box('x', 2, 2, 'win32'), box('y', 2, 2, 'win32')], { prefer: ['y'] })), ['y', 'x']);
});

test('w1872: an offline, paused (held) or avoided computer is skipped', () => {
  const [beast, loth, m3, m5] = fleet();
  assert.deepEqual(ids(timedRank([beast, loth, { ...m3, online: false }, m5])), ['lothdesktop', 'beast']);
  assert.deepEqual(ids(timedRank([beast, loth, m3, m5], { hold: { m3: 'paused from its tray' } })), ['lothdesktop', 'beast']);
  assert.deepEqual(ids(timedRank([beast, loth, m3, m5], { avoid: { lothdesktop: 'Lothsahn plays there' } })), ['m3', 'beast']);
});

test('w1872: "Next timed work" lists the computers smallest first, without m5', () => {
  const line = timedLine(fleet())!;
  assert.match(line, /^Next timed work \(benchmarks, perf A\/Bs and probes; on the platform it names, w1628\): m3 \(timed or exclusive-lock work goes to the smallest computer with room \(w1872, lothsahn: "machines that have a smaller number of editors or slots"\): m3 \(.*\) > lothdesktop \(.*\) > beast \(.*\); never m5 \(it takes no timed runs: /);
  assert.equal(/\bm5 \(\d/.test(line), false, line);
});

test('w1872: a named computer wins over the ranking; one that takes no timed runs is refused back to the caller with the ones that do', () => {
  // Pinned to BEAST (a baseline machine for an A/B): no refusal, the start goes there; the hint only says the default.
  assert.equal(timedPinRefusal('beast', fleet(), {}, 'timed'), undefined);
  assert.match(placementHint('beast', fleet(), undefined, {}, undefined, 'game', false, 'timed')!, /the next new timed work goes to m3 .*Unless this work needs beast/);
  // Pinned to m5: refused, nothing started or moved, with the computers that take it and the way out.
  const no = timedPinRefusal('m5', fleet(), {}, 'timed:darwin')!;
  assert.match(no, /^m5 takes no timed or exclusive-lock work \(lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"; w1861\): this timed work was not started or moved\. Pick another computer on darwin and start it there: m3 \(4 agent slots, 2 editors, 1 live\) \("Next timed work" ranks them, w1872\)\. If none of them can do it, ask an operator \(waiting_on_person\) instead of placing it\.$/);
  const [beast, loth, m3, m5] = fleet();
  assert.match(timedPinRefusal('M5', [beast, loth, { ...m3, freeSandboxes: 0, sandboxes: 2 }, m5], {}, 'timed')!, /start it there: lothdesktop \(.*\) > beast \(.*\) > m3 \(no room now\) /);
  assert.match(timedPinRefusal('m5', [{ ...m3, online: false }, m5], {}, 'timed:darwin')!, /start it there: none is online/);
});

test('w1872: work that asks for an exclusive lock or timing runs is timed work', () => {
  assert.equal(needsTimed(work('Measure the belt cache under an exclusive lock')), 'any');
  assert.equal(needsTimed(work('w1780: timing runs on the Mac')), 'darwin');
  assert.equal(needsTimed(work('Fix the bench_lock --timing refusal text', 'exclusive bench tickets')), 'any');
  for (const t of ['Fix the belt stall', 'Lock the research tree while exclusive content loads']) assert.equal(needsTimed(work(t)), false, t);
});

test('w1872: "Next timed work" also names the computers without room, smallest first, so a one-computer line still shows the ranking', () => {
  // Live, 2026-10-23: "lothdesktop (10 agent slots, 3 editors, 5 live); never m5" with m3 and BEAST full.
  const full = (c: Computer) => ({ ...c, freeSandboxes: 0, sandboxes: c.maxSandboxes });
  const [beast, loth, m3, m5] = fleet();
  const p = pickTimed([full(beast), loth, full(m3), m5], {}, 'timed')!;
  assert.equal(p.pick.id, 'lothdesktop');
  assert.match(p.why, /: lothdesktop \(8 agent slots, 3 editors, 2 live\); no room now: m3 \(4 agent slots\), beast \(12 agent slots\); never m5 /);
  // A held or offline computer is not "no room now".
  const q = pickTimed([full(beast), loth, { ...m3, online: false }, m5], { hold: { beast: 'paused' } }, 'timed')!;
  assert.doesNotMatch(q.why, /no room now/);
});

test('w1872: timedFacts gives the ledger m5 and why, and the computers that take the work, ranked ones first; naming m5 asks for no Mac', () => {
  const full = (c: Computer) => ({ ...c, freeSandboxes: 0, sandboxes: c.maxSandboxes });
  const [beast, loth, m3, m5] = fleet();
  const f = timedFacts([beast, full(loth), m3, m5], {}, 'timed');
  assert.deepEqual(f.noTimed, { m5: NO });
  assert.deepEqual(f.takes, ['m3', 'beast', 'lothdesktop'], 'with room in timedRank order, then the full one');
  assert.deepEqual(timedFacts(fleet(), {}, 'timed:darwin').takes, ['m3']);
  // w1789's worker: "waiting for a sandbox on m5 for the timed runs". Before, \bm5\b made it Mac work, so only m3 took it.
  assert.equal(needsTimed(work('w1789: UI main-thread cost', 'still open: waiting for a sandbox on m5 for the timed runs')), 'any');
  assert.equal(needsTimed(work('Timed A/B of the Mac player on m3')), 'darwin');
});
