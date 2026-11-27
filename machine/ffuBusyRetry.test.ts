import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FfuBusyRetry, busySlotsOf, type FfuBusyRetryMode } from './ffuBusyRetry.ts';
import type { CleanupItem, CleanupRun } from '../server/cleanup.ts';
import type { StalePlan } from '../server/staleOutput.ts';

const ROOT = path.resolve('/ffw');
const tgt = (slot: string) => path.join(ROOT, 'ffu-sandboxes', slot, 'target');
const busy = (slot: string, why = 'a running process uses it (pid 9: rustc --crate-name ffu_sim)') => ({ path: tgt(slot), bytes: 17e9, why: `an ffu slot's cargo target kept: ${why}` });
const inc = (slot: string): CleanupItem => ({ path: path.join(tgt(slot), 'debug', 'incremental'), rule: 'ffu-slot-target', why: 'over the cap', base: path.join(ROOT, 'ffu-sandboxes', slot) });

test('w6290: busySlotsOf names only slot targets kept for something running in or from them', () => {
  const held = [
    busy('slot1'),
    busy('slot2', 'a running process names it (pid 5: "V:/ffw/ffu-sandboxes/slot2/target/debug/deps/ffu_ui-0c.exe" --test-threads 6)'),
    busy('slot3', 'over the 16 GB cap after its stale units, written 3 min ago, within the settle time'),
    { path: tgt('slot4'), bytes: 17e9, why: "an ffu slot's cargo target kept: refused: protected" },
    { path: path.join(ROOT, 'tmp', 'ffa-1', 'ffu-target'), bytes: 9e9, why: '1 rebuildable cache(s) kept: a running process uses it' },
    { path: path.join(ROOT, 'ffu-sandboxes', 'slot5', 'ffu', 'target'), bytes: 9e9, why: "an ffu slot's cargo target kept: a running process uses it" },
  ];
  assert.deepEqual(busySlotsOf(held, ROOT).sort(), ['slot1', 'slot2', 'slot3']);
  assert.deepEqual(busySlotsOf(held, undefined), []);
  assert.deepEqual(busySlotsOf(undefined, ROOT), []);
});

function rig(o: { mode?: FfuBusyRetryMode; staleMode?: 'on' | 'dry-run' | 'off'; plans: StalePlan[]; inPass?: boolean }) {
  let now = 1_000_000_000_000;
  const planned: string[][] = [];
  const removed: CleanupItem[][] = [];
  const records: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const settings = { mode: o.mode ?? 'warn', staleMode: o.staleMode ?? 'on', everyMinutes: 60, retryMinutes: 5 };
  const r = new FfuBusyRetry({
    root: () => ROOT,
    settings: () => settings,
    plan: async (slots) => {
      planned.push(slots);
      return o.plans.shift() ?? { items: [], listed: [] };
    },
    remove: async (items): Promise<CleanupRun> => {
      removed.push(items);
      return { removed: items.map((i) => ({ path: i.path, bytes: 1e9, rule: i.rule, why: i.why })), failed: [], bytes: items.length * 1e9 };
    },
    size: async (items) => items.map((i) => ({ path: i.path, bytes: 2e9, rule: i.rule, why: i.why })),
    passRunning: () => !!o.inPass,
    log: (l) => lines.push(l),
    record: (e) => records.push(e),
    now: () => now,
  });
  return { r, planned, removed, records, lines, settings, advance: (min: number) => (now += min * 60_000) };
}

test('w6290: warn-only: a busy slot is re-checked, still busy it stays watched, idle its trim is logged once and nothing removed', async () => {
  const x = rig({ plans: [{ items: [], listed: [], held: [busy('slot2')] }, { items: [inc('slot2')], listed: [] }] });
  x.r.note({ held: [busy('slot2'), { path: tgt('slot1'), bytes: 1, why: 'x' }] });
  assert.deepEqual(x.r.watched(), ['slot2']);
  assert.deepEqual(await x.r.tick(), { slots: ['slot2'], planned: 0, removed: 0 });
  assert.deepEqual(x.r.watched(), ['slot2'], 'still busy: watched');
  assert.deepEqual(await x.r.tick(), { slots: ['slot2'], planned: 1, removed: 0 });
  assert.deepEqual(x.removed, [], 'warn removes nothing');
  assert.equal(x.records.length, 1);
  assert.equal(x.records[0].ffuBusyRetry, 'warn');
  assert.equal((x.records[0].planned as unknown[]).length, 1);
  assert.match(x.lines[0], /warn-only\): would remove 1 item\(s\), 1\.9 GB in slot2/);
  assert.deepEqual(x.r.watched(), [], 'said once, then no longer watched');
  assert.equal(await x.r.tick(), undefined, 'nothing watched: no plan');
  assert.equal(x.planned.length, 2);
});

test('w6290: on (with stale-output on) removes through runCleanup; with stale-output dry-run it only warns', async () => {
  const on = rig({ mode: 'on', plans: [{ items: [inc('slot3')], listed: [] }] });
  on.r.note({ held: [busy('slot3')] });
  assert.deepEqual(await on.r.tick(), { slots: ['slot3'], planned: 1, removed: 1 });
  assert.equal(on.removed.length, 1);
  assert.equal(on.records[0].ffuBusyRetry, 'on');
  assert.deepEqual(on.r.watched(), []);

  const dry = rig({ mode: 'on', staleMode: 'dry-run', plans: [{ items: [inc('slot3')], listed: [] }] });
  dry.r.note({ held: [busy('slot3')] });
  await dry.r.tick();
  assert.deepEqual(dry.removed, []);
  assert.equal(dry.records[0].ffuBusyRetry, 'warn');
});

test('w6290: a slot found idle and within the cap is dropped; the watch ends when the next pass is due; off and a running pass do nothing', async () => {
  const x = rig({ plans: [{ items: [], listed: [] }] });
  x.r.note({ held: [busy('slot1'), busy('slot4')] });
  await x.r.tick();
  assert.deepEqual(x.r.watched(), [], 'nothing to take and not kept: done');

  const late = rig({ plans: [] });
  late.r.note({ held: [busy('slot1')] });
  late.advance(61);
  assert.equal(await late.r.tick(), undefined);
  assert.deepEqual(late.planned, [], 'past the next pass: that pass judges it');

  const pass = rig({ plans: [], inPass: true });
  pass.r.note({ held: [busy('slot1')] });
  assert.equal(await pass.r.tick(), undefined);
  assert.deepEqual(pass.planned, []);

  const off = rig({ mode: 'off', plans: [] });
  off.r.note({ held: [busy('slot1')] });
  assert.deepEqual(off.r.watched(), []);
});

test('w6290: maybeTick re-checks at most every retryMinutes', async () => {
  const x = rig({ plans: [{ items: [], listed: [], held: [busy('slot1')] }, { items: [], listed: [], held: [busy('slot1')] }] });
  x.r.note({ held: [busy('slot1')] });
  await x.r.maybeTick();
  await x.r.maybeTick();
  assert.equal(x.planned.length, 1);
  x.advance(5);
  await x.r.maybeTick();
  assert.equal(x.planned.length, 2);
});
