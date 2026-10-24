import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchLockDir } from '../machine/benchLock.ts';
import { benchQueueDir } from '../machine/benchQueue.ts';
import { readBenchState } from '../machine/benchState.ts';
import { UnitySlots } from '../machine/unitySlots.ts';
import { editorSlotRefusal, queueWaitsAll } from '../shared/queueWaits.ts';
import { workLive, type WorkLiveFacts } from '../shared/workState.ts';
import { liveLine } from './work.ts';
import type { BenchState, MachineStats, SessionInfo, UnitySlotsReport, WorkItem } from '../shared/types.ts';

/**
 * w1949 (lothsahn, 2026-10-23: "Show those requests as blocked, with the existing blocked state in the request list, and
 * clearly indicate that they're blocked on the exclusive lock"): w1898, w1893 and w1891 showed Working while their workers
 * sat in `bench_queue.py` behind exclusive ticket t00000911 on LothDesktop. The wait is read from the queue's own files as the
 * daemon reports them (machine/benchState.ts waiters), never from what the worker says.
 */

const NOW = Date.parse('2026-10-23T23:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const sec = (minAgo: number) => (NOW - minAgo * 60_000) / 1000;

const tmp = (t: { after(fn: () => void): void }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w1949-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** A ticket folder as bench_queue.py writes it; `granted` in seconds. */
function ticket(root: string, name: string, info: object, created: number, granted?: number) {
  const d = path.join(benchQueueDir(benchLockDir(root)), name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'info.json'), JSON.stringify({ ticket: name, pid: 555, created: ago(created), ...info }));
  if (granted) fs.writeFileSync(path.join(d, 'granted'), JSON.stringify({ at: new Date(granted * 1000).toISOString(), ts: granted }));
}
const grant = (root: string, name: string, granted: number) =>
  fs.writeFileSync(path.join(benchQueueDir(benchLockDir(root)), name, 'granted'), JSON.stringify({ at: new Date(granted * 1000).toISOString(), ts: granted }));
const drop = (root: string, name: string) => fs.rmSync(path.join(benchQueueDir(benchLockDir(root)), name), { recursive: true, force: true });
const alive = (pid: number) => pid === 555;

const item = (id: string, o: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `Request ${id}`,
  brief: 'Do it.',
  priority: 'high',
  keys: [],
  requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' },
  requesters: [{ userId: 'lothsahn', displayName: 'Lothsahn' }],
  humanAsked: true,
  status: 'active',
  createdAt: ago(600),
  updatedAt: ago(30),
  sessionIds: [],
  overlaps: [],
  asks: 0,
  log: [],
  ...o,
});
const session = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: `worker ${id}`,
  status: 'running',
  permissionMode: 'default',
  createdAt: ago(600),
  lastActivityAt: ago(1),
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  machineId: 'lothdesktop',
  ...o,
});
const live = (w: WorkItem, sessions: SessionInfo[], stats: Record<string, Pick<MachineStats, 'bench' | 'unity'>>) => {
  const f: WorkLiveFacts = { items: [w], session: (id) => sessions.find((s) => s.id === id), queueWaits: queueWaitsAll(stats), now: NOW };
  return workLive(w, f)!;
};

