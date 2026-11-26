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
 * w5976: a room move whose fresh session does not start. Before, Orchestrators.handBack left the request Queued with no
 * worker while the old worker kept the movedAway mark moveForRoom sets before startMoved succeeds (the w5950 review). With
 * config movedAwayWorkers "on" the request is given back to the old worker instead; "warn" (the default) keeps the hand-back.
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
  const sent: { id: string; text: string; from: string }[] = [];
  sessions.send = ((id: string, text: string, from: 'human' | 'orchestrator' | 'system' = 'human') => {
    sent.push({ id, text, from });
    return 'queued';
  }) as SessionManager['send'];
  return { store, sessions, agents, machines, starts, worker, request, queued, roomMove, settled, sent };
}

const RELEASED = { at: OLD, sandbox: 'slot1', branch: 'w5449-fix', why: 'idle' };

/** A startMoved that fails: before the request was touched (no seat there), or after movedForRoom took it off (late). */
function failing(agents: Agents, how: 'early' | 'late', tried: string[]) {
  const x = agents as unknown as Internals;
  x.startMoved = async (info, w, to, _why, _hold, _branch, _lead, hb) => {
    tried.push(`${to}:${w.id}`);
    if (how === 'late') {
      agents.orchestrators.movedForRoom(w, info, hb);
      throw new Error('its session new1 did not start: spawn failed');
    }
    throw new Error(`no agent seat on ${to} now`);
  };
}

for (const how of ['early', 'late'] as const) {
  test(`w5976 ("on"): a move whose fresh session fails to start (${how}) gives the request back to its old worker, with its message`, async (t) => {
    const { store, sessions, agents, worker, request, queued, roomMove, settled } = await setup(t, 'on');
    const tried: string[] = [];
    failing(agents, how, tried);
    const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
    request(['5449aaaa']);
    const q = queued('5449aaaa', 'go on', Date.now() - 60_000);
    assert.equal(roomMove(s, q, BISCUIT_FULL, Date.now()), true);
    await settled('5449aaaa');
    assert.equal(tried.length, 1);
    const to = tried[0]!.split(':')[0]!;
    const w = store.work.get('w5869')!;
    assert.deepEqual(w.sessionIds, ['5449aaaa'], 'linked to its old worker');
    assert.equal(w.status, 'active', 'not Queued with no worker');
    assert.equal(w.queuedFor, undefined);
    assert.equal(w.movedOff?.['5449aaaa'], undefined, 'not marked moved off');
    assert.equal(w.handedBack, undefined, 'no hand-off left for a new worker');
    if (how === 'late') assert.ok(w.links?.['5449aaaa'], 'its link is back');
    assert.equal(store.sessions.get('5449aaaa')!.movedAway, undefined, 'the old worker keeps no movedAway mark');
    assert.ok(store.sessions.get('5449aaaa')!.placeReleased, 'its sandbox stays released: it resumes when one frees at home');
    const back = sessions.queued().filter((m) => m.id === '5449aaaa');
    assert.equal(back.length, 1, 'the message waits for the old worker again');
    assert.equal(back[0]!.text, 'go on');
    assert.equal(back[0]!.at, q.at, 'with the time it was first queued');
    assert.match(agents.moveGuard.refusals(Date.now())[to] ?? '', /a moved session did not start there .*w5976/, `${to} is no move target for a while`);
    // The next drain does not try the same computer again.
    assert.equal(roomMove(s, back[0]!, BISCUIT_FULL, Date.now()), true);
    await settled('5449aaaa');
    assert.equal(tried.length, 2);
    assert.notEqual(tried[1]!.split(':')[0], to, 'the next move tries another computer');
  });
}

test('w5976 ("on"): a single message put back after a failed start keeps its attachments and its own text (w5995)', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled } = await setup(t, 'on');
  failing(agents, 'late', []);
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa']);
  const att = { id: 'att_abcdef123456', name: 'Player.log', size: 10, sha256: 'ab'.repeat(32), kind: 'Unity Player.log', mediaType: 'text/plain', path: 'Inbox/att_abcdef123456-Player.log' };
  const q: QueuedSend = { ...queued('5449aaaa', 'look at this log', Date.now() - 60_000), attachments: [att] };
  assert.equal(roomMove(s, q, BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  assert.equal(store.work.get('w5869')!.status, 'active');
  const back = sessions.queued().filter((m) => m.id === '5449aaaa');
  assert.equal(back.length, 1);
  assert.equal(back[0]!.text, 'look at this log', 'its own text, not the attachment ids written into it');
  assert.deepEqual(back[0]!.attachments, [att], 'its attachments go back with it');
  assert.equal(back[0]!.at, q.at);
});

test('w5976 ("on"): the other requests are handed back only once the fresh session started; a failed start keeps them too', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled } = await setup(t, 'on');
  const tried: string[] = [];
  failing(agents, 'early', tried);
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa'], 'w5869');
  request(['5449aaaa'], 'w5870');
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  assert.equal(tried.length, 1);
  for (const id of ['w5869', 'w5870']) {
    const w = store.work.get(id)!;
    assert.deepEqual(w.sessionIds, ['5449aaaa'], `${id} stays with its worker`);
    assert.notEqual(w.status, 'queued', `${id} is not Queued with no worker`);
  }
});

test('w5976 ("on"): a move that starts hands the other requests back as before, and holds the moved one where it went', async (t) => {
  const { store, sessions, agents, starts, worker, request, queued, roomMove, settled } = await setup(t, 'on');
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa'], 'w5869');
  request(['5449aaaa'], 'w5870');
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  assert.equal(starts.length, 1);
  const moved = [...store.work.values()].filter((w) => w.sessionIds.includes('new1'));
  const handed = [...store.work.values()].filter((w) => w.status === 'queued');
  assert.equal(moved.length, 1, 'one request went to the fresh session');
  assert.equal(handed.length, 1, 'the other is handed back to the dispatcher');
  assert.deepEqual(handed[0]!.sessionIds, []);
  assert.ok(store.sessions.get('5449aaaa')!.movedAway, 'the old worker is marked moved away');
  assert.equal(sessions.queued().filter((m) => m.id === '5449aaaa').length, 0, 'nothing put back');
  assert.match(agents.moveGuard.movedLately([moved[0]!.id], Date.now()) ?? '', /moved to/);
});

test('w5976 ("warn", the default): a failed start is handed back to the dispatcher as before', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled } = await setup(t, 'warn');
  const tried: string[] = [];
  failing(agents, 'early', tried);
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa']);
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const w = store.work.get('w5869')!;
  assert.equal(w.status, 'queued');
  assert.deepEqual(w.sessionIds, []);
  assert.ok(store.sessions.get('5449aaaa')!.movedAway, 'its movedAway mark stays, as before');
  assert.equal(sessions.queued().filter((m) => m.id === '5449aaaa').length, 0);
  assert.deepEqual(agents.moveGuard.refusals(Date.now()), {});
});
