import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchHolderWatch, HOLDER_IDLE_NUDGE_MS, HOLDER_REVOKE_AFTER_MS, harnessTicket, workerTickets } from './benchHolders.ts';
import { Store } from './store.ts';
import { Waker } from './wake.ts';
import type { SessionManager } from './sessions.ts';
import type { BenchState, BenchTicketGlance, SessionInfo } from '../shared/types.ts';

/**
 * w3715 (lothsahn, 2026-11-08): "We probably should be able to pre empt a worker with a lock but it shouldn't be idle and
 * hold the lock." On LothDesktop w3536's worker left a probe holding the exclusive bench ticket for over an hour while it
 * sat idle behind placement.hold. A holder with no turn and no background task is nudged, then its ticket revoked; a
 * holder's wake_me fires when its last ticket goes.
 */

const ticket = (over: Partial<BenchTicketGlance> = {}): BenchTicketGlance => ({ ticket: 't00000042', mode: 'exclusive', what: 'probe A/B leg 3', session: 'w8de5', ...over });
const state = (running: BenchTicketGlance[]): BenchState => ({ mode: running.length ? 'exclusive' : 'free', running, runningCount: running.length, waiting: 0 });
const worker = (over: Partial<SessionInfo> = {}) => ({ id: 'w8de50001', kind: 'worker', status: 'idle', ...over }) as SessionInfo;

function setup(o: { info?: SessionInfo; live?: boolean } = {}) {
  let now = 1_000_000;
  let bench: BenchState | undefined = state([ticket()]);
  const info = o.info ?? worker();
  const sent: string[] = [];
  const revoked: { machineId: string; ticket: string; session: string }[] = [];
  const woken: string[] = [];
  let midTurn = false;
  const watch = new BenchHolderWatch({
    machineIds: () => ['lothdesktop'],
    bench: () => bench,
    session: (sid) => (info.id.startsWith(sid) ? info : undefined),
    live: () => o.live ?? true,
    midTurn: () => midTurn,
    send: (_id, text) => void sent.push(text),
    revoke: (machineId, t, session) => (revoked.push({ machineId, ticket: t, session }), true),
    wakeEarly: (sid) => (woken.push(sid), true),
    now: () => now,
  });
  return {
    watch,
    sent,
    revoked,
    woken,
    info,
    at: (ms: number) => ((now = 1_000_000 + ms), watch.tick()),
    setBench: (b: BenchState | undefined) => void (bench = b),
    setMidTurn: (m: boolean) => void (midTurn = m),
  };
}

test('w3715: harness tickets (an editor, a timed_run leg, none) are not a worker\'s own; a session prefix matches', () => {
  assert.equal(harnessTicket(ticket({ what: 'timed run tr-1: fps' })), true);
  assert.equal(harnessTicket(ticket({ session: 'editor:slot3' })), true);
  assert.equal(harnessTicket(ticket({ session: undefined })), true);
  assert.equal(harnessTicket(ticket()), false);
  assert.deepEqual(workerTickets(state([ticket(), ticket({ ticket: 't2', what: 'timed run x: y' })]), 'w8de50001').map((t) => t.ticket), ['t00000042']);
  assert.deepEqual(workerTickets(state([ticket()]), 'other'), []);
  assert.deepEqual(workerTickets(undefined, 'w8de50001'), []);
});

test('w3715: an idle holder is nudged after 2 minutes, and its ticket revoked 10 minutes after the nudge if it stays idle', () => {
  const s = setup();
  s.at(0);
  s.at(HOLDER_IDLE_NUDGE_MS - 1);
  assert.equal(s.sent.length, 0);
  s.at(HOLDER_IDLE_NUDGE_MS);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /no turn and no background task of yours is running.*revokes it/);
  s.at(HOLDER_IDLE_NUDGE_MS + HOLDER_REVOKE_AFTER_MS - 1);
  assert.equal(s.revoked.length, 0);
  s.at(HOLDER_IDLE_NUDGE_MS + HOLDER_REVOKE_AFTER_MS);
  assert.deepEqual(s.revoked, [{ machineId: 'lothdesktop', ticket: 't00000042', session: 'w8de5' }]);
  assert.match(s.sent[1], /FF Factory revoked your lothdesktop's exclusive bench ticket t00000042/);
  s.at(HOLDER_IDLE_NUDGE_MS + HOLDER_REVOKE_AFTER_MS + 60_000);
  assert.equal(s.revoked.length, 1, 'asked once');
});

