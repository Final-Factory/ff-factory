import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_SOURCES, benchHourLine, readPortalLogs, type PortalLogsDeps } from './portalLogs.ts';
import { BenchHoursStore } from './benchHoursStore.ts';
import { CATALOG } from './launch.ts';
import type { BenchHourRow } from '../shared/benchHours.ts';

/** portal_logs source bench_hours (w1996, docs/portal-logs.md): what each machine's exclusive bench tickets cost it, per UTC hour. */

const NOW = Date.parse('2026-10-24T07:10:00Z');
const row = (hour: string, o: Partial<BenchHourRow> = {}): BenchHourRow => ({ hour, exclusiveS: 0, holds: 0, idleSlotS: 0, sharedWaitS: 0, sharedS: 0, byRequest: {}, ...o });

function setup(t: { after: (f: () => void) => void }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1996-logs-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new BenchHoursStore({ dataDir, now: () => NOW });
  store.merge('beast', [
    row('2026-10-24T05:00:00Z', { exclusiveS: 41 * 60, holds: 3, idleSlotS: 160 * 60, sharedWaitS: 52 * 60, sharedS: 38 * 60, byRequest: { w1908: 30 * 60, w1891: 11 * 60 } }),
    row('2026-10-24T06:00:00Z', { exclusiveS: 14 * 60, holds: 1, idleSlotS: 20 * 60, sharedWaitS: 8 * 60, sharedS: 50 * 60, byRequest: { '-': 14 * 60 } }),
    row('2026-10-24T03:00:00Z', { exclusiveS: 1800, holds: 1, idleSlotS: 0, sharedWaitS: 0, sharedS: 0, byRequest: { 'w1,w2': 1800 } }),
  ]);
  store.merge('lothdesktop', [row('2026-10-24T06:00:00Z', { exclusiveS: 3600, holds: 2, idleSlotS: 7200, sharedWaitS: 3600, sharedS: 0, byRequest: { w5: 3600 } })]);
  const deps: PortalLogsDeps = {
    dataDir,
    journal: async () => ({ lines: [] }),
    machine: (id) => (['beast', 'lothdesktop', 'm5'].includes(id) ? { id, local: false } : undefined),
    machineIds: () => ['beast', 'lothdesktop', 'm5'],
    now: () => NOW,
  };
  return { dataDir, deps };
}

/** The text between the ~~~ fences. */
const body = (out: string) => out.split('~~~text\n')[1]?.split('\n~~~')[0] ?? '';

test('w1996: a machine-hour is one line, in minutes, with the requests that held', () => {
  assert.equal(
    benchHourLine('beast', row('2026-10-24T05:00:00Z', { exclusiveS: 41 * 60, holds: 3, idleSlotS: 160 * 60, sharedWaitS: 52 * 60, sharedS: 38 * 60, byRequest: { w1891: 11 * 60, w1908: 30 * 60 } })),
    '2026-10-24T05:00Z beast: exclusive 41 min in 3 holds, idle slots 160 slot-min, shared waited 52 min, shared granted 38 min; w1908 30m, w1891 11m',
  );
  assert.equal(benchHourLine('m5', row('2026-10-24T05:00:00Z', { holds: 1, sharedS: 60, byRequest: { '-': 10 } })), '2026-10-24T05:00Z m5: exclusive 0 min in 1 hold, idle slots 0 slot-min, shared waited 0 min, shared granted 1 min; - <1m');
});

