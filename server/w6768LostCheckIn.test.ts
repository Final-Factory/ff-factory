// w6768: a worker's own check-in that nothing can deliver (its worker gone, its computer away past the grace) is said:
// the Waker reports it (onLost), the request carries it (lostCheckIn), its live state is Stalled with the reason, and the
// dispatcher is told once. With config lostCheckIns "on" (unset) its work resumes elsewhere with the check-in's note (moved off
// the away computer, or a fresh worker for one that is gone); "warn" is the recovery switch that only shows and tells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Waker } from './wake.ts';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents, releasedFrom } from './agents.ts';
import { Identity } from './identity.ts';
import { workLive } from '../shared/workState.ts';
import { lostLine, lostStands, type LostCheckIn } from '../shared/lostCheckIn.ts';
import type { Config } from './config.ts';
import type { Computer } from './placement.ts';
import type { Machine, Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

const MIN = 60_000;
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];
const T = '2026-11-27T15:00:00.000Z';

function wakerSetup(t: { after: (fn: () => void) => void }, send: (id: string) => void = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6768-'));
  const store = new Store(dir);
  const sent: string[] = [];
  const live = new Set(['w1']);
  const sessions = {
    sessions: { has: (id: string) => live.has(id) },
    get: (id: string) => {
      if (!live.has(id)) throw new Error(`no session "${id}"`);
      return {};
    },
    send: (id: string, text: string) => (send(id), sent.push(text), 'u'),
  } as unknown as SessionManager;
  const w = new Waker(sessions, store, path.join(dir, 'wakes.json'));
  let now = Date.parse('2026-11-28T09:00:00Z');
  w.now = () => now;
  const lost: { id: string; at: number; note: string; why: string }[] = [];
  w.onLost = (id, wake, why) => lost.push({ id, ...wake, why });
  t.after(() => {
    w.close();
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { w, store, sent, lost, live, dir, advance: (ms: number) => (now += ms) };
}

test('w6768: a due check-in whose worker is gone is reported lost, not dropped unsaid', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, sent, lost, live, advance } = wakerSetup(t);
  w.schedule('w1', 45, 'check the follow-up PR');
  live.delete('w1'); // removed with its sandbox (w6370's e41a69e8)
  advance(45 * MIN);
  t.mock.timers.tick(45 * MIN);
  assert.equal(sent.length, 0);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].id, 'w1');
  assert.equal(lost[0].why, 'is gone');
  assert.equal(lost[0].note, 'check the follow-up PR');
  assert.equal(w.pending('w1'), undefined, 'the wake is spent');
});

test('w6768: after a restart, a saved check-in whose worker is gone is kept and reported when due', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = wakerSetup(t);
  a.w.schedule('w1', 30, 'look at CI');
  a.w.close();
  // A new server: w1 no longer exists.
  const sessions = { sessions: { has: () => false }, get: () => { throw new Error('gone'); }, send: () => 'u' } as unknown as SessionManager;
  const b = new Waker(sessions, a.store, path.join(a.dir, 'wakes.json'));
  b.now = a.w.now;
  const lost: string[] = [];
  b.onLost = (id, _w, why) => lost.push(`${id} ${why}`);
  t.after(() => b.close());
  assert.equal(b.restore(), 1, 'armed, not dropped');
  a.advance(30 * MIN);
  t.mock.timers.tick(30 * MIN);
  assert.deepEqual(lost, ['w1 is gone']);
});

test('w6768: a wake refused while its computer is away past the grace is reported after its last retry, with the computer named', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let tries = 0;
  const { w, lost, advance } = wakerSetup(t, () => {
    tries++;
    throw new Error('beast is offline');
  });
  w.awayOf = () => 'is on beast (offline 147 min)';
  w.schedule('w1', 10, 'is the build done?');
  advance(10 * MIN);
  t.mock.timers.tick(10 * MIN);
  assert.equal(tries, 1);
  assert.equal(lost.length, 0, 'not while a retry may still deliver it (review w6771, S2)');
  for (let i = 0; i < 15; i++) t.mock.timers.tick(MIN);
  assert.ok(tries > 5, `retried (${tries})`);
  assert.deepEqual(lost.map((l) => l.why), ['is on beast (offline 147 min)'], 'said once, after the last retry');
});

