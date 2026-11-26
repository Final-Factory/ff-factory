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

// ---------------------------------------------------------------- w6047: the w5995 review's minor findings

test('w6047 (finding 3): a start that goes through on a computer clears its cap refusal, never a moved session that did not start there', async () => {
  const { MoveGuard } = await import('./resumeMove.ts');
  const g = new MoveGuard();
  const t0 = Date.now();
  g.noteRefusal('beast', 'spawn failed', t0, 'a moved session did not start there');
  g.startedOn('beast');
  assert.match(g.refusals(t0 + 1000).beast ?? '', /a moved session did not start there .*w5976/, 'still no move target');
  g.noteRefusal('lothdesktop', 'already 6 agents running', t0);
  g.startedOn('lothdesktop');
  assert.equal(g.refusals(t0 + 1000).lothdesktop, undefined, 'a cap refusal is over once a start goes through');
  // The w6056 review (minor): a cap refusal there later never turns the standing one into one a start clears.
  g.noteRefusal('beast', 'already 6 agents running', t0 + 2000);
  g.startedOn('beast');
  assert.match(g.refusals(t0 + 3000).beast ?? '', /a moved session did not start there/, 'still no move target after a cap refusal');
  // It still ends by itself (REFUSED_FOR_MS, 30 min): nobody at the machine is needed.
  assert.equal(g.refusals(t0 + 31 * 60_000).beast, undefined);
});

test('w6047 (finding 4, "on"): a hand-back made while the start was under way stands; the failed move does not undo it', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  x.startMoved = async (info, w) => {
    // biscuit is paused meanwhile: its pause hands the request back to the dispatcher (w1532).
    agents.orchestrators.handBack(w, info, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
    throw new Error('no agent seat there now');
  };
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa']);
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const w = store.work.get('w5869')!;
  assert.equal(w.status, 'queued', 'Queued for the dispatcher, as the pause said');
  assert.deepEqual(w.sessionIds, [], 'not linked back to the old worker');
  assert.match(w.handedBack?.how ?? '', /paused/, "the pause's hand-back stands");
  assert.match(w.log.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'), /not given back to worker 5449aaaa .*handed back meanwhile/);
  // The w6056 review, 2: the message the move held goes with that hand-off, never to the old worker, which holds nothing now.
  assert.match(w.handedBack?.message ?? '', /go on/, "the message rides the pause's hand-off");
  assert.equal(sessions.queued().filter((m) => m.id === '5449aaaa').length, 0, 'not put back for the old worker');
});

type PreemptInternals = Internals & {
  preemptVerdict: () => { move?: string; release?: boolean; stays?: string };
  runTimedLegStart: (w: WorkItem, machine: string, why: string, moves: readonly { session: string }[]) => Promise<void>;
};

/** A timed leg pre-empts biscuit's 5449aaaa (moved to beast); a message for it comes while the fresh session starts. */
async function preemptLeg(t: Parameters<typeof setup>[0], mode: 'on' | 'warn', fail: boolean) {
  const s = await setup(t, mode);
  const x = s.agents as unknown as PreemptInternals;
  const info = s.worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 3 });
  s.store.putMachine({ id: 'biscuit', host: 'biscuit', portalUrl: 'x', sessionIds: [], sandboxes: [{ id: 'slot1', sessionIds: ['5449aaaa'] } as never] } as never);
  s.request(['5449aaaa']);
  const leg = s.request([], 'w6100');
  x.preemptVerdict = () => ({ move: 'beast' });
  (s.agents as unknown as { branchNow: () => string }).branchNow = () => 'w5869-fix';
  (s.agents as unknown as { saveSandboxWork: () => Promise<unknown> }).saveSandboxWork = async () => ({ files: 0, pushed: true, notes: [] });
  const plain = x.startMoved;
  let late: QueuedSend | undefined;
  x.startMoved = async (...a) => {
    // The message comes while the fresh session starts: roomMove takes it into the move.
    late = s.queued('5449aaaa', 'one more thing', Date.now());
    assert.equal(s.roomMove(info, late, BISCUIT_FULL, Date.now()), true, 'taken into the move');
    if (fail) throw new Error('its session new1 did not start: spawn failed');
    return plain(...a);
  };
  const logs: string[] = [];
  const log = console.log;
  console.log = (...m: unknown[]) => void logs.push(m.join(' '));
  try {
    await x.runTimedLegStart(leg, 'biscuit', 'w6100 needs biscuit', [{ session: '5449aaaa' }]).catch(() => undefined);
  } finally {
    console.log = log;
  }
  return { ...s, logs };
}

