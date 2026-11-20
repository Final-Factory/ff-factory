import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchHistoryFiles, benchHours, capBenchRows, readBenchHours } from '../machine/benchHours.ts';
import { BENCH_HOURS_MAX_REQUESTS, BENCH_HOURS_MAX_ROWS, sanitizeBenchRows, type BenchHourRow } from '../shared/benchHours.ts';
import { BENCH_HOURS_FILE, BenchHoursStore } from './benchHoursStore.ts';

/**
 * w1996: what a machine's exclusive bench tickets cost it, per UTC hour, from the bench queue's history.jsonl (written by
 * the game repo's scripts/bench/bench_queue.py), and the portal's keeping of it.
 */

const T = (hhmm: string, day = '2026-10-24') => Date.parse(`${day}T${hhmm}:00Z`);
const NOW = T('07:10');

/** One history line as bench_queue.py writes it. */
function ev(at: string, name: string, ticket: string, mode: 'shared' | 'exclusive', extra: Record<string, unknown> = {}, day?: string): string {
  const ms = T(at, day);
  return JSON.stringify({ at: new Date(ms).toISOString().replace('.000Z', 'Z'), ts: ms / 1000, ev: name, ticket, mode, what: `work ${ticket}`, session: '', sandbox: '', cwd: 'x', requests: [], priority: 'normal', ahead: [], ...extra });
}

/**
 * Hour 03: X3 (requests w1, w2) holds 10 minutes.
 * Hour 05-06: X1 (session A, slot1, w1908) holds 05:50 to 06:10, across two hours; behind it S1 (slot2) and S5 (slot4, never
 * granted, gives up at 06:09) wait; S2 is slot2 again (one sandbox, counted once); S3 is X1's own session (counted nowhere
 * but in the shared-granted union); S4 (no sandbox, named by `what`) ended before the hold began.
 * Hour 06-07: X2 (slot5, no request) is still held at NOW, 07:10; S6 (slot6) still waits behind it.
 */
const HISTORY = [
  ev('03:00', 'take', 'X3', 'exclusive', { session: 'G', sandbox: 'slot7', requests: ['w1', 'w2'] }),
  ev('03:10', 'grant', 'X3', 'exclusive', { session: 'G', sandbox: 'slot7', requests: ['w1', 'w2'], waited_s: 600 }),
  ev('03:20', 'release', 'X3', 'exclusive', { session: 'G', sandbox: 'slot7', requests: ['w1', 'w2'], held_s: 600 }),
  'not json at all',
  ev('05:20', 'take', 'S4', 'shared', { session: 'C', what: 'editor compile/tests slot3' }),
  ev('05:20', 'grant', 'S4', 'shared', { session: 'C', what: 'editor compile/tests slot3', waited_s: 0 }),
  ev('05:40', 'take', 'X1', 'exclusive', { session: 'A', sandbox: 'slot1', requests: ['w1908'] }),
  ev('05:45', 'keep', 'X1', 'exclusive', { session: 'A' }),
  ev('05:45', 'take', 'S1', 'shared', { session: 'B', sandbox: 'slot2' }),
  ev('05:49', 'release', 'S4', 'shared', { session: 'C', what: 'editor compile/tests slot3', held_s: 1740 }),
  ev('05:50', 'grant', 'X1', 'exclusive', { session: 'A', sandbox: 'slot1', requests: ['w1908'], waited_s: 600 }),
  ev('05:55', 'take', 'S3', 'shared', { session: 'A', sandbox: 'slot1' }),
  ev('06:00', 'take', 'S2', 'shared', { session: 'B', sandbox: 'slot2' }),
  ev('06:05', 'take', 'S5', 'shared', { session: 'D', sandbox: 'slot4' }),
  ev('06:09', 'gone', 'S5', 'shared', { session: 'D', sandbox: 'slot4' }),
  ev('06:10', 'release', 'X1', 'exclusive', { session: 'A', sandbox: 'slot1', requests: ['w1908'], held_s: 1200 }),
  ev('06:12', 'grant', 'S2', 'shared', { session: 'B', sandbox: 'slot2' }),
  ev('06:12', 'grant', 'S3', 'shared', { session: 'A', sandbox: 'slot1' }),
  ev('06:15', 'grant', 'S1', 'shared', { session: 'B', sandbox: 'slot2' }),
  ev('06:20', 'release', 'S2', 'shared', { session: 'B', sandbox: 'slot2' }),
  ev('06:20', 'leave', 'S3', 'shared', { session: 'A', sandbox: 'slot1' }),
  ev('06:30', 'release', 'S1', 'shared', { session: 'B', sandbox: 'slot2' }),
  ev('06:40', 'take', 'X2', 'exclusive', { session: 'E', sandbox: 'slot5' }),
  ev('06:40', 'grant', 'X2', 'exclusive', { session: 'E', sandbox: 'slot5', waited_s: 0 }),
  ev('06:50', 'take', 'S6', 'shared', { session: 'F', sandbox: 'slot6' }),
];

