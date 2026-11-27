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
type Timers = Map<string, { note: string; resumeOf?: string }>;
const answer = (env: Awaited<ReturnType<typeof setup>>, w: WorkItem, note: string) =>
  (env.agents.orchestrators as unknown as { answerNeedsYou: (w: WorkItem, by: Requester, note: string) => string }).answerNeedsYou(w, LOTH, note);
const timersOf = (env: Awaited<ReturnType<typeof setup>>) => (env.agents as unknown as { waker: { timers: Timers } }).waker.timers;
const ask = () => ({ kind: 'question', key: 'declared:ship', question: 'Ship it?', worker: '5449aaaa', at: OLD, raisedAt: OLD }) as unknown as WorkItem['needsYou'];

const T = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
function reached(env: Awaited<ReturnType<typeof setup>>, id: string) {
  const timers = timersOf(env);
  return !!timers.get(id) || env.sent.some((s) => s.id === id && /ship it/.test(s.text));
}

// R1: a pair-style request with two workers on it: E (linked first) and the asker A (linked later). A asks, then A alone is
// taken off (plain moveOff: a stopped-away leg, w2566; or w1076), no hand-back. E still holds the request. The answer must
// reach E, and never resume A (w2079).
test('R1: asker moved off (no hand-back), co-worker linked earlier still on it: answer goes to that co-worker, not the asker', async (t) => {
  const env = await setup(t, 'on');
  const e = env.worker('3333aaaa', { machineId: 'beast', machineSandbox: 'slot2' });
  env.sessions.adopt({ info: e, live: false, stop: () => {} } as unknown as SessionHandle);
  const a = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1' });
  env.sessions.adopt({ info: a, live: false, stop: () => {} } as unknown as SessionHandle);
  const w = env.request(['3333aaaa', '5449aaaa']);
  w.links = { '3333aaaa': { at: T(3600_000), how: 'sent' }, '5449aaaa': { at: T(1800_000), how: 'sent' } };
  w.needsYou = ask();
  env.store.putWork(w);
  env.agents.orchestrators.moveOff(w, '5449aaaa', 'stopped while biscuit is offline (w2566)');
  const said = answer(env, w, 'yes, ship it');
  assert.ok(!reached(env, '5449aaaa'), `the moved-off asker 5449aaaa is resumed with the answer: "${said}"`);
  assert.ok(reached(env, '3333aaaa'), `the worker still on w5869, 3333aaaa, never hears the answer: "${said}"`);
});

// R2: as R1, but the request was handed back once long ago (an earlier worker's paused computer), then placed again: its
// handedBack record stays. The answer must not go into that stale hand-off, which nobody will read.
test('R2: stale hand-back from long ago: answer goes to the worker on it, not into the old hand-off', async (t) => {
  const env = await setup(t, 'on');
  const z = env.worker('1111aaaa', { machineId: 'biscuit', machineSandbox: 'slot1' });
  env.sessions.adopt({ info: z, live: false, stop: () => {} } as unknown as SessionHandle);
  const w = env.request(['1111aaaa']);
  env.agents.orchestrators.handBack(w, z, pausedHb);
  // Back-date the hand-back, then place E and A after it.
  w.handedBack = { ...w.handedBack!, at: T(7200_000) };
  w.movedOff = { '1111aaaa': T(7200_000) };
  w.status = 'active';
  delete (w as { queuedFor?: unknown }).queuedFor;
  const e = env.worker('3333aaaa', { machineId: 'beast', machineSandbox: 'slot2' });
  env.sessions.adopt({ info: e, live: false, stop: () => {} } as unknown as SessionHandle);
  const a = env.worker('5449aaaa', { machineId: 'lothdesktop', machineSandbox: 'slot1' });
  env.sessions.adopt({ info: a, live: false, stop: () => {} } as unknown as SessionHandle);
  w.sessionIds = ['3333aaaa', '5449aaaa'];
  w.links = { '3333aaaa': { at: T(3600_000), how: 'sent' }, '5449aaaa': { at: T(1800_000), how: 'linked' } };
  w.needsYou = ask();
  env.store.putWork(w);
  env.agents.orchestrators.moveOff(w, '5449aaaa', 'stopped while lothdesktop is offline (w2566)');
  const said = answer(env, w, 'yes, ship it');
  const msg = env.store.work.get('w5869')!.handedBack?.message ?? '';
  assert.ok(!reached(env, '5449aaaa'), `the moved-off asker is resumed: "${said}"`);
  assert.ok(reached(env, '3333aaaa'), `3333aaaa, on w5869 now, never hears it (hand-off message: ${JSON.stringify(msg.slice(0, 80))}): "${said}"`);
});

// R3: control (w6248 A's spirit with link times): handed back, then a new worker N placed after it: N gets it.
test('R3: handed back then placed on N (linked after): N gets the answer', async (t) => {
  const env = await setup(t, 'on');
  const a = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1' });
  env.sessions.adopt({ info: a, live: false, stop: () => {} } as unknown as SessionHandle);
  const w = env.request(['5449aaaa']);
  w.links = { '5449aaaa': { at: T(3600_000), how: 'sent' } };
  w.needsYou = { ...ask(), to: ["lothsahn"], who: ["lothsahn"] } as WorkItem["needsYou"];
  env.store.putWork(w);
  env.agents.orchestrators.handBack(w, a, pausedHb);
  const n = env.worker('7777aaaa', { machineId: 'beast', machineSandbox: 'slot2' });
  env.sessions.adopt({ info: n, live: false, stop: () => {} } as unknown as SessionHandle);
  env.agents.orchestrators.linkWorker(w.id, n, 'started worker 7777aaaa');
  const live = env.store.work.get('w5869')!;
  const said = live.needsYou && !live.needsYou.answered ? answer(env, live, 'yes, ship it') : 'settled at start';
  assert.ok(!reached(env, '5449aaaa'), `the old asker is resumed: "${said}"`);
});
