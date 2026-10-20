import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD_WAIT_MS, BuildPlans, PLAN_MAX_MS, type BuildDeps } from './buildPlans.ts';
import type { BenchLock, SessionInfo, WorkItem } from '../shared/types.ts';

/**
 * Builds first on BEAST (w1606). Ben, 2026-10-20: "when you know builds are coming up, we also prioritize using beast for
 * builds because its faster. so when it's coming time, move work off beast, or when apropriate, pause work and finish the
 * build, then resume. make this a rule of FFF".
 */

interface W {
  id: string;
  machine: string;
  midTurn?: boolean;
  live?: boolean;
  view?: boolean;
  requests: string[];
}

function world(ws: W[], o: { moveTo?: Record<string, string | undefined>; moveFails?: string[]; bench?: BenchLock; file?: string } = {}) {
  let now = Date.parse('2026-10-20T05:00:00Z');
  const told: { id: string; text: string }[] = [];
  const notes: string[] = [];
  const moves: { id: string; to: string }[] = [];
  const marked: string[] = [];
  let kicks = 0;
  const bench = { lock: o.bench };
  const info = (w: W) => ({ id: w.id, kind: 'worker', machineId: w.machine, machineSandbox: `slot-${w.id}`, pendingPermissions: [] }) as unknown as SessionInfo;
  const deps: BuildDeps = {
    buildMachines: () => ['beast'],
    workersOn: (m) => ws.filter((w) => w.machine === m).map(info),
    isLive: (id) => ws.find((w) => w.id === id)?.live !== false,
    isMidTurn: (i) => !!ws.find((w) => w.id === i.id)?.midTurn,
    openRequestsOf: (id) => (ws.find((w) => w.id === id)?.requests ?? []).map((r) => ({ id: r, needs: 'game' }) as unknown as WorkItem),
    hasView: (id) => !!ws.find((w) => w.id === id)?.view,
    benchLock: () => bench.lock,
    moveTarget: (i) => o.moveTo?.[i.id],
    move: async (id, to) => {
      if (o.moveFails?.includes(id)) throw new Error('lothdesktop has no room for game work now');
      moves.push({ id, to });
      const w = ws.find((x) => x.id === id)!;
      w.machine = to;
      w.live = false;
      return 'Moved';
    },
    tell: (id, text) => told.push({ id, text }),
    notify: (t) => notes.push(t),
    kick: () => void kicks++,
    markBuild: (w) => void marked.push(w.id),
    log: () => {},
    now: () => now,
    ...(o.file ? { file: o.file } : {}),
  };
  const plans = new BuildPlans(deps);
  return { plans, told, notes, moves, marked, bench, kicks: () => kicks, at: (min: number) => (now = Date.parse('2026-10-20T05:00:00Z') + min * 60_000), ws };
}