test('w6047 (finding 5): a message that comes while a timed-leg pre-empt moves its worker goes to the new worker', async (t) => {
  const { sent, logs } = await preemptLeg(t, 'on', false);
  const to = sent.filter((m) => m.id === 'new1');
  assert.equal(to.length, 1, 'forwarded to the new worker');
  assert.match(to[0]!.text, /one more thing/);
  assert.ok(logs.some((l) => /timed preempt .* moved to beast/.test(l)));
});

test('w6047 (finding 5, "on"): a pre-empt whose move does not start puts the message back for the old worker and says so', async (t) => {
  const { sessions, store, logs } = await preemptLeg(t, 'on', true);
  const back = sessions.queued().filter((m) => m.id === '5449aaaa');
  assert.equal(back.length, 1, 'the message waits for the old worker again');
  assert.equal(back[0]!.text, 'one more thing');
  assert.deepEqual(store.work.get('w5869')!.sessionIds, ['5449aaaa']);
  assert.ok(!logs.some((l) => /timed preempt .* moved to beast/.test(l)), 'no "moved to" after a give-back');
  assert.ok(logs.some((l) => /timed preempt .* stays its worker's/.test(l)));
});

test('w6047 (finding 5, "warn"): a pre-empt whose move does not start hands the message back with the request', async (t) => {
  const { store } = await preemptLeg(t, 'warn', true);
  const w = store.work.get('w5869')!;
  assert.equal(w.status, 'queued');
  assert.match(w.handedBack?.message ?? '', /one more thing/, "the message rides the request's hand-off");
});

test('w6047 (the w6088 review): a hand-back placed on a next worker before the failed start returns: the held message reaches that worker', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled, sent } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  x.startMoved = async (info, w) => {
    agents.orchestrators.handBack(w, info, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
    // The dispatcher places the handed-back request meanwhile (its handover read handedBack now, with no message yet).
    const n: SessionInfo = { id: 'next1', kind: 'worker', title: 'w5869: FF Factory fix', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 0, costUsd: 0, pendingPermissions: [], machineId: 'lothdesktop', machineSandbox: 'slot2' };
    store.putSession(n);
    agents.orchestrators.linkWorker(w.id, n, 'started worker next1 in lothdesktop/slot2');
    throw new Error('no agent seat there now');
  };
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa']);
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const reached = sent.some((m) => m.id === 'next1' && /go on/.test(m.text)) || sessions.queued().some((m) => m.id === 'next1' && /go on/.test(m.text));
  assert.ok(reached, '"go on" reaches next1, the worker the hand-back went to');
});


test('w6047 (the w6104 review): every request handed back, no next worker yet, an OLDER worker still linked: the held message rides the hand-off', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled, sent } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  x.startMoved = async (info, w) => {
    agents.orchestrators.handBack(w, info, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
    throw new Error('no agent seat there now');
  };
  worker('old0aaaa', { machineId: 'm5', machineSandbox: 'slot3', turns: 4 });
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['old0aaaa', '5449aaaa']);
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const w = store.work.get('w5869')!;
  assert.equal(sent.filter((m) => m.id === 'old0aaaa').length, 0, 'not forwarded to the older, stale worker');
  assert.match(w.handedBack?.message ?? '', /go on/, "the message rides the pause's hand-off for the next worker");
});

const nextW = (id: string, m: string): SessionInfo => ({ id, kind: 'worker', title: 'w5869: FF Factory fix', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 0, costUsd: 0, pendingPermissions: [], machineId: m, machineSandbox: 'slot2' });

