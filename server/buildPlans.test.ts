import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildPlans, PLAN_MAX_MS, pauseNotice, type BuildDeps, type SeatResult } from './buildPlans.ts';
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
  /** Its sandbox (default slot-<id>). */
  sandbox?: string;
}

function world(ws: W[], o: { moveTo?: Record<string, string | undefined>; moveFails?: string[]; bench?: BenchLock; file?: string; seat?: SeatResult[]; handBack?: BuildDeps['handBack'] } = {}) {
  let now = Date.parse('2026-10-20T05:00:00Z');
  const told: { id: string; text: string }[] = [];
  const notes: string[] = [];
  const moves: { id: string; to: string }[] = [];
  const marked: string[] = [];
  const stopped: string[] = [];
  let kicks = 0;
  const bench = { lock: o.bench };
  const info = (w: W) => ({ id: w.id, kind: 'worker', machineId: w.machine, machineSandbox: w.sandbox ?? `slot-${w.id}`, pendingPermissions: [] }) as unknown as SessionInfo;
  const seats: string[] = [];
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
    stopEditor: async (id) => (stopped.push(id), 'Stopped'),
    notify: (t) => notes.push(t),
    kick: () => void kicks++,
    markBuild: (w) => void marked.push(w.id),
    log: () => {},
    now: () => now,
    ...(o.file ? { file: o.file } : {}),
    ...(o.handBack ? { handBack: o.handBack } : {}),
    ...(o.seat
      ? {
          seat: async (_p, id) => {
            seats.push(id);
            const r = o.seat!.shift() ?? { wait: 'nothing scripted' };
            if (r.moved) ws.find((w) => w.id === id)!.sandbox = 'slot1';
            return r;
          },
        }
      : {}),
  };
  const plans = new BuildPlans(deps);
  return { plans, told, notes, moves, marked, stopped, bench, seats, kicks: () => kicks, at: (min: number) => (now = Date.parse('2026-10-20T05:00:00Z') + min * 60_000), ws };
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
  assert.ok(!t.told.some((x) => x.id === 'builder' || x.id === 'elsewhere'), 'the builder and other computers are not told');
  // w1639: the Live view stays open; its worker is asked only to hold its heavy work, never to stop its editor.
  const view = t.told.filter((x) => x.id === 'viewer');
  assert.equal(view.length, 1);
  assert.match(view[0].text, /Your Live view stays open and your editor runs/);
  assert.match(view[0].text, /start no compile, refresh, test run, player build or batch Unity run/);
  assert.doesNotMatch(view[0].text, /Stop your sandbox's Unity editor|end your turn/i);
  // Paused workers' resumes wait in the send queue; the builder's and the Live view's do not.
  assert.match(t.plans.resumeHold({ id: 'stuck', machineId: 'beast' }) ?? '', /^beast is cleared for a build since 05:10Z \(a player for the w1588 clip, .*\): this worker was paused for it and resumes when it is done \(w1606\)$/);
  assert.match(t.plans.resumeHold({ id: 'busy', machineId: 'beast' }) ?? '', /paused for it/);
  assert.equal(t.plans.resumeHold({ id: 'builder', machineId: 'beast' }), undefined);
  assert.equal(t.plans.resumeHold({ id: 'viewer', machineId: 'beast' }), undefined);
  assert.match(t.notes.at(-1)!, /^\[ledger\] BUILD CLEARING \(w1606\): beast for a player for the w1588 clip\. Moved off it .*: w1500 to lothdesktop\. Asked to pause at a safe point: busy;/);
});