test('w1996: bench_hours lists every machine newest first with a totals line per machine on top', async (t) => {
  const { deps } = setup(t);
  const list = await readPortalLogs(deps, {});
  assert.match(list, /- bench_hours: .*\[there now: beast 3 h, lothdesktop 1 h\]/);
  const all = await readPortalLogs(deps, { source: 'bench_hours' });
  assert.match(all, /exclusive bench cost per UTC hour of every machine, all kept \(14 days\): 4 line\(s\) of 4 matching, newest first/);
  assert.deepEqual(body(all).split('\n'), [
    'beast totals, 2026-10-24T03:00Z to 2026-10-24T06:00Z (3 hours with activity): exclusive 1.4 h, idle slots 3.0 slot-h, shared waited 1.0 h, shared granted 1.5 h',
    'lothdesktop totals, 2026-10-24T06:00Z to 2026-10-24T06:00Z (1 hour with activity): exclusive 1.0 h, idle slots 2.0 slot-h, shared waited 1.0 h, shared granted 0.0 h',
    '2026-10-24T06:00Z beast: exclusive 14 min in 1 hold, idle slots 20 slot-min, shared waited 8 min, shared granted 50 min; - 14m',
    '2026-10-24T06:00Z lothdesktop: exclusive 60 min in 2 holds, idle slots 120 slot-min, shared waited 60 min, shared granted 0 min; w5 60m',
    '2026-10-24T05:00Z beast: exclusive 41 min in 3 holds, idle slots 160 slot-min, shared waited 52 min, shared granted 38 min; w1908 30m, w1891 11m',
    '2026-10-24T03:00Z beast: exclusive 30 min in 1 hold, idle slots 0 slot-min, shared waited 0 min, shared granted 0 min; w1,w2 30m',
  ]);
});

test('w1996: machine, since, until, grep, regex, limit and offset work as for the other sources', async (t) => {
  const { deps } = setup(t);
  const one = body(await readPortalLogs(deps, { source: 'bench_hours', machine: 'beast' })).split('\n');
  assert.equal(one.length, 4, 'one totals line and three hours');
  assert.ok(one.every((l) => !l.includes('lothdesktop')));
  await assert.rejects(readPortalLogs(deps, { source: 'bench_hours', machine: 'nope' }), /machine: no machine "nope"/);
  await assert.rejects(readPortalLogs(deps, { source: 'bench_hours', machine: '../x' }), /is not a machine id/);
  // an hour is in the window when it overlaps since..until
  const win = body(await readPortalLogs(deps, { source: 'bench_hours', machine: 'beast', since: '2026-10-24T05:30:00Z', until: '2026-10-24T05:45:00Z' })).split('\n');
  assert.equal(win.length, 2);
  assert.match(win[0], /^beast totals, 2026-10-24T05:00Z to 2026-10-24T05:00Z \(1 hour with activity\): exclusive 0\.7 h/);
  assert.match(win[1], /^2026-10-24T05:00Z beast/);
  // grep filters the hour lines; the totals head every page whatever the filter
  const g = await readPortalLogs(deps, { source: 'bench_hours', grep: 'w1908' });
  assert.match(g, /1 line\(s\) of 1 matching/);
  assert.equal(body(g).split('\n').length, 3, 'two totals lines and the one hour');
  const re = body(await readPortalLogs(deps, { source: 'bench_hours', regex: 'T0[36]:00Z beast' }));
  assert.match(re, /06:00Z beast/);
  assert.match(re, /03:00Z beast/);
  assert.doesNotMatch(re, /05:00Z beast/);
  const page = await readPortalLogs(deps, { source: 'bench_hours', limit: 2, offset: 1 });
  assert.match(page, /2 line\(s\) of 4 matching, newest first, offset 1; more: offset 3/);
  assert.match(body(page), /06:00Z lothdesktop/);
  assert.match(body(page), /05:00Z beast/);
});

test('w1996: with no hours yet it says so, and a damaged file is reported, not thrown', async (t) => {
  const { deps, dataDir } = setup(t);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'w1996-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const none = await readPortalLogs({ ...deps, dataDir: empty }, { source: 'bench_hours' });
  assert.match(none, /0 line\(s\) of 0 matching.*no bench hours yet/);
  assert.match(await readPortalLogs({ ...deps, dataDir: empty }, {}), /- bench_hours: .*\[no hours yet\]/);
  fs.writeFileSync(path.join(dataDir, 'bench-hours.json'), '{"machines": {');
  assert.match(await readPortalLogs(deps, { source: 'bench_hours' }), /bench-hours\.json could not be read/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'bench-hours.json'), 'utf8'), '{"machines": {', 'reading changed nothing');
});

test('w1996: the tool texts name the source', () => {
  assert.ok(LOG_SOURCES.bench_hours);
  assert.match(String((CATALOG.portal_logs.source as unknown as { description?: string }).description), /bench_hours/);
  assert.match(fs.readFileSync(new URL('./agents.ts', import.meta.url), 'utf8'), /and bench_hours \(w1996/);
  assert.match(fs.readFileSync(new URL('../docs/portal-logs.md', import.meta.url), 'utf8'), /`bench_hours`/);
});