test('w1606: a build declared coming holds BEAST for new work at once, and clears nothing before it is due', () => {
  const t = world([
    { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1588'] },
    { id: 'waiting', machine: 'beast', requests: ['w1500'] },
  ]);
  const out = t.plans.declare({ machine: 'BEAST', minutes: 20, what: '0.50.0.112 Windows player', builder: 'builder', requests: ['w1588'], by: 'worker builder' });
  assert.match(out, /^Declared \(w1606\): 0\.50\.0\.112 Windows player on beast at 05:20Z\. No new work goes there from now\./);
  assert.deepEqual(Object.keys(t.plans.holds()), ['beast']);
  assert.match(t.plans.holds().beast, /^a build is coming at 05:20Z \(0\.50\.0\.112 Windows player, worker builder for w1588; w1606\): no new work until it is done$/);
  assert.match(t.notes[0], /^\[ledger\] BUILD COMING \(w1606\): worker builder builds 0\.50\.0\.112 Windows player on beast at 05:20Z \(in 20 min\) for w1588\./);
  // Before it is due its workers go on as they are: nothing waits.
  assert.equal(t.plans.resumeHold({ id: 'waiting', machineId: 'beast' }), undefined);
  assert.equal(t.moves.length + t.told.length, 0);
  // Not a build computer: nothing is cleared, and the answer says where builds go.
  assert.match(t.plans.declare({ machine: 'm5', minutes: 0, what: 'x', builder: 'other', requests: [], by: 'worker other' }), /^Builds run first on beast \(config placement\.build, w1606\); m5 is not one of them/);
  assert.equal(t.plans.plan('m5'), undefined);
  // One build at a time there: a second builder is told to wait.
  assert.match(t.plans.declare({ machine: 'beast', minutes: 5, what: 'y', builder: 'waiting', requests: ['w1500'], by: 'worker waiting' }), /^Not now: beast is a build is coming at 05:20Z/);
});

test('w1606: when it is due, BEAST is cleared: workers between turns move first, pause where none can move, mid-turn ones finish their step, a Live view stays', async () => {
  const t = world(
    [
      { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1588'] },
      { id: 'movable', machine: 'beast', requests: ['w1500'] },
      { id: 'stuck', machine: 'beast', requests: ['w1501'] },
      { id: 'failing', machine: 'beast', requests: ['w1502'] },
      { id: 'busy', machine: 'beast', midTurn: true, requests: ['w1503'] },
      { id: 'viewer', machine: 'beast', requests: ['w1466'], view: true },
      { id: 'elsewhere', machine: 'm5', midTurn: true, requests: ['w1504'] },
    ],
    { moveTo: { movable: 'lothdesktop', failing: 'lothdesktop' }, moveFails: ['failing'] },
  );
  t.plans.declare({ machine: 'beast', minutes: 10, what: 'a player for the w1588 clip', builder: 'builder', requests: ['w1588'], by: 'worker builder' });
  t.at(9);
  await t.plans.tick();
  assert.equal(t.plans.plan('beast')!.clearedAt, undefined, 'not due yet');
  t.at(10);
  await t.plans.tick();
  const p = t.plans.plan('beast')!;
  assert.deepEqual(t.moves, [{ id: 'movable', to: 'lothdesktop' }], 'move first');
  assert.deepEqual(p.moved, [{ session: 'movable', to: 'lothdesktop', requests: ['w1500'] }]);
  assert.deepEqual(p.paused.sort(), ['failing', 'stuck'], 'pause where no computer has room, or the move was refused');
  assert.deepEqual(Object.keys(p.told), ['busy'], 'mid-turn: asked, never cut off');
  assert.deepEqual(p.kept.map((k) => k.session), ['viewer']);
  const notice = t.told.find((x) => x.id === 'busy')!.text;
  assert.match(notice, /^\[FF Factory\] BUILD \(w1606\): worker builder builds a player for the w1588 clip on beast now/);
  assert.match(notice, /Commit what is unfinished on your branch .* and push it\./);
  assert.match(notice, /`w1503: paused for the build on beast; <where you stopped>`/);
  assert.ok(!t.told.some((x) => x.id === 'builder' || x.id === 'viewer' || x.id === 'elsewhere'), 'the builder, a Live view and other computers are not told');
  // Paused workers' resumes wait in the send queue; the builder's and the Live view's do not.
  assert.match(t.plans.resumeHold({ id: 'stuck', machineId: 'beast' }) ?? '', /^beast is cleared for a build since 05:10Z \(a player for the w1588 clip, .*\): this worker was paused for it and resumes when it is done \(w1606\)$/);
  assert.match(t.plans.resumeHold({ id: 'busy', machineId: 'beast' }) ?? '', /paused for it/);
  assert.equal(t.plans.resumeHold({ id: 'builder', machineId: 'beast' }), undefined);
  assert.equal(t.plans.resumeHold({ id: 'viewer', machineId: 'beast' }), undefined);
  assert.match(t.notes.at(-1)!, /^\[ledger\] BUILD CLEARING \(w1606\): beast for a player for the w1588 clip\. Moved off it .*: w1500 to lothdesktop\. Asked to pause at a safe point: busy;/);
});

test('w1606: the build waits for workers finishing their step (up to BUILD_WAIT_MS) and for a bench lock (always); then goes; done resumes the paused work', async () => {
  const t = world([
    { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1588'] },
    { id: 'busy', machine: 'beast', midTurn: true, requests: ['w1503'] },
    { id: 'idle', machine: 'beast', requests: ['w1501'] },
  ]);
  t.plans.declare({ machine: 'beast', minutes: 0, what: 'the 0.50.0.112 player', builder: 'builder', requests: ['w1588'], by: 'worker builder' });
  await t.plans.tick();
  assert.match(await t.plans.start('builder', 'beast'), /^Not yet \(w1606\): 1 worker\(s\) on beast were asked at 05:00Z to finish their step and pause \(busy\); none is cut off mid-edit\./);
  assert.match(await t.plans.start('idle', 'beast'), /^Not yours/);
  // Its turn ends: it is paused, and the build may go.
  t.ws.find((w) => w.id === 'busy')!.midTurn = false;
  t.at(4);
  await t.plans.tick();
  assert.ok(t.plans.plan('beast')!.paused.includes('busy'));
  // A timed run took the bench lock meanwhile: the build waits for it, however long it has waited for the workers.
  t.bench.lock = { owner: 'BEAST pid 4121 probe A round 2', since: '2026-10-20T05:03:00.000Z' };
  t.at(40);
  assert.match(await t.plans.start('builder', 'beast'), /^Not yet \(w1606\): on beast, its bench lock is held since 05:03Z \(BEAST pid 4121 probe A round 2\): a timed run, and a build beside it would spoil that run's numbers\./);
  t.bench.lock = undefined;
  assert.match(await t.plans.start('builder', 'beast'), /^Go \(w1606\): beast is cleared for the 0\.50\.0\.112 player \(0 moved: none; 2 paused\)\. Build now through unity-slot run --label "the 0\.50\.0\.112 player"\./);
  // Done: the hold lifts, the queue looks again, the worker paused mid-turn is told to carry on; one paused between turns resumes with its own next message.
  t.at(62);
  const done = t.plans.done('beast', 'worker builder said it is done');
  assert.match(done, /^Done \(w1606\): beast takes work again; the build took 22 min\. 1 paused worker\(s\) told to carry on; 1 paused between turns/);
  assert.deepEqual(t.plans.holds(), {});
  assert.equal(t.plans.resumeHold({ id: 'idle', machineId: 'beast' }), undefined);
  assert.equal(t.kicks(), 1);
  const carryOn = t.told.filter((x) => /The build on beast is done/.test(x.text)).map((x) => x.id);
  assert.deepEqual(carryOn, ['busy']);
  assert.match(t.notes.at(-1)!, /^\[ledger\] BUILD DONE \(w1606\): the 0\.50\.0\.112 player on beast \(worker builder said it is done; the build took 22 min\)\./);
});

test('w1606: a worker still mid-turn after BUILD_WAIT_MS is not cut off: the build goes ahead beside it and says so', async () => {
  const t = world([
    { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1588'] },
    { id: 'long', machine: 'beast', midTurn: true, requests: ['w1503'] },
  ]);
  t.plans.declare({ machine: 'beast', minutes: 0, what: 'a player', builder: 'builder', requests: ['w1588'], by: 'worker builder' });
  await t.plans.tick();
  t.at(BUILD_WAIT_MS.value / 60_000 + 1);
  const go = await t.plans.start('builder', 'beast');
  assert.match(go, /^Go \(w1606\)/);
  assert.match(go, /long did not end its turn in 20 minutes; the build goes ahead beside it, a little slower\./);
});

test('w1606: the dispatcher declares a build for a request; its worker is the builder; a plan nobody ends is ended after PLAN_MAX_MS', async () => {
  const t = world([
    { id: 'rel', machine: 'beast', midTurn: true, requests: ['w1588'] },
    { id: 'idle', machine: 'beast', requests: ['w1501'] },
  ]);
  t.plans.declare({ machine: 'beast', minutes: 15, what: 'the release build', requests: ['w1588'], by: 'the dispatcher' });
  t.at(15);
  await t.plans.tick();
  assert.equal(Object.keys(t.plans.plan('beast')!.told).length, 0, 'the worker serving w1588 is the builder');
  assert.match(await t.plans.start('rel', 'beast'), /^Go/);
  t.at(15 + PLAN_MAX_MS.value / 60_000 + 1);
  await t.plans.tick();
  assert.equal(t.plans.plan('beast'), undefined);
  assert.match(t.notes.at(-1)!, /not ended 180 min after it was due, so FF Factory ended it/);
});

test('w1606: a plan survives a portal restart (data/builds.json), so paused work is still resumed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1606-'));
  const file = path.join(dir, 'builds.json');
  const a = world([{ id: 'b', machine: 'beast', requests: ['w1'] }], { file });
  a.plans.declare({ machine: 'beast', minutes: 30, what: 'a player', builder: 'b', requests: ['w1'], by: 'worker b' });
  const b = world([], { file });
  assert.equal(b.plans.restore(), 1);
  assert.match(b.plans.holds().beast, /^a build is coming at 05:30Z \(a player, worker b for w1; w1606\)/);
});