test('w6768: a wake refused twice and then delivered is never reported lost (review w6771, P4)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let refuse = 2;
  const { w, sent, lost, advance } = wakerSetup(t, () => {
    if (refuse > 0 && refuse--) throw new Error('beast is offline');
  });
  w.awayOf = () => 'is on beast (offline 147 min)';
  w.schedule('w1', 10, 'x');
  advance(10 * MIN);
  t.mock.timers.tick(10 * MIN);
  for (let i = 0; i < 5; i++) t.mock.timers.tick(MIN);
  assert.equal(sent.length, 1);
  assert.equal(lost.length, 0);
});

test('w6768: a wake refused with its computer not away reports only after its last retry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, lost, advance } = wakerSetup(t, () => {
    throw new Error('at the agent limit');
  });
  w.schedule('w1', 10, 'x');
  advance(10 * MIN);
  t.mock.timers.tick(10 * MIN);
  assert.equal(lost.length, 0, 'a retry may still deliver it');
  for (let i = 0; i < 15; i++) t.mock.timers.tick(MIN);
  assert.equal(lost.length, 1);
  assert.match(lost[0].why, /^could not be woken \(at the agent limit\)$/);
});

// ---------------------------------------------------------------- the ledger state

const item = (o: Partial<WorkItem> = {}): WorkItem =>
  ({ id: 'w6370', title: 'Follow-up', brief: '', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: T, updatedAt: T, sessionIds: ['e41a69e8'], overlaps: [], asks: 0, log: [], ...o }) as WorkItem;
const worker = (id: string, o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, kind: 'worker', title: 'w6370: follow-up', status: 'stopped', permissionMode: 'default', createdAt: T, lastActivityAt: T, turns: 4, costUsd: 0, pendingPermissions: [], ...o }) as SessionInfo;
const lostOf = (o: Partial<LostCheckIn> = {}): LostCheckIn => ({ worker: 'e41a69e8', due: '2026-11-28T09:45:00.000Z', note: 'check the follow-up', why: 'is gone', seen: '2026-11-28T09:45:10.000Z', turns: {}, ...o });

test('w6768: a merged request whose worker is gone with a due check-in is Stalled with the reason, not "Merged, follow-up pending"', () => {
  const now = Date.parse('2026-11-28T10:00:00Z');
  const merged = { prs: [{ repo: 'Final-Factory/ff-factory', number: 1500, state: 'merged' as const }] };
  const before = item(merged);
  assert.equal(workLive(before, { items: [before], session: () => undefined, now })?.state, 'followup', 'the w6370 reading before the fix');
  const w = item({ ...merged, lostCheckIn: lostOf() });
  assert.deepEqual(workLive(w, { items: [w], session: () => undefined, now }), { state: 'stalled', why: 'its check-in at 09:45Z is due, and worker e41a69e8 is gone: nothing resumes it (w6768)' });
});

test('w6768: a stopped worker on a computer offline past the grace with a due check-in is Stalled with the computer named, not Sleeping', () => {
  const now = Date.parse('2026-11-28T10:10:00Z');
  const s = worker('69908625', { machineId: 'beast', machineSandbox: 'agent1', wakeAt: '2026-11-28T10:06:00.000Z' });
  const w = item({ id: 'w6484', sessionIds: ['69908625'], lostCheckIn: lostOf({ worker: '69908625', due: '2026-11-28T10:06:00.000Z', why: 'is on beast (offline 147 min)', turns: { '69908625': 4 } }) });
  const l = workLive(w, { items: [w], session: (id) => (id === s.id ? s : undefined), now });
  assert.equal(l?.state, 'stalled');
  assert.match(l!.why, /^its check-in at 10:06Z is due, and worker 69908625 is on beast \(offline 147 min\): nothing resumes it \(w6768\)/);
});

test('w6768: a turn by its worker, or a new worker on the request, ends the lost check-in', () => {
  const l = lostOf({ worker: '69908625', turns: { '69908625': 4 } });
  assert.equal(lostStands({ lostCheckIn: l }, [worker('69908625')]), true);
  assert.equal(lostStands({ lostCheckIn: l }, [worker('69908625', { turns: 5 })]), false, 'it took a turn since');
  assert.equal(lostStands({ lostCheckIn: l }, [worker('69908625', { status: 'running' })]), false, 'mid-turn');
  assert.equal(lostStands({ lostCheckIn: l }, [worker('69908625'), worker('new1', { turns: 1 })]), false, 'a new worker came');
  assert.equal(lostStands({ lostCheckIn: lostOf() }, []), true, 'gone, and nobody else');
  assert.equal(lostLine(l), 'its check-in at 09:45Z is due, and worker 69908625 is gone');
});

