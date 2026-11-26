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
import type { Computer } from './placement.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

/**
 * w6047 (the w6214 review, from its reviewer's repro): a person's [answer] to a [needs you] asked by a worker its request has
 * since moved off goes to the request's worker now, never to the old one (F1); and a sibling another worker took and handed
 * back during a move's waits never puts a message back to the moving worker, which stays moved (F2). Setup as in
 * server/w6193Review.test.ts.
 */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'lothsahn' };
const PEOPLE: UserInfo[] = [{ ...LOTH, role: 'owner' }];
const OLD = new Date(Date.now() - 3 * 3600_000).toISOString();
const BISCUIT_FULL = '4 agents mid-turn on biscuit, in sandboxes and standing agents together (its agent cap 4)';
const pc = (id: string, over: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 6, maxSandboxes: 6, freeSandboxes: 3, platform: 'win32', ...over });

type Internals = {
  roomMove: (h: SessionHandle, q: QueuedSend, hold: string, now: number) => true | string | undefined;
  startMoved: (info: SessionInfo, w: WorkItem, to: string, why: string, hold: string, branch: string | undefined, lead: string | undefined, hb: Parameters<Agents['orchestrators']['movedForRoom']>[2]) => Promise<string>;
  places: () => Computer[];
};

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, mode: 'on' | 'warn') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w5976-'));
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
    movedAwayWorkers: mode,
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    clearInterval(agents.placeAgainTick);
    agents.close(); // w6152: Agents' timers stop before the folder goes (w5915: a release pass wrote into a removed transcript, ENOENT).
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const x = agents as unknown as Internals;
  // Biscuit full; beast and lothdesktop with room by the portal's count.
  x.places = () => [pc('biscuit', { maxAgents: 4, midTurn: 4, sandboxes: 4, maxSandboxes: 4, freeSandboxes: 0 }), pc('beast', { midTurn: 2 }), pc('lothdesktop')];
  const starts: string[] = [];
  x.startMoved = async (info, w, to, _why, _hold, _branch, _lead, hb) => {
    const id = `new${starts.length + 1}`;
    starts.push(`${to}:${id}`);
    agents.orchestrators.movedForRoom(w, info, hb);
    // A fresh session: no turn yet.
    const s: SessionInfo = { id, kind: 'worker', title: info.title, status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 0, costUsd: 0, pendingPermissions: [], machineId: to, machineSandbox: 'slot3' };
    store.putSession(s);
    agents.orchestrators.linkWorker(w.id, s, `started worker ${id} in ${to}/slot3: moved from worker ${info.id}`);
    return `${to}/slot3 as worker ${id}`;
  };
  const worker = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => {
    const s: SessionInfo = { id, kind: 'worker', title: 'w5869: FF Factory fix', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 7, costUsd: 0, pendingPermissions: [], ...o };
    store.putSession(s);
    return s;
  };
  const request = (sessionIds: string[], id = 'w5869'): WorkItem => {
    const w: WorkItem = { id, title: 'FF Factory fix', brief: 'Do it.', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [], humanAsked: true, status: 'active', createdAt: OLD, updatedAt: OLD, sessionIds, overlaps: [], asks: 0, log: [] } as unknown as WorkItem;
    store.putWork(w);
    store.workSeq = Math.max(store.workSeq, Number(id.slice(1)));
    return w;
  };
  const queued = (id: string, text: string, at: number, from: QueuedSend['from'] = 'orchestrator'): QueuedSend => ({ uuid: `u-${id}-${text}`, id, text, from, at: new Date(at).toISOString(), why: BISCUIT_FULL });
  const roomMove = (info: SessionInfo, q: QueuedSend, hold: string, now: number) => x.roomMove({ info } as SessionHandle, q, hold, now);
  const settled = async (id: string) => {
    for (let n = 0; n < 200 && agents.isMoving(id); n++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(agents.isMoving(id), false, 'the move finished');
  };
  // What reached each worker's send (a delivery to a worker of another computer is SessionManager's business, tested there).
  const sent: { id: string; text: string; from: string; images?: unknown[] }[] = [];
  const realSend = sessions.send.bind(sessions);
  sessions.send = ((id: string, text: string, from: 'human' | 'orchestrator' | 'system' = 'human', images?: unknown[]) => {
    sent.push({ id, text, from, ...(images ? { images } : {}) });
    return 'queued';
  }) as SessionManager['send'];
  return { store, sessions, agents, machines, starts, worker, request, queued, roomMove, settled, sent, realSend };
}

