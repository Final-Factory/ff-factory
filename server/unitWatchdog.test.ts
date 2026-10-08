import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnitWatchdogMonitor, UNIT_WATCHDOG_SILENT_AFTER_MS, describeEvent, fileUnitWatchdog, parseUnitWatchdog, recentRestarts } from './unitWatchdog.ts';
import type { UnitWatchdog } from '../shared/types.ts';

const AT = Date.parse('2026-10-08T15:33:30Z');
const UPDATED = '2026-10-08T15:33:02Z';

const unit = (o: Record<string, unknown> = {}) => ({ unit: 'fff-ops.socket', active: 'active', enabled: 'enabled', state: 'ok', attempts: 0, nextTryAt: '', ...o });
const event = (o: Record<string, unknown> = {}) => ({ at: '2026-10-08T15:30:00Z', unit: 'fff-ops.socket', action: 'restart', why: 'inactive (dead) while it should be active', attempt: 1, ok: true, ...o });
const file = (o: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, updatedAt: UPDATED, host: 'fff', units: [unit()], events: [], ...o });

test('a healthy file: one unit, no events, not silent', () => {
  const u = parseUnitWatchdog(file(), AT)!;
  assert.equal(u.host, 'fff');
  assert.equal(u.updatedAt, UPDATED);
  assert.deepEqual(u.units, [{ unit: 'fff-ops.socket', active: 'active', enabled: 'enabled', state: 'ok', attempts: 0, nextTryAt: '' }]);
  assert.deepEqual(u.events, []);
  assert.equal(u.silentMinutes, undefined);
});

test('a file that is not the watchdog\'s, or half written, shows nothing', () => {
  for (const text of ['', '{', 'null', '[]', '5', '{"schema":2,"updatedAt":"2026-10-08T15:33:02Z"}', '{"schema":1}', '{"schema":1,"updatedAt":5}']) {
    assert.equal(parseUnitWatchdog(text, AT), undefined, text);
  }
});

test('missing lists are empty, and unknown fields are ignored', () => {
  const u = parseUnitWatchdog(JSON.stringify({ schema: 1, updatedAt: UPDATED, extra: { a: 1 } }), AT)!;
  assert.deepEqual(u.units, []);
  assert.deepEqual(u.events, []);
  assert.ok(!('extra' in u));
});

test('odd text and numbers are made safe; unknown states and actions are handled', () => {
  const u = parseUnitWatchdog(
    file({
      host: 'a\nb  ' + 'x'.repeat(2000),
      units: [unit({ state: 'exploding', attempts: -4 }), unit({ unit: 'b', attempts: 1e12, nextTryAt: 7, active: null }), { state: 'ok' }, 5, null],
      events: [event({ why: 'a\n\nb  ' + 'x'.repeat(2000), attempt: 'many', ok: 'yes' }), event({ action: 'reboot' }), event({ unit: '' }), event({ at: '' }), 'x'],
    }),
    AT,
  )!;
  assert.equal(u.host.length, 700);
  assert.ok(!u.host.includes('\n'));
  assert.equal(u.units.length, 2);
  assert.equal(u.units[0].state, 'unknown');
  assert.equal(u.units[0].attempts, 0);
  assert.equal(u.units[1].attempts, 1_000_000);
  assert.equal(u.units[1].nextTryAt, '');
  assert.equal(u.units[1].active, '');
  assert.equal(u.events.length, 1);
  assert.equal(u.events[0].why.length, 700);
  assert.equal(u.events[0].attempt, 0);
  assert.equal(u.events[0].ok, false);
});

test('only the newest 50 events are kept', () => {
  const events = Array.from({ length: 80 }, (_, i) => event({ at: `2026-10-08T15:${String(i % 60).padStart(2, '0')}:00Z`, attempt: i }));
  const u = parseUnitWatchdog(file({ events }), AT)!;
  assert.equal(u.events.length, 50);
  assert.equal(u.events[0].attempt, 30);
  assert.equal(u.events[49].attempt, 79);
});

test('a silent watchdog: its units are not shown as current, its events stay', () => {
  const text = file({ units: [unit({ state: 'gave-up', attempts: 5 })], events: [event()] });
  assert.equal(parseUnitWatchdog(text, Date.parse(UPDATED) + UNIT_WATCHDOG_SILENT_AFTER_MS)!.silentMinutes, undefined);
  const u = parseUnitWatchdog(text, Date.parse(UPDATED) + UNIT_WATCHDOG_SILENT_AFTER_MS + 3 * 60_000)!;
  assert.equal(u.silentMinutes, 13);
  assert.deepEqual(u.units, []);
  assert.equal(u.events.length, 1);
});

