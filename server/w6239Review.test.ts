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

// w6239 F1: the mirror of w6226 F1b. The worker asked the same question on w5869 and w5871. w5869 was handed back and placed on
// its next worker 77770000; w5871 stays with the asker. The person answers on w5871 (the card they see first). The asker is
// resumed, and w5869 is marked answered too (w1812), but 77770000, now the worker on w5869, is never told: w5869 no longer
// waits on input and its worker never hears the answer.
for (const mode of ['on', 'warn'] as const) {
  test(`w6239 F1 ("${mode}"): an answer on the request the asker kept reaches the next worker of its moved twin`, async (t) => {
    const env = await setup(t, mode);
    const old = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1' });
    env.sessions.adopt({ info: old, live: false, stop: () => {} } as unknown as SessionHandle);
    const w = env.request(['5449aaaa']);
    const x = env.request(['5449aaaa'], 'w5871');
    env.agents.orchestrators.handBack(w, old, pausedHb);
    const next = env.worker('77770000', { machineId: 'beast', machineSandbox: 'slot3' });
    env.sessions.adopt({ info: next, live: false, stop: () => {} } as unknown as SessionHandle);
    env.agents.orchestrators.linkWorker(w.id, next, 'started worker 77770000');
    w.needsYou = ask();
    x.needsYou = ask();
    env.store.putWork(w);
    env.store.putWork(x);
    const said = answer(env, x, 'yes, ship it');
    const timers = timersOf(env);
    const toNext = timers.get('77770000');
    const wAnswered = !!env.store.work.get('w5869')!.needsYou?.answered;
    const nextHears = !!toNext && /ship it/.test(toNext.note) && env.agents.orchestrators.staleResume(w.id, '77770000', toNext.note) === undefined;
    assert.ok(!wAnswered || nextHears, `answerNeedsYou on w5871 said "${said}"; w5869 is marked answered (${wAnswered}) but its worker now, 77770000, gets no resume (timers: ${JSON.stringify([...timers.keys()])})`);
  });
}

// w6239 F1b: the text the asking worker gets in F1 tells it the answer "answers it on all of them", naming w5869, the request
// it was moved off (w2079: it must never take that one up again).
test('w6239 F1b: the asker is not told to carry on with a request it was moved off', async (t) => {
  const env = await setup(t, 'on');
  const old = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1' });
  env.sessions.adopt({ info: old, live: false, stop: () => {} } as unknown as SessionHandle);
  const w = env.request(['5449aaaa']);
  const x = env.request(['5449aaaa'], 'w5871');
  env.agents.orchestrators.handBack(w, old, pausedHb);
  const next = env.worker('77770000', { machineId: 'beast', machineSandbox: 'slot3' });
    env.sessions.adopt({ info: next, live: false, stop: () => {} } as unknown as SessionHandle);
  env.agents.orchestrators.linkWorker(w.id, next, 'started worker 77770000');
  w.needsYou = ask();
  x.needsYou = ask();
  env.store.putWork(w);
  env.store.putWork(x);
  answer(env, x, 'yes, ship it');
  const toOld = timersOf(env).get('5449aaaa');
  assert.ok(toOld, 'the asker is resumed on w5871');
  assert.ok(!/w5869/.test(toOld!.note.split('\n\n').slice(1).join('\n\n')), `the asker, moved off w5869, is told to carry on with it: ${toOld!.note}`);
});

// w6239 F2: the asker's two requests both moved, to two different workers (Y on w5869, Z on w5871). The answer on w5869 goes to
// Y; w5871 is marked answered too, but Z, its worker now, hears nothing (toAsker only looks at the asker; the main send only at
// w5869's worker).
test('w6239 F2: an answer shared with a twin moved to another worker reaches that worker', async (t) => {
  const env = await setup(t, 'on');
  const old = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1' });
  env.sessions.adopt({ info: old, live: false, stop: () => {} } as unknown as SessionHandle);
  const w = env.request(['5449aaaa']);
  const x = env.request(['5449aaaa'], 'w5871');
  env.agents.orchestrators.handBack(w, old, pausedHb);
  env.agents.orchestrators.handBack(x, old, pausedHb);
  const y = env.worker('77770000', { machineId: 'beast', machineSandbox: 'slot3' });
    env.sessions.adopt({ info: y, live: false, stop: () => {} } as unknown as SessionHandle);
  const z = env.worker('88880000', { machineId: 'lothdesktop', machineSandbox: 'slot2' });
    env.sessions.adopt({ info: z, live: false, stop: () => {} } as unknown as SessionHandle);
  env.agents.orchestrators.linkWorker(w.id, y, 'started worker 77770000');
  env.agents.orchestrators.linkWorker(x.id, z, 'started worker 88880000');
  w.needsYou = ask();
  x.needsYou = ask();
  env.store.putWork(w);
  env.store.putWork(x);
  const said = answer(env, w, 'yes, ship it');
  const timers = timersOf(env);
  assert.ok(timers.get('77770000'), `Y hears it on w5869: said "${said}" timers ${JSON.stringify([...timers.keys()])}`);
  const toZ = timers.get('88880000');
  const xAnswered = !!env.store.work.get('w5871')!.needsYou?.answered;
  assert.ok(!xAnswered || (!!toZ && /ship it/.test(toZ.note)), `answerNeedsYou said "${said}"; w5871 is marked answered but its worker 88880000 gets nothing (timers: ${JSON.stringify([...timers.keys()])})`);
});
