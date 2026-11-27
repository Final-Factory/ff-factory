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
 * w6047 (the w6193 review, from its reviewer's repro): a person's [answer] or [note] that a room move puts back to the old
 * worker survives the drain's staleResume (w1128) when its request closed meanwhile, in "warn" (deliverHeld) and "on"
 * (giveBack) alike; and a moved worker is never un-marked (kept) for a sibling another worker handed back while its start ran.
 * Setup as in w5976MoveGiveBack.test.ts.
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
const stale = (env: Env, re: RegExp) =>
  env.sessions.queued().filter((m) => re.test(m.text)).map((m) => (m.resumeOf ? env.agents.orchestrators.staleResume(m.resumeOf.work, m.id, m.resumeOf.note) : undefined));

// R1 ("warn"): the move's only request is handed back and closed during the waits; the held message is a person's [answer]
// sent as a resume of it. deliverHeld's put-back keeps resumeOf, and the drain's staleResume drops a resume of a closed request
// (orchestrators.ts staleResume: `!isOpen(w)`, with no ANSWER_MARK exemption), so the person's answer never reaches anyone.
test('w6193 R1 ("warn"): a person\'s [answer] put back to the old worker survives the drain', async (t) => {
  const env = await setup(t, 'warn');
  const answer: QueuedSend = { uuid: 'u-answer', id: '5449aaaa', text: '[answer] lothsahn: yes, ship it', from: 'human', at: new Date().toISOString(), why: BISCUIT_FULL, resumeOf: { work: 'w5869', note: '[answer] yes, ship it' } };
  const handOffs: (string | undefined)[] = [];
  recordStarts(env, handOffs);
  (env.agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      assert.equal(env.roomMove(s, answer, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
      env.agents.orchestrators.handBack(env.store.work.get('w5869')!, env.store.sessions.get('5449aaaa')!, pausedHb);
      close(env, 'w5869');
      return undefined;
    },
    running: () => false,
  };
  const s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  env.request(['5449aaaa']);
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: go on', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /ship it/, handOffs);
  assert.ok(reached(p) > 0, `reached nobody: ${JSON.stringify(p)}`);
  assert.deepEqual(stale(env, /ship it/).filter(Boolean), [], `the drain drops the put-back answer: ${JSON.stringify(stale(env, /ship it/))}`);
});

// R2 ("on"): the same through giveBack: the start fails and the only request closed while it ran; giveBack's keep loop puts
// the answer back with its resumeOf, which staleResume then drops.
test('w6193 R2 ("on"): a failed start whose request closed meanwhile: the put-back person\'s [answer] survives the drain', async (t) => {
  const env = await setup(t, 'on');
  const x = env.agents as unknown as Internals;
  x.startMoved = async () => {
    close(env, 'w5869');
    throw new Error('no free sandbox on beast now');
  };
  const answer: QueuedSend = { uuid: 'u-answer', id: '5449aaaa', text: '[answer] lothsahn: yes, ship it', from: 'human', at: new Date().toISOString(), why: BISCUIT_FULL, resumeOf: { work: 'w5869', note: '[answer] yes, ship it' } };
  (env.agents as unknown as { liveHub: unknown }).liveHub = { endFor: async () => { assert.equal(env.roomMove(s, answer, BISCUIT_FULL, Date.now()), true, 'absorbed'); return undefined; }, running: () => false };
  const s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  env.request(['5449aaaa']);
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: go on', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /ship it/, [] as (string | undefined)[]);
  assert.ok(reached(p) > 0, `reached nobody: ${JSON.stringify(p)}`);
  assert.deepEqual(stale(env, /ship it/).filter(Boolean), [], `the drain drops the put-back answer: ${JSON.stringify(stale(env, /ship it/))}`);
});

// R3 ("warn"): a sibling's message absorbed while the start runs, the sibling re-placed on worker yyyy and handed back by it
// meanwhile (handedBack.session is yyyy). deliverHeld finds no hand-back of the old worker's, so it puts the message back to
// the old worker and deletes its movedAway, while its primary request has moved to new1: a worker kept AND moved.
test('w6193 R3 ("warn"): a moved worker is never un-marked while its request runs on the new one', async (t) => {
  const env = await setup(t, 'warn');
  const handOffs: (string | undefined)[] = [];
  const msg: QueuedSend = { uuid: 'u-late', id: '5449aaaa', text: 'lothsahn: about w5870, use the old flag', from: 'human', at: new Date().toISOString(), why: BISCUIT_FULL, resumeOf: { work: 'w5870', note: '[note] use the old flag' } };
  let s: SessionInfo;
  recordStarts(env, handOffs, () => {
    assert.equal(env.roomMove(s, msg, BISCUIT_FULL, Date.now()), true, 'absorbed while the start runs');
    const y = env.worker('yyyyyyyy', { machineId: 'beast', machineSandbox: 'slot2' });
    const g = env.store.work.get('w5870')!;
    g.sessionIds = [...g.sessionIds, y.id];
    env.store.putWork(g);
    env.agents.orchestrators.handBack(g, y, { ...pausedHb, machine: 'beast', sandbox: 'slot2' });
  });
  s = env.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  env.request(['5449aaaa'], 'w5869');
  env.request(['5449aaaa'], 'w5870');
  assert.equal(env.roomMove(s, env.queued('5449aaaa', 'lothsahn: go on', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await env.settled('5449aaaa');
  const p = whereIs(env, /old flag/, handOffs);
  const info = env.store.sessions.get('5449aaaa')!;
  assert.ok(info.movedAway, `the old worker lost its movedAway mark although w5869 moved to new1; the message went: ${JSON.stringify(p)}, drain verdict: ${JSON.stringify(stale(env, /old flag/))}`);
});

// R4: staleResume itself lets a person's answer or note go when its request closed (w2495 widened), never an own resume, and a
// moved-off worker still takes none (w2079): it goes to the request's new worker.
test('w6193 R4: staleResume lets a person\'s answer to a closed request go, but not to a worker moved off it', async (t) => {
  const env = await setup(t, 'warn');
  const w = env.request(['5449aaaa']);
  close(env, w.id);
  const o = env.agents.orchestrators;
  assert.equal(o.staleResume(w.id, '5449aaaa', '[answer] yes, ship it'), undefined);
  assert.equal(o.staleResume(w.id, '5449aaaa', '[note] use the old flag'), undefined);
  assert.match(o.staleResume(w.id, '5449aaaa', 'CI on #1 cleared') ?? '', /is done/);
  const m = env.request(['new1'], 'w5871');
  m.movedOff = { '5449aaaa': new Date().toISOString() };
  env.store.putWork(m);
  assert.match(o.staleResume(m.id, '5449aaaa', '[answer] yes') ?? '', /was moved off worker 5449aaaa/);
});
