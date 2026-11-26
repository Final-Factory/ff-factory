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
    assert.match(cut[0], /the previous low-space pass, started 2026-11-25 13:57Z, was cut off 67 min later, before it finished: it had removed nothing by then/);
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
    });
    await r.run('asked', { dryRun: true });
    assert.equal(during, undefined);
    assert.deepEqual(started, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: a low pass goes straight to the pass, and its step timings reach the summary (w5795: no quick plan first)', async () => {
  const order: string[] = [];
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 30 }),
    diskPaths: () => ['V:/'],
    statfs: async () => ({ free: 20 * GB, total: 320 * GB }),
    pass: async (low) => (order.push(low ? 'low pass' : 'pass'), { removed: [], failed: [], bytes: 0, phasesMs: { regular: 1, cap: 2 } }),
    consumers: async () => [],
    log: () => undefined,
    done: () => undefined,
  });
  const low = await r.tick();
  assert.equal(low?.trigger, 'low-space');
  assert.deepEqual(order, ['low pass'], 'nothing planned before the pass');
  assert.ok(!("quick" in (low ?? {})), "no quick report in the summary");
  assert.deepEqual(low?.phasesMs, { regular: 1, cap: 2 }, "the pass's step timings reach the summary");
});

test('describeCutOff rounds the minutes and never goes negative (w5795)', () => {
  const at = Date.parse('2026-11-25T14:00:00Z');
  assert.match(describeCutOff({ startedAt: at, trigger: 'hourly' }, at - 1000), /cut off 0 min later/);
  assert.match(describeCutOff({ startedAt: at, trigger: 'hourly' }, at + 90_000), /cut off 2 min later/);
});