const byHour = (rows: BenchHourRow[]) => Object.fromEntries(rows.map((r) => [r.hour.slice(11, 13), r]));

test('w1996: a hold is split across the UTC hours it spans, with its requests, holds and idle slots per hour', () => {
  const rows = benchHours(HISTORY, { sinceMs: T('00:00'), nowMs: NOW });
  assert.deepEqual(rows.map((r) => r.hour), ['2026-10-24T03:00:00Z', '2026-10-24T05:00:00Z', '2026-10-24T06:00:00Z', '2026-10-24T07:00:00Z'], 'oldest first; hour 04 had nothing');
  const h = byHour(rows);
  assert.equal(h['03'].exclusiveS, 600);
  assert.equal(h['03'].holds, 1);
  assert.deepEqual(h['03'].byRequest, { 'w1,w2': 600 }, 'requests are joined with a comma');
  assert.equal(h['03'].idleSlotS, 0);
  // X1: 05:50-06:10 is 10 minutes in each of hours 05 and 06
  assert.equal(h['05'].exclusiveS, 600);
  assert.equal(h['05'].holds, 1);
  assert.equal(h['05'].byRequest.w1908, 600);
  // slot2 (S1 and S2 are one sandbox) and slot4 were alive during X1: two other sandboxes, not S3 (X1's own session), not S4 (over before)
  assert.equal(h['05'].idleSlotS, 600 * 2);
  // hour 06: X1's last 10 minutes and X2's 20; two holds
  assert.equal(h['06'].exclusiveS, 600 + 1200);
  assert.equal(h['06'].holds, 2);
  assert.deepEqual(h['06'].byRequest, { '-': 1200, w1908: 600 }, 'no request is "-"');
  assert.equal(h['06'].idleSlotS, 600 * 2 + 1200 * 1, 'X2 idled slot6 only: S1 ended before it was granted');
  // X2 is still held: counted up to now
  assert.equal(h['07'].exclusiveS, 600);
  assert.equal(h['07'].holds, 1);
  assert.equal(h['07'].idleSlotS, 600);
});

test('w1996: shared waits behind an exclusive hold count other sessions only, within the hour, until grant or give-up', () => {
  const h = byHour(benchHours(HISTORY, { sinceMs: T('00:00'), nowMs: NOW }));
  // hour 05: S1 (taken 05:45) waits through 05:50-06:00 of X1; S2 and S5 were taken at 06:00 and 06:05
  assert.equal(h['05'].sharedWaitS, 600);
  // hour 06: S1 06:00-06:10 (600), S2 06:00-06:10 (600), S5 06:05-06:09 (240, gone without a grant); S3 is X1's own session: 0.
  // X2: S6 06:50-07:00 (600)
  assert.equal(h['06'].sharedWaitS, 600 + 600 + 240 + 600);
  assert.equal(h['07'].sharedWaitS, 600, 'S6 still waits at now');
  assert.equal(h['03'].sharedWaitS, 0);
});

