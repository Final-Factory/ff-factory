// w2147: capacity is never a question for a person. lothsahn, 2026-10-25: "Stop asking to bring computers online. It's a
// cluster where computers are sometimes online and sometimes paused. Use and schedule resources based on what you have.
// Don't ask for permission". The case: w1958's worker on m5 (no timed runs) queued a Windows A/B for desktop-coosego,
// which was offline; timed_place then answered "no small computer takes w1958's timed leg: ask an operator", and the worker
// asked lothsahn "bring desktop-coosego back online, or say which computer may time the shield frame-rate A/B".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTimedPlace } from './timedAsk.ts';
import { timedLegStep } from './timedLegPlace.ts';
import { timedPinRefusal, type Computer } from './placement.ts';
import { noTimedWaitNotice } from './agents.ts';
import { machineAskIn, machineAskProblem } from '../shared/machineAsk.ts';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-10-25T14:00:00Z');
const NO = 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"';
const box = (id: string, maxAgents: number, platform: string, o: Partial<Computer> = {}): Computer => ({
  id,
  online: true,
  live: 1,
  midTurn: 0,
  maxAgents,
  sandboxes: 1,
  maxSandboxes: Math.max(1, Math.ceil(maxAgents / 2)),
  freeSandboxes: 1,
  memUsedBytes: 16 * GB,
  memTotalBytes: 64 * GB,
  editors: 0,
  maxEditors: 2,
  platform,
  ...o,
});
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
// 2026-10-25 as w1958 met it: desktop-coosego (the one small Windows computer for it) and lothlaptop offline, the big ones busy.
const fleet = (o: Record<string, Partial<Computer>> = {}): Computer[] =>
  [
    box('beast', 6, 'win32', { live: 6, midTurn: 5 }),
    box('lothdesktop', 10, 'win32', { live: 4, midTurn: 4 }),
    box('desktop-coosego', 1, 'win32', { online: false, offlineSince: ago(90), live: 0 }),
    box('lothlaptop', 1, 'win32', { online: false, offlineSince: ago(200), live: 0 }),
    box('m3', 3, 'darwin', { online: false, offlineSince: ago(400) }),
    box('m5', 4, 'darwin', { noTimedRuns: NO }),
  ].map((c) => ({ ...c, ...o[c.id] }));
const ids = fleet().map((c) => c.id);
const W1958 = 'bring desktop-coosego back online, or say which computer may time the shield frame-rate A/B';

test('w2147: the w1958 case: timed_place from m5 with every small Windows computer offline files the leg Queued for the computers that take timed runs, smallest first, never m5, and never says "ask an operator"', () => {
  const d = decideTimedPlace({ here: fleet().find((c) => c.id === 'm5'), places: fleet(), platform: 'win32', now: NOW, waitMs: 5 * 60_000 });
  assert.equal(d.verdict, 'elsewhere');
  assert.deepEqual(d.needs, ['desktop-coosego', 'lothlaptop', 'beast', 'lothdesktop']);
  assert.match(d.why, /waits Queued for desktop-coosego > lothlaptop > beast > lothdesktop and starts by itself on the first that comes online or frees up/);
  assert.doesNotMatch(d.why, /operator|bring .* online|which computer/i);
  // The w2055 pass then places it with what is up: every small one offline, so the next class, at once (no wait for them).
  const step = timedLegStep({ id: 'w9', priority: 'normal', platform: 'win32', places: fleet(), prefs: {}, occupants: {}, now: NOW, blipMs: 5 * 60_000 });
  assert.ok(!('start' in step && step.start === 'm5') && !JSON.stringify(step).includes('"m5"'), JSON.stringify(step));
  assert.doesNotMatch(step.why, /operator/);
});

test('w2147: with no computer at all that takes the leg, it still files Queued (needs empty), a capacity wait, not a question', () => {
  const places = fleet({ m3: { noTimedRuns: 'test' } });
  const d = decideTimedPlace({ here: places.find((c) => c.id === 'm5'), places, platform: 'darwin', now: NOW });
  assert.equal(d.verdict, 'elsewhere');
  assert.deepEqual(d.needs, []);
  assert.match(d.why, /the leg waits Queued and starts by itself/);
  assert.doesNotMatch(d.why, /operator/);
});

test('w2147: the pin refusal and the no-timed-wait notice say to queue, never to ask an operator; the exclusions stand', () => {
  const r = timedPinRefusal('m5', fleet(), {}, 'timed')!;
  assert.match(r, /^m5 takes no timed or exclusive-lock work/);
  assert.match(r, /queue it with needs naming them: it starts by itself on the first that comes online or frees up/);
  assert.doesNotMatch(r, /operator|waiting_on_person/);
  const n = noTimedWaitNotice('w1958', 'waits on m5 for the timed A/B', 'm5', NO, ['desktop-coosego']);
  assert.doesNotMatch(n, /operator|waiting_on_person/);
  assert.match(n, /never ask a person for a computer \(w2147\)/);
});

test('w2147: waiting_on_person refuses a wait whose only ask is a computer: the w1958 text, waking, picking, permission, an installer (w847)', () => {
  for (const what of [
    W1958,
    'Bring desktop-coosego back online so the A/B can run',
    'wake the m3 or unpause it',
    'Say which computer may time the shield frame-rate A/B',
    'Should I wait for desktop-coosego or use another computer?',
    'May I use beast for the timing run?',
    'Give permission to run the timed leg on lothdesktop',
    're-run the installer on lothdesktop', // w847
  ]) {
    assert.ok(machineAskIn(what, ids), what);
    const p = machineAskProblem(what, [], ids, 'worker');
    assert.match(p ?? '', /^Nothing was recorded \(w2147, lothsahn, 2026-10-25: "Stop asking to bring computers online/, what);
    assert.match(p!, /capacity wait, Queued, never a question for a person/);
    assert.match(p!, /timed_place always files the leg, Queued/);
  }
  // The card form: every question a capacity ask.
  assert.ok(machineAskProblem('time the shield A/B', ['Should desktop-coosego be brought back online, or which computer may time it?'], ids, 'worker'));
  // The dispatcher's decide_work ask is told to queue.
  assert.match(machineAskProblem(undefined, [W1958], ids, 'dispatcher')!, /Use decide_work queue with needs naming the computers/);
});

test('w2147: a blocker only that person can clear still goes through, and so do design questions and mixed cards', () => {
  for (const what of [
    'reboot the m3 and log in (FileVault)',
    'reboot the m3 and log in: FileVault asks for a password',
    'log in to lothlaptop: it waits at its login screen',
    'approve the admin prompt on beast (UAC) for the driver install',
    'Which machine should make copper plates first in the starter base?', // "machine" is a game noun
    'OK the circuit button look so it can merge on green CI',
  ])
    assert.equal(machineAskProblem(what, [], ids, 'worker'), undefined, what);
  // One capacity question beside a real decision: the card goes to the person (the decision is theirs).
  assert.equal(machineAskProblem('decide the arrow look', [W1958, 'Which arrow look should ship: the red one or the white one?'], ids, 'worker'), undefined);
});
