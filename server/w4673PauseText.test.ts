// w4673 (lothsahn, 2026-11-18): a tray-paused machine's hold named "its tray's Unpause, its schedule, or 90 minutes without
// input" for every pause. A pause set by hand holds until the tray's Unpause or the schedule's next edge, and the activity
// pause is off by default (w1574), so LothLaptop, paused by hand since 2026-11-11, read as if its pause had ended. The hold
// now names only the routes that release it, and how old the pause is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseAge, pauseHold, pauseHolds, pauseRelease } from './machinePause.ts';
import { holdReason, timedLine, type Computer } from './placement.ts';
import { pauseState } from '../machine/pauseRules.ts';
import type { MachinePause, MachinePauseSettings } from '../shared/types.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const DAY = 86_400_000;
const settings = (activity: boolean, schedule = false): MachinePauseSettings => ({
  schedule: { enabled: schedule, start: '09:00', end: '17:00', days: [0, 1, 2, 3, 4, 5, 6] },
  activity: { enabled: activity, idleMinutes: 90 },
});
/** The pause as the daemon reports it (machine/pause.ts current()). */
const report = (s: MachinePauseSettings, mem: Parameters<typeof pauseState>[1], now = NOW): MachinePause => ({ ...pauseState(s, mem, now), settings: s });

for (const activity of [false, true]) {
  test(`w4673: a pause set by hand (activity pause ${activity ? 'on' : 'off'}) names only the tray's Unpause, and its age`, () => {
    const p = report(settings(activity), { manual: { paused: true, at: NOW - 7 * DAY } });
    assert.equal(p.reason, 'manual');
    const hold = pauseHold(p, NOW);
    assert.equal(hold, "paused from its tray app: paused by hand 7 days ago (w1532); it runs again only on its tray's Unpause");
    assert.doesNotMatch(hold, /minutes|input/);
    const why = holdReason('lothlaptop', { hold: pauseHolds([{ id: 'lothlaptop', pause: p }], NOW) })!;
    assert.equal(why, "lothlaptop is paused from its tray app: paused by hand 7 days ago (w1532): nothing resumes there until it runs again, only on its tray's Unpause");
  });
}

test('w4673: a pause set by hand on a machine with a schedule names the Unpause and the schedule edge, never input', () => {
  // Paused by hand at 10:00 inside the 09:00-17:00 window: the window's end (17:00) leaves it paused; the next start frees it.
  const p = report(settings(true, true), { manual: { paused: true, at: NOW - 2 * 3_600_000 } });
  assert.equal(p.reason, 'manual');
  assert.ok(p.until);
  assert.equal(pauseRelease(p), `on its tray's Unpause or its schedule at ${p.until!.slice(11, 16)} UTC`);
  assert.match(pauseHold(p, NOW), /^paused from its tray app: paused by hand 2 hours ago \(w1532\); it runs again on its tray's Unpause or its schedule at \d\d:\d\d UTC$/);
});

test("w4673: the activity pause (on) names its idle minutes and the tray's Unpause, with the last input's age", () => {
  const p = report(settings(true), { inputAt: NOW - 12 * 60_000 });
  assert.equal(p.reason, 'activity');
  assert.equal(pauseHold(p, NOW), "paused from its tray app: someone is using it (last input 12 min ago) (w1532); it runs again after 90 minutes without a person's input (at 13:18 UTC if nobody touches it) or on its tray's Unpause");
});

test('w4673: with the activity pause off, a person\'s input never pauses the machine, so no hold is made', () => {
  const p = report(settings(false), { inputAt: NOW - 60_000 });
  assert.equal(p.paused, false);
  assert.deepEqual(pauseHolds([{ id: 'beast', pause: p }], NOW), {});
});

test("w4673: the schedule's pause names its next start and the tray's Unpause", () => {
  const p = report(settings(false, true), {}, Date.parse('2026-11-18T20:00:00.000Z'));
  assert.equal(p.reason, 'schedule');
  assert.equal(pauseHold(p, Date.parse('2026-11-18T20:00:00.000Z')), `paused from its tray app: outside its work schedule (paused ${pauseAge(p.since, Date.parse('2026-11-18T20:00:00.000Z'))}) (w1532); it runs again on its schedule at ${p.until!.slice(11, 16)} UTC or its tray's Unpause`);
});

test('w4673: the timed-run computers line carries the routes and age too', () => {
  const box = (id: string): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 2, sandboxes: 1, maxSandboxes: 1, freeSandboxes: 1, memUsedBytes: 16e9, memTotalBytes: 64e9, editors: 0, maxEditors: 1, platform: 'linux' }) as Computer;
  const hold = pauseHolds([{ id: 'lothlaptop', pause: report(settings(false), { manual: { paused: true, at: NOW - 7 * DAY } }) }], NOW);
  assert.match(timedLine([box('lothlaptop'), { ...box('beast'), online: false }], undefined, { hold })!, /waits on lothlaptop: paused from its tray app: paused by hand 7 days ago \(w1532\); it runs again only on its tray's Unpause/);
});

test('w4673: the age of a pause, and none without a since (an older daemon)', () => {
  assert.equal(pauseAge(undefined, NOW), undefined);
  assert.equal(pauseAge(new Date(NOW - 20_000).toISOString(), NOW), 'just now');
  assert.equal(pauseAge(new Date(NOW - 59 * 60_000).toISOString(), NOW), '59 min ago');
  assert.equal(pauseAge(new Date(NOW - 3_600_000).toISOString(), NOW), '1 hour ago');
  assert.equal(pauseAge(new Date(NOW - 47 * 3_600_000).toISOString(), NOW), '47 hours ago');
  assert.equal(pauseAge(new Date(NOW - 2 * DAY).toISOString(), NOW), '2 days ago');
  assert.equal(pauseHold({ reason: 'manual', detail: '' }, NOW), "paused from its tray app: paused by hand (w1532); it runs again only on its tray's Unpause");
});