test('w3715: a holder mid-turn, or with a background task running, is never nudged or revoked', () => {
  const s = setup();
  s.setMidTurn(true);
  for (let m = 0; m <= 60; m++) s.at(m * 60_000);
  assert.equal(s.sent.length + s.revoked.length, 0);
  const b = setup({ info: worker({ backgroundTasks: 1 }) });
  for (let m = 0; m <= 60; m++) b.at(m * 60_000);
  assert.equal(b.sent.length + b.revoked.length, 0);
});

test('w3715: a holder that takes a turn after the nudge and ends it still holding is revoked only after 2 more idle minutes', () => {
  const s = setup();
  s.at(0);
  s.at(HOLDER_IDLE_NUDGE_MS);
  assert.equal(s.sent.length, 1);
  s.setMidTurn(true);
  s.at(HOLDER_IDLE_NUDGE_MS + 60_000);
  s.setMidTurn(false);
  // its turn ended just before the revoke time: it gets 2 idle minutes first
  s.at(HOLDER_IDLE_NUDGE_MS + HOLDER_REVOKE_AFTER_MS);
  assert.equal(s.revoked.length, 0);
  s.at(HOLDER_IDLE_NUDGE_MS + HOLDER_REVOKE_AFTER_MS + 2 * 60_000);
  assert.equal(s.revoked.length, 1);
});

test('w3715: a holder with no process at all (its ticket held by a detached script) counts as idle', () => {
  const s = setup({ info: worker({ status: 'running', backgroundTasks: 2 }), live: false });
  s.at(0);
  s.at(HOLDER_IDLE_NUDGE_MS);
  assert.equal(s.sent.length, 1);
});

test('w3715: harness tickets, the release lane and the nightly are left alone', () => {
  for (const t of [ticket({ what: 'timed run tr-9: fps' }), ticket({ exempt: 'release' }), ticket({ exempt: 'nightly' })]) {
    const s = setup();
    s.setBench(state([t]));
    for (let m = 0; m <= 30; m++) s.at(m * 60_000);
    assert.equal(s.sent.length + s.revoked.length, 0, t.what);
  }
});

test('w3715: when an idle holder\'s last ticket goes its wake fires now; not while it is busy, nor when the report is missing or cut short', () => {
  const s = setup();
  s.at(0);
  s.setBench(undefined);
  s.at(30_000);
  assert.deepEqual(s.woken, [], 'no report from the machine: nothing is judged gone');
  s.setBench({ ...state([]), runningCount: 7 });
  s.at(60_000);
  assert.deepEqual(s.woken, [], 'a list cut short says nothing of the tickets left out');
  s.setBench(state([]));
  s.at(90_000);
  assert.deepEqual(s.woken, ['w8de50001']);
  const busy = setup();
  busy.at(0);
  busy.setMidTurn(true);
  busy.setBench(state([]));
  busy.at(30_000);
  assert.deepEqual(busy.woken, []);
});

test('w3715: Waker.fireEarly sends a pending wake now, saying why, and is false with none pending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w3715-'));
  const store = new Store(dir);
  const sent: string[] = [];
  const sessions = { sessions: new Map([['w1', {}]]), get: () => ({}), send: (_id: string, text: string) => (sent.push(text), 'u') } as unknown as SessionManager;
  const w = new Waker(sessions, store);
  let now = 1_000_000;
  w.now = () => now;
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(w.fireEarly('w1', 'x'), false);
  w.schedule('w1', 60, 'read the probe results');
  now += 5 * 60_000;
  assert.equal(w.fireEarly('w1', 'the bench ticket your work held was let go'), true);
  t.mock.timers.tick(0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^\[wake_me\] Woken early: the bench ticket your work held was let go \(it was due at \d\d:\d\dZ\)\. Your note: read the probe results$/);
  assert.equal(w.pending('w1'), undefined);
});
