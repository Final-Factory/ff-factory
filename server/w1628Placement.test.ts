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

test('w1628: only a release build is build work (w1639: only an urgent one); timed work is told by its words, with the platform it names', () => {
  // w1639, lothsahn: "Release builds should be handed by ffbox ... a release (ffbox) or a quick or urgent release (beast,
  // if offline, LothDesktop)": a normal release builds nothing on these computers.
  assert.equal(needsBuild(work('Cut the 0.50.0.112 release build')), false);
  assert.equal(needsBuild(work('w1588: ci-release for 1.0.0.12')), false);
  assert.equal(needsBuild(work('Urgent release of 1.0.0.12')), true);
  assert.equal(needsBuild(work('Lothsahn: quick release please', 'ci-release, the urgent lane')), true);
  for (const t of ['Fix the belt stall', 'Record a 60 fps clip of the comet', 'Windows player build for the w1475 clip', 'MP check with a Mac build']) assert.equal(needsBuild(work(t)), false, t);
  assert.equal(needsTimed(work('Perf A/B of the belt cache', 'probe_ab_win.sh, 4 rounds')), 'win32');
  assert.equal(needsTimed(work('Benchmark the spatial map on the Mac')), 'darwin');
  assert.equal(needsTimed(work('Frame time regression after w1572')), 'any');
  for (const t of ['Record a 60 fps clip of the comet', 'Fix the belt stall', 'Improve performance notes in the docs']) assert.equal(needsTimed(work(t)), false, t);
});