// w5795: the first pass on the new code (LothDesktop, 2026-11-25 19:54Z) was cut off 61 min later by an update, and said
// nothing of where its hour went. The marker now carries the step in flight and the steps done.
test('runner: a pass cut off mid-step names the step and the steps it had done (w5795)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-marker-'));
  try {
    let now = Date.parse('2026-11-25T19:54:00Z');
    const marker = passMarkerFile(dir);
    const cut: string[] = [];
    const deps = {
      settings: () => ({ everyMinutes: 60, softFreeGB: 30 }),
      diskPaths: () => ['V:/'],
      statfs: async () => ({ free: 200 * GB, total: 320 * GB }),
      consumers: async () => [],
      log: () => undefined,
      done: () => undefined,
      now: () => now,
      marker,
      cutOff: (text: string) => void cut.push(text),
    };
    const hang = new CleanupRunner({
      ...deps,
      pass: (_low, opts) => {
        opts.step?.('regular', {});
        now += 4 * 60_000;
        opts.step?.('stale', { regular: 4 * 60_000 });
        return new Promise<CleanupRun>(() => undefined);
      },
    });
    void hang.tick();
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(marker.load()?.step, 'stale');
    assert.deepEqual(marker.load()?.done, { regular: 4 * 60_000 });
    now += 57 * 60_000;
    new CleanupRunner({ ...deps, pass: async () => ({ removed: [], failed: [], bytes: 0 }) });
    assert.equal(cut.length, 1);
    assert.match(cut[0], /started 2026-11-25 19:54Z, was cut off 61 min later, in its stale step \(57 min in it\), before it finished: it had removed nothing by then; steps done before: regular 4 min \(w5795\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupPass says each step as it begins, with the steps done (w5795)', async () => {
  const { cleanupPass } = await import('./staleOutput.ts');
  const seen: string[] = [];
  await cleanupPass({
    opts: { stale: true, dryRun: true, step: (n: string, d: Record<string, number>) => void seen.push(`${n}<${Object.keys(d).join(',')}>`) },
    guard: { protect: [], busy: () => undefined } as never,
    mode: 'on',
    regular: async () => [],
    stale: async () => ({ items: [], listed: [] }),
  } as never);
  assert.deepEqual(seen.slice(0, 2), ['regular<>', 'stale<regular>']);
});

// w5795: four low passes in a row on LothDesktop (2026-11-25 21:28Z to 23:58Z) were cut off by daemon restarts after 26-58 min
// of planning, in or before their one remove step, and removed nothing. Each step's plan now goes as soon as it is planned.
test('cleanupPass removes each step\'s plan before the next step plans, and a hang later keeps what went (w5795)', async () => {
  const { cleanupPass } = await import('./staleOutput.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-perstep-'));
  try {
    const put = (name: string) => {
      const p = path.join(root, name);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'f'), 'x'.repeat(1000));
      return p;
    };
    const reg = put('old-temp');
    const stale = put('old-build');
    const guard = { keep: [], inUse: [], home: path.join(root, 'nobody') };
    const item = (p: string, rule: string) => ({ path: p, rule, why: 'test' });
    const marks: { step: string; removed: number }[] = [];
    let regularGoneAtStale: boolean | undefined;
    const r = await cleanupPass({
      opts: { stale: true, dryRun: false, step: (n: string, _d: Record<string, number>, s?: { removed: number }) => void marks.push({ step: n, removed: s?.removed ?? 0 }) },
      guard,
      mode: 'on',
      regular: async () => [item(reg, 'temp-old')],
      stale: async () => {
        regularGoneAtStale = !fs.existsSync(reg);
        return { items: [item(stale, 'build-output')], listed: [] };
      },
      root,
    });
    assert.equal(regularGoneAtStale, true);
    assert.ok(!fs.existsSync(stale));
    assert.deepEqual(r.removed.map((x) => x.path).sort(), [reg, stale].sort());
    assert.deepEqual(marks.map((m) => m.step), ['regular', 'remove', 'stale', 'removeStale', 'listed']);
    assert.equal(marks.find((m) => m.step === 'stale')?.removed, 1);

    // A stale plan that never ends (a restart cuts the pass off there): the regular items are gone all the same.
    const reg2 = put('old-temp-2');
    void cleanupPass({ opts: { stale: true, dryRun: false }, guard, mode: 'on', regular: async () => [item(reg2, 'temp-old')], stale: () => new Promise(() => undefined), root });
    for (let i = 0; i < 50 && fs.existsSync(reg2); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(!fs.existsSync(reg2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('describeCutOff says what a cut-off pass had removed by then (w5795)', () => {
  const at = Date.parse('2026-11-25T23:04:00Z');
  const text = describeCutOff({ startedAt: at, trigger: 'low-space', step: 'stale', stepAt: at + 5 * 60_000, done: { regular: 3 * 60_000, remove: 2 * 60_000 }, soFar: { removed: 12, bytes: 40 * GB } }, at + 55 * 60_000);
  assert.match(text, /was cut off 55 min later, in its stale step \(50 min in it\), before it finished: it had removed 12 items \(40\.0 GB\) by then; steps done before: regular 3 min, remove 2 min \(w5795\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-marker-'));
  try {
    const m = passMarkerFile(dir);
    m.save({ startedAt: at, trigger: 'hourly', step: 'stale', stepAt: at, soFar: { removed: 2, bytes: 5 } });
    assert.deepEqual(m.load()?.soFar, { removed: 2, bytes: 5 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// w6044: BEAST, 2026-11-26: the 09:10Z low pass was cut off 4 min into its regular step having removed nothing, while three
// released ffu slot targets held 190.6 GB that the ffu rule (in the later stale or cap step) would have taken. The released
// targets are now planned and removed first, before the regular step (stage 1, #1353, only said them).
test('cleanupPass removes the released ffu targets first, before the regular step (w6044)', async () => {
  const { cleanupPass } = await import('./staleOutput.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-ffufirst-'));
  try {
    const mk = (slot: string) => {
      const t = path.join(root, 'ffu-sandboxes', slot, 'target');
      fs.mkdirSync(path.join(t, 'debug'), { recursive: true });
      fs.writeFileSync(path.join(t, 'debug', 'x.rlib'), Buffer.alloc(100));
      return t;
    };
    const t1 = mk('slot1');
    const t2 = mk('slot2');
    const steps: string[] = [];
    const reported: { paths: string[]; removed?: number; failed?: number }[] = [];
    let regularSaw: boolean | undefined;
    const outside = path.join(os.tmpdir(), 'outside-w6044');
    const r = await cleanupPass({
      opts: { stale: false, dryRun: false, step: (n: string) => void steps.push(n) },
      guard: { keep: [], inUse: [], home: path.join(root, 'nobody') },
      mode: 'on',
      regular: async () => ((regularSaw = fs.existsSync(t1)), []),
      stale: async () => ({ items: [], listed: [] }),
      first: {
        plan: async () => ({ items: [t1, t2, outside].map((p) => ({ path: p, rule: 'ffu-slot-target', why: 'test' })), listed: [] }),
        report: (items, _ms, run) => {
          reported.push({ paths: items.map((i) => i.path), removed: run?.removed.length, failed: run?.failed.length });
          throw new Error('a report that throws costs the pass nothing');
        },
      },
      busyNow: async (it) => (it.path === t2 ? 'taken since the plan' : undefined),
      root,
    });
    assert.deepEqual(steps.slice(0, 3), ['ffu first', 'ffu firstRemove', 'regular']);
    assert.equal(regularSaw, false, 'gone before the regular step is planned');
    assert.deepEqual(reported, [{ paths: [t1, t2], removed: 1, failed: 1 }], 'said once, fenced to the install folder, with the removal');
    assert.ok(!fs.existsSync(t1) && fs.existsSync(t2), 'the re-check keeps the slot taken since the plan');
    assert.deepEqual(r.removed.map((x) => x.path), [t1]);
    assert.ok(r.bytes >= 100);
    // Own's leftovers keep clear of what the first step took (withoutOverlap); the later cap step finds it gone; a removal the
    // guard refuses, or whose re-check throws, keeps the target and the pass goes on.
    const t4 = mk('slot4');
    const t5 = mk('slot5');
    const t6 = mk('slot6');
    let ownGot: string[] | undefined;
    let capSaw: boolean[] | undefined;
    const g = await cleanupPass({
      opts: { stale: false, dryRun: false },
      guard: { keep: [t5], inUse: [], home: path.join(root, 'nobody') },
      mode: 'on',
      regular: async () => [],
      stale: async () => ({ items: [], listed: [] }),
      cap: async () => ((capSaw = [fs.existsSync(t4), fs.existsSync(t5)]), { items: [], listed: [] }),
      first: { plan: async () => ({ items: [t4, t5, t6].map((p) => ({ path: p, rule: 'ffu-slot-target', why: 'test' })), listed: [] }) },
      busyNow: async (it) => {
        if (it.path === t6) throw new Error('boom');
        return undefined;
      },
      own: { plan: async () => ({ items: [{ path: path.join(t4, 'debug'), why: 'own' } as never, { path: path.join(root, 'tmp', 'ffa-x'), why: 'own' } as never], listed: [] }), run: async (p) => ((ownGot = p.items.map((i: { path: string }) => i.path)), { removed: [], failed: [], bytes: 0 }) },
      root,
    });
    assert.deepEqual(capSaw, [false, true], 'the cap step runs after the removal and finds the taken target gone');
    assert.deepEqual(ownGot, [path.join(root, 'tmp', 'ffa-x')], "own's item inside a taken target is dropped");
    assert.deepEqual(g.removed.map((x) => x.path), [t4]);
    assert.deepEqual(g.failed.map((x) => [x.path, /refused|re-check failed/.test(x.why)]), [[t5, true], [t6, true]]);
    assert.ok(fs.existsSync(t5) && fs.existsSync(t6));
    // A plan that fails costs the pass nothing; dry-run mode says the plan and removes nothing.
    const t3 = mk('slot3');
    const said: (number | undefined)[] = [];
    const f = await cleanupPass({ opts: { stale: false, dryRun: false }, guard: { keep: [], inUse: [], home: root }, mode: 'on', regular: async () => [], stale: async () => ({ items: [], listed: [] }), first: { plan: async () => Promise.reject(new Error('boom')) }, root });
    assert.equal(f.removed.length, 0);
    await cleanupPass({ opts: { stale: false, dryRun: false }, guard: { keep: [], inUse: [], home: root }, mode: 'dry-run', regular: async () => [], stale: async () => ({ items: [], listed: [] }), first: { plan: async () => ({ items: [{ path: t3, rule: 'ffu-slot-target', why: 'test' }], listed: [] }), report: (_i, _ms, run) => void said.push(run?.removed.length) }, root });
    assert.deepEqual(said, [undefined]);
    assert.ok(fs.existsSync(t3), 'dry-run mode: said, not removed');
    const off: string[] = [];
    await cleanupPass({ opts: { stale: false, dryRun: true }, guard: { keep: [], inUse: [], home: root }, mode: 'on', regular: async () => [], stale: async () => ({ items: [], listed: [] }), first: { plan: async () => (off.push('dry'), { items: [], listed: [] }) } });
    await cleanupPass({ opts: { stale: false, dryRun: false }, guard: { keep: [], inUse: [], home: root }, mode: 'off', regular: async () => [], stale: async () => ({ items: [], listed: [] }), first: { plan: async () => (off.push('off'), { items: [], listed: [] }) } });
    assert.deepEqual(off, [], 'not planned in a dry run or with the stale-output rules off');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