test('w1996: sharedS is the union of the time any shared ticket was granted, not the sum', () => {
  const h = byHour(benchHours(HISTORY, { sinceMs: T('00:00'), nowMs: NOW }));
  assert.equal(h['05'].sharedS, 29 * 60, 'S4 05:20-05:49');
  // S2 06:12-06:20, S3 06:12-06:20 and S1 06:15-06:30 overlap: 06:12 to 06:30
  assert.equal(h['06'].sharedS, 18 * 60);
  assert.equal(h['07'].sharedS, 0);
  assert.ok(!('04' in h));
});

test('w1996: the window clips a hold, and a ticket still open at now is counted to now', () => {
  const rows = benchHours(HISTORY, { sinceMs: T('05:55'), nowMs: T('06:05') });
  const h = byHour(rows);
  assert.equal(h['05'].exclusiveS, 300, 'X1 05:55-06:00');
  assert.equal(h['06'].exclusiveS, 300, 'X1 06:00-06:05');
  assert.equal(h['03'], undefined);
  // nothing at all in a window that is empty
  assert.deepEqual(benchHours(HISTORY, { sinceMs: NOW, nowMs: NOW }), []);
  assert.deepEqual(benchHours([], { sinceMs: T('00:00'), nowMs: NOW }), []);
});

test('w1996: a hold with no end, a ticket never seen to be taken and a hold never granted', () => {
  const lines = [
    ev('06:00', 'grant', 'Y1', 'exclusive', { session: 'A', requests: ['w9'] }), // take rotated away; still held
    ev('06:20', 'release', 'Y2', 'exclusive', { session: 'A' }), // its grant rotated away: nothing to hold
    ev('06:30', 'take', 'Y3', 'exclusive', { session: 'A' }), // still waiting: not a hold
  ];
  const rows = benchHours(lines, { sinceMs: T('06:00'), nowMs: T('06:45') });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exclusiveS, 45 * 60);
  assert.equal(rows[0].holds, 1);
  assert.deepEqual(rows[0].byRequest, { w9: 45 * 60 });
});

test('w1996: a rotated pair of files is read in time order whichever comes first', () => {
  const a = benchHours(HISTORY, { sinceMs: T('00:00'), nowMs: NOW });
  const b = benchHours([...HISTORY].reverse(), { sinceMs: T('00:00'), nowMs: NOW });
  assert.deepEqual(b, a);
});

test('w1996: capBenchRows keeps the newest 72 hours and each hour\'s 10 biggest requests', () => {
  const rows: BenchHourRow[] = Array.from({ length: 80 }, (_, i) => ({
    hour: new Date(Date.UTC(2026, 9, 20, 0) + i * 3_600_000).toISOString().replace('.000Z', 'Z'),
    exclusiveS: 1,
    holds: 1,
    idleSlotS: 0,
    sharedWaitS: 0,
    sharedS: 0,
    byRequest: Object.fromEntries(Array.from({ length: 15 }, (_, k) => [`w${k}`, k + 1])),
  }));
  const out = capBenchRows(rows);
  assert.equal(out.length, BENCH_HOURS_MAX_ROWS);
  assert.equal(out[0].hour, rows[8].hour);
  assert.equal(out.at(-1)!.hour, rows[79].hour);
  assert.equal(Object.keys(out[0].byRequest).length, BENCH_HOURS_MAX_REQUESTS);
  assert.equal(out[0].byRequest.w14, 15);
  assert.equal(out[0].byRequest.w0, undefined);
});

