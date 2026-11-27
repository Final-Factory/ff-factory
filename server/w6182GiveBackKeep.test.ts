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
 * w6047 (the w6182 review): a failed start's give-back ("on") puts each kept message back on its own, and a request closed
 * while the start ran takes no message into a hand-off nobody reads. Setup as in w5976MoveGiveBack.test.ts.
 *
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

// w6182 review A: a give-back ("on") that puts several kept messages back joins them under the FIRST one's resumeOf. When
// that first one is the old worker's own CI resume, the drain's staleResume check (w1128) drops the whole joined message,
// a person's words included, if the request is blocked again while the worker waits for a sandbox.
test('w6182 A ("on"): a person\'s message put back behind a CI resume survives the stale-resume check', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa']);
  x.startMoved = async () => {
    const person: QueuedSend = { uuid: 'u-person', id: '5449aaaa', text: 'lothsahn: also rename the flag', from: 'human', at: new Date().toISOString(), why: BISCUIT_FULL };
    assert.equal(roomMove(s, person, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
    throw new Error('no agent seat on beast now');
  };
  const resume: QueuedSend = { ...queued('5449aaaa', 'w5869: its CI cleared', Date.now() - 60_000, 'system'), resumeOf: { work: 'w5869', note: 'its CI cleared' } };
  assert.equal(roomMove(s, resume, BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const mine = sessions.queued().filter((m) => m.id === '5449aaaa' && /rename the flag/.test(m.text));
  assert.equal(mine.length, 1, "the person's message is put back for the old worker");
  // The request is blocked again (a hold, a new gate) while the worker waits for a sandbox on biscuit.
  const w = store.work.get('w5869')!;
  w.blocked = { kind: 'pr', ref: 'Final-Factory/ff-factory#1', at: new Date().toISOString() } as never;
  w.status = 'blocked';
  store.putWork(w);
  const m = mine[0]!;
  const stale = m.resumeOf ? agents.orchestrators.staleResume(m.resumeOf.work, m.id, m.resumeOf.note) : undefined;
  assert.equal(stale, undefined, `the joined message is dropped as a stale resume (${stale}); from=${m.from}; text=${JSON.stringify(m.text)}`);
});

// w6182 review B: a request closed while the start runs ("on"), the start fails: giveBack finds nothing given back and
// deliverHeld finds no open hand-off, so a person's message absorbed into the move reaches nobody.
test('w6182 B ("on"): a person\'s message is not lost when the request closes during a failed start', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled, sent } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa']);
  x.startMoved = async (info, w, _to, _why, _hold, _branch, _lead, hb) => {
    agents.orchestrators.movedForRoom(w, info, hb);
    const cur = store.work.get('w5869')!;
    cur.status = 'done';
    store.putWork(cur);
    throw new Error('its session new1 did not start: spawn failed');
  };
  assert.equal(roomMove(s, queued('5449aaaa', 'lothsahn: also rename the flag', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const hit = (m: { id: string; text: string }) => /rename the flag/.test(m.text);
  const w = store.work.get('w5869')!;
  const where = { sent: sent.filter(hit).map((m) => m.id), queued: sessions.queued().filter(hit).map((m) => m.id), inClosedHandOff: /rename the flag/.test(w.handedBack?.message ?? '') };
  assert.ok(where.sent.length + where.queued.length > 0, `reached no worker: ${JSON.stringify(where)}`);
});

// w6047 (the w6182 fix): kept messages go back one by one, each with its own send, in the order they came.
test('w6182 A2 ("on"): kept messages go back each on its own, in order, each with its own sender', async (t) => {
  const { sessions, agents, worker, request, queued, roomMove, settled } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa']);
  x.startMoved = async () => {
    for (const n of ['one', 'two']) {
      const person: QueuedSend = { uuid: `u-person-${n}`, id: '5449aaaa', text: `lothsahn: message ${n}`, from: 'human', at: new Date().toISOString(), why: BISCUIT_FULL };
      assert.equal(roomMove(s, person, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
    }
    throw new Error('no agent seat on beast now');
  };
  const resume: QueuedSend = { ...queued('5449aaaa', 'w5869: its CI cleared', Date.now() - 60_000, 'system'), resumeOf: { work: 'w5869', note: 'its CI cleared' } };
  assert.equal(roomMove(s, resume, BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const mine = sessions.queued().filter((m) => m.id === '5449aaaa');
  assert.deepEqual(mine.map((m) => [m.text, m.from, !!m.resumeOf]), [
    ['w5869: its CI cleared', 'system', true],
    ['lothsahn: message one', 'human', false],
    ['lothsahn: message two', 'human', false],
  ]);
});
