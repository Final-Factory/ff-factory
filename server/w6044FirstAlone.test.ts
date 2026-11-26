import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CleanupRunner, type CleanupRun } from './cleanup.ts';

const GB = 1024 ** 3;
const none: CleanupRun = { removed: [], failed: [], bytes: 0 };

// w6044 stage 3: on BEAST, 2026-11-26, hourly passes ran 59 to 72 min back to back. A low tick or an asked pass that met one
// was dropped (`if (this.running) return undefined`), and that pass's own first step had run with the 7-day idle rule, so a
// released slot's target stayed while free space fell. A low trigger that meets a pass that is not low runs the first step alone.
function rig(o: { free: number; hold?: string }) {
  let now = Date.parse('2026-11-26T16:31:00Z');
  const s = { free: o.free };
  const alone: string[] = [];
  let release!: () => void;
  const inFlight = new Promise<void>((res) => (release = res));
  const passes: boolean[] = [];
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 60 }),
    diskPaths: () => ['F:/'],
    statfs: async () => ({ free: s.free, total: 900 * GB }),
    pass: async (low) => {
      passes.push(low);
      await inFlight;
      return none;
    },
    consumers: async () => [],
    log: () => undefined,
    done: () => undefined,
    now: () => now,
    ...(o.hold ? { hold: () => o.hold, holdFloorGB: () => 20 } : {}),
    firstAlone: async (trigger) => void alone.push(trigger),
  });
  return {
    r,
    s,
    alone,
    passes,
    release,
    advance: (min: number) => (now += min * 60_000),
  };
}

test('w6044: a low tick during an hourly pass runs the ffu first step alone, at most every 15 minutes', async () => {
  const g = rig({ free: 200 * GB });
  const hourly = g.r.tick();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(g.passes, [false], 'an hourly pass is in flight');
  g.advance(5);
  await g.r.tick();
  assert.deepEqual(
    g.alone,
    [],
    'not while the disk is above the soft threshold',
  );
  g.s.free = 40 * GB;
  await g.r.tick();
  assert.deepEqual(
    g.alone,
    ['low-space'],
    'the disk fell below it mid-pass: the first step alone',
  );
  g.advance(10);
  await g.r.tick();
  assert.deepEqual(g.alone, ['low-space'], 'not again within 15 minutes');
  g.advance(5);
  await g.r.tick();
  assert.deepEqual(
    g.alone,
    ['low-space', 'low-space'],
    'again after 15 minutes',
  );
  g.release();
  await hourly;
});

test('w6044: an asked or critical pass that meets a pass in flight runs the first step alone; a dry run does not', async () => {
  const g = rig({ free: 200 * GB });
  const hourly = g.r.tick();
  await new Promise((res) => setImmediate(res));
  assert.equal(await g.r.run('asked', { dryRun: true }), undefined);
  assert.deepEqual(
    g.alone,
    [],
    'a dry run removes nothing, so it never runs the step',
  );
  assert.equal(
    await g.r.run('asked'),
    undefined,
    'the pass in flight still answers the asked one',
  );
  assert.deepEqual(g.alone, ['asked']);
  assert.equal(await g.r.run('critical'), undefined);
  assert.deepEqual(
    g.alone,
    ['asked', 'critical'],
    'an asked or critical pass is not throttled',
  );
  g.release();
  await hourly;
});

test('w6044: a low pass in flight already took the targets at low: nothing runs alone', async () => {
  const g = rig({ free: 40 * GB });
  const low = g.r.tick();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(g.passes, [true], 'a low-space pass is in flight');
  g.advance(20);
  await g.r.tick();
  assert.equal(await g.r.run('asked'), undefined);
  assert.deepEqual(g.alone, []);
  g.release();
  await low;
  assert.deepEqual(g.alone, []);
});

test('w6044: a hold (a timed run) keeps the low tick off, until free space falls below its floor', async () => {
  const g = rig({ free: 200 * GB, hold: 'a timed run is in flight here' });
  const hourly = g.r.run('hourly');
  await new Promise((res) => setImmediate(res));
  g.s.free = 40 * GB;
  await g.r.tick();
  assert.deepEqual(g.alone, [], 'held above the floor');
  g.s.free = 10 * GB;
  await g.r.tick();
  assert.deepEqual(
    g.alone,
    ['low-space'],
    'below the floor a hold no longer defers it',
  );
  g.release();
  await hourly;
});