test('w1996: readBenchHours reads history.1.jsonl then history.jsonl from the worker root, and nothing when there is none', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1996-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(await readBenchHours(root, NOW), undefined);
  assert.equal(await readBenchHours(undefined, NOW), undefined);
  const [old, cur] = benchHistoryFiles(root);
  assert.equal(path.basename(old), 'history.1.jsonl');
  assert.equal(path.basename(path.dirname(old)), 'bench.queue');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  const split = HISTORY.indexOf(HISTORY.find((l) => l.includes('"S1"') && l.includes('"take"'))!);
  fs.writeFileSync(old, HISTORY.slice(0, split).join('\n') + '\n');
  fs.writeFileSync(cur, HISTORY.slice(split).join('\r\n') + '\n');
  const rows = (await readBenchHours(root, NOW))!;
  // w4924: no ticket folder holds X2, so its open hold ends at the history's last event (S6's take, 06:50), not at NOW
  assert.deepEqual(rows, capBenchRows(benchHours(HISTORY, { sinceMs: T('07:00') - BENCH_HOURS_MAX_ROWS * 3_600_000, nowMs: NOW, live: new Set() })));
  assert.equal(rows.find((r) => r.hour.startsWith('2026-10-24T06'))!.exclusiveS, 600 + 600, 'X1 06:00-06:10, X2 06:40-06:50');
});

test('w4924: an open ticket whose helper is gone ends at the next exclusive grant, else at the last event, never at now', () => {
  // lothlaptop, 2026-11-10: w3881's ticket was granted, the machine went offline, and no scan wrote "gone"; counted to now it
  // showed 60 exclusive minutes every hour for ten days ("22.3 h" in r341)
  const lines = [
    ev('04:00', 'take', 'P1', 'exclusive', { session: 'A', requests: ['w3881'] }),
    ev('04:00', 'grant', 'P1', 'exclusive', { session: 'A', requests: ['w3881'], waited_s: 0 }),
    ev('04:20', 'take', 'S1', 'shared', { session: 'B', sandbox: 'slot2' }),
  ];
  const now = T('06:00', '2026-11-20');
  const since = T('00:00', '2026-11-17');
  const day = (l: string) => {
    const d = JSON.parse(l);
    const ms = Date.parse(String(d.at).replace('2026-10-24', '2026-11-17'));
    return JSON.stringify({ ...d, at: new Date(ms).toISOString(), ts: ms / 1000 });
  };
  const moved = lines.map(day);
  assert.ok(benchHours(moved, { sinceMs: since, nowMs: now }).length > 48, 'without `live` an open ticket is still counted to now (the old reading)');
  const dead = benchHours(moved, { sinceMs: since, nowMs: now, live: new Set() });
  assert.deepEqual(dead.map((r) => [r.hour.slice(11, 13), r.exclusiveS]), [['04', 20 * 60]], 'P1 ends at 04:20, the last event');
  const alive = benchHours(moved, { sinceMs: since, nowMs: now, live: new Set(['P1']) });
  assert.ok(alive.length > 48, 'a live ticket is still held, counted to now');
  // a later exclusive grant ends it there: the queue gave the lock to someone else
  const next = benchHours([...lines, ev('04:10', 'take', 'X9', 'exclusive'), ev('04:12', 'grant', 'X9', 'exclusive'), ev('04:30', 'release', 'X9', 'exclusive'), ev('05:00', 'take', 'S7', 'shared')], { sinceMs: T('00:00'), nowMs: T('06:00'), live: new Set() });
  assert.deepEqual(next.map((r) => [r.hour.slice(11, 13), r.exclusiveS, r.holds]), [['04', 12 * 60 + 18 * 60, 2]]);
});

