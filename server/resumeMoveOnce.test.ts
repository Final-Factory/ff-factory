import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, type QueuedSend, type SessionHandle } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { latestWorker } from '../shared/blockers.ts';
import type { Computer } from './placement.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

/**
 * w2079: one resume's move starts exactly one new worker. At 19:23Z on 2026-10-24 w1903's worker d5ab39da (released from
 * m3/slot1) was moved to m5/slot3 (worker d70e5d02); the sweep, which saw its resume dropped from the send queue, resumed it
 * again at 19:23:28, and that message moved it once more at 19:24:55 (biscuit/slot2, worker c477b52b), because its title
 * still named w1903 (workIdsOf). eca53c32 owned w1903 all along (PR #2369), live in lothdesktop/slot4 since 19:20:43.
 */

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];
const OLD = new Date(Date.now() - 3 * 3600_000).toISOString();
const HOLD = 'no sandbox on m3 is free (its own, slot1, took other work after it was released)';
const pc = (id: string, over: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, platform: 'win32', ...over });

type Internals = {
  roomMove: (h: SessionHandle, q: QueuedSend, hold: string, now: number) => true | string | undefined;
  startMoved: (info: SessionInfo, w: WorkItem, to: string, why: string, hold: string, branch: string | undefined, lead: string | undefined, hb: Parameters<Agents['orchestrators']['movedForRoom']>[2]) => Promise<string>;
  places: () => Computer[];
};

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-move-once-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/master',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    clearInterval(agents.placeAgainTick);
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const x = agents as unknown as Internals;
  // m3 is full, m5 and biscuit have room: every pass would pick one of them.
  x.places = () => [pc('m3', { freeSandboxes: 0, sandboxes: 1, maxSandboxes: 1 }), pc('m5'), pc('biscuit')];
  // The fresh session itself is the real startMoved's business (a daemon, a branch switch): here it is linked as one would be.
  const starts: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  x.startMoved = async (info, w, to, _why, _hold, _branch, _lead, hb) => {
    await gate;
    const id = `new${starts.length + 1}`;
    starts.push(`${to}:${id}`);
    agents.orchestrators.movedForRoom(w, info, hb);
    const s: SessionInfo = { id, kind: 'worker', title: info.title, status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 1, costUsd: 0, pendingPermissions: [], machineId: to, machineSandbox: 'slot3' };
    store.putSession(s);
    agents.orchestrators.linkWorker(w.id, s, `started worker ${id} in ${to}/slot3: moved from worker ${info.id}`);
    return `${to}/slot3 as worker ${id}`;
  };
  const worker = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => {
    const s: SessionInfo = { id, kind: 'worker', title: 'w1903: Circuit conditions on mobile-station route stops', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 3, costUsd: 0, pendingPermissions: [], ...o };
    store.putSession(s);
    return s;
  };
  const request = (sessionIds: string[]): WorkItem => {
    const w: WorkItem = { id: 'w1903', title: 'Circuits for station stops', brief: 'Do it.', priority: 'normal', keys: [], requestedBy: BEN, requesters: [], humanAsked: true, status: 'active', createdAt: OLD, updatedAt: OLD, sessionIds, overlaps: [], asks: 0, log: [] };
    store.putWork(w);
    store.workSeq = Math.max(store.workSeq, 1903);
    return w;
  };
  const queued = (id: string, text: string, at = OLD): QueuedSend => ({ uuid: `u-${text}`, id, text, from: 'system', at, why: HOLD });
  const roomMove = (info: SessionInfo, q: QueuedSend) => x.roomMove({ info } as SessionHandle, q, HOLD, Date.now());
  const settled = async () => {
    for (let n = 0; n < 200 && agents.isMoving('d5ab39da'); n++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(agents.isMoving('d5ab39da'), false, 'the move finished');
  };
  return { store, agents, starts, worker, request, queued, roomMove, settled, hold: (p: Promise<void>) => (gate = p) };
}

