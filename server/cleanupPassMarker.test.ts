import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CleanupRunner, passMarkerFile, describeCutOff, type CleanupRun } from './cleanup.ts';

const GB = 1024 ** 3;

// w5795: LothDesktop's daemon started 14 times in 13 h on 2026-11-25 and its low passes finished 67-78 min after a start, so
// a restart in between lost the whole pass (nothing goes until every plan is made) without a word in any log.
test('runner: a pass in flight is marked on disk, and the next start says it was cut off (w5795)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-marker-'));
  try {
    let now = Date.parse('2026-11-25T13:42:00Z');
    const started: string[] = [];
    const cut: string[] = [];
    let seenDuring: unknown;
    const marker = passMarkerFile(dir);
    const deps = {
      settings: () => ({ everyMinutes: 60, softFreeGB: 30 }),
      diskPaths: () => ['V:/'],
      statfs: async () => ({ free: 20 * GB, total: 320 * GB }),
      consumers: async () => [],
      log: () => undefined,
      done: () => undefined,
      now: () => now,
      marker,
      started: (t: string, low: boolean) => void started.push(`${t}:${low}`),
      cutOff: (text: string) => void cut.push(text),
    };
    const r = new CleanupRunner({
      ...deps,
      pass: async () => {
        seenDuring = marker.load();
        return { removed: [], failed: [], bytes: 0 };
      },
    });
    assert.deepEqual(cut, [], 'no marker at a first start');
    const s = await r.tick();
    assert.equal(s?.trigger, 'low-space');
    assert.deepEqual(started, ['low-space:true']);
    assert.deepEqual(seenDuring, { startedAt: Date.parse('2026-11-25T13:42:00Z'), trigger: 'low-space' }, 'marked while the pass runs');
    assert.equal(marker.load(), undefined, 'cleared once it ends');
    assert.equal(typeof s?.passMs, 'number');

    // A pass the daemon never finishes (a restart mid-plan): the marker stays, and the next start reports it, once.
    const hang = new CleanupRunner({ ...deps, pass: () => new Promise<CleanupRun>(() => undefined) });
    now += 15 * 60_000;
    void hang.tick();
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(marker.load()?.trigger, 'low-space');
    now += 67 * 60_000;
    new CleanupRunner({ ...deps, pass: async () => ({ removed: [], failed: [], bytes: 0 }) });
    assert.equal(cut.length, 1);
    assert.match(cut[0], /the previous low-space pass, started 2026-11-25 13:57Z, was cut off 67 min later, before it finished: nothing it had planned was removed/);
    assert.equal(marker.load(), undefined, 'said once: the marker goes');
    new CleanupRunner({ ...deps, pass: async () => ({ removed: [], failed: [], bytes: 0 }) });
    assert.equal(cut.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: a dry run neither marks nor reports a start (w5795)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-marker-'));
  try {
    const marker = passMarkerFile(dir);
    const started: string[] = [];
    let during: unknown = 'unset';
    const r = new CleanupRunner({
      settings: () => ({ everyMinutes: 60, softFreeGB: 30 }),
      diskPaths: () => ['V:/'],
      statfs: async () => ({ free: 20 * GB, total: 320 * GB }),
      pass: async () => ((during = marker.load()), { removed: [], failed: [], bytes: 0 }),
      consumers: async () => [],
      log: () => undefined,
      done: () => undefined,
      marker,
      started: (t) => void started.push(t),
      quick: async () => assert.fail('no quick plan in a dry run'),
    });
    await r.run('asked', { dryRun: true });
    assert.equal(during, undefined);
    assert.deepEqual(started, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: a low pass plans the quick scope first and reports what it would free; an hourly pass does not (w5795, report-only)', async () => {
  let free = 20 * GB;
  let order: string[] = [];
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 30 }),
    diskPaths: () => ['V:/'],
    statfs: async () => ({ free, total: 320 * GB }),
    pass: async () => (order.push('pass'), { removed: [], failed: [], bytes: 0, phasesMs: { regular: 1, cap: 2 } }),
    consumers: async () => [],
    log: () => undefined,
    done: () => undefined,
    quick: async () => {
      order.push('quick');
      return [
        { path: 'V:/ffw/ffu-slots/slot3/target', bytes: 24 * GB, rule: 'ffu-slot-target' },
        { path: 'V:/ffw/tmp/ffa-1/ffu-target', bytes: 2 * GB, rule: 'cargo-target-cap' },
      ];
    },
  });
  const low = await r.tick();
  assert.deepEqual(order, ['quick', 'pass'], 'the quick plan first, then the full pass as before');
  assert.equal(low?.quick?.items, 2);
  assert.equal(low?.quick?.bytes, 26 * GB);
  assert.equal(low?.quick?.top?.[0].rule, 'ffu-slot-target');
  assert.deepEqual(low?.phasesMs, { regular: 1, cap: 2 }, "the pass's step timings reach the summary");

  free = 200 * GB;
  order = [];
  const r2 = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 30 }),
    diskPaths: () => ['V:/'],
    statfs: async () => ({ free, total: 320 * GB }),
    pass: async () => (order.push('pass'), { removed: [], failed: [], bytes: 0 }),
    consumers: async () => [],
    log: () => undefined,
    done: () => undefined,
    quick: async () => (order.push('quick'), []),
  });
  const hourly = await r2.tick();
  assert.equal(hourly?.trigger, 'hourly');
  assert.deepEqual(order, ['pass']);
  assert.equal(hourly?.quick, undefined);
});

test('describeCutOff rounds the minutes and never goes negative (w5795)', () => {
  const at = Date.parse('2026-11-25T14:00:00Z');
  assert.match(describeCutOff({ startedAt: at, trigger: 'hourly' }, at - 1000), /cut off 0 min later/);
  assert.match(describeCutOff({ startedAt: at, trigger: 'hourly' }, at + 90_000), /cut off 2 min later/);
});
