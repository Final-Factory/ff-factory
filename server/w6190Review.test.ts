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
 * w6047 (the w6190 review, from its reviewer's repro): a person's message held by a room move whose request closed meanwhile
 * (the move's own one handed back and closed, or a sibling closed in the waits or while the start ran) reaches someone: the
 * move's request's hand-off or new worker, else the old worker, which is then kept. And a fault after the start never undoes
 * the move. Setup as in w5976MoveGiveBack.test.ts.
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
  sessions.send = ((id: string, text: string, from: 'human' | 'orchestrator' | 'system' = 'human', images?: unknown[]) => {
    sent.push({ id, text, from, ...(images ? { images } : {}) });
    return 'queued';
  }) as SessionManager['send'];
  return { store, sessions, agents, machines, starts, worker, request, queued, roomMove, settled, sent };
}

const RELEASED = { at: OLD, sandbox: 'slot1', branch: 'w5449-fix', why: 'idle' };
const pausedHb = { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' };
type Env = Awaited<ReturnType<typeof setup>>;
// Where a text went: a send, a queued message, any request's hand-off, or a fresh session's hand-off (startMoved's hb.message).
function whereIs(env: Env, re: RegExp, handOffs: (string | undefined)[]) {
  const w = [...env.store.work.values()];
  return {
    sent: env.sent.filter((m) => re.test(m.text)).map((m) => m.id),
    queued: env.sessions.queued().filter((m) => re.test(m.text)).map((m) => m.id),
    openHandOff: w.filter((x) => x.status !== 'done' && re.test(x.handedBack?.message ?? '')).map((x) => x.id),
    closedHandOff: w.filter((x) => x.status === 'done' && re.test(x.handedBack?.message ?? '')).map((x) => x.id),
    freshHandOff: handOffs.filter((m) => re.test(m ?? '')).length,
  };
}
const reached = (p: ReturnType<typeof whereIs>) => p.sent.length + p.queued.length + p.openHandOff.length + p.freshHandOff;
function recordStarts(env: Env, handOffs: (string | undefined)[], during?: () => void) {
  const x = env.agents as unknown as Internals;
  const start = x.startMoved;
  x.startMoved = async (info, w, to, why, hold, branch, lead, hb) => {
    during?.();
    handOffs.push(hb.message);
    return start(info, w, to, why, hold, branch, lead, hb);
  };
}
const close = (env: Env, id: string) => {
  const w = env.store.work.get(id)!;
  w.status = 'done';
  env.store.putWork(w);
};

// Gap (c): "warn", the move's only request handed back during the move's waits and then closed: the person's message.
test('w6190 C ("warn"): a person\'s message is not dropped when its only request is handed back and closed during the move', async (t) => {
  const env = await setup(t, 'warn');
  const handOffs: (string | undefined)[] = [];
  recordStarts(env, handOffs);
  (env.agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      env.agents.orchestrators.handBack(env.store.work.get('w5869')!, env.store.sessions.get('5449aaaa')!, pausedHb);
      close(env, 'w5869');
      return undefined;
    },
    running: () => false,
  };
  const s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  env.request(['5449aaaa']);
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: also rename the flag', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /rename the flag/, handOffs);
  assert.ok(reached(p) > 0, `reached nobody: ${JSON.stringify(p)}`);
});

// A person's [answer] resume of a SIBLING request that closes during the move's waits ("warn", the default).
test('w6190 D ("warn"): a person\'s [answer] for a sibling request closed during the move is not dropped', async (t) => {
  const env = await setup(t, 'warn');
  const handOffs: (string | undefined)[] = [];
  recordStarts(env, handOffs);
  const s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  const answer: QueuedSend = { uuid: 'u-answer', id: '5449aaaa', text: '[answer] lothsahn: yes, ship w5870', from: 'human', at: new Date().toISOString(), why: BISCUIT_FULL, resumeOf: { work: 'w5870', note: '[answer] yes, ship it' } };
  (env.agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      assert.equal(env.roomMove(s, answer, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
      close(env, 'w5870');
      return undefined;
    },
    running: () => false,
  };
  env.request(['5449aaaa'], 'w5869');
  env.request(['5449aaaa'], 'w5870');
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: go on', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /ship w5870/, handOffs);
  assert.ok(reached(p) > 0, `the person's answer reached nobody: ${JSON.stringify(p)}`);
});

// The same with "on": the sibling closes while the fresh session starts; its hand-back and the held answer come after.
test('w6190 E ("on"): a person\'s [answer] for a sibling request closed while the start ran is not dropped', async (t) => {
  const env = await setup(t, 'on');
  const handOffs: (string | undefined)[] = [];
  recordStarts(env, handOffs, () => close(env, 'w5870'));
  const s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  const answer: QueuedSend = { uuid: 'u-answer', id: '5449aaaa', text: '[answer] lothsahn: yes, ship w5870', from: 'human', at: new Date().toISOString(), why: BISCUIT_FULL, resumeOf: { work: 'w5870', note: '[answer] yes, ship it' } };
  (env.agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      assert.equal(env.roomMove(s, answer, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
      return undefined;
    },
    running: () => false,
  };
  env.request(['5449aaaa'], 'w5869');
  env.request(['5449aaaa'], 'w5870');
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: go on', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /ship w5870/, handOffs);
  assert.ok(reached(p) > 0, `the person's answer reached nobody: ${JSON.stringify(p)}`);
});

// w6047 (the w6190 fix): in C the message goes back to the old worker once, which keeps its session: no move mark, not retired.
test('w6190 C2 ("warn"): the held message goes back to the old worker once, which is kept, not retired', async (t) => {
  const env = await setup(t, 'warn');
  const retired: string[] = [];
  env.agents.orchestrators.retireWhenFree = ((id: string) => (retired.push(id), 'retired')) as typeof env.agents.orchestrators.retireWhenFree;
  (env.agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      env.agents.orchestrators.handBack(env.store.work.get('w5869')!, env.store.sessions.get('5449aaaa')!, pausedHb);
      close(env, 'w5869');
      return undefined;
    },
    running: () => false,
  };
  const s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  env.request(['5449aaaa']);
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: also rename the flag', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /rename the flag/, []);
  assert.deepEqual(p.queued, ['5449aaaa'], JSON.stringify(p));
  assert.deepEqual(p.sent, []);
  const q = env.sessions.queued().find((m) => /rename the flag/.test(m.text))!;
  assert.equal(q.from, 'human', 'its own sender');
  assert.deepEqual(retired, [], 'not retired');
  assert.equal(env.store.sessions.get('5449aaaa')!.movedAway, undefined, 'no move mark');
});

// w6047 (the w6190 review, F2): a fault in a step after the start never gives the request back ("on").
test('w6190 F2 ("on"): a step that throws after the start does not undo the move or deliver twice', async (t) => {
  const env = await setup(t, 'on');
  const handOffs: (string | undefined)[] = [];
  recordStarts(env, handOffs);
  (env.agents as unknown as { moveGuard: { noteMove: () => void } }).moveGuard.noteMove = () => {
    throw new Error('boom');
  };
  const s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  env.request(['5449aaaa']);
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: also rename the flag', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /rename the flag/, handOffs);
  assert.equal(p.freshHandOff, 1, JSON.stringify(p));
  assert.deepEqual(p.queued, [], 'not put back to the old worker as well');
  assert.deepEqual(p.sent, []);
  assert.ok(env.store.sessions.get('5449aaaa')!.movedAway, 'the move stands');
  assert.ok(env.store.work.get('w5869')!.sessionIds.includes('new1'), 'the request is with new1');
});

// A non-person resume (the old worker's own check-in) of a sibling closed during the start still goes nowhere ("on").
test('w6190 E2 ("on"): the old worker\'s own [wake_me] for a sibling closed while the start ran is dropped, not forwarded', async (t) => {
  const env = await setup(t, 'on');
  const handOffs: (string | undefined)[] = [];
  recordStarts(env, handOffs, () => close(env, 'w5870'));
  const s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  const wake: QueuedSend = { uuid: 'u-wake', id: '5449aaaa', text: '[wake_me] check w5870 CI', from: 'system', at: new Date().toISOString(), why: BISCUIT_FULL, resumeOf: { work: 'w5870', note: 'CI' } };
  (env.agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      assert.equal(env.roomMove(s, wake, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
      return undefined;
    },
    running: () => false,
  };
  env.request(['5449aaaa'], 'w5869');
  env.request(['5449aaaa'], 'w5870');
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: go on', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /check w5870 CI/, handOffs);
  assert.equal(p.sent.length + p.queued.length + p.openHandOff.length, 0, JSON.stringify(p));
});