test('w1656: a release build goes at once, waiting neither for workers finishing their step nor for a bench lock (w1628: its ticket queues); done resumes the paused work', async () => {
  const t = world([
    { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1588'] },
    { id: 'busy', machine: 'beast', midTurn: true, requests: ['w1503'] },
    { id: 'idle', machine: 'beast', requests: ['w1501'] },
  ]);
  t.plans.declare({ machine: 'beast', minutes: 0, what: 'the 0.50.0.112 player', builder: 'builder', requests: ['w1588'], by: 'worker builder' });
  await t.plans.tick();
  // w1656, lothsahn: a release build does not wait for other workers to pause; it starts at once and takes the bench first
  // (1.0.0.3 waited 20 minutes for one worker, then behind that worker's test run).
  const first = await t.plans.start('builder', 'beast');
  assert.match(first, /^Go \(w1606\): beast is cleared for the 0\.50\.0\.112 player \(0 moved: none; 2 paused\)/);
  assert.match(first, /busy still finishing their step \(asked at 05:00Z to start no new one\): the release does not wait for them \(w1656\); your bench tickets count as urgent/);
  assert.equal(t.plans.releaseBuilder('beast', 'builder'), true, 'its tickets count as urgent');
  // w1656: the editors of the workers it paused or asked to pause stop at the start (their compile or test run ends,
  // to run again after done); never the builder's.
  assert.deepEqual(t.stopped.sort(), ['busy', 'idle']);
  assert.match(first, /Stopped the editors of (busy, idle|idle, busy) \(w1656/);
  assert.match(t.told.find((x) => x.id === 'busy' && /stopped your sandbox's Unity editor/.test(x.text))!.text, /start your editor again \(mcp__machine__unity start\) and run that step again/);
  assert.equal(t.plans.releaseBuilder('beast', 'busy'), false);
  assert.match(t.told.find((x) => x.id === 'busy')!.text, /start no new one: no compile, refresh, test run, player build or batch Unity run\. The release starts now and takes the bench first \(w1656\)/);
  assert.match(await t.plans.start('idle', 'beast'), /^Not yours/);
  // Its turn ends: it is paused, and the build may go.
  t.ws.find((w) => w.id === 'busy')!.midTurn = false;
  t.at(4);
  await t.plans.tick();
  assert.ok(t.plans.plan('beast')!.paused.includes('busy'));
  // w1628: a timed run holds the bench lock: the build goes anyway, and its own Unity run's shared ticket waits for that
  // leg in the bench queue (a poll for a free lock lost on BEAST, whose lock was never free for 4 minutes on 2026-10-20).
  t.bench.lock = { owner: 'BEAST pid 4121 probe A round 2', since: '2026-10-20T05:03:00.000Z' };
  t.at(40);
  const go = await t.plans.start('builder', 'beast');
  assert.match(go, /^Go \(w1606\): beast is cleared for the 0\.50\.0\.112 player \(0 moved: none; 2 paused\)\. Build now through unity-slot run --label "the 0\.50\.0\.112 player"\./);
  assert.match(go, /On beast, its bench lock is held since 05:03Z \(BEAST pid 4121 probe A round 2\): a timed run: your build takes a shared ticket in its bench queue and starts as soon as that leg \(and any queued before your build\) ends, never beside one/);
  t.bench.lock = undefined;
  assert.doesNotMatch(await t.plans.start('builder', 'beast'), /bench queue/, 'no lock: no queue note');
  // Done: the hold lifts, the queue looks again, the worker paused mid-turn is told to carry on; one paused between turns resumes with its own next message.
  t.at(62);
  const done = await t.plans.done('beast', 'worker builder said it is done');
  assert.match(done, /^Done \(w1606\): beast takes work again; the build took 62 min\. 1 paused worker\(s\) told to carry on; 1 paused between turns/);
  assert.equal(t.plans.releaseBuilder('beast', 'builder'), false, 'no plan: back to its request\'s priority');
  assert.deepEqual(t.plans.holds(), {});
  assert.equal(t.plans.resumeHold({ id: 'idle', machineId: 'beast' }), undefined);
  assert.equal(t.kicks(), 1);
  const carryOn = t.told.filter((x) => /The build on beast is done/.test(x.text)).map((x) => x.id);
  assert.deepEqual(carryOn, ['busy']);
  assert.match(t.notes.at(-1)!, /^\[ledger\] BUILD DONE \(w1606\): the 0\.50\.0\.112 player on beast \(worker builder said it is done; the build took 62 min\)\./);
});

test('w1656: a worker mid-turn is not cut off and not waited for: the build goes at once beside it and says so', async () => {
  const t = world([
    { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1588'] },
    { id: 'long', machine: 'beast', midTurn: true, requests: ['w1503'] },
  ]);
  t.plans.declare({ machine: 'beast', minutes: 0, what: 'a player', builder: 'builder', requests: ['w1588'], by: 'worker builder' });
  await t.plans.tick();
  const go = await t.plans.start('builder', 'beast');
  assert.match(go, /^Go \(w1606\)/);
  assert.match(go, /long still finishing their step .*: the release does not wait for them \(w1656\)/);
  assert.equal(t.plans.plan('beast')!.startedAt, Date.parse('2026-10-20T05:00:00Z'), 'started at once');
  assert.ok(pauseNotice);
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

test('w1668: an urgent release builds in slot1: a builder elsewhere is told to end its turn, moved there, then goes; one in slot1 goes at once', async () => {
  // lothsahn: "Let's make sure that urgent builds always get scheduled in slot1 on whatever machine they run in so that it uses caches as warm as possible."
  const t = world(
    [
      { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1700'], sandbox: 'slot3' },
      { id: 'nightly', machine: 'beast', midTurn: true, requests: ['w1650'], sandbox: 'slot1' },
    ],
    { seat: [{ wait: 'nightly is mid-turn there' }, { wait: 'the builder is mid-turn: it moves once its turn ends' }, { done: 'moved its builder builder from slot3 to slot1 on its branch w1700-rel', moved: true }] },
  );
  t.plans.declare({ machine: 'beast', minutes: 0, what: '1.0.0.5 urgent release', builder: 'builder', requests: ['w1700'], by: 'worker builder' });
  await new Promise((r) => setImmediate(r));
  const p = t.plans.plan('beast')!;
  assert.equal(p.seat?.sandbox, 'slot1', 'the clearing sets the seat for a builder outside slot1');
  const first = await t.plans.start('builder', 'beast');
  assert.match(first, /^Not yet \(w1668\): urgent release builds run in beast\/slot1/);
  assert.match(first, /END YOUR TURN NOW, with no check-in/);
  assert.match(first, /Now: nightly is mid-turn there\.$/);
  assert.equal(p.startedAt, undefined, 'not started until the builder is in slot1');
  await t.plans.tick();
  assert.equal(p.seat?.waiting, 'the builder is mid-turn: it moves once its turn ends');
  t.ws[0].midTurn = false;
  t.ws[0].live = false;
  await t.plans.tick();
  assert.match(p.seat?.done ?? '', /^moved its builder/);
  const seated = t.told.find((x) => x.id === 'builder')!.text;
  assert.match(seated, /^\[FF Factory\] You are in beast\/slot1 now \(w1668/);
  assert.match(seated, /Run `build_plan start` \(release: true\) again/);
  assert.deepEqual(t.seats, ['builder', 'builder', 'builder']);
  assert.match(await t.plans.start('builder', 'beast'), /^Go \(w1606\)/);
  assert.equal(t.seats.length, 3, 'seated: start asks no more');

  // A builder already in slot1: no seat, Go at once.
  const u = world([{ id: 'b1', machine: 'beast', midTurn: true, requests: ['w1701'], sandbox: 'slot1' }], { seat: [] });
  assert.match(await u.plans.start('b1', 'beast'), /^Go \(w1606\)/);
  assert.equal(u.plans.plan('beast')!.seat, undefined);
  assert.deepEqual(u.seats, []);
});

test('w1668: slot1 that cannot be emptied in time: the builder is told to build where it is, and start goes', async () => {
  const t = world([{ id: 'builder', machine: 'beast', midTurn: true, requests: ['w1700'], sandbox: 'slot2' }], { seat: [{ wait: 'a Unity batch run of slot1 is in flight' }, { gaveUp: 'slot1 was not free after 10 min: a Unity batch run of slot1 is in flight' }] });
  assert.match(await t.plans.start('builder', 'beast'), /^Not yet \(w1668\).*Now: a Unity batch run of slot1 is in flight\.$/s);
  await t.plans.tick();
  assert.match(t.told.at(-1)!.text, /^\[FF Factory\] beast\/slot1 could not be emptied for the release build \(w1668\): slot1 was not free after 10 min.*build where you are/);
  assert.match(await t.plans.start('builder', 'beast'), /^Go \(w1606\)/);
  // PlaceAgain keeps slot1 for the builder only while the seat is pending.
  assert.equal(t.plans.seats('beast').size, 0);
});

test('w1668: a builder placed on the computer after its clearing still gets slot1 at its start', async () => {
  const ws: W[] = [];
  const t = world(ws, { seat: [{ wait: 'the builder is mid-turn: it moves once its turn ends' }] });
  t.plans.declare({ machine: 'beast', minutes: 0, what: '1.0.0.6 urgent release', requests: ['w1702'], by: 'the dispatcher' });
  await new Promise((r) => setImmediate(r));
  assert.equal(t.plans.plan('beast')!.seat, undefined, 'no builder there at the clearing');
  ws.push({ id: 'late', machine: 'beast', midTurn: true, requests: ['w1702'], sandbox: 'slot4' });
  assert.match(await t.plans.start('late', 'beast'), /^Not yet \(w1668\)/);
  assert.equal(t.plans.plan('beast')!.seat?.sandbox, 'slot1');
});

test('w1841 (a): the workers a build paused are known until done (their requests show Blocked on it), done tells one told to pause even after it was placed on another computer, and a dead worker with nothing open is not paused', async () => {
  // w1475 and w1768 read Stalled while w1836's 1.0.0.10 build held BEAST; its clearing listed 7819 paused (every worker ever there).
  const t = world([
    { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1836'] },
    { id: '83aa4ecd', machine: 'beast', midTurn: true, requests: ['w1475'] },
    { id: 'idle', machine: 'beast', requests: ['w1501'] },
    { id: 'old', machine: 'beast', live: false, requests: [] },
  ]);
  t.plans.declare({ machine: 'beast', minutes: 30, what: 'the 1.0.0.10 urgent release', builder: 'builder', requests: ['w1836'], by: 'the dispatcher' });
  assert.equal(t.plans.pausedFor('83aa4ecd'), undefined, 'declared, not cleared yet: nobody is paused');
  await t.plans.start('builder', 'beast');
  assert.deepEqual(t.plans.pausedFor('83aa4ecd'), { what: 'the 1.0.0.10 urgent release', machine: 'beast', told: true });
  assert.deepEqual(t.plans.pausedFor('idle'), { what: 'the 1.0.0.10 urgent release', machine: 'beast', told: false });
  assert.equal(t.plans.pausedFor('builder'), undefined, 'not the builder');
  assert.equal(t.plans.pausedFor('old'), undefined, 'a dead worker holding nothing is nobody to pause');
  assert.deepEqual(Object.keys(t.plans.pausedAmong(['83aa4ecd', 'idle', 'old', 'nobody'])).sort(), ['83aa4ecd', 'idle']);
  // Its turn ends with its pause line; its sandbox goes to other work and it is placed again on lothdesktop, not live.
  const w = t.ws.find((x) => x.id === '83aa4ecd')!;
  w.midTurn = false;
  await t.plans.tick();
  w.machine = 'lothdesktop';
  w.live = false;
  t.at(60);
  await t.plans.done('beast');
  assert.ok(t.told.some((x) => x.id === '83aa4ecd' && /The build on beast is done \(w1606\): carry on where you stopped/.test(x.text)), 'it is told to carry on wherever it is');
  assert.equal(t.plans.pausedFor('83aa4ecd'), undefined, 'done: no hold');
});

test('w1856: done puts the release sandbox back on its own branch BEFORE the workers paused there carry on, and says so', async () => {
  const order: string[] = [];
  const t = world(
    [
      { id: 'builder', machine: 'beast', midTurn: true, requests: ['w1836'], sandbox: 'slot1' },
      { id: 'c28c5061', machine: 'beast', midTurn: true, requests: ['w1767'], sandbox: 'slot1' },
    ],
    {
      handBack: async (p, caller) => {
        order.push(`handBack ${p.what} by ${caller}`);
        return ['beast/slot1 is back on w1767-circuit-visibility, off the release branch urgent/1.0.0.12'];
      },
    },
  );
  t.plans.declare({ machine: 'beast', minutes: 0, what: 'the 1.0.0.12 urgent release', builder: 'builder', requests: ['w1836'], by: 'worker builder' });
  await t.plans.start('builder', 'beast');
  const told = t.told.length;
  const answer = await t.plans.done('beast', 'worker builder said it is done', 'builder');
  order.push(...t.told.slice(told).filter((x) => /The build on beast is done/.test(x.text)).map((x) => `told ${x.id}`));
  assert.deepEqual(order, ['handBack the 1.0.0.12 urgent release by builder', 'told c28c5061']);
  assert.match(answer, /Hand-back \(w1856\): beast\/slot1 is back on w1767-circuit-visibility, off the release branch urgent\/1\.0\.0\.12\.$/);
  assert.match(t.notes.at(-1)!, /^\[ledger\] BUILD DONE .*Hand-back \(w1856\): beast\/slot1 is back on w1767-circuit-visibility/);
});

test('w1856: a hand-back that throws still ends the build and says nothing was switched back', async () => {
  const t = world([{ id: 'builder', machine: 'beast', requests: ['w1836'], sandbox: 'slot1' }], {
    handBack: async () => {
      throw new Error("beast's daemon is offline");
    },
  });
  t.plans.declare({ machine: 'beast', minutes: 0, what: 'the 1.0.0.12 urgent release', builder: 'builder', requests: ['w1836'], by: 'worker builder' });
  const answer = await t.plans.done('beast');
  assert.match(answer, /^Done \(w1606\)/);
  assert.match(answer, /the hand-back failed \(beast's daemon is offline\): no sandbox was switched back/);
  assert.deepEqual(t.plans.holds(), {});
});