test("w6768: a removed worker's lost check-in does not read Stalled over another worker's own check-in or job (review w6771, B1)", () => {
  const now = Date.parse('2026-11-28T10:00:00Z');
  const lc = lostOf({ worker: 'gone1', turns: { b: 4 }, ids: ['gone1', 'b'] });
  const w = item({ sessionIds: ['gone1', 'b'], lostCheckIn: lc });
  const live = (b: SessionInfo) => workLive(w, { items: [w], session: (id) => (id === 'b' ? b : undefined), now });
  const sleeper = live(worker('b', { wakeAt: '2026-11-28T10:30:00.000Z' }));
  assert.equal(sleeper?.state, 'sleeping', JSON.stringify(sleeper));
  assert.match(sleeper!.why, /b's check-in/);
  const job = live(worker('b', { status: 'idle', backgroundTasks: 1 }));
  assert.notEqual(job?.state, 'stalled', JSON.stringify(job));
  assert.equal(live(worker('b'))?.state, 'stalled', 'b stopped with nothing coming: the lost check-in stands');
});

test('w6768: a new worker ends a lost check-in for good, also after it leaves the request again (review w6771, M1)', () => {
  const lc = lostOf({ worker: 'gone1', turns: {}, ids: ['gone1'] });
  assert.equal(lostStands({ lostCheckIn: lc, sessionIds: ['gone1'] }, []), true);
  assert.equal(lostStands({ lostCheckIn: lc, sessionIds: ['gone1', 'n'] }, []), false, 'n came and went: its id stays on the request');
});

// ---------------------------------------------------------------- the server

async function agentsSetup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6768a-'));
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
    agents.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const online = new Set(['lothdesktop']);
  machines.isOnline = (id: string) => online.has(id.toLowerCase());
  const told: string[] = [];
  agents.orchestrators.toDispatcher = (text: string) => void told.push(text);
  const machine = (id: string, o: Partial<Machine> = {}) =>
    store.putMachine({ id, host: id, purpose: 'unused', status: 'ready', online: false, repoPath: '/r', home: '/h', portalUrl: 'http://x', sessionIds: [], createdAt: '', ...o } as Machine);
  const request = (o: Partial<WorkItem> = {}) => {
    const w = item(o);
    store.putWork(w);
    return w;
  };
  return { store, agents, told, machine, request, cfg };
}

test('w6768: a gone worker\'s due check-in is recorded on its open request, logged with the would-be move, and the dispatcher told once', async (t) => {
  const { store, agents, told, request, cfg } = await agentsSetup(t);
  cfg.lostCheckIns = 'warn';
  request({ prs: [{ repo: 'Final-Factory/ff-factory', number: 1500, state: 'merged' }] });
  request({ id: 'w6000', status: 'done', sessionIds: ['e41a69e8'] }); // closed: left alone
  const at = Date.parse('2026-11-28T09:45:00Z');
  // The Waker's report reaches Agents (its wiring), once per wake.
  agents.waker.onLost!('e41a69e8', { at, note: 'check the follow-up PR' }, 'is gone');
  const w = store.work.get('w6370')!;
  assert.equal(w.lostCheckIn?.worker, 'e41a69e8');
  assert.equal(w.lostCheckIn?.due, '2026-11-28T09:45:00.000Z');
  assert.equal(w.lostCheckIn?.note, 'check the follow-up PR');
  assert.equal(store.work.get('w6000')!.lostCheckIn, undefined);
  assert.ok(w.log.some((l) => l.includes("its check-in at 09:45Z is due, and worker e41a69e8 is gone: nothing resumes it (w6768); lostCheckIns is \"warn\", so nothing moves: \"on\" would start a fresh worker for it where it fits, with the check-in's note")), w.log.join(' | '));
  assert.equal(told.length, 1);
  assert.match(told[0], /^\[ledger\] LOST CHECK-IN \(w6768\): w6370 /);
  assert.match(told[0], /Start a worker for it with start_agent/);
  assert.match(told[0], /passing its note: "check the follow-up PR"/);
  const l = workLive(w, { items: [w], session: (id) => store.sessions.get(id), now: Date.now() });
  assert.equal(l?.state, 'stalled');
  assert.equal(agents.lostCheckIn('e41a69e8', { at, note: 'x' }, 'is gone').length, 0, 'the same check-in is not recorded twice');
  assert.equal(told.length, 1);
});

