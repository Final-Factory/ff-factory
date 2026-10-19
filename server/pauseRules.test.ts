import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAUSE_SETTINGS, IDLE_MINUTES, SUPPRESS_SECONDS, cleanSettings, nextChangeAt, pauseState, personInput, scheduleAt, scheduleText, trayCommand, trayView, type PauseMemory } from '../machine/pauseRules.ts';
import type { MachinePauseSettings } from '../shared/types.ts';

// w1532 (lothsahn, 2026-10-19): "It'll unpause when the schedule begins and pause when the schedule ends ... If someone clicks
// the mouse or types a key, it should pause and only unpause after 90 minutes of inactivity. Unpausing via the taskbar should
// prevent any such pausing for 30 seconds after unpausing in the taskbar."
// Times are this computer's local time (the schedule is), built with the local Date constructor so any TZ runs them.

const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 9, d, h, m, s).getTime(); // October 2026; the 19th is a Monday
const MIN = 60_000;
const night: MachinePauseSettings = { ...DEFAULT_PAUSE_SETTINGS, schedule: { enabled: true, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] } };
const noActivity: MachinePauseSettings = { ...night, activity: { enabled: false, idleMinutes: IDLE_MINUTES } };

test('w1532: no schedule and nobody at the machine: it runs; the tray pause holds until the tray unpauses', () => {
  const s = DEFAULT_PAUSE_SETTINGS;
  assert.equal(pauseState(s, {}, at(19, 12)).paused, false);
  const paused = trayCommand({}, true, at(19, 12));
  const p = pauseState(s, paused, at(25, 12));
  assert.equal(p.paused, true, 'a week later it is still paused: only the tray lifts a tray pause without a schedule');
  assert.equal(p.reason, 'manual');
  assert.match(p.detail, /paused from the tray at 12:00/);
  assert.equal(pauseState(s, trayCommand(paused, false, at(25, 13)), at(25, 13, 1)).paused, false);
});

test('w1532: the schedule unpauses when its window starts and pauses when it ends, a night window across midnight included', () => {
  const s = noActivity;
  const before = pauseState(s, {}, at(19, 21, 59));
  assert.deepEqual([before.paused, before.reason], [true, 'schedule']);
  assert.match(before.detail, /outside the schedule \(22:00 to 08:00, every day\): work resumes at 22:00/);
  assert.equal(before.until, new Date(at(19, 22)).toISOString());
  const inside = pauseState(s, {}, at(19, 22));
  assert.deepEqual([inside.paused, inside.reason], [false, 'schedule']);
  assert.equal(inside.since, new Date(at(19, 22)).toISOString());
  assert.match(inside.detail, /until 08:00/);
  assert.equal(pauseState(s, {}, at(20, 3)).paused, false, 'after midnight, still inside');
  assert.equal(pauseState(s, {}, at(20, 7, 59)).paused, false);
  const after = pauseState(s, {}, at(20, 8));
  assert.deepEqual([after.paused, after.reason], [true, 'schedule'], 'the window ends at 08:00');
});

test('w1532: a window on chosen days only, and a day schedule', () => {
  const work: MachinePauseSettings = { ...noActivity, schedule: { enabled: true, start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] } };
  assert.equal(scheduleText(work.schedule), '09:00 to 17:00, Mon Tue Wed Thu Fri');
  assert.equal(pauseState(work, {}, at(19, 10)).paused, false, 'Monday 10:00 runs');
  assert.equal(pauseState(work, {}, at(18, 10)).paused, true, 'Sunday 10:00 is paused');
  const fri = pauseState(work, {}, at(23, 18));
  assert.equal(fri.paused, true);
  assert.equal(fri.until, new Date(at(26, 9)).toISOString(), 'Friday evening: next Monday 09:00');
  const whole: MachinePauseSettings = { ...noActivity, schedule: { enabled: true, start: '00:00', end: '00:00', days: [0, 6] } };
  assert.equal(pauseState(whole, {}, at(24, 23, 59)).paused, false, 'start equal to end is the whole day (Saturday)');
  assert.equal(pauseState(whole, {}, at(26, 0, 1)).paused, true, 'Monday is off');
  assert.equal(scheduleAt(whole.schedule, at(25, 12))?.nextEdge, at(26, 0), 'Saturday and Sunday join into one window');
});

test('w1532: the latest event wins: a tray pause inside the window holds until the next window starts; a tray unpause outside it until the next edge', () => {
  const s = noActivity;
  const mem = trayCommand({}, true, at(19, 23));
  assert.deepEqual([pauseState(s, mem, at(20, 2)).paused, pauseState(s, mem, at(20, 2)).reason], [true, 'manual']);
  assert.match(pauseState(s, mem, at(20, 2)).detail, /paused from the tray at 23:00; the schedule takes over at 08:00/);
  assert.equal(pauseState(s, mem, at(20, 9)).reason, 'schedule', 'the window ended: the schedule again');
  assert.equal(pauseState(s, mem, at(20, 22)).paused, false, 'the next window start unpauses, as lothsahn asked');
  const run = trayCommand({}, false, at(20, 12));
  const r = pauseState(s, run, at(20, 15));
  assert.deepEqual([r.paused, r.reason], [false, 'manual'], 'unpaused from the tray outside the window');
  assert.equal(r.until, new Date(at(20, 22)).toISOString());
  assert.equal(pauseState(s, run, at(21, 9)).paused, true, 'and paused again when the window after it ends');
});