test('w2079: a resume moves its worker once: the sweep does not resume it while or after it moves, and a second message moves nothing', async (t) => {
  const { store, agents, starts, worker, request, queued, roomMove, settled, hold } = await setup(t);
  const released = { at: OLD, sandbox: 'slot1', branch: 'w1903-station-stop-circuits', why: 'it waits on w1903: w1982 reporting' };
  const d5 = worker('d5ab39da', { machineId: 'm3', machineSandbox: 'slot1', placeReleased: released });
  const w = request(['d5ab39da']);
  // The gate's resume the sweep watches (w1094), 134 minutes old and never taken.
  w.gateResumes = [{ session: 'd5ab39da', at: OLD, mark: 'CI on #2369 cleared', note: 'CI on #2369 cleared', seq: 0, tries: 1 }];
  store.putWork(w);

  let open!: () => void;
  hold(new Promise<void>((r) => (open = r)));
  assert.equal(roomMove(d5, queued('d5ab39da', 'CI on #2369 cleared')), true, 'the first resume moves it');
  // 19:23:28: the sweep runs while the move is under way; the server's predicate counts a move as pending (index.ts).
  assert.equal(agents.isMoving('d5ab39da'), true);
  let swept = agents.orchestrators.sweepResumes((id) => agents.isMoving(id));
  assert.equal(swept.size, 0, 'not resumed again while it moves');
  open();
  await settled();
  assert.deepEqual(starts, [starts[0]], 'one new worker');
  assert.match(starts[0], /^(m5|biscuit):new1$/);
  assert.equal(store.work.get('w1903')!.gateResumes, undefined, 'its gate resume went with it');
  swept = agents.orchestrators.sweepResumes(() => false);
  assert.equal(swept.size, 0, 'not resumed again after it moved');

  // Before the fix this message (the sweep's 19:24:28 one) moved it again, to a second computer.
  assert.equal(roomMove(d5, queued('d5ab39da', 'resumed again by the sweep')), true, 'the message is not delivered to it');
  await settled();
  assert.equal(starts.length, 1, `a second message started no second copy (${starts.join(', ')})`);
  const after = store.work.get('w1903')!;
  assert.equal(latestWorker(after), 'new1', 'the moved copy carries it');
  // 19:40Z: eca53c32, moved off w1903 at 19:34Z, took the sweep's resume beside its new worker c62e5ad1. A resume for a
  // request its worker was moved off does not go (SessionManager.drain drops it, staleResume).
  assert.match(agents.orchestrators.staleResume('w1903', 'd5ab39da', 'CI on #2369 cleared') ?? '', /^w1903 was moved off worker d5ab39da at .*; it is with new1 now$/);
  assert.equal(agents.orchestrators.staleResume('w1903', 'new1', 'CI on #2369 cleared'), undefined, 'the new worker takes its resumes');
  assert.equal(after.log.filter((l) => / moved from m3\/slot1 to /.test(l)).length, 1, `one move in the log: ${after.log.join(' | ')}`);
});

test('w2079: a request another live worker carries gets no moved copy, and that worker stays its owner', async (t) => {
  const { store, starts, worker, request, queued, roomMove, settled } = await setup(t);
  const released = { at: OLD, sandbox: 'slot1', branch: 'w1903-station-stop-circuits', why: 'it waits on w1903: w1982 reporting' };
  const d5 = worker('d5ab39da', { machineId: 'm3', machineSandbox: 'slot1', placeReleased: released });
  // eca53c32 merges PR #2369, mid-turn in lothdesktop/slot4.
  worker('eca53c32', { status: 'running', machineId: 'lothdesktop', machineSandbox: 'slot4', title: 'w1903: Route stop circuits: finish PR #2369' });
  const w = request(['d5ab39da', 'eca53c32']);
  w.links = { d5ab39da: { at: OLD, how: 'linked' }, eca53c32: { at: new Date().toISOString(), how: 'sent' } };
  store.putWork(w);

  assert.equal(roomMove(d5, queued('d5ab39da', 'CI on #2369 cleared')), true, 'its message is not delivered and it does not wait');
  await settled();
  assert.deepEqual(starts, [], 'no moved copy starts');
  const after = store.work.get('w1903')!;
  assert.deepEqual(after.sessionIds, ['eca53c32'], 'taken off the old worker');
  assert.equal(latestWorker(after), 'eca53c32', 'the owner stays its newest worker: its check-in is not "work that is over"');
  assert.match(after.log.join('\n'), /taken off worker d5ab39da: not moved \(w2079\): its worker eca53c32 works on it in lothdesktop\/slot4/);
  // And a second message after it is a no-op as well.
  assert.equal(roomMove(d5, queued('d5ab39da', 'resumed again')), true);
  await settled();
  assert.deepEqual(starts, []);
});