test('w6047 (the w6118 review, 1): dispatcher re-links an OLDER worker already on the request while the start runs: "go on" reaches it', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled, sent } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  x.startMoved = async (info, w) => {
    agents.orchestrators.handBack(w, info, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
    // The dispatcher sends the handed-back request to old0aaaa, "already on it" (agents.ts send path -> linkWorker).
    agents.orchestrators.linkWorker(w.id, store.sessions.get('old0aaaa')!, 'sent to old0aaaa, already on it');
    throw new Error('no agent seat there now');
  };
  worker('old0aaaa', { machineId: 'm5', machineSandbox: 'slot3', turns: 4 });
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['old0aaaa', '5449aaaa']);
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const w = store.work.get('w5869')!;
  const reached = sent.some((m) => m.id === 'old0aaaa' && /go on/.test(m.text)) || sessions.queued().some((m) => m.id === 'old0aaaa' && /go on/.test(m.text));
  assert.ok(reached, '"go on" reaches old0aaaa, the worker the request was re-sent to');
});

test('w6047 (the w6118 review, 2): hand-back and next worker placed BEFORE MoveBefore is taken (during the stop/save awaits): "go on" reaches next1', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled, sent } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  (agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      const w = store.work.get('w5869')!;
      agents.orchestrators.handBack(w, store.sessions.get('5449aaaa')!, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
      const n = nextW('next1', 'lothdesktop');
      store.putSession(n);
      agents.orchestrators.linkWorker(w.id, n, 'started worker next1 in lothdesktop/slot2');
      return undefined;
    },
    running: () => false,
  };
  x.startMoved = async () => {
    throw new Error('no agent seat there now');
  };
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa']);
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const w = store.work.get('w5869')!;
  const reached = sent.some((m) => m.id === 'next1' && /go on/.test(m.text)) || sessions.queued().some((m) => m.id === 'next1' && /go on/.test(m.text));
  assert.ok(reached, '"go on" reaches next1');
  // The hand-back made during the waits stands (MoveBefore.handedBack is the one from when the move began): the old worker
  // is not linked again beside next1, so it is retired, not left holding the request.
  assert.deepEqual(w.sessionIds, ['next1']);
});

test('w6047 (the w6118 review): two requests handed back, one placed: each request gets the message once, none twice', async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled, sent } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  let first = true;
  x.startMoved = async (info, w) => {
    if (first) {
      first = false;
      for (const id of ['w5869', 'w5870']) agents.orchestrators.handBack(store.work.get(id)!, info, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
      const n = nextW('next1', 'lothdesktop');
      store.putSession(n);
      agents.orchestrators.linkWorker('w5869', n, 'started worker next1');
    }
    throw new Error('no agent seat there now');
  };
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  request(['5449aaaa'], 'w5869');
  request(['5449aaaa'], 'w5870');
  assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const a = store.work.get('w5869')!, b = store.work.get('w5870')!;
  assert.equal(sent.filter((m) => m.id === 'next1').length, 1);
  assert.equal(a.handedBack?.message, undefined);
  assert.match(b.handedBack?.message ?? '', /^go on$/);
  assert.equal(sessions.queued().filter((m) => m.id === '5449aaaa').length, 0, 'not also put back for the old worker');
});