test('recent restarts: the last 24 hours, restarts and enables, not a give-up', () => {
  const evs = [
    event({ at: '2026-10-07T15:00:00Z' }), // 24.5 h old
    event({ at: '2026-10-07T16:00:00Z' }),
    event({ at: '2026-10-08T10:00:00Z', action: 'enable' }),
    event({ at: '2026-10-08T11:00:00Z', action: 'gave-up' }),
    event({ at: 'not a time' }),
  ];
  const u = parseUnitWatchdog(file({ events: evs }), AT)!;
  assert.deepEqual(recentRestarts(u.events, AT).map((e) => e.action), ['restart', 'enable']);
});

test('describeEvent says what, which unit, when and why', () => {
  const u = parseUnitWatchdog(file({ events: [event({ ok: false, attempt: 2 })] }), AT)!;
  assert.equal(describeEvent(u.events[0]), 'The VM watchdog restarted fff-ops.socket at 2026-10-08 15:30Z (attempt 2, failed): inactive (dead) while it should be active.');
});

function monitor(files: { text?: string }, clock = { t: AT }) {
  const reports: [string, string][] = [];
  const changes: (UnitWatchdog | undefined)[] = [];
  const m = new UnitWatchdogMonitor({
    read: () => files.text,
    now: () => clock.t,
    changed: (u) => changes.push(u),
    report: (t, b) => reports.push([t, b]),
    log: () => undefined,
  });
  return { m, reports, changes, clock };
}

test('the monitor: no file, nothing to show', () => {
  const { m, reports, changes } = monitor({});
  m.tick();
  assert.equal(m.status, undefined);
  assert.deepEqual(m.statusLines(), []);
  assert.deepEqual(changes, []);
  assert.deepEqual(reports, []);
});

test('the monitor: a healthy file shows nothing and says nothing', () => {
  const { m, reports, changes } = monitor({ text: file() });
  m.tick();
  m.tick();
  assert.deepEqual(changes, []);
  assert.deepEqual(reports, []);
  assert.deepEqual(m.statusLines(), []);
});

test('the monitor: the first read notes existing events and gave-up units without reporting, but shows them', () => {
  const f = { text: file({ units: [unit({ state: 'gave-up', attempts: 5, active: 'failed' })], events: [event(), event({ at: '2026-10-08T15:31:00Z', action: 'gave-up', attempt: 5, ok: false })] }) };
  const { m, reports, changes } = monitor(f);
  m.tick();
  m.tick();
  assert.deepEqual(reports, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.units[0].state, 'gave-up');
  assert.equal(changes[0]!.events.length, 2);
});

test('the monitor: a new restart is reported once, and shown for 24 hours', () => {
  const f: { text?: string } = { text: file({ events: [event({ at: '2026-10-08T15:00:00Z' })] }) };
  const { m, reports, changes, clock } = monitor(f);
  m.tick();
  assert.equal(changes.length, 1); // the old event is shown
  f.text = file({ events: [event({ at: '2026-10-08T15:00:00Z' }), event({ at: '2026-10-08T15:32:00Z', unit: 'fff-health.timer', why: 'failed' })] });
  m.tick();
  m.tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], 'The VM watchdog restarted fff-health.timer');
  assert.match(reports[0][1], /^The VM watchdog restarted fff-health\.timer at 2026-10-08 15:32Z \(attempt 1\): failed\.$/);
  assert.equal(changes.length, 2);
  assert.equal(changes[1]!.events.length, 2);
  // The same time, another action on the same unit, is another event.
  f.text = file({ events: [event({ at: '2026-10-08T15:32:00Z', unit: 'fff-health.timer', why: 'failed' }), event({ at: '2026-10-08T15:32:00Z', unit: 'fff-health.timer', action: 'enable', why: 'disabled' })] });
  m.tick();
  assert.equal(reports.length, 2);
  assert.equal(reports[1][0], 'The VM watchdog restarted fff-health.timer');
  // A day later nothing is left to show.
  clock.t = AT + 25 * 3_600_000;
  f.text = file({ updatedAt: new Date(clock.t - 5_000).toISOString(), events: [event({ at: '2026-10-08T15:32:00Z' })] });
  m.tick();
  assert.equal(changes.at(-1), undefined);
});

test('the monitor: a half-written file does not make old events look new', () => {
  const f: { text?: string } = { text: file({ events: [event()] }) };
  const { m, reports } = monitor(f);
  m.tick();
  f.text = '{"schema":1,"upda';
  m.tick();
  f.text = file({ events: [event()] });
  m.tick();
  assert.deepEqual(reports, []);
});

