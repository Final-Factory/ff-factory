import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_LINE_TEXT, describeItem } from './work.ts';
import { describeTimers } from './agents.ts';
import type { WorkItem } from '../shared/types.ts';
import type { TimerView } from './timers.ts';

/** w1866: what a person's orchestrator reads again on every call is kept short; the full text stays one call away. */

const long = (c: string) => c.repeat(400);
const item = (): WorkItem =>
  ({
    id: 'w7',
    title: 'Fix the belt',
    status: 'active',
    priority: 'normal',
    requesters: [{ userId: 'lothsahn', displayName: 'Lothsahn' }],
    requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' },
    createdAt: '2026-10-23T10:00:00.000Z',
    updatedAt: '2026-10-23T10:00:00.000Z',
    sessionIds: ['s-old', 's-now'],
    outcome: long('o'),
    liveView: { machine: 'beast' },
    log: [],
    overlaps: [],
    brief: 'b',
  }) as unknown as WorkItem;
const worker = (id: string) => (id === 's-old' ? `${id} (gone)` : `${id} (running)`);
const now = { state: 'working', why: long('y') } as const;

test('w1866: a person\'s list line leaves out cost, placement and gone workers, and cuts its free text shorter', () => {
  const full = describeItem(item(), worker, now, ' Cost so far: $5.31.');
  const short = describeItem(item(), worker, now, '', '', true);
  assert.match(full, /workers: s-old \(gone\), s-now \(running\)\./);
  assert.match(short, /workers: s-now \(running\), 1 gone\./);
  assert.match(full, /Cost so far/);
  assert.match(full, /place it by "Next Live view work"/);
  assert.doesNotMatch(short, /Next Live view work|Cost so far/);
  assert.match(full, /`?y{199}…/);
  assert.match(short, new RegExp(`y{${LIST_LINE_TEXT.short - 1}}…\\)`));
  assert.doesNotMatch(short, new RegExp(`y{${LIST_LINE_TEXT.short}}`));
  assert.match(short, new RegExp(`Latest: o{${LIST_LINE_TEXT.short - 1}}…$`));
  assert.ok(short.length < full.length * 0.75, `${short.length} against ${full.length}`);
});

test('w1866: list_timers shows an ended timer for a day, then only counts it', () => {
  const at = Date.parse('2026-10-23T12:00:00Z');
  const timer = (id: string, endedAt?: string): TimerView =>
    ({ id, title: id, note: long('n'), state: endedAt ? 'ended' : 'active', scheduleText: 'every 240 min', fires: 1, ...(endedAt ? { endedAt, endReason: 'max fires' } : { nextFireAt: '2026-10-23T14:00:00Z' }) }) as unknown as TimerView;
  const text = describeTimers([timer('t-live'), timer('t-new', '2026-10-23T02:00:00Z'), timer('t-old', '2026-10-21T02:00:00Z'), timer('t-older', '2026-10-01T02:00:00Z')], 3, at);
  assert.match(text, /t-live/);
  assert.match(text, /t-new/);
  assert.doesNotMatch(text, /t-old/);
  assert.match(text, /2 timer\(s\) that ended more than a day ago are not shown\./);
  assert.doesNotMatch(describeTimers([timer('t-live')], 0, at), /not shown/);
});