test('w1949: a worker waiting behind an exclusive bench ticket shows Blocked on the exclusive lock, then Working once its ticket is granted', (t) => {
  const root = tmp(t);
  // t00000911: w1908's timed run holds LothDesktop's lock; w1891's and w1893's timed legs wait behind it, in that order.
  ticket(root, 't00000911', { mode: 'exclusive', what: 'timed: w1908 A/B', session: 'aaaa1111', requests: ['w1908'] }, 40, sec(25));
  ticket(root, 't00000912', { mode: 'exclusive', what: 'timed: RoundRobin belt A/B', session: 'bbbb2222', requests: ['w1891'] }, 20);
  ticket(root, 't00000913', { mode: 'exclusive', what: 'timed: inventory claims Transfer A/B', session: 'cccc3333', requests: ['w1893'] }, 10);
  const bench = readBenchState(root, NOW, alive)!;
  assert.deepEqual(
    bench.waiters?.map((x) => [x.ticket, x.session, x.ahead]),
    [
      ['t00000912', 'bbbb2222', 0],
      ['t00000913', 'cccc3333', 1],
    ],
    'the daemon reports every waiter with its place',
  );

  const w = item('w1893', { sessionIds: ['cccc3333'] });
  const s = session('cccc3333', { activeTool: { id: 't', name: 'Bash', since: ago(10) } });
  const l = live(w, [s], { lothdesktop: { bench } });
  assert.equal(l.state, 'blocked');
  assert.deepEqual(l.waitsOn, ['the exclusive bench lock on lothdesktop (held by w1908 / t00000911 since 22:35 UTC, 1 ahead in queue)']);
  assert.match(l.why, /^cccc3333 waits in lothdesktop's bench queue for an exclusive ticket t00000913 \(timed: inventory claims Transfer A\/B\), waiting since 22:50 UTC; it shows Working again by itself once the ticket is granted$/);
  assert.match(liveLine(l), /^Blocked on the exclusive bench lock on lothdesktop \(held by w1908 \/ t00000911/);
  // The bug: with no queue state, mid-turn in that wait read as Working.
  assert.equal(workLive(w, { items: [w], session: () => s, now: NOW })?.state, 'working');

  // Stopped with only a check-in while its ticket waits (a run it left going): Blocked too, not Working.
  const stopped = session('cccc3333', { status: 'idle', wakeAt: new Date(NOW + 20 * 60_000).toISOString(), wakeNote: 'timed leg' });
  assert.equal(live(w, [stopped], { lothdesktop: { bench } }).state, 'blocked');

  // t00000911 ends, t00000912 runs, t00000913 is next: still Blocked, now behind w1891, next in queue.
  drop(root, 't00000911');
  grant(root, 't00000912', sec(1));
  const next = live(w, [s], { lothdesktop: { bench: readBenchState(root, NOW, alive)! } });
  assert.deepEqual(next.waitsOn, ['the exclusive bench lock on lothdesktop (held by w1891 / t00000912 since 22:59 UTC, next in queue)']);

  // Its ticket is granted: Working again, by itself, with nothing said by the worker.
  drop(root, 't00000912');
  grant(root, 't00000913', sec(0));
  const after = readBenchState(root, NOW, alive)!;
  assert.equal(after.waiters, undefined);
  assert.equal(live(w, [s], { lothdesktop: { bench: after } }).state, 'working');
  assert.equal(live(w, [stopped], { lothdesktop: { bench: after } }).state, 'working', 'its check-in brings it back');
});

test('w1949: a wait behind shared holders says it is a shared lock; another worker of the request still working keeps it Working', () => {
  const bench: BenchState = {
    mode: 'shared',
    running: [
      { ticket: 't00000001', mode: 'shared', what: 'unity: build slot1', session: 'dddd4444', requests: ['w1800'], since: ago(5) },
      { ticket: 't00000002', mode: 'shared', what: 'running editor slot3', sandbox: 'slot3', since: ago(3) },
    ],
    runningCount: 2,
    waiting: 2,
    waiters: [
      { ticket: 't00000003', mode: 'exclusive', what: 'timed: radius leg', session: 'eeee5555', requests: ['w1898'], since: ago(2), ahead: 0 },
      { ticket: 't00000004', mode: 'shared', what: 'unity: build slot2', session: 'ffff6666', requests: ['w1700'], since: ago(1), ahead: 1 },
    ],
  };
  const ex = live(item('w1898', { sessionIds: ['eeee5555'] }), [session('eeee5555')], { beast: { bench } });
  assert.equal(ex.state, 'blocked');
  assert.match(ex.waitsOn![0], /^the shared bench lock on beast \(a shared lock, held by 2 shared tickets: w1800 \/ t00000001, slot3's editor \/ t00000002; an exclusive ticket waits for all of them to finish; next in queue\)$/);
  const sh = live(item('w1700', { sessionIds: ['ffff6666'] }), [session('ffff6666')], { beast: { bench } });
  assert.match(sh.waitsOn![0], /^the shared bench lock on beast \(a shared lock, .*; behind the exclusive ticket w1898 \/ t00000003, which waits for them; 1 ahead in queue\)$/);
  // Two workers on it mid-turn, one of them not waiting: Working.
  const two = item('w1898', { sessionIds: ['eeee5555', 'gggg7777'] });
  assert.equal(live(two, [session('eeee5555'), session('gggg7777')], { beast: { bench } }).state, 'working');
});

test('w1949: a Unity slot wait and a queued sandbox editor start show Blocked with their own reasons; only for work that needs an editor', () => {
  const unity: UnitySlotsReport = {
    limit: 3,
    used: 3,
    interactive: 2,
    batch: 1,
    outside: 0,
    players: 0,
    overLimit: false,
    ramLimitPct: 90,
    waiting: [{ label: 'build host player', count: 1, holder: 'sandbox:slot2', since: ago(4), why: 'needs 1, 0 free (3 of 3 in use)', session: 'hhhh8888', position: 1 }],
    granted: [],
    at: ago(0),
  };
  const slot = live(item('w1898', { sessionIds: ['hhhh8888'] }), [session('hhhh8888')], { lothdesktop: { unity } });
  assert.equal(slot.state, 'blocked');
  assert.deepEqual(slot.waitsOn, ['a Unity editor slot on lothdesktop (3 of 3 in use, next in queue)']);
  assert.match(slot.why, /^hhhh8888 waits on lothdesktop for 1 Unity slot for "build host player", waiting since 22:56 UTC: needs 1, 0 free/);
  // Stopped with only a check-in while that run waits for its slot: Blocked too.
  const stoppedSlot = session('hhhh8888', { status: 'idle', wakeAt: new Date(NOW + 15 * 60_000).toISOString(), wakeNote: 'build done?' });
  assert.deepEqual(live(item('w1898', { sessionIds: ['hhhh8888'] }), [stoppedSlot], { lothdesktop: { unity } }).waitsOn, ['a Unity editor slot on lothdesktop (3 of 3 in use, next in queue)']);

  // Its sandbox editor's start waits in the bench queue behind a timed run; the worker stopped with a check-in.
  const bench: BenchState = {
    mode: 'exclusive',
    running: [{ ticket: 't00000911', mode: 'exclusive', what: 'timed: w1908 A/B', session: 'aaaa1111', requests: ['w1908'], since: ago(25) }],
    runningCount: 1,
    waiting: 1,
    waiters: [{ ticket: 't00000920', mode: 'shared', what: 'running editor slot4', sandbox: 'slot4', since: ago(3), ahead: 0 }],
  };
  const checkIn = { status: 'idle' as const, machineSandbox: 'slot4', wakeAt: new Date(NOW + 10 * 60_000).toISOString(), wakeNote: 'editor up?' };
  const ed = live(item('w1891', { sessionIds: ['iiii9999'] }), [session('iiii9999', checkIn)], { lothdesktop: { bench } });
  assert.equal(ed.state, 'blocked');
  assert.match(ed.waitsOn![0], /^the exclusive bench lock on lothdesktop \(held by w1908 \/ t00000911/);
  assert.match(ed.why, /^its sandbox slot4's editor start waits in lothdesktop's bench queue for a shared ticket t00000920 \(running editor slot4\)/);
  // Mid-turn it does what needs no editor meanwhile: Working. A request that needs no editor beside it: not its wait.
  assert.equal(live(item('w1891', { sessionIds: ['iiii9999'] }), [session('iiii9999', { machineSandbox: 'slot4' })], { lothdesktop: { bench } }).state, 'working');
  assert.equal(live(item('w1949', { sessionIds: ['iiii9999'], needs: 'agent' }), [session('iiii9999', checkIn)], { lothdesktop: { bench } }).state, 'working');
  // Another sandbox's editor start is no wait of this worker's.
  assert.equal(live(item('w1891', { sessionIds: ['iiii9999'] }), [session('iiii9999', { ...checkIn, machineSandbox: 'slot1' })], { lothdesktop: { bench } }).state, 'working');
});

test('w1949: a worker stopped with a check-in after its editor start was refused for want of a Unity slot shows Blocked on the slot, Working once one is free', async (t) => {
  // The refusal as the machine's slot gate words it (RAM at its cap: no launch is granted), then its report.
  let ram = 97;
  const slots = new UnitySlots({ dir: tmp(t), platform: 'win32', procs: async () => [], alive: () => true, now: () => NOW, limit: () => 3, places: () => [], ramPct: () => ram, ramLimitPct: 90 });
  const refusal = (await slots.startRefusal('sandbox:slot4')) ?? '';
  assert.match(refusal, /^not started: RAM 97% used/);
  const why = editorSlotRefusal(refusal)!;
  assert.match(why, /^RAM 97% used; new Unity launches wait below 90%/);
  assert.equal(editorSlotRefusal('not started: disk space is low on V:/ffw; new editors wait until space is freed'), undefined, 'not a slot wait');

  const refused = { machine: 'lothdesktop', sandbox: 'slot4', at: ago(4), why };
  const checkIn = { status: 'idle' as const, machineSandbox: 'slot4', wakeAt: new Date(NOW + 10 * 60_000).toISOString(), wakeNote: 'start the editor again', editorRefused: refused };
  const w = item('w1891', { sessionIds: ['jjjj0000'] });
  const full = live(w, [session('jjjj0000', checkIn)], { lothdesktop: { unity: slots.report() } });
  assert.equal(full.state, 'blocked');
  assert.deepEqual(full.waitsOn, ['a Unity editor slot on lothdesktop (0 of 3 in use, RAM 97%, new launches wait below 90%)']);
  assert.match(full.why, /^jjjj0000 waits for a Unity slot on lothdesktop: its start of sandbox slot4's editor, refused at 22:56 UTC \(RAM 97% used\); its check-in tries again/);
  assert.match(liveLine(full), /^Blocked on a Unity editor slot on lothdesktop/);

  // Every slot in use, by the report's counts: the same.
  const busy: UnitySlotsReport = { ...slots.report()!, ramPct: 40, used: 3 };
  assert.deepEqual(live(w, [session('jjjj0000', checkIn)], { lothdesktop: { unity: busy } }).waitsOn, ['a Unity editor slot on lothdesktop (3 of 3 in use)']);
  // A slot frees: Working (its check-in comes to start it).
  ram = 40;
  await slots.tick();
  assert.equal(live(w, [session('jjjj0000', checkIn)], { lothdesktop: { unity: slots.report() } }).state, 'working');
  // Mid-turn (it does what needs no editor meanwhile), no refusal on it, or work that needs no editor: Working.
  assert.equal(live(w, [session('jjjj0000', { machineSandbox: 'slot4', editorRefused: refused })], { lothdesktop: { unity: busy } }).state, 'working');
  assert.equal(live(w, [session('jjjj0000', { ...checkIn, editorRefused: undefined })], { lothdesktop: { unity: busy } }).state, 'working');
  assert.equal(live(item('w1949', { sessionIds: ['jjjj0000'], needs: 'agent' }), [session('jjjj0000', checkIn)], { lothdesktop: { unity: busy } }).state, 'working');
  // Another machine full is no wait of its.
  assert.equal(live(w, [session('jjjj0000', checkIn)], { beast: { unity: busy } }).state, 'working');
});
