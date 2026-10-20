import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsBuild, needsTimed } from '../shared/capacity.ts';
import { capacityLines, pickComputer, pickTimed, type Computer } from './placement.ts';
import { BuildPlans, type BuildDeps } from './buildPlans.ts';
import { readBenchQueue, writeBenchPriorities } from '../machine/benchLock.ts';
import type { BenchQueueReport, WorkItem } from '../shared/types.ts';

/**
 * w1628, lothsahn's three bench-queue answers and two corrections, 2026-10-20:
 * - "Yes, let's make the change you recommend to move things off when there are timed runs": a release build passes over
 *   a build computer with a timed leg running or waiting in its bench queue.
 * - "Ben's guidance was only supposed to be for release builds of the software, not all builds that workers do when
 *   making fixes": a worker's own player build is placed like any game work.
 * - "We should also prefer boxes with a small number of slots and players for timed runs, not beast since it's big".
 */

const GB = 1024 ** 3;
const box = (id: string, maxSandboxes: number, platform: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 1, midTurn: 0, maxAgents: 2 * maxSandboxes, sandboxes: 1, maxSandboxes, freeSandboxes: 1, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 1, maxEditors: 2, platform, ...o });
const timed = (n: number, first = 'probe A round 1'): BenchQueueReport => ({ timed: n, first });
const work = (title: string, brief = ''): WorkItem => ({ title, brief, notes: [], needs: 'game' }) as unknown as WorkItem;

test('w1628: only a release build is build work; timed work is told by its words, with the platform it names', () => {
  assert.equal(needsBuild(work('Cut the 0.50.0.112 release build')), true);
  assert.equal(needsBuild(work('w1588: ci-release for 1.0.0.12')), true);
  for (const t of ['Fix the belt stall', 'Record a 60 fps clip of the comet', 'Windows player build for the w1475 clip', 'MP check with a Mac build']) assert.equal(needsBuild(work(t)), false, t);
  assert.equal(needsTimed(work('Perf A/B of the belt cache', 'probe_ab_win.sh, 4 rounds')), 'win32');
  assert.equal(needsTimed(work('Benchmark the spatial map on the Mac')), 'darwin');
  assert.equal(needsTimed(work('Frame time regression after w1572')), 'any');
  for (const t of ['Record a 60 fps clip of the comet', 'Fix the belt stall', 'Improve performance notes in the docs']) assert.equal(needsTimed(work(t)), false, t);
});

test('w1628: a release build passes over BEAST while a timed leg runs or waits there, and goes back to it once none does', () => {
  const beast = box('beast', 8, 'win32', { benchQueue: timed(2) });
  const loth = box('lothdesktop', 4, 'win32');
  const away = pickComputer([beast, loth], undefined, {}, 'game', false, 'build')!;
  assert.equal(away.pick.id, 'lothdesktop');
  assert.match(away.why, /beast has 2 timed runs in its bench queue, running or waiting \(the first: probe A round 1\) \(w1628: release builds go elsewhere meanwhile\)/);
  assert.equal(pickComputer([{ ...beast, benchQueue: undefined }, loth], undefined, {}, 'game', false, 'build')!.pick.id, 'beast');
  // Every computer has one: the general placement still answers.
  assert.ok(pickComputer([beast, { ...loth, benchQueue: timed(1) }], undefined, {}, 'game', false, 'build'));
});

test('w1628: timed work goes to the smallest computer with room and no timed leg queued, BEAST last, on the platform it names', () => {
  const beast = box('beast', 8, 'win32', { live: 0, editors: 0 });
  const loth = box('lothdesktop', 4, 'win32', { live: 3, editors: 2 });
  const m3 = box('m3', 2, 'darwin');
  assert.equal(pickTimed([beast, loth, m3], {}, 'timed')!.pick.id, 'm3', 'smallest first, whatever its live agents');
  assert.equal(pickTimed([beast, loth, m3], {}, 'timed:win32')!.pick.id, 'lothdesktop', 'a Windows run stays on Windows');
  assert.equal(pickTimed([beast, loth, m3], {}, 'timed:darwin')!.pick.id, 'm3');
  // A computer whose queue already holds a timed leg comes after one with none: the leg would wait there.
  assert.equal(pickTimed([beast, { ...loth, benchQueue: timed(1) }, m3], {}, 'timed:win32')!.pick.id, 'beast');
  // Busy, held or avoided computers are passed over; none left: the general placement, said so.
  assert.equal(pickTimed([beast, { ...loth, live: 8 }], {}, 'timed:win32')!.pick.id, 'beast');
  assert.equal(pickTimed([beast, loth], { hold: { lothdesktop: 'a build' } }, 'timed:win32')!.pick.id, 'beast');
  assert.equal(pickTimed([beast, loth], {}, 'timed:darwin'), undefined);
  assert.match(pickComputer([beast, loth], undefined, {}, 'game', false, 'timed:darwin')!.why, /^timed work, but no computer on darwin has room; so the general placement/);
  assert.match(pickComputer([beast, loth, m3], undefined, {}, 'game', false, 'timed')!.why, /prefer boxes with a small number of slots and players for timed runs, not beast/);
  assert.ok(capacityLines([beast, loth, m3]).some((l) => /^Next timed work \(benchmarks, perf A\/Bs and probes; on the platform it names, w1628\): m3 /.test(l)));
});