test('w6768: a worker on a computer offline past the grace: its wake reads as away, and the would-be move is off that computer', async (t) => {
  const { store, agents, told, machine, request } = await agentsSetup(t);
  machine('beast', { lastSeen: new Date(Date.now() - 147 * MIN).toISOString() });
  machine('lothdesktop', { online: true });
  store.putSession(worker('69908625', { machineId: 'beast', machineSandbox: 'agent1', title: 'w6484: x' }));
  store.putSession(worker('aaaa1111', { machineId: 'lothdesktop', machineSandbox: 'slot1' }));
  request({ id: 'w6484', sessionIds: ['69908625'] });
  assert.match(agents.waker.awayOf!('69908625') ?? '', /^is on beast \(offline 14\d min\)$/);
  assert.equal(agents.waker.awayOf!('aaaa1111'), undefined, 'its computer is online');
  const why = agents.waker.awayOf!('69908625')!;
  assert.deepEqual(agents.lostCheckIn('69908625', { at: Date.now() - MIN, note: 'is the build done?' }, why), ['w6484']);
  const w = store.work.get('w6484')!;
  assert.deepEqual(w.lostCheckIn?.turns, { '69908625': 4 });
  assert.ok(w.log.some((l) => /worker 69908625 is on beast \(offline .*\) \(w6768\): FF Factory will move it to a computer with room/.test(l)), w.log.join(' | '));
  assert.match(told[0], /FF Factory moves it off that computer by itself, with the check-in's note/);
  assert.match(told[0], /Only if it still reads Stalled for this in 15 min, stop_agent its worker 69908625 with move_to a computer with room/);
  const l = workLive(w, { items: [w], session: (id) => store.sessions.get(id), now: Date.now() });
  assert.equal(l?.state, 'stalled');
  assert.match(l!.why, /^its check-in at \d\d:\d\dZ is due, and worker 69908625 is on beast/);
  // Its next turn ends it.
  store.putSession({ ...store.sessions.get('69908625')!, turns: 5 });
  assert.notEqual(workLive(w, { items: [w], session: (id) => store.sessions.get(id), now: Date.now() })?.why?.includes('w6768'), true);
});

test('w6768: another worker on the request with its own check-in carries it: nothing recorded and the dispatcher not told (review w6771, B1); nor on a request its worker reported done (M2)', async (t) => {
  const { store, agents, told, request } = await agentsSetup(t);
  store.putSession(worker('bbbb2222', { wakeAt: new Date(Date.now() + 30 * MIN).toISOString() }));
  request({ sessionIds: ['e41a69e8', 'bbbb2222'] });
  request({ id: 'w6001', sessionIds: ['e41a69e8'], done: { e41a69e8: { at: T, report: 'DONE: w6001' } } });
  assert.deepEqual(agents.lostCheckIn('e41a69e8', { at: Date.now() - MIN, note: 'x' }, 'is gone'), []);
  assert.equal(store.work.get('w6370')!.lostCheckIn, undefined);
  assert.equal(store.work.get('w6001')!.lostCheckIn, undefined);
  assert.equal(told.length, 0);
});

test('w6768: deleting a sandbox keeps the workers that released it before (e41a69e8 was removed with slot5)', () => {
  assert.equal(releasedFrom({ placeReleased: { at: T, sandbox: 'slot5', branch: 'b', why: 'x' } } as never, 'slot5'), true);
  assert.equal(releasedFrom({ machineSandbox: 'slot2' }, 'slot5'), true, 'placed elsewhere since');
  assert.equal(releasedFrom({ machineSandbox: 'slot5' }, 'slot5'), false, 'still in it');
  assert.equal(releasedFrom(undefined, 'slot5'), false);
});

// ---------------------------------------------------------------- the move (lostCheckIns "on")

type MoveInternals = {
  startMoved: (info: SessionInfo, w: WorkItem, to: string, why: string, hold: string, branch: string | undefined, lead: string | undefined, hb: { why: string; message?: string; machine: string }) => Promise<string>;
  places: () => Computer[];
  lostStarting: Set<string>;
};
const pcx = (id: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, platform: 'win32', ...o });