for (const mode of ['on', 'warn'] as const) {
  for (const start of ['late failure', 'success'] as const) {
    test(`w6047 (the w6124 review, "${mode}"): a hand-back made during the move's waits stands; the move never starts (it would end in a ${start})`, async (t) => {
      const { store, sessions, agents, worker, request, queued, roomMove, settled, starts } = await setup(t, mode);
      const tried: string[] = [];
      if (start === 'late failure') failing(agents, 'late', tried);
      (agents as unknown as { liveHub: unknown }).liveHub = {
        endFor: async () => {
          agents.orchestrators.handBack(store.work.get('w5869')!, store.sessions.get('5449aaaa')!, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
          return undefined;
        },
        running: () => false,
      };
      const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
      request(['5449aaaa']);
      assert.equal(roomMove(s, queued('5449aaaa', 'go on', Date.now() - 60_000), BISCUIT_FULL, Date.now()), true);
      await settled('5449aaaa');
      const w = store.work.get('w5869')!;
      assert.deepEqual([...tried, ...starts], [], 'no fresh session was started');
      assert.match(w.handedBack?.how ?? '', /paused/, "the pause's hand-back stands");
      assert.equal(w.status, 'queued');
      assert.ok(!w.sessionIds.includes('5449aaaa') || w.movedOff?.['5449aaaa'], 'the old worker is not given the request back');
      assert.match(w.handedBack?.message ?? '', /^go on$/, 'the held message goes with the hand-back, once');
      assert.equal(sessions.queued().filter((m) => m.id === '5449aaaa').length, 0, 'not put back for the old worker');
      assert.deepEqual(agents.moveGuard.refusals(Date.now()), {}, 'the target is no worse a move target for it');
    });
  }
}

for (const mode of ['on', 'warn'] as const) {
  test(`w6047 (the w6136 review, "${mode}"): the request a message resumes, handed back during the move's waits, carries it; not a sibling's hand-off, not the old worker`, async (t) => {
    const { store, sessions, agents, worker, request, queued, roomMove, settled, starts } = await setup(t, mode);
    (agents as unknown as { liveHub: unknown }).liveHub = {
      endFor: async () => {
        agents.orchestrators.handBack(store.work.get('w5870')!, store.sessions.get('5449aaaa')!, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
        return undefined;
      },
      running: () => false,
    };
    const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
    request(['5449aaaa'], 'w5869');
    request(['5449aaaa'], 'w5870');
    const q: QueuedSend = { ...queued('5449aaaa', 'go on', Date.now() - 60_000), resumeOf: { work: 'w5870', note: 'its CI cleared' } };
    assert.equal(roomMove(s, q, BISCUIT_FULL, Date.now()), true);
    await settled('5449aaaa');
    const a = store.work.get('w5869')!, b = store.work.get('w5870')!;
    assert.deepEqual(starts, [], 'no fresh session was started');
    assert.match(b.handedBack?.how ?? '', /paused/, "the pause's hand-back stands");
    assert.match(b.handedBack?.message ?? '', /^go on$/, 'the request it resumes carries the message, once');
    assert.equal(a.handedBack?.message, undefined, "not in the sibling's hand-off");
    assert.equal(sessions.queued().filter((m) => m.id === '5449aaaa' && m.resumeOf?.work === 'w5870').length, 0, 'no resume of w5870 waits for the old worker');
    if (mode === 'on') assert.ok(a.sessionIds.includes('5449aaaa') && !a.handedBack, 'the sibling stays with the old worker');
  });
}

for (const order of ['resume first', 'resume later'] as const) {
  test(`w6047 (the w6149 review, ${order === 'resume first' ? '1' : '2'}): only the resume of a request handed back meanwhile goes with its hand-back; a person's message goes back to the old worker (${order})`, async (t) => {
    const { store, sessions, agents, worker, request, queued, roomMove, settled } = await setup(t, 'on');
    const tried: string[] = [];
    failing(agents, 'early', tried);
    const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
    const resume: QueuedSend = { ...queued('5449aaaa', 'go on', Date.now() - 60_000), resumeOf: { work: 'w5870', note: 'its CI cleared' } };
    const person = queued('5449aaaa', 'lothsahn: also rename the w5869 flag', Date.now() - 50_000, 'human');
    const [first, later] = order === 'resume first' ? [resume, person] : [person, resume];
    (agents as unknown as { liveHub: unknown }).liveHub = {
      endFor: async () => {
        agents.orchestrators.handBack(store.work.get('w5870')!, store.sessions.get('5449aaaa')!, { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' });
        assert.equal(roomMove(s, later, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
        return undefined;
      },
      running: () => false,
    };
    request(['5449aaaa'], 'w5869');
    request(['5449aaaa'], 'w5870');
    assert.equal(roomMove(s, first, BISCUIT_FULL, Date.now()), true);
    await settled('5449aaaa');
    const a = store.work.get('w5869')!, b = store.work.get('w5870')!;
    assert.ok(a.sessionIds.includes('5449aaaa') && !a.handedBack, 'w5869 stays with the old worker');
    assert.match(b.handedBack?.how ?? '', /paused/, "the pause's hand-back stands");
    assert.match(b.handedBack?.message ?? '', /^go on$/, 'the resume, and only it, goes with w5870');
    const back = sessions.queued().filter((m) => m.id === '5449aaaa');
    assert.equal(back.length, 1, 'one message put back for the old worker');
    assert.match(back[0]!.text, /^lothsahn: also rename the w5869 flag$/);
    assert.notEqual(back[0]!.resumeOf?.work, 'w5870', 'no resume of w5870 waits for the old worker');
  });
}

// w6047 (the w6159 review, 1): the other exits from a move route a sibling's resume to that sibling, as giveBack does.
const pausedHb = { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' };

for (const mode of ['on', 'warn'] as const) {
  for (const when of ['during the waits', 'during the start'] as const) {
    test(`w6047 (the w6159 review, 1, "${mode}"): a started move carries a person's message to the new worker, and a sibling's resume (absorbed ${when}) to that sibling's hand-back`, async (t) => {
      const { store, agents, worker, request, queued, roomMove, settled, starts } = await setup(t, mode);
      const x = agents as unknown as Internals;
      const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
      const resume: QueuedSend = { ...queued('5449aaaa', 'w5870: its CI cleared', Date.now() - 50_000, 'system'), resumeOf: { work: 'w5870', note: 'its CI cleared' } };
      (agents as unknown as { liveHub: unknown }).liveHub = {
        endFor: async () => {
          agents.orchestrators.handBack(store.work.get('w5870')!, store.sessions.get('5449aaaa')!, pausedHb);
          if (when === 'during the waits') assert.equal(roomMove(s, resume, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
          return undefined;
        },
        running: () => false,
      };
      const handOff: (string | undefined)[] = [];
      const start = x.startMoved;
      x.startMoved = async (info, w, to, why, hold, branch, lead, hb) => {
        handOff.push(hb.message);
        if (when === 'during the start') assert.equal(roomMove(s, resume, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
        return start(info, w, to, why, hold, branch, lead, hb);
      };
      request(['5449aaaa'], 'w5869');
      request(['5449aaaa'], 'w5870');
      assert.equal(roomMove(s, queued('5449aaaa', 'lothsahn: also rename the w5869 flag', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
      await settled('5449aaaa');
      const b = store.work.get('w5870')!;
      assert.equal(starts.length, 1, 'w5869 moved');
      assert.match(handOff[0] ?? '', /^lothsahn: also rename the w5869 flag$/, "the new worker's hand-off carries the person's message, and only it");
      assert.match(b.handedBack?.how ?? '', /paused/, "the pause's hand-back stands");
      assert.match(b.handedBack?.message ?? '', /^w5870: its CI cleared$/, 'the resume goes with w5870, once');
    });
  }
}

test(`w6047 (the w6159 review, 1, "warn"): a failed start hands back the move's request with its own messages only; a sibling's resume goes with the sibling`, async (t) => {
  const { store, agents, worker, request, queued, roomMove, settled } = await setup(t, 'warn');
  const tried: string[] = [];
  failing(agents, 'early', tried);
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  const resume: QueuedSend = { ...queued('5449aaaa', 'w5870: its CI cleared', Date.now() - 50_000, 'system'), resumeOf: { work: 'w5870', note: 'its CI cleared' } };
  (agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      agents.orchestrators.handBack(store.work.get('w5870')!, store.sessions.get('5449aaaa')!, pausedHb);
      assert.equal(roomMove(s, resume, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
      return undefined;
    },
    running: () => false,
  };
  request(['5449aaaa'], 'w5869');
  request(['5449aaaa'], 'w5870');
  assert.equal(roomMove(s, queued('5449aaaa', 'lothsahn: also rename the w5869 flag', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const a = store.work.get('w5869')!, b = store.work.get('w5870')!;
  assert.equal(tried.length, 1, 'one start was tried');
  assert.match(a.handedBack?.message ?? '', /^lothsahn: also rename the w5869 flag$/, "w5869's hand-back carries the person's message, and only it");
  assert.match(b.handedBack?.message ?? '', /^w5870: its CI cleared$/, 'the resume goes with w5870, once');
});

test(`w6047 (the w6159 review, 1, "warn"): the move's own request handed back meanwhile carries its own resume; a sibling's resume goes with the sibling`, async (t) => {
  const { store, agents, worker, request, queued, roomMove, settled, starts } = await setup(t, 'warn');
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  const other: QueuedSend = { ...queued('5449aaaa', 'w5870: its CI cleared', Date.now() - 50_000, 'system'), resumeOf: { work: 'w5870', note: 'its CI cleared' } };
  (agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      agents.orchestrators.handBack(store.work.get('w5869')!, store.sessions.get('5449aaaa')!, pausedHb);
      assert.equal(roomMove(s, other, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
      return undefined;
    },
    running: () => false,
  };
  request(['5449aaaa'], 'w5869');
  request(['5449aaaa'], 'w5870');
  const own: QueuedSend = { ...queued('5449aaaa', 'w5869: its CI cleared', Date.now() - 60_000, 'system'), resumeOf: { work: 'w5869', note: 'its CI cleared' } };
  assert.equal(roomMove(s, own, BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const a = store.work.get('w5869')!, b = store.work.get('w5870')!;
  assert.deepEqual(starts, [], 'no fresh session was started');
  assert.match(a.handedBack?.how ?? '', /paused/, "the pause's hand-back stands");
  assert.match(a.handedBack?.message ?? '', /^w5869: its CI cleared$/, 'w5869 carries its own resume, and only it');
  assert.match(b.handedBack?.message ?? '', /^w5870: its CI cleared$/, 'the resume of w5870 goes with w5870');
});

test(`w6047 (the w6159 review, 2): a resume of a request handed back meanwhile and already on a next worker goes into no hand-off that worker read, nor to the old worker`, async (t) => {
  const { store, sessions, agents, worker, request, queued, roomMove, settled, sent } = await setup(t, 'on');
  const x = agents as unknown as Internals;
  const s = worker('5449aaaa', { machineId: 'biscuit', machineSandbox: 'slot1', turns: 0, placeReleased: RELEASED });
  const resume: QueuedSend = { ...queued('5449aaaa', 'w5870: its CI cleared', Date.now() - 50_000, 'system'), resumeOf: { work: 'w5870', note: 'its CI cleared' } };
  (agents as unknown as { liveHub: unknown }).liveHub = {
    endFor: async () => {
      const b = store.work.get('w5870')!;
      agents.orchestrators.handBack(b, store.sessions.get('5449aaaa')!, pausedHb);
      const n = nextW('next1', 'lothdesktop');
      store.putSession(n);
      agents.orchestrators.linkWorker(b.id, n, 'started worker next1 in lothdesktop/slot2');
      assert.equal(roomMove(s, resume, BISCUIT_FULL, Date.now()), true, 'absorbed into the move');
      return undefined;
    },
    running: () => false,
  };
  const handOff: (string | undefined)[] = [];
  const start = x.startMoved;
  x.startMoved = async (info, w, to, why, hold, branch, lead, hb) => {
    handOff.push(hb.message);
    return start(info, w, to, why, hold, branch, lead, hb);
  };
  request(['5449aaaa'], 'w5869');
  request(['5449aaaa'], 'w5870');
  assert.equal(roomMove(s, queued('5449aaaa', 'lothsahn: also rename the w5869 flag', Date.now() - 60_000, 'human'), BISCUIT_FULL, Date.now()), true);
  await settled('5449aaaa');
  const b = store.work.get('w5870')!;
  assert.match(handOff[0] ?? '', /^lothsahn: also rename the w5869 flag$/, "not in w5869's hand-off");
  assert.doesNotMatch(b.handedBack?.message ?? '', /CI cleared/, 'not into the hand-off next1 read already');
  assert.equal(sent.filter((m) => /CI cleared/.test(m.text)).length, 0, "not forwarded (a resume is the old worker's own wait, w5949)");
  assert.equal(sessions.queued().filter((m) => m.id === '5449aaaa').length, 0, 'not put back for the old worker');
});
