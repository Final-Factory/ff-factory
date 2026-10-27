import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchLockDir } from '../machine/benchLock.ts';
import { benchQueueDir } from '../machine/benchQueue.ts';
import { readBenchState } from '../machine/benchState.ts';
import { queueWaitsAll } from '../shared/queueWaits.ts';
import { workLive, type WorkLiveFacts } from '../shared/workState.ts';
import type { BenchState, MachineStats, SessionInfo, WorkItem } from '../shared/types.ts';

/**
 * w2410 (lothsahn, 2026-10-27): on BEAST worker d2d9c644 queued shared ticket t00002471 at 12:23 UTC ("unity: w2367 release
 * base for launch clip"), stopped at 12:49 UTC blocked on w2402, and its sandbox was released at 14:07 UTC; w2366, w2367 and
 * w2370 still showed "Blocked on the shared bench lock on beast ... next in queue" hours later. A stopped worker's waiting
 * ticket must block nobody, and its requests must show their real block.
 */

const NOW = Date.parse('2026-10-27T15:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const sec = (minAgo: number) => (NOW - minAgo * 60_000) / 1000;
const alive = (pid: number) => pid === 555;

const tmp = (t: { after(fn: () => void): void }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w2410-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function ticket(root: string, name: string, info: object, created: number, o: { granted?: number; parked?: string } = {}) {
  const d = path.join(benchQueueDir(benchLockDir(root)), name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'info.json'), JSON.stringify({ ticket: name, pid: 555, created: ago(created), ...info }));
  if (o.granted) fs.writeFileSync(path.join(d, 'granted'), JSON.stringify({ at: new Date(o.granted * 1000).toISOString(), ts: o.granted }));
  // as bench_queue.py _park writes it (w1984)
  if (o.parked) fs.writeFileSync(path.join(d, 'parked'), JSON.stringify({ at: ago(1), ts: sec(1), why: o.parked }));
}

const item = (id: string, o: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `Request ${id}`,
  brief: 'Do it.',
  priority: 'normal',
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
  machineId: 'beast',
  ...o,
});
const live = (w: WorkItem, sessions: SessionInfo[], bench: BenchState) => {
  const stats: Record<string, Pick<MachineStats, 'bench' | 'unity'>> = { beast: { bench } };
  const f: WorkLiveFacts = { items: [w], session: (id) => sessions.find((s) => s.id === id), queueWaits: queueWaitsAll(stats), now: NOW };
  return workLive(w, f)!;
};

test('w2410: a parked ticket waits last in the daemon\'s bench state, is nobody\'s next turn and nobody\'s wait', (t) => {
  const root = tmp(t);
  ticket(root, 't00002529', { mode: 'shared', what: 'unity: build', session: 'aaaa1111', requests: ['w2350'] }, 60, { granted: sec(50) });
  // d2d9c644's ticket, first in line, parked because its worker is away
  ticket(root, 't00002471', { mode: 'exclusive', what: 'unity: w2367 release base for launch clip', session: 'd2d9c644', requests: ['w2367'] }, 157, { parked: 'its worker d2d9c644 stopped and released its sandbox slot4' });
  ticket(root, 't00002540', { mode: 'exclusive', what: 'timed: w2364 A/B', session: 'bbbb2222', requests: ['w2364'] }, 10);
  const b = readBenchState(root, NOW, alive)!;
  assert.deepEqual(b.waiters?.map((x) => [x.ticket, x.ahead, x.parked ?? null]), [
    ['t00002540', 0, null],
    ['t00002471', 1, 'its worker d2d9c644 stopped and released its sandbox slot4'],
  ]);
  assert.equal(b.nextExclusive?.ticket, 't00002540', 'the exclusive ticket behind the parked one goes next');
  assert.equal(b.nextExclusive?.ahead, 0);
  const waits = queueWaitsAll({ beast: { bench: b } });
  assert.deepEqual(waits.map((q) => q.session), ['bbbb2222'], 'a parked ticket is no request\'s wait');
  assert.match(waits[0].on, /; next in queue\)$/);
});

test('w2410: a stopped worker whose sandbox is released no longer holds its request on its waiting ticket: the request shows its gate', () => {
  const bench: BenchState = {
    mode: 'shared',
    running: [{ ticket: 't00002529', mode: 'shared', what: 'unity: build', session: 'aaaa1111', requests: ['w2350'], since: ago(50) }],
    runningCount: 1,
    waiting: 1,
    waiters: [{ ticket: 't00002471', mode: 'shared', what: 'unity: w2367 release base for launch clip', session: 'd2d9c644', requests: ['w2367'], since: ago(157), ahead: 0 }],
  };
  const w = item('w2367', { status: 'blocked', sessionIds: ['d2d9c644'], blocked: { kind: 'request', ref: 'w2402', on: 'report', what: 'w2402 reporting', at: ago(130), by: 'd2d9c644' } });
  // The case: stopped, nothing ahead, its sandbox released.
  const released = session('d2d9c644', { status: 'stopped', placeReleased: { at: ago(53), sandbox: 'slot4', branch: 'sandbox/slot4-w2367', why: 'stopped idle' } });
  const l = live(w, [released], bench);
  assert.equal(l.state, 'blocked');
  assert.doesNotMatch(l.why, /bench/, l.why);
  assert.match(l.why, /^w2402 reporting/);
  // Stopped with nothing to bring it back, sandbox still held: its ticket is no wait of its either.
  assert.match(live(w, [session('d2d9c644', { status: 'stopped' })], bench).why, /^w2402 reporting/);
  // Constraint: a worker that keeps its sandbox and comes back by its check-in (a run it left going) still shows the wait.
  const checkIn = session('d2d9c644', { status: 'stopped', wakeAt: new Date(NOW + 20 * 60_000).toISOString(), wakeNote: 'the clip' });
  assert.match(live(w, [checkIn], bench).waitsOn![0], /^the shared bench lock on beast/);
  // ...and so does one alive between turns.
  assert.match(live(w, [session('d2d9c644', { status: 'idle', wakeAt: new Date(NOW + 20 * 60_000).toISOString() })], bench).waitsOn![0], /^the shared bench lock on beast/);
});

test('w2410: a shared ticket with no exclusive ticket ahead is not told an exclusive ticket waits', () => {
  const bench: BenchState = {
    mode: 'shared',
    running: [
      { ticket: 't00002529', mode: 'shared', what: 'unity: build', session: 'aaaa1111', requests: ['w2350'], since: ago(50) },
      { ticket: 't00002533', mode: 'shared', what: 'unity: build', session: 'cccc3333', requests: ['w2395'], since: ago(40) },
    ],
    runningCount: 2,
    waiting: 1,
    waiters: [{ ticket: 't00002550', mode: 'shared', what: 'unity: clip', session: 'eeee5555', requests: ['w2400'], since: ago(5), ahead: 0 }],
  };
  const l = live(item('w2400', { sessionIds: ['eeee5555'] }), [session('eeee5555')], bench);
  assert.equal(l.waitsOn![0], 'the shared bench lock on beast (a shared lock, held by 2 shared tickets: w2350 / t00002529, w2395 / t00002533; no exclusive ticket waits ahead of it; next in queue)');
});