async function moveSetup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const s = await agentsSetup(t);
  const { store, agents } = s;
  const x = agents as unknown as MoveInternals;
  x.places = () => [pcx('beast', { online: false }), pcx('lothdesktop')];
  s.machine('lothdesktop', { online: true });
  const starts: { from: string; to: string; lead?: string; why: string; message?: string; machine: string }[] = [];
  x.startMoved = async (info, w, to, _why, _hold, _branch, lead, hb) => {
    const id = `new${starts.length + 1}`;
    starts.push({ from: info.id, to, ...(lead ? { lead } : {}), why: hb.why, ...(hb.message ? { message: hb.message } : {}), machine: hb.machine });
    agents.orchestrators.movedForRoom(w, info, hb as never);
    const n = worker(id, { machineId: to, machineSandbox: 'slot2', turns: 1, status: 'running', lastActivityAt: new Date().toISOString() });
    store.putSession(n);
    agents.orchestrators.linkWorker(w.id, n, `started worker ${id} in ${to}/slot2: moved from worker ${info.id}`, { moved: true });
    return `${to}/slot2 as worker ${id}`;
  };
  const settled = async (id: string) => {
    for (let n = 0; n < 200 && (agents.isMoving(id) || x.lostStarting.size); n++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(agents.isMoving(id) || x.lostStarting.size > 0, false, 'the move finished');
  };
  const live = (id: string) => {
    const w = store.work.get(id)!;
    return workLive(w, { items: [w], session: (sid) => store.sessions.get(sid), now: Date.now() });
  };
  return { ...s, x, starts, settled, live };
}