// The w6142 review of #1384 found two race windows; both its probes are kept here.
test('w6044: a tick while a low pass is still reading free space runs nothing alone beside it', async () => {
  let calls = 0;
  let openStat!: () => void;
  const statGate = new Promise<void>((res) => (openStat = res));
  const alone: string[] = [];
  const firsts: boolean[] = [];
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 60 }),
    diskPaths: () => ['F:/'],
    statfs: async () => {
      calls++;
      if (calls === 1) await statGate;
      return { free: 40 * GB, total: 900 * GB };
    },
    pass: async (low) => (firsts.push(low), none),
    consumers: async () => [],
    log: () => undefined,
    done: () => undefined,
    now: () => Date.parse('2026-11-26T16:31:00Z'),
    firstAlone: async (t) => void alone.push(t),
  });
  const asked = r.run('asked');
  await new Promise((res) => setImmediate(res));
  await r.tick();
  openStat();
  await asked;
  assert.deepEqual(firsts, [true]);
  assert.deepEqual(alone, []);
});

test('w6044: a pass waits for the first step alone to end before it starts', async () => {
  let free = 200 * GB;
  let endHourly!: () => void;
  const hourlyGate = new Promise<void>((res) => (endHourly = res));
  let endAlone!: () => void;
  const aloneGate = new Promise<void>((res) => (endAlone = res));
  const passes: boolean[] = [];
  let aloneIn = false;
  const overlap: boolean[] = [];
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 60 }),
    diskPaths: () => ['F:/'],
    statfs: async () => ({ free, total: 900 * GB }),
    pass: async (low) => {
      passes.push(low);
      overlap.push(aloneIn);
      if (passes.length === 1) await hourlyGate;
      return none;
    },
    consumers: async () => [],
    log: () => undefined,
    done: () => undefined,
    now: () => Date.parse('2026-11-26T16:31:00Z'),
    firstAlone: async () => {
      aloneIn = true;
      await aloneGate;
      aloneIn = false;
    },
  });
  const hourly = r.tick();
  await new Promise((res) => setImmediate(res));
  free = 40 * GB;
  const alone = r.tick();
  await new Promise((res) => setImmediate(res));
  endHourly();
  await hourly;
  const asked = r.run('asked');
  await new Promise((res) => setImmediate(res));
  assert.equal(passes.length, 1, 'the asked pass has not started while the alone step runs');
  endAlone();
  await alone;
  await asked;
  assert.deepEqual(passes, [false, true]);
  assert.deepEqual(overlap.filter(Boolean), [], 'no pass ran beside the alone step');
});

test('w6044: firstAlonePass removes a released target with mode on, says it in dry-run, and plans nothing with mode off', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { firstAlonePass } = await import('./staleOutput.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-alone-'));
  try {
    const t = path.join(root, 'ffu-sandboxes', 'slot2', 'target');
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, 'x.rlib'), Buffer.alloc(100));
    const guard = { keep: [], inUse: [], home: path.join(root, 'nobody') };
    let planned = 0;
    const said: (number | undefined)[] = [];
    const first = {
      plan: async () => (planned++, { items: [{ path: t, rule: 'ffu-slot-target', why: 'test' }], listed: [] }),
      report: (_i: unknown, _ms: number, run?: CleanupRun) => void said.push(run?.removed.length),
    };
    assert.equal(await firstAlonePass({ mode: 'off', root: [root], guard, first }), undefined);
    assert.equal(await firstAlonePass({ mode: 'on', guard, first }), undefined, 'no root: nothing');
    assert.equal(planned, 0, 'mode off or no root plans nothing');
    const d = await firstAlonePass({ mode: 'dry-run', root: [root], guard, first });
    assert.equal(planned, 1);
    assert.deepEqual(said, [undefined], 'dry-run: said, not removed');
    assert.equal(d?.removed.length, 0);
    assert.ok(fs.existsSync(t));
    const busy = await firstAlonePass({ mode: 'on', root: [root], guard, first, busyNow: async () => 'taken since the plan' });
    assert.equal(busy?.removed.length, 0, 'a slot taken since the plan keeps its target');
    assert.ok(fs.existsSync(t));
    const kept = await firstAlonePass({ mode: 'on', root: [root], guard: { ...guard, keep: [t] }, first });
    assert.equal(kept?.removed.length, 0, 'a path the guard keeps stays');
    assert.ok(fs.existsSync(t));
    const outside = await firstAlonePass({ mode: 'on', root: [path.join(root, 'elsewhere')], guard, first });
    assert.equal(outside?.removed.length, 0, 'nothing outside the install folder');
    assert.ok(fs.existsSync(t));
    const r = await firstAlonePass({ mode: 'on', root: [root], guard, first });
    assert.deepEqual(r?.removed.map((x) => x.path), [t], 'mode on: the released target goes');
    assert.ok(r!.bytes >= 100);
    assert.ok(!fs.existsSync(t));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
