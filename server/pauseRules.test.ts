import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAUSE_SETTINGS, IDLE_MINUTES, SUPPRESS_SECONDS, cleanSettings, nextChangeAt, pauseState, personInput, scheduleAt, scheduleText, settingsChanged, trayCommand, trayView, type PauseMemory } from '../machine/pauseRules.ts';
import type { MachinePauseSettings } from '../shared/types.ts';

// w1532 (lothsahn, 2026-10-19): "It'll unpause when the schedule begins and pause when the schedule ends ... If someone clicks
// the mouse or types a key, it should pause and only unpause after 90 minutes of inactivity. Unpausing via the taskbar should
// prevent any such pausing for 30 seconds after unpausing in the taskbar."
// Times are this computer's local time (the schedule is), built with the local Date constructor so any TZ runs them.

const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 9, d, h, m, s).getTime(); // October 2026; the 19th is a Monday
const MIN = 60_000;
// The activity pause on, as a machine that turned it on has it (off by default since w1574).
const watching: MachinePauseSettings = { ...DEFAULT_PAUSE_SETTINGS, activity: { enabled: true, idleMinutes: IDLE_MINUTES } };
const night: MachinePauseSettings = { ...watching, schedule: { enabled: true, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] } };
const noActivity: MachinePauseSettings = { ...night, activity: { enabled: false, idleMinutes: IDLE_MINUTES } };

test('w1532: no schedule and nobody at the machine: it runs; the tray pause holds until the tray unpauses', () => {
  const s = watching;
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
  const s = watching;
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
  const s = watching;
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
  assert.deepEqual(act, { why: 'Someone is using this PC', next: 'Resumes at Tue 00:00 after 90 min idle', tip: 'someone is using this PC', schedule: '22:00 to 08:00, every day' });
  assert.equal(trayView(s, pauseState(s, {}, at(20, 23, 0)), at(20, 23, 0)).next, 'Work pauses at Wed 08:00, or when someone uses this PC');
  assert.deepEqual(trayView(s, pauseState(s, {}, now), now), { why: 'Outside the work schedule', next: 'Work starts at 22:00', tip: 'outside the schedule', schedule: '22:00 to 08:00, every day' });
  const manual = trayView(DEFAULT_PAUSE_SETTINGS, pauseState(DEFAULT_PAUSE_SETTINGS, trayCommand({}, true, at(19, 14, 2)), now), now);
  assert.deepEqual(manual, { why: 'Paused from the tray at 14:02', next: 'Until you unpause it here', tip: 'paused from the tray', schedule: 'none' });
  assert.deepEqual(trayView(watching, pauseState(watching, {}, now), now), { why: 'No schedule: work runs any time', next: 'A key or click on this PC pauses work', schedule: 'none' });
  assert.deepEqual(trayView(DEFAULT_PAUSE_SETTINGS, pauseState(DEFAULT_PAUSE_SETTINGS, {}, now), now), { why: 'No schedule: work runs any time', next: undefined, schedule: 'none' }, 'off by default (w1574): no line about input');
});

test('w1532: turning the schedule off never brings back a tray pause the schedule had already replaced (seen in the beast demo)', () => {
  const sched: MachinePauseSettings = { ...noActivity, schedule: { enabled: true, start: '22:58', end: '22:59', days: [0, 1, 2, 3, 4, 5, 6] } };
  const off: MachinePauseSettings = { ...sched, schedule: { ...sched.schedule, enabled: false } };
  const mem = trayCommand({}, true, at(19, 22, 56));
  assert.equal(pauseState(sched, mem, at(19, 22, 59, 1)).reason, 'schedule', 'the window ended at 22:59; the schedule holds');
  const kept = settingsChanged(sched, mem, at(19, 22, 59, 1));
  assert.equal(kept.manual, undefined, 'the 22:56 pause was overtaken by the 22:58 edge: dropped');
  assert.equal(pauseState(off, kept, at(19, 22, 59, 2)).paused, false, 'no schedule now: it runs');
  const fresh = trayCommand({}, true, at(19, 23, 30));
  assert.deepEqual(settingsChanged(sched, fresh, at(19, 23, 31)), fresh, 'a pause after the last edge is the latest word: kept');
  assert.equal(pauseState(off, fresh, at(19, 23, 32)).reason, 'manual');
});

