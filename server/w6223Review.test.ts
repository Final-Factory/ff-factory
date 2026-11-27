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


// w6223 F1: R3/F2 of w6214 again, and the message is followed to its end. The sibling w5870 is handed back by worker yyyyyyyy
// during the move's waits and no next worker is placed on it yet. toSiblings (agents.ts:4912-4916) sends the message to
// deliverHeld(anyHandBack = true), whose `back` now holds w5870 and whose `w` is w5870 (no next worker), so it calls
// orchestrators.carryInHandBack(w5870, '5449aaaa', text) (agents.ts:5092). carryInHandBack refuses any hand-back whose session
// is not the caller's (orchestrators.ts:2272: hb.session !== sid -> return), silently. deliverHeld answers false, nothing is
// put back, nothing is logged: the person's [note] reaches no worker, no hand-off and no queue.
for (const mode of ['warn', 'on', 'off'] as const) {
  test(`w6223 F1 ("${mode}"): a person's [note] for a sibling another worker handed back during the move is never lost`, async (t) => {
    const env = await setup(t, mode as 'on' | 'warn');
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
    const where: string[] = [];
    for (const w of env.store.work.values()) if (/old flag/.test(w.handedBack?.message ?? '')) where.push(`hand-off of ${w.id}`);
    for (const m of env.sessions.queued()) if (/old flag/.test(m.text)) where.push(`queued for ${m.id}`);
    for (const m of env.sent) if (/old flag/.test(m.text)) where.push(`sent to ${m.id}`);
    const w70 = env.store.work.get('w5870')!;
    assert.ok(where.length, `the person's [note] about w5870 reached nobody (w5870.handedBack = ${JSON.stringify({ session: w70.handedBack?.session, message: w70.handedBack?.message })})`);
  });
}

// w6223 F2: w6214 F1 again, but the request is between workers: handed back (a pause, a move to the dispatcher) and Queued, no
// worker placed yet. answerNeedsYou (orchestrators.ts:1509) finds no latestWorker (sessionIds is empty), so sid stays the asker,
// the old worker; wakeNow schedules its resume, which staleResume (w2079) refuses at the drain. The person is told "nothing for
// you to pass on", the answer goes into no hand-off, and the request's next worker never sees it.
test('w6223 F2: a person\'s [answer] while its request waits Queued after a hand-back is not lost', async (t) => {
  const env = await setup(t, 'warn');
  const old = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1' });
  env.sessions.adopt({ info: old, live: false, stop: () => {} } as unknown as SessionHandle);
  const w = env.request(['5449aaaa']);
  env.agents.orchestrators.handBack(w, old, pausedHb);
  assert.equal(w.status, 'queued');
  assert.deepEqual(w.sessionIds, []);
  w.needsYou = { kind: 'question', key: 'q', question: 'Ship it?', worker: '5449aaaa', at: OLD, raisedAt: OLD } as unknown as WorkItem['needsYou'];
  env.store.putWork(w);
  const said = (env.agents.orchestrators as unknown as { answerNeedsYou: (w: WorkItem, by: Requester, note: string) => string }).answerNeedsYou(w, LOTH, 'yes, ship it');
  const timers = (env.agents as unknown as { waker: { timers: Map<string, { note: string; resumeOf?: string }> } }).waker.timers;
  const toOld = timers.get('5449aaaa');
  const refused = toOld ? env.agents.orchestrators.staleResume(w.id, '5449aaaa', toOld.note) : 'no timer';
  const inHandOff = /ship it/.test(env.store.work.get('w5869')!.handedBack?.message ?? '');
  assert.ok(inHandOff || (toOld && refused === undefined), `answerNeedsYou said "${said}"; the old worker's resume is refused (${JSON.stringify(refused)}) and w5869's hand-off does not carry the answer`);
});