test('w1532: a person\'s key or click pauses a running machine until 90 minutes without one; more input keeps it paused', () => {
  const s = DEFAULT_PAUSE_SETTINGS;
  let mem: PauseMemory = personInput({}, at(19, 14));
  const p = pauseState(s, mem, at(19, 14, 0, 1));
  assert.deepEqual([p.paused, p.reason], [true, 'activity']);
  assert.match(p.detail, /someone is using this PC: work resumes 90 min after the last key or click \(at 15:30/);
  mem = personInput(mem, at(19, 15));
  assert.equal(pauseState(s, mem, at(19, 16)).paused, true, 'input at 15:00 moves it to 16:30');
  assert.equal(pauseState(s, mem, at(19, 16, 29, 59)).paused, true);
  assert.equal(pauseState(s, mem, at(19, 16, 30)).paused, false, '90 minutes after the last input it runs again by itself');
  assert.equal(nextChangeAt(s, mem, at(19, 16)), at(19, 16, 30));
  assert.equal(pauseState({ ...s, activity: { enabled: false, idleMinutes: 90 } }, mem, at(19, 15, 1)).paused, false, 'the watch turned off: input does not pause');
});

test('w1532: a tray unpause ends a person\'s pause and ignores input for 30 seconds, then input pauses again', () => {
  const s = DEFAULT_PAUSE_SETTINGS;
  let mem = personInput({}, at(19, 14));
  mem = trayCommand(mem, false, at(19, 14, 5));
  assert.equal(pauseState(s, mem, at(19, 14, 5)).paused, false);
  mem = personInput(mem, at(19, 14, 5, 10));
  mem = personInput(mem, at(19, 14, 5, SUPPRESS_SECONDS - 1));
  assert.equal(pauseState(s, mem, at(19, 14, 5, SUPPRESS_SECONDS - 1)).paused, false, 'input inside the 30 seconds is ignored');
  mem = personInput(mem, at(19, 14, 5, SUPPRESS_SECONDS));
  const p = pauseState(s, mem, at(19, 14, 5, SUPPRESS_SECONDS));
  assert.deepEqual([p.paused, p.reason], [true, 'activity'], 'at 30 seconds a click counts again');
});

test('w1532: a person at the machine holds it paused across a window start; the tray pause beats a person', () => {
  const s = night;
  const mem = personInput({}, at(19, 21, 30));
  assert.equal(pauseState(s, mem, at(19, 21, 31)).reason, 'schedule', 'outside the window the schedule is the reason');
  const p = pauseState(s, mem, at(19, 22, 10));
  assert.deepEqual([p.paused, p.reason], [true, 'activity'], 'the window started while someone was there');
  assert.equal(pauseState(s, mem, at(19, 23)).paused, false, 'at 23:00, 90 minutes after the last input, the window runs');
  const both = trayCommand(personInput({}, at(19, 23)), true, at(19, 23, 1));
  assert.equal(pauseState(s, both, at(19, 23, 2)).reason, 'manual');
});

test('w1532: settings from a file or the tray are checked field by field', () => {
  const c = cleanSettings({ schedule: { enabled: true, start: '7:00', end: '18:30', days: [1, 1, 9, 'x', 3] }, activity: { enabled: false, idleMinutes: 0 } });
  assert.deepEqual(c, { schedule: { enabled: true, start: '22:00', end: '18:30', days: [1, 3] }, activity: { enabled: false, idleMinutes: 90 } });
  assert.deepEqual(cleanSettings(undefined), DEFAULT_PAUSE_SETTINGS);
  assert.deepEqual(cleanSettings('junk'), DEFAULT_PAUSE_SETTINGS);
});

test('w1532: the tray menu says why and what comes next in short lines', () => {
  const now = at(19, 14, 10);
  const s = night;
  const act = trayView(s, pauseState(s, personInput({}, at(19, 22, 30)), at(19, 22, 31)), at(19, 22, 31));
  assert.deepEqual(act, { why: 'Someone is using this PC', next: 'Work resumes at Tue 00:00, after 90 minutes with no key or click', tip: 'someone is using this PC', schedule: '22:00 to 08:00, every day' });
  assert.equal(trayView(s, pauseState(s, {}, at(20, 23, 0)), at(20, 23, 0)).next, 'Work pauses at Wed 08:00, or when someone uses this PC');
  assert.deepEqual(trayView(s, pauseState(s, {}, now), now), { why: 'Outside the work schedule', next: 'Work starts at 22:00', tip: 'outside the schedule', schedule: '22:00 to 08:00, every day' });
  const manual = trayView(DEFAULT_PAUSE_SETTINGS, pauseState(DEFAULT_PAUSE_SETTINGS, trayCommand({}, true, at(19, 14, 2)), now), now);
  assert.deepEqual(manual, { why: 'Paused from the tray at 14:02', next: 'Until you unpause it here', tip: 'paused from the tray', schedule: 'none' });
  assert.deepEqual(trayView(DEFAULT_PAUSE_SETTINGS, pauseState(DEFAULT_PAUSE_SETTINGS, {}, now), now), { why: 'No schedule: work runs any time', next: 'A key or click on this PC pauses work', schedule: 'none' });
});