function plans(queue: Record<string, BenchQueueReport | undefined>, target: string | undefined) {
  const deps: BuildDeps = {
    buildMachines: () => ['beast', 'lothdesktop'],
    workersOn: () => [],
    isLive: () => false,
    isMidTurn: () => false,
    openRequestsOf: () => [],
    hasView: () => false,
    benchLock: () => undefined,
    benchQueue: (id) => queue[id],
    releaseTarget: () => target,
    moveTarget: () => undefined,
    move: async () => 'Moved',
    tell: () => {},
    notify: () => {},
    log: () => {},
    now: () => Date.parse('2026-10-20T18:00:00Z'),
  };
  return new BuildPlans(deps);
}

test('w1628: a release build declared on BEAST while a timed leg is there is sent where the release placement points', () => {
  const p = plans({ beast: timed(1, 'w1440 probe B round 2') }, 'lothdesktop');
  const out = p.declare({ machine: 'beast', minutes: 10, what: '1.0.0.12 Windows player', builder: 's1', requests: ['w1588'], by: 'worker s1' });
  assert.match(out, /^Not on beast \(w1628\): it has 1 timed run in its bench queue, running or waiting \(the first: w1440 probe B round 2\), and a release build goes elsewhere meanwhile\. Build it on lothdesktop: ask the dispatcher to move this work there \(stop_agent move_to lothdesktop\)/);
  assert.equal(p.plan('beast'), undefined, 'nothing is held or cleared on beast');
  // The dispatcher, for a request: told the machine to name.
  assert.match(plans({ beast: timed(1) }, 'lothdesktop').declare({ machine: 'beast', minutes: 0, what: 'x', requests: ['w1588'], by: 'the dispatcher' }), /Build it on lothdesktop: build_plan coming with machine lothdesktop/);
  // Nowhere else has room: it is declared there, and waits for the legs in the bench queue.
  const stay = plans({ beast: timed(1) }, 'beast').declare({ machine: 'beast', minutes: 10, what: 'x', builder: 's1', requests: [], by: 'worker s1' });
  assert.match(stay, /^Declared \(w1606\): x on beast at 18:10Z\. beast has 1 timed run in its bench queue.*no other computer has room for a release build: the build waits for those legs in its bench queue, never beside one\./);
  // No timed leg: as before.
  assert.match(plans({}, 'lothdesktop').declare({ machine: 'beast', minutes: 10, what: 'x', builder: 's1', requests: [], by: 'worker s1' }), /^Declared \(w1606\): x on beast at 18:10Z\. No new work/);
});

test('w1628: the daemon reports the timed legs in its queue, running or waiting, and writes each worker\'s request priority for it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1628-q-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readBenchQueue(root), undefined, 'no queue');
  const q = path.join(root, 'tmp', 'bench.queue');
  const put = (name: string, mode: string, what: string, pid: number, extra: Record<string, string> = {}) => {
    fs.mkdirSync(path.join(q, name), { recursive: true });
    fs.writeFileSync(path.join(q, name, 'info.json'), JSON.stringify({ mode, what, pid }));
    for (const [f, v] of Object.entries(extra)) fs.writeFileSync(path.join(q, name, f), v);
  };
  const alive = (pid: number) => pid !== 999;
  put('t00000001', 'shared', 'a build', 1);
  assert.equal(readBenchQueue(root, alive), undefined, 'a shared ticket is not a timed run');
  put('t00000002', 'exclusive', 'probe A round 1', 2, { granted: JSON.stringify({ at: 'x', ts: 1 }) });
  put('t00000003', 'exclusive', 'probe B round 1', 3);
  put('t00000004', 'exclusive', 'its helper is gone', 999);
  put('t00000005', 'exclusive', 'revoked', 5, { revoked: JSON.stringify({ at: 'x', why: 'overdue' }) });
  assert.deepEqual(readBenchQueue(root, alive), { timed: 2, first: 'probe A round 1' });

  const file = writeBenchPriorities(root, { s1: { priority: 'high', requests: ['w1628'] } }, new Date('2026-10-20T18:00:00Z'))!;
  assert.equal(file, path.join(q, 'priorities.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: '2026-10-20T18:00:00.000Z', sessions: { s1: { priority: 'high', requests: ['w1628'] } } });
  assert.equal(writeBenchPriorities(undefined, {}), undefined);
});