const pausedHb = { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' };
const RELEASED = { at: OLD, sandbox: 'slot1', branch: 'w5449-fix', why: 'idle' };

// F1: a person's [answer] to a [needs you] whose request has since moved off the asking worker (a room move, a hand-back and
// a re-place) goes to that old worker (answerNeedsYou -> wakeNow -> wake.ts fire -> sessions.send with resumeOf). Its
// staleResume (orchestrators.ts:4951, the w2079 branch) refuses it, and send only calls notDelivered: nothing forwards it to
// the request's new worker, although the comment at orchestrators.ts:4946-4948 and test R4 say forwardToHeirs takes it there.
// The person is told "sent to its worker ..., nothing for you to pass on" and the answer reaches nobody.
test('w6214 F1: a person\'s [answer] to a worker its request moved off reaches the request\'s new worker', async (t) => {
  const env = await setup(t, 'warn');
  const old = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1' });
  const nw = env.worker('new1', { machineId: 'beast', machineSandbox: 'slot3' });
  env.sessions.adopt({ info: old, live: false, stop: () => {} } as unknown as SessionHandle);
  env.sessions.adopt({ info: nw, live: false, stop: () => {} } as unknown as SessionHandle);
  const w = env.request(['new1']);
  w.movedOff = { '5449aaaa': new Date().toISOString() };
  w.needsYou = { kind: 'question', key: 'q', question: 'Ship it?', worker: '5449aaaa', at: OLD, raisedAt: OLD } as unknown as WorkItem['needsYou'];
  env.store.putWork(w);
  const said = (env.agents.orchestrators as unknown as { answerNeedsYou: (w: WorkItem, by: Requester, note: string) => string }).answerNeedsYou(w, LOTH, 'yes, ship it');
  assert.match(said, /nothing for you to pass on/, said);
  // What wake.ts fire sends when the 1-minute check-in comes due.
  // w6047: the answer goes to the request's worker now (answerNeedsYou re-points it), never to the old one (w2079).
  const timers = (env.agents as unknown as { waker: { timers: Map<string, { note: string; resumeOf?: string }> } }).waker.timers;
  assert.equal(timers.get('5449aaaa'), undefined, 'the old worker is not resumed');
  const timer = timers.get('new1');
  assert.ok(timer, 'wakeNow scheduled the resume of the new worker');
  assert.match(timer.note, /worker 5449aaaa asked before w5869 moved to you/);
  // The drain lets it go to the new worker (staleResume); a live delivery is SessionManager's business, so the send is recorded.
  assert.equal(env.agents.orchestrators.staleResume(w.id, 'new1', timer.note), undefined);
  env.sessions.send('new1', `[wake_me] Time is up. Your note: ${timer.note}`, 'system', undefined, { ops: 'wake', ...(timer.resumeOf ? { resumeOf: { work: timer.resumeOf, note: timer.note } } : {}) });
  const reachedNew = env.sent.some((m) => m.id === 'new1' && /ship it/.test(m.text)) || env.sessions.queued().some((m) => m.id === 'new1' && /ship it/.test(m.text));
  const reachedOld = env.sessions.queued().some((m) => m.id === '5449aaaa' && /ship it/.test(m.text));
  assert.ok(reachedNew && !reachedOld, `the person's answer reached nobody: staleResume says ${JSON.stringify(env.agents.orchestrators.staleResume(w.id, '5449aaaa', timer.note))}`);
});

// F2 ("warn"): R3 of w6193 again, but the sibling is re-placed on worker yyyy and handed back by it during the move's stop/save
// waits (liveHub.endFor), before the start. The pre-start toSiblings(held.groups) (agents.ts:4943, no orElse) sends it to
// deliverHeld, whose `back` filter (handedBack.session === info.id) is empty, so it puts the message back to the old worker and
// deletes info.movedAway (agents.ts ~5085); then the start goes through and w5869 runs on new1: a worker kept AND moved.
test('w6214 F2 ("warn"): a sibling handed back by another worker during the waits never un-marks the moved worker', async (t) => {
  const env = await setup(t, 'warn');
  const msg: QueuedSend = { uuid: 'u-early', id: '5449aaaa', text: 'lothsahn: about w5870, use the old flag', from: 'human', at: new Date().toISOString(), why: BISCUIT_FULL, resumeOf: { work: 'w5870', note: '[note] use the old flag' } };
  let s: SessionInfo;
  (env.agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      assert.equal(env.roomMove(s, msg, BISCUIT_FULL, Date.now()), true, 'absorbed during the waits');
      const y = env.worker('yyyyyyyy', { machineId: 'beast', machineSandbox: 'slot2' });
      const g = env.store.work.get('w5870')!;
      g.sessionIds = [...g.sessionIds, y.id];
      env.store.putWork(g);
      env.agents.orchestrators.handBack(g, y, { ...pausedHb, machine: 'beast', sandbox: 'slot2' });
      return undefined;
    },
    running: () => false,
  };
  s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  env.request(['5449aaaa'], 'w5869');
  env.request(['5449aaaa'], 'w5870');
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: go on', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  assert.deepEqual(env.starts, ['beast:new1'], 'w5869 started on the new worker');
  const info = env.store.sessions.get('5449aaaa')!;
  assert.ok(info.movedAway, `the old worker lost its movedAway mark although w5869 moved to new1; queued for it: ${JSON.stringify(env.sessions.queued().map((m) => m.id))}`);
});