test('w1532: the daemon keeps a pause, the schedule and a person\'s 90 minutes in pause.json across a restart, and tells each change once', async (t) => {
  const { PauseKeeper } = await import('../machine/pause.ts');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pause-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pause.json');
  let now = at(19, 14);
  const told: string[] = [];
  const keeper = () => new PauseKeeper({ file, now: () => now, log: () => {}, changed: (p) => void told.push(`${p.paused ? 'paused' : 'running'}:${p.reason ?? '-'}`) });
  const a = keeper();
  a.command(true);
  a.setSettings({ schedule: { enabled: true, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] }, activity: { enabled: true, idleMinutes: 90 } });
  a.stop();
  assert.deepEqual(told, ['paused:manual', 'paused:manual'], 'the pause, then the settings change (sent again so the portal has the settings)');
  now = at(19, 15);
  const b = keeper();
  assert.deepEqual([b.current().paused, b.current().reason], [true, 'manual'], 'a restarted daemon is still paused');
  assert.equal(b.currentSettings().schedule.start, '22:00');
  b.command(false);
  now = at(19, 15, 0, 40);
  b.input('key', now);
  b.stop();
  const c = keeper();
  assert.deepEqual([c.current().paused, c.current().reason], [true, 'activity'], 'a person\'s input before the restart still holds it');
  c.stop();
});

// w1574, lothsahn: "if the mouse and keyboard was being used the worker would go to sleep. That needs to be configurable. We
// want it off on all of the workers currently so that they continue to work even if a user is at the station."
test('w1574: the activity pause is off by default and on every machine from before; a key or click then never pauses', async (t) => {
  const { PauseKeeper } = await import('../machine/pause.ts');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pause-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pause.json');
  let now = at(19, 14);
  const logs: string[] = [];
  const keeper = () => new PauseKeeper({ file, now: () => now, log: (l) => void logs.push(l), changed: () => {} });

  // A new machine: no pause.json, off.
  const fresh = keeper();
  assert.equal(fresh.currentSettings().activity.enabled, false);
  fresh.input('click', now);
  assert.equal(fresh.current().paused, false, 'a click on a new machine does not pause it');
  fresh.stop();

  // lothdesktop's case: w1532's pause.json with the activity pause on and a person's input a minute ago, paused for it.
  fs.writeFileSync(file, JSON.stringify({ settings: { ...DEFAULT_PAUSE_SETTINGS, activity: { enabled: true, idleMinutes: 90 } }, memory: { inputAt: now - MIN } }));
  const old = keeper();
  assert.equal(old.current().paused, false, 'loaded off, so not paused for the input before the update');
  old.start();
  assert.ok(logs.some((l) => l.includes('the activity pause is now off on this machine')), logs.join('\n'));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([saved.v, saved.settings.activity.enabled, saved.memory.inputAt], [2, false, undefined], 'saved off, the old input dropped');
  logs.length = 0;
  now += MIN;
  old.input('key', now);
  now += 2 * MIN;
  old.input('click', now);
  assert.equal(old.current().paused, false, 'keys and clicks while it is off never pause');
  assert.deepEqual(logs.filter((l) => l.includes('ignored: the activity pause is off')).length, 2, logs.join('\n'));
  old.stop();

  // Saved off (v 2) stays off; a machine that turned it on keeps it on across a restart.
  const again = keeper();
  assert.equal(again.currentSettings().activity.enabled, false);
  again.setActivity({ enabled: true, idleMinutes: 30 });
  assert.equal(again.current().paused, false, 'turning it on does not pause for input seen while it was off');
  now += MIN;
  again.input('key', now);
  assert.deepEqual([again.current().paused, again.current().reason], [true, 'activity']);
  assert.ok(again.current().detail.includes('30 min'), again.current().detail);
  again.stop();
  const on = keeper();
  assert.deepEqual(on.currentSettings().activity, { enabled: true, idleMinutes: 30 }, 'on stays on across a restart');
  on.setActivity({ enabled: false, idleMinutes: 30 });
  assert.equal(on.current().paused, false, 'turned off while paused for input: work goes on at once');
  on.stop();
});

test('w1574: the tray tells the daemon only an activity change to pass to the portal; the schedule stays on the machine', async (t) => {
  const { PauseKeeper } = await import('../machine/pause.ts');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pause-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const k = new PauseKeeper({ file: path.join(dir, 'pause.json'), now: () => at(19, 14), log: () => {}, changed: () => {} });
  const s = k.currentSettings();
  assert.equal(k.setSettings({ ...s, schedule: { ...s.schedule, enabled: true } }), undefined, 'a schedule change is the machine\'s own');
  assert.deepEqual(k.setSettings({ ...k.currentSettings(), activity: { enabled: true, idleMinutes: 90 } }), { enabled: true, idleMinutes: 90 });
  assert.equal(k.setSettings({ ...k.currentSettings() }), undefined, 'no change, nothing to tell');
  k.stop();
});