test('w1639 (was w1628): an urgent release stays on BEAST with a timed leg queued there, and goes to LothDesktop only when BEAST is offline', () => {
  const beast = box('beast', 8, 'win32', { benchQueue: timed(2) });
  const loth = box('lothdesktop', 4, 'win32');
  const stay = pickComputer([beast, loth], undefined, {}, 'game', false, 'build')!;
  assert.equal(stay.pick.id, 'beast');
  assert.match(stay.why, /it has 2 timed runs in its bench queue, running or waiting \(the first: probe A round 1\): the release's exclusive tickets go first after the leg running now/);
  const off = pickComputer([{ ...beast, online: false }, loth], undefined, {}, 'game', false, 'build')!;
  assert.equal(off.pick.id, 'lothdesktop');
  assert.match(off.why, /^Urgent release work goes to the first with room in placement\.build \(beast > lothdesktop/);
  // BEAST online but full: the general placement answers, and the note says an urgent release clears BEAST first.
  const full = pickComputer([{ ...beast, freeSandboxes: 0, sandboxes: 8 }, { ...loth, online: false }, box('m3', 2, 'darwin')], undefined, {}, 'game', false, 'build')!;
  assert.match(full.why, /beast is busy \(no free sandbox .*\): an urgent release clears it first \(build_plan coming with its work_id\), then goes there/);
});

test('w1628: timed work goes to the smallest computer with room and no timed leg queued, BEAST last, on the platform it names', () => {
  const beast = box('beast', 8, 'win32', { live: 0, editors: 0 });
  const loth = box('lothdesktop', 4, 'win32', { live: 3, editors: 2 });
  const m3 = box('m3', 2, 'darwin');
  assert.equal(pickTimed([beast, loth, m3], {}, 'timed')!.pick.id, 'm3', 'smallest first, whatever its live agents');
  assert.equal(pickTimed([beast, loth, m3], {}, 'timed:win32')!.pick.id, 'lothdesktop', 'a Windows run stays on Windows');
  assert.equal(pickTimed([beast, loth, m3], {}, 'timed:darwin')!.pick.id, 'm3');
  // w1872: size first, then live agents, then queued legs: a leg queued on the smaller computer waits there rather than
  // locking BEAST (was w1628: a computer with a queued leg came after one with none).
  assert.equal(pickTimed([beast, { ...loth, benchQueue: timed(1) }, m3], {}, 'timed:win32')!.pick.id, 'lothdesktop');
  // Busy, held or avoided computers are passed over; none left: the general placement, said so.
  assert.equal(pickTimed([beast, { ...loth, live: 8, midTurn: 8 }], {}, 'timed:win32')!.pick.id, 'beast');
  assert.equal(pickTimed([beast, loth], { hold: { lothdesktop: 'a build' } }, 'timed:win32')!.pick.id, 'beast');
  assert.equal(pickTimed([beast, loth], {}, 'timed:darwin'), undefined);
  assert.match(pickComputer([beast, loth], undefined, {}, 'game', false, 'timed:darwin')!.why, /^timed work, but no computer on darwin has room; so the general placement/);
  assert.match(pickComputer([beast, loth, m3], undefined, {}, 'game', false, 'timed')!.why, /machines that have a smaller number of editors or slots"\): m3 \(large, 4 agent slots, 2 editors, 1 live\) > lothdesktop .* > beast /);
  assert.ok(capacityLines([beast, loth, m3]).some((l) => /^Next timed work \(benchmarks, perf A\/Bs and probes; on the platform it names, w1628\): m3 /.test(l)));
});

function plans(queue: Record<string, BenchQueueReport | undefined>, target: string | undefined, offline: string[] = []) {
  const deps: BuildDeps = {
    machineOnline: (id) => !offline.includes(id),
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

test('w1639 (was w1628): an urgent release declared on BEAST with a timed leg there stays there; an offline BEAST names LothDesktop', () => {
  const p = plans({ beast: timed(1, 'w1440 probe B round 2') }, 'lothdesktop');
  const out = p.declare({ machine: 'beast', minutes: 10, what: '1.0.0.12 urgent release', builder: 's1', requests: ['w1639'], by: 'worker s1' });
  assert.match(out, /^Declared \(w1606\): 1\.0\.0\.12 urgent release on beast at 18:10Z\. beast has 1 timed run in its bench queue, running or waiting \(the first: w1440 probe B round 2\): the release's exclusive tickets, at its request's urgent priority, go first after the leg running now, never beside one\./);
  assert.ok(p.plan('beast'), 'beast is held for it');
  // BEAST offline: refused, naming LothDesktop, for a worker and for the dispatcher.
  const off = plans({}, 'lothdesktop', ['beast']);
  assert.match(off.declare({ machine: 'beast', minutes: 0, what: 'x', builder: 's1', requests: [], by: 'worker s1' }), /^Not on beast \(w1639\): it is offline\. An urgent release builds on lothdesktop then: ask the dispatcher to move this work there \(stop_agent move_to lothdesktop\)/);
  assert.match(off.declare({ machine: 'beast', minutes: 0, what: 'x', requests: ['w1639'], by: 'the dispatcher' }), /build_plan coming with machine lothdesktop, and place its request there/);
  assert.equal(off.plan('beast'), undefined, 'nothing is held on an offline beast');
  assert.match(plans({}, undefined, ['beast', 'lothdesktop']).declare({ machine: 'beast', minutes: 0, what: 'x', requests: [], by: 'the dispatcher' }), /No build computer \(beast, lothdesktop\) is online/);
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
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: '2026-10-20T18:00:00.000Z', sessions: { s1: { priority: 'high', requests: ['w1628'] } } }, 'w1832: an older portal sends no singleWorker, so the file stays v 1 and the queue keeps its pre-empt rule');
  writeBenchPriorities(root, { s1: { priority: 'high', requests: ['w1628'] } }, new Date('2026-10-20T18:00:00Z'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: '2026-10-20T18:00:00.000Z', v: 2, single_worker: false, sessions: { s1: { priority: 'high', requests: ['w1628'] } } });
  // w1832: the exempt marks and the single-worker flag, which bench_queue.py reads (v 2)
  writeBenchPriorities(root, { s2: { priority: 'urgent', requests: ['w9'], exempt: 'release' } }, new Date('2026-10-23T08:00:00Z'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: '2026-10-23T08:00:00.000Z', v: 2, single_worker: true, sessions: { s2: { priority: 'urgent', requests: ['w9'], exempt: 'release' } } });
  assert.equal(writeBenchPriorities(undefined, {}), undefined);
});