test('w4924: readBenchHours keeps counting a ticket whose helper lives, and ends one whose helper is gone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w4924-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const [, cur] = benchHistoryFiles(root);
  const q = path.dirname(cur);
  fs.mkdirSync(path.join(q, 't00000001'), { recursive: true });
  fs.writeFileSync(path.join(q, 't00000001', 'info.json'), JSON.stringify({ pid: 4242, mode: 'exclusive', what: 'x' }));
  fs.writeFileSync(cur, [ev('06:00', 'take', 't00000001', 'exclusive'), ev('06:00', 'grant', 't00000001', 'exclusive'), ev('06:10', 'take', 'S1', 'shared')].join('\n') + '\n');
  const held = (await readBenchHours(root, NOW, (pid) => pid === 4242))!;
  assert.equal(held.find((r) => r.hour.startsWith('2026-10-24T06'))!.exclusiveS, 3600, 'its helper lives: held to now');
  const gone = (await readBenchHours(root, NOW, () => false))!;
  assert.equal(gone.find((r) => r.hour.startsWith('2026-10-24T06'))!.exclusiveS, 600, 'its helper is gone: ends at 06:10');
});

test('w1996: sanitizeBenchRows drops a bad row and shapes the rest', () => {
  const good = { hour: '2026-10-24T05:00:00Z', exclusiveS: 600.4, holds: 1, idleSlotS: 1200, sharedWaitS: 0, sharedS: 5, byRequest: { w1: 600, 'bad key!': 1, '-': 3 } };
  const rows = sanitizeBenchRows([good, { ...good, hour: '2026-10-24T05:30:00Z' }, { ...good, holds: -1 }, { ...good, exclusiveS: 'x' }, null, 'x']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exclusiveS, 600);
  assert.deepEqual(rows[0].byRequest, { w1: 600, '-': 3 });
  assert.deepEqual(sanitizeBenchRows({ rows: 1 }), []);
  assert.equal(sanitizeBenchRows(Array.from({ length: 100 }, () => good)).length, BENCH_HOURS_MAX_ROWS);
});

test('w1996: the portal keeps the newest report of an hour, merges machines apart, and drops hours older than 14 days', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1996-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-24T06:30:00Z');
  const store = new BenchHoursStore({ dataDir: dir, now: () => now });
  const row = (hour: string, exclusiveS: number): BenchHourRow => ({ hour, exclusiveS, holds: 1, idleSlotS: 0, sharedWaitS: 0, sharedS: 0, byRequest: {} });
  assert.equal(store.merge('beast', [row('2026-10-24T05:00:00Z', 100), row('2026-10-24T06:00:00Z', 50)]), 2);
  assert.equal(store.merge('beast', [row('2026-10-24T06:00:00Z', 90), row('2026-10-24T07:00:00Z', 1)]), 2);
  assert.equal(store.merge('lothdesktop', [row('2026-10-24T06:00:00Z', 7)]), 1);
  assert.equal(store.merge('beast', 'garbage'), 0);
  assert.deepEqual(store.hours('beast').map((r) => [r.hour.slice(11, 13), r.exclusiveS]), [['05', 100], ['06', 90], ['07', 1]], 'the newest report wins an hour, the others stay');
  assert.deepEqual(store.hours('lothdesktop').map((r) => r.exclusiveS), [7]);
  // a restart reads the file back
  assert.deepEqual(new BenchHoursStore({ dataDir: dir, now: () => now }).hours('beast'), store.hours('beast'));
  assert.ok(fs.existsSync(path.join(dir, BENCH_HOURS_FILE)));
  // 14 days on, the oldest hours go with the next report
  now = Date.parse('2026-11-07T05:30:00Z');
  store.merge('lothdesktop', [row('2026-11-07T05:00:00Z', 3)]);
  assert.deepEqual(store.hours('beast').map((r) => r.hour.slice(11, 13)), ['06', '07'], 'hour 05 is over 14 days old; hour 06 is not yet (13.99 d)');
  assert.deepEqual(store.hours('lothdesktop').map((r) => r.hour.slice(0, 13)), ['2026-10-24T06', '2026-11-07T05']);
  now = Date.parse('2026-11-09T00:00:00Z');
  store.merge('lothdesktop', [row('2026-11-09T00:00:00Z', 1)]);
  assert.deepEqual(store.hours('beast'), [], 'a machine with no hour left is dropped');
});