test('the monitor: a unit that turns gave-up is reported once, with its give-up event not twice', () => {
  const f: { text?: string } = { text: file() };
  const { m, reports, changes } = monitor(f);
  m.tick();
  f.text = file({ units: [unit({ state: 'gave-up', attempts: 5, active: 'failed' })], events: [event({ at: '2026-10-08T15:33:00Z', action: 'gave-up', attempt: 5, ok: false, why: 'failed 5 times' })] });
  m.tick();
  m.tick();
  assert.equal(reports.length, 1);
  assert.equal(reports[0][0], 'The VM watchdog gave up restarting fff-ops.socket');
  assert.match(reports[0][1], /sudo fffctl status/);
  assert.equal(changes.at(-1)!.units[0].state, 'gave-up');
  // It recovers and gives up again later: reported again.
  f.text = file();
  m.tick();
  f.text = file({ units: [unit({ state: 'gave-up', attempts: 5, active: 'failed' })] });
  m.tick();
  assert.equal(reports.length, 2);
  assert.match(reports[1][1], /restarted 5 time\(s\) without staying up/);
});

test('the monitor: a gave-up state with no event in the file is still reported', () => {
  const f: { text?: string } = { text: file() };
  const { m, reports } = monitor(f);
  m.tick();
  f.text = file({ units: [unit({ state: 'gave-up', attempts: 3 })] });
  m.tick();
  assert.equal(reports.length, 1);
});

test('the monitor: backoff, paused and held units; only held and ok are quiet', () => {
  const f = {
    text: file({
      units: [unit({ unit: 'a', state: 'backoff', active: 'inactive', attempts: 2, nextTryAt: '2026-10-08T15:34:00Z' }), unit({ unit: 'b', state: 'paused', active: 'inactive' }), unit({ unit: 'c', state: 'held', active: 'inactive' }), unit({ unit: 'd' })],
    }),
  };
  const { m, changes } = monitor(f);
  m.tick();
  assert.deepEqual(changes[0]!.units.map((u) => u.unit), ['a', 'b']);
  const lines = m.statusLines();
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Unit a is inactive; the VM watchdog is backing off after 2 attempt(s), next try 2026-10-08 15:34Z.');
  assert.match(lines[1], /^Unit b is inactive; .*switched off on purpose/);
});

test('the monitor: a held unit alone shows nothing', () => {
  const { m, changes } = monitor({ text: file({ units: [unit({ state: 'held', active: 'inactive' })] }) });
  m.tick();
  assert.deepEqual(changes, []);
  assert.deepEqual(m.statusLines(), []);
});

test('the monitor: a silent watchdog is shown once, and its units are not', () => {
  const f = { text: file({ units: [unit({ state: 'gave-up', attempts: 5 })] }) };
  const { m, reports, changes, clock } = monitor(f);
  clock.t = Date.parse(UPDATED) + 20 * 60_000;
  m.tick();
  m.tick();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.silentMinutes, 20);
  assert.deepEqual(changes[0]!.units, []);
  assert.deepEqual(reports, []);
  const lines = m.statusLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARNING: the VM's unit watchdog \(fff-health on fff\) has been silent for 20 min/);
  // It speaks again: the silence goes away.
  clock.t += 60_000;
  f.text = file({ updatedAt: new Date(clock.t - 1000).toISOString() });
  m.tick();
  assert.equal(changes.at(-1), undefined);
});

test('statusLines: a give-up and the restarts of the last 24 hours, with unit, time and why', () => {
  const f = {
    text: file({
      units: [unit({ state: 'gave-up', attempts: 5, active: 'failed' })],
      events: [event({ at: '2026-10-06T10:00:00Z' }), event({ at: '2026-10-08T09:00:00Z', unit: 'fff-health.timer', why: 'failed' }), event({ at: '2026-10-08T15:30:00Z', ok: false })],
    }),
  };
  const { m } = monitor(f);
  m.tick();
  assert.deepEqual(m.statusLines(), [
    'PROBLEM: the VM watchdog gave up restarting fff-ops.socket (failed) after 5 attempt(s). A person must act: sudo fffctl status on the VM.',
    'The VM watchdog restarted 2 time(s) in the last 24 h:',
    '  - fff-health.timer at 2026-10-08 09:00Z: failed',
    '  - fff-ops.socket at 2026-10-08 15:30Z (failed): inactive (dead) while it should be active',
  ]);
});

test('fileUnitWatchdog: reads the file, and a missing file is undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fff-uw-'));
  try {
    const p = path.join(dir, 'unit-watchdog.json');
    assert.equal(fileUnitWatchdog(p)(), undefined);
    fs.writeFileSync(p, file());
    assert.equal(parseUnitWatchdog(fileUnitWatchdog(p)()!, AT)!.host, 'fff');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