test('w6768 (on): a worker on a computer offline past the grace with a due check-in moves to a computer with room; the check-in\'s note goes with it and Stalled ends', async (t) => {
  const { store, agents, machine, request, starts, settled, live } = await moveSetup(t);
  const git = { branch: 'sandbox/agent1-w6484', upstream: 'origin/sandbox/agent1-w6484', ahead: 0, dirty: 0, untracked: 0, at: new Date(Date.now() - 150 * MIN).toISOString() };
  machine('beast', { lastSeen: new Date(Date.now() - 147 * MIN).toISOString(), sandboxes: [{ id: 'agent1', git } as never] });
  store.putSession(worker('69908625', { machineId: 'beast', machineSandbox: 'agent1', title: 'w6484: x' }));
  request({ id: 'w6484', title: 'Beast work', sessionIds: ['69908625'] });
  assert.deepEqual(agents.lostCheckIn('69908625', { at: Date.now() - MIN, note: 'is the build done?' }, agents.waker.awayOf!('69908625')!), ['w6484']);
  assert.equal(live('w6484')?.state, 'stalled', 'Stalled until it moves');
  const did = agents.moveAwayWork(Date.now());
  assert.equal(did.length, 1, JSON.stringify(did));
  assert.match(did[0]![1], /^moved off beast \(offline 14\d min\) \(w2544\)$/);
  await settled('69908625');
  assert.deepEqual(starts.map((m) => [m.from, m.to]), [['69908625', 'lothdesktop']]);
  assert.match(starts[0]!.message ?? '', /^\[wake_me, w6768\] Your worker's check-in at \d\d:\d\dZ came due while its computer was beast \(offline 14\d min\), so FF Factory moved the work here\. Its note: is the build done\?/);
  const w = store.work.get('w6484')!;
  assert.deepEqual(w.sessionIds, ['new1'], w.log.join(' | '));
  assert.notEqual(live('w6484')?.state, 'stalled', `the work resumed elsewhere: ${live('w6484')?.why}`);
  agents.moveAwayWork(Date.now());
  assert.equal(store.work.get('w6484')!.lostCheckIn, undefined, 'the lost check-in is cleared once a new worker holds the request');
  assert.equal(starts.length, 1, 'nothing moves twice');
});

test('w6768 (on): a gone worker\'s due check-in starts a fresh worker where the work fits, its prompt leading with the note; Stalled ends', async (t) => {
  const { store, agents, request, starts, settled, live } = await moveSetup(t);
  request({ prs: [{ repo: 'Final-Factory/ff-factory', number: 1500, state: 'merged' }] });
  agents.waker.onLost!('e41a69e8', { at: Date.parse('2026-11-28T09:45:00Z'), note: 'check the follow-up PR' }, 'is gone');
  assert.equal(live('w6370')?.state, 'stalled');
  const did = agents.moveAwayWork(Date.now());
  assert.deepEqual(did, [['w6370', 'a fresh worker starts on lothdesktop for its lost check-in (w6768)']]);
  assert.deepEqual(agents.moveAwayWork(Date.now()), [], 'one start at a time');
  await settled('e41a69e8');
  assert.deepEqual(starts.map((m) => [m.from, m.to, m.machine]), [['e41a69e8', 'lothdesktop', '(removed)']]);
  assert.match(starts[0]!.lead ?? '', /^\[lost check-in, w6768\] FF Factory started you for w6370: its check-in at 09:45Z is due, and worker e41a69e8 is gone, so nothing could deliver it\. Its note: "check the follow-up PR"\./);
  const w = store.work.get('w6370')!;
  assert.ok(w.sessionIds.includes('new1'), w.sessionIds.join(','));
  assert.notEqual(live('w6370')?.state, 'stalled', `the work resumed elsewhere: ${live('w6370')?.why}`);
  agents.moveAwayWork(Date.now());
  assert.equal(store.work.get('w6370')!.lostCheckIn, undefined);
  assert.equal(starts.length, 1);
});

test('w6768: with lostCheckIns "warn" (the recovery switch) nothing moves or starts; it stays Stalled', async (t) => {
  const { store, agents, request, starts, live, cfg, machine } = await moveSetup(t);
  cfg.lostCheckIns = 'warn';
  request();
  agents.lostCheckIn('e41a69e8', { at: Date.now() - MIN, note: 'x' }, 'is gone');
  machine('beast', { lastSeen: new Date(Date.now() - 147 * MIN).toISOString() });
  store.putSession(worker('69908625', { machineId: 'beast', machineSandbox: 'agent1' }));
  request({ id: 'w6484', sessionIds: ['69908625'] });
  agents.lostCheckIn('69908625', { at: Date.now() - MIN, note: 'y' }, agents.waker.awayOf!('69908625')!);
  assert.deepEqual(agents.moveAwayWork(Date.now()), []);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(starts.length, 0);
  assert.equal(live('w6370')?.state, 'stalled');
  assert.equal(live('w6484')?.state, 'stalled');
});

test('w6768 (on): a worker that took up its own check-in since carries the request: nothing starts; a new worker clears the lost check-in', async (t) => {
  const { store, agents, request, starts } = await moveSetup(t);
  store.putSession(worker('bbbb2222'));
  request({ sessionIds: ['e41a69e8', 'bbbb2222'] });
  assert.deepEqual(agents.lostCheckIn('e41a69e8', { at: Date.now() - MIN, note: 'x' }, 'is gone'), ['w6370'], 'recorded: its other worker had nothing pending then');
  store.putSession({ ...store.sessions.get('bbbb2222')!, wakeAt: new Date(Date.now() + 30 * MIN).toISOString() });
  assert.deepEqual(agents.moveAwayWork(Date.now()), [], 'its other worker\'s own check-in carries it');
  assert.equal(starts.length, 0);
  // A worker joining the request since ends it for good.
  store.putSession(worker('cccc3333'));
  store.putWork({ ...store.work.get('w6370')!, sessionIds: ['e41a69e8', 'bbbb2222', 'cccc3333'] });
  agents.moveAwayWork(Date.now());
  assert.equal(store.work.get('w6370')!.lostCheckIn, undefined);
  assert.equal(starts.length, 0);
});

test('w6768 (on): with no computer free for its work a fresh worker waits and is tried again after 10 min', async (t) => {
  const { agents, request, starts, x } = await moveSetup(t);
  x.places = () => [pcx('lothdesktop', { online: false })];
  request();
  agents.lostCheckIn('e41a69e8', { at: Date.now() - MIN, note: 'x' }, 'is gone');
  const now = Date.now();
  assert.deepEqual(agents.moveAwayWork(now), []);
  x.places = () => [pcx('lothdesktop')];
  assert.deepEqual(agents.moveAwayWork(now + 5 * MIN), [], 'not before 10 min');
  assert.equal(agents.moveAwayWork(now + 11 * MIN).length, 1);
  assert.equal(starts.length, 1);
  await new Promise((r) => setTimeout(r, 30));
});
