import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DISMISSED_PER_USER, dismissedUserKey, undismissed, unitEventKey, withDismissed } from '../shared/dismissals.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { UnitWatchdogMonitor } from './unitWatchdog.ts';
import type { UnitWatchdogEvent } from '../shared/types.ts';

const ev = (o: Partial<UnitWatchdogEvent> = {}): UnitWatchdogEvent => ({ at: '2026-10-09T05:48:10Z', unit: 'fff-ops.socket', action: 'restart', why: 'inactive (dead)', attempt: 1, ok: true, ...o });

test('a closed restart stays hidden; a restart at another time or of another unit is new (w751)', () => {
  const first = ev();
  const closed = [unitEventKey(first)];
  assert.deepEqual(undismissed([first], closed), []);
  const later = ev({ at: '2026-10-09T09:00:00Z' });
  const other = ev({ unit: 'fff-portal.service' });
  assert.deepEqual(undismissed([first, later, other], closed), [later, other]);
});

test('closing a banner that lists several restarts hides all of them, and only a later one brings it back', () => {
  const a = ev({ at: '2026-10-09T05:00:00Z' });
  const b = ev({ at: '2026-10-09T05:10:00Z', unit: 'fff-health.service' });
  const c = ev({ at: '2026-10-09T05:20:00Z' });
  const map = withDismissed(undefined, 'lothsahn', [a, b, c].map(unitEventKey));
  assert.deepEqual(undismissed([a, b, c], map.lothsahn), []);
  const d = ev({ at: '2026-10-09T06:00:00Z' });
  assert.deepEqual(undismissed([a, b, c, d], map.lothsahn), [d]);
});

test('each person closes for themselves: Ben closing a restart does not hide it for lothsahn', () => {
  const e = ev();
  const map = withDismissed(withDismissed(undefined, 'ben', [unitEventKey(e)]), 'lothsahn', [unitEventKey(ev({ at: '2026-10-08T01:00:00Z' }))]);
  assert.deepEqual(undismissed([e], map.ben), []);
  assert.deepEqual(undismissed([e], map.lothsahn), [e]);
  assert.deepEqual(undismissed([e], map.nobody), [e]);
});

test('a user id is kept in lower case, whatever the login\'s spelling', () => {
  const map = withDismissed(undefined, 'Lothsahn', ['k1']);
  assert.deepEqual(map, { lothsahn: ['k1'] });
  assert.equal(dismissedUserKey('LOTHSAHN'), 'lothsahn');
  assert.deepEqual(withDismissed(map, 'LOTHSAHN', ['k2']), { lothsahn: ['k1', 'k2'] });
});

test('closing the same event twice adds it once; the list is capped, oldest first, and the other people\'s lists are not touched', () => {
  let map = withDismissed({ ben: ['x'] }, 'lothsahn', ['a', 'b']);
  map = withDismissed(map, 'lothsahn', ['b', 'c']);
  assert.deepEqual(map, { ben: ['x'], lothsahn: ['a', 'b', 'c'] });
  const many = Array.from({ length: MAX_DISMISSED_PER_USER + 30 }, (_, i) => `k${i}`);
  const capped = withDismissed(map, 'lothsahn', many).lothsahn;
  assert.equal(capped.length, MAX_DISMISSED_PER_USER);
  assert.equal(capped.at(-1), many.at(-1));
  assert.ok(!capped.includes('a'));
});

test('the monitor reports an event once under the same key the dismissals use (a closed banner and a reported event are one identity)', () => {
  const e = ev();
  const reports: string[] = [];
  const file = (events: UnitWatchdogEvent[]) => JSON.stringify({ schema: 1, updatedAt: '2026-10-09T05:48:30Z', host: 'fff', units: [], events });
  let text = file([]);
  const m = new UnitWatchdogMonitor({ read: () => text, now: () => Date.parse('2026-10-09T05:49:00Z'), changed: () => undefined, report: (t) => reports.push(t), log: () => undefined });
  m.tick();
  text = file([e]);
  m.tick();
  m.tick();
  assert.equal(reports.length, 1);
  assert.equal(m.status?.events.map(unitEventKey)[0], unitEventKey(e));
});

test('what a person closed survives a portal restart: the store saves it and the next one reads it back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-dismiss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const e = ev();
  const a = new Store(dir);
  a.putSettings({ dismissedEvents: withDismissed(a.settings.dismissedEvents, 'lothsahn', [unitEventKey(e)]) });
  a.flush();
  const b = new Store(dir);
  assert.deepEqual(undismissed([e], b.settings.dismissedEvents?.lothsahn), []);
  assert.deepEqual(undismissed([e], b.settings.dismissedEvents?.ben), [e]);
});
