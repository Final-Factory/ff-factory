// w2544: work waiting on a computer away (offline or paused) past the grace moves elsewhere; a short blip moves nothing; a
// request that names the computer stays, its orchestrator told once; a person's named computer for timed work is honoured.
// lothsahn, 2026-10-29: "the dispatcher should not be scheduling work on offline computers--at least ones that have been
// offline for a few minutes or more. Make sure those get moved somewhere else". LothLaptop was paused and shut for the day
// while w2542's worker e6d3dfe1 sat Blocked on it; "w2542 should move to LothDesktop" was refused twice by the timing order.
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
import { awayLead, awayLine, awayOf, longAway } from './machineAway.ts';
import { moveDecision, type MoveFacts } from './resumeMove.ts';
import { workLive } from '../shared/workState.ts';
import type { Computer } from './placement.ts';
import type { Config } from './config.ts';
import type { Machine, Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-29T16:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('w2544: away past the grace is long; a blip, a pause that ends within it, or a running computer is not', () => {
  const grace = 5 * MIN;
  const off6 = awayOf({ online: false, offlineSince: ago(6 * MIN) }, NOW);
  assert.deepEqual(off6 && [off6.kind, off6.ms], ['offline', 6 * MIN]);
  assert.equal(longAway(off6, {}, grace, NOW), true);
  assert.equal(awayLine('lothlaptop', off6!), 'lothlaptop (offline 6 min)');
  // The longest drop the portal journal showed (2026-10-28 09:37:26 to 09:39:39, a portal restart) is 133 s: a blip.
  const blip = awayOf({ online: false, offlineSince: ago(133_000) }, NOW);
  assert.equal(longAway(blip, {}, grace, NOW), false);
  const paused = { paused: true, since: ago(7 * MIN) };
  assert.equal(awayLine('lothlaptop', awayOf({ online: true, pause: paused }, NOW)!), 'lothlaptop (paused 7 min)');
  assert.equal(longAway(awayOf({ online: true, pause: paused }, NOW), { pause: paused }, grace, NOW), true);
  const ending = { ...paused, until: new Date(NOW + 2 * MIN).toISOString() };
  assert.equal(longAway(awayOf({ online: true, pause: ending }, NOW), { pause: ending }, grace, NOW), false, 'a pause ending in 2 min is a short wait');
  assert.equal(awayOf({ online: true }, NOW), undefined);
  assert.equal(awayOf({ online: true, pause: { paused: false } }, NOW), undefined);
  // A pause from before MachinePause.since counts from its earliest wait.
  assert.equal(awayOf({ online: true, pause: { paused: true }, fallbackSince: NOW - 9 * MIN }, NOW)?.ms, 9 * MIN);
});

test('w2544: an away computer no longer keeps work for what only it has; a pin to it and a pair run under way still do', () => {
  const pc = (id: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 2, maxSandboxes: 3, freeSandboxes: 2, platform: 'win32', ...o });
  const f: MoveFacts = {
    machine: 'lothlaptop',
    released: false,
    branch: 'sandbox/slot1-w2542',
    git: { ahead: 2, upstream: 'origin/sandbox/slot1-w2542', dirty: 3, untracked: 1 },
    canSave: false,
    benchHeld: true,
    requests: [{ id: 'w2547', priority: 'high', kind: 'game', timedLeg: true }],
    places: [pc('lothlaptop', { online: false }), pc('lothdesktop')],
    prefs: {},
  };
  assert.ok('stay' in moveDecision(f), 'without away it stays (bench lock, timed leg, unpushed work)');
  const d = moveDecision({ ...f, away: 'lothlaptop (offline 6 min)' });
  assert.deepEqual('move' in d && d.move.to, 'lothdesktop');
  const pinned = moveDecision({ ...f, away: 'lothlaptop (offline 6 min)', requests: [{ id: 'w2499', priority: 'high', kind: 'game', pinned: ['lothlaptop'] }] });
  assert.match('stay' in pinned ? pinned.stay : '', /w2499 is pinned to lothlaptop/);
  const pair = moveDecision({ ...f, away: 'x', requests: [{ id: 'w9', priority: 'normal', kind: 'game', pair: { leg: 2, others: ['beast'], live: true } }] });
  assert.ok('stay' in pair, 'a pair leg under way never moves alone');
  const lead = awayLead({ ids: 'w2542', first: 'w2542', worker: 'e6d3dfe1', from: 'lothlaptop/slot1', machine: 'lothlaptop', line: 'lothlaptop (offline 6 min)', kind: 'offline', graceMin: 5, to: 'lothdesktop/slot2', why: 'room', branch: 'sandbox/slot1-w2542', lost: 'UNPUSHED WORK: 3 changed and 1 untracked file on sandbox/slot1-w2542, not committed (as last seen at 15:50 UTC)' });
  assert.match(lead, /What may be lost: UNPUSHED WORK: 3 changed/);
  assert.match(lead, /nothing in its sandbox can be fetched: start from the pushed branch sandbox\/slot1-w2542/);
});

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];
const OLD = ago(3 * 3600_000);
const pcx = (id: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, platform: 'win32', ...o });

type Internals = {
  roomMove: (h: SessionHandle, q: QueuedSend, hold: string, now: number) => true | string | undefined;
  startMoved: (info: SessionInfo, w: WorkItem, to: string, why: string, hold: string, branch: string | undefined, lead: string | undefined, hb: Parameters<Agents['orchestrators']['movedForRoom']>[2]) => Promise<string>;
  places: () => Computer[];
  timedOrderProblem: (on: string | undefined, w: WorkItem | undefined, prompt?: string) => string | undefined;
};

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w2544-'));
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
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const online = new Set(['lothdesktop', 'm3', 'beast']);
  machines.isOnline = (id: string) => online.has(id.toLowerCase());
  const x = agents as unknown as Internals;
  x.places = () => [pcx('lothlaptop', { online: false, sandboxes: 1, maxSandboxes: 1, freeSandboxes: 0 }), pcx('lothdesktop')];
  const machine = (id: string, o: Partial<Machine> = {}) =>
    store.putMachine({ id, host: id, purpose: 'unused', status: 'ready', online: false, repoPath: '/r', home: '/h', portalUrl: 'http://x', sessionIds: [], createdAt: '', ...o } as Machine);
  const git = { branch: 'sandbox/slot1-w2542', upstream: 'origin/sandbox/slot1-w2542', ahead: 0, dirty: 0, untracked: 0, at: ago(10 * MIN) };
  const laptop = (o: Partial<Machine> = {}) => machine('lothlaptop', { sandboxes: [{ id: 'slot1', git } as never], ...o });
  machine('lothdesktop');
  const starts: { to: string; lead?: string; why: string }[] = [];
  x.startMoved = async (info, w, to, _why, _hold, _branch, lead, hb) => {
    const id = `new${starts.length + 1}`;
    starts.push({ to, ...(lead ? { lead } : {}), why: hb.why });
    agents.orchestrators.movedForRoom(w, info, hb);
    const s: SessionInfo = { id, kind: 'worker', title: info.title, status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 1, costUsd: 0, pendingPermissions: [], machineId: to, machineSandbox: 'slot2' };
    store.putSession(s);
    agents.orchestrators.linkWorker(w.id, s, `started worker ${id} in ${to}/slot2: moved from worker ${info.id}`, { moved: true });
    return `${to}/slot2 as worker ${id}`;
  };
  const worker = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => {
    const s: SessionInfo = { id, kind: 'worker', title: 'w2542: frame pacing A/B', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 3, costUsd: 0, pendingPermissions: [], machineId: 'lothlaptop', machineSandbox: 'slot1', ...o };
    store.putSession(s);
    return s;
  };
  const request = (o: Partial<WorkItem> = {}): WorkItem => {
    const w: WorkItem = { id: 'w2542', title: 'Frame pacing A/B', brief: 'Compare frame pacing on the branch.', priority: 'high', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: OLD, updatedAt: OLD, sessionIds: ['e6d3dfe1'], overlaps: [], asks: 0, log: [], ...o };
    store.putWork(w);
    store.workSeq = Math.max(store.workSeq, 2542);
    return w;
  };
  // Blocked on lothlaptop by its drop (w2433) or its pause (w2443), set `gateAgo` ago.
  const gated = (gateAgo: number, pause = false, o: Partial<WorkItem> = {}) =>
    request({ status: 'blocked', blocked: { kind: 'machine', ref: 'lothlaptop', what: 'lothlaptop coming back', at: ago(gateAgo), by: 'worker e6d3dfe1', ...(pause ? { pause: true } : {}) } as never, ...o });
  const settled = async () => {
    for (let n = 0; n < 200 && agents.isMoving('e6d3dfe1'); n++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(agents.isMoving('e6d3dfe1'), false, 'the move finished');
  };
  const told = () => store.work.get('w2542')!.log.filter((l) => /stays waiting for/.test(l)).length;
  return { store, agents, x, online, laptop, worker, request, gated, starts, settled, told };
}

test('w2544: a worker Blocked on a computer offline past the grace moves; its gate goes and the move is on its log and live line', async (t) => {
  const { store, agents, laptop, worker, gated, starts, settled } = await setup(t);
  laptop({ lastSeen: ago(6 * MIN) });
  worker('e6d3dfe1');
  gated(6 * MIN);
  const did = agents.moveAwayWork(NOW);
  assert.deepEqual(did, [['w2542', 'moved off lothlaptop (offline 6 min) (w2544)']]);
  await settled();
  assert.deepEqual(starts.map((s) => s.to), ['lothdesktop']);
  assert.match(starts[0].lead ?? '', /^\[moved, w2544\] FF Factory moved w2542 to this computer: its worker e6d3dfe1 on lothlaptop\/slot1 waited for lothlaptop \(offline 6 min\), past the 5 min grace/);
  assert.match(starts[0].lead ?? '', /What may be lost: nothing unpushed: sandbox\/slot1-w2542 is clean and pushed/);
  const w = store.work.get('w2542')!;
  assert.equal(w.status, 'active', `no longer Blocked on lothlaptop: ${w.log.join(' | ')}`);
  assert.equal(w.blocked, undefined);
  assert.deepEqual(w.sessionIds, ['new1']);
  assert.ok(w.log.some((l) => l.includes('moved from lothlaptop (offline 6 min) to lothdesktop/slot2 (w2544)')), w.log.join(' | '));
  assert.equal(w.awayMove?.line, 'moved from lothlaptop (offline 6 min) to lothdesktop/slot2');
  const l = workLive(w, { session: (id) => store.sessions.get(id), items: [w], now: Date.now() });
  assert.match(l?.why ?? '', /; moved from lothlaptop \(offline 6 min\) to lothdesktop\/slot2 at \d\d:\d\d UTC \(w2544\)$/);
  assert.deepEqual(agents.moveAwayWork(NOW), [], 'nothing moves twice');
});

test('w2544: a short blip moves nothing', async (t) => {
  const { store, agents, laptop, worker, gated, starts } = await setup(t);
  laptop({ lastSeen: ago(90_000) });
  worker('e6d3dfe1');
  gated(90_000);
  assert.deepEqual(agents.moveAwayWork(NOW), []);
  assert.equal(starts.length, 0);
  assert.equal(store.work.get('w2542')!.status, 'blocked');
});

test('w2544: a worker stopped by a pause past the grace moves too', async (t) => {
  const { store, agents, online, laptop, worker, gated, starts, settled } = await setup(t);
  online.add('lothlaptop');
  laptop({ pause: { paused: true, reason: 'manual', since: ago(8 * MIN) } as never });
  worker('e6d3dfe1');
  gated(8 * MIN, true);
  assert.equal(agents.moveAwayWork(NOW).length, 1);
  await settled();
  assert.equal(starts.length, 1);
  assert.match(starts[0].lead ?? '', /lothlaptop \(paused 8 min\)/);
  assert.equal(store.work.get('w2542')!.status, 'active');
});

test('w2544: a request whose brief names the computer stays waiting for it, and its orchestrator is told once', async (t) => {
  const { store, agents, laptop, worker, gated, starts, told } = await setup(t);
  laptop({ lastSeen: ago(20 * MIN) });
  worker('e6d3dfe1');
  gated(20 * MIN, false, { constraints: 'Must run on LothLaptop (the only G-SYNC screen).' });
  assert.deepEqual(agents.moveAwayWork(NOW), []);
  assert.deepEqual(agents.moveAwayWork(NOW + MIN), []);
  assert.equal(starts.length, 0);
  assert.equal(store.work.get('w2542')!.status, 'blocked');
  assert.equal(told(), 1, 'told once');
});

test('w2544: a Queued request waiting only for a long-away computer waits for it no longer, unless it names it', async (t) => {
  const { store, agents, laptop, request, told } = await setup(t);
  laptop({ lastSeen: ago(30 * MIN) });
  request({ status: 'queued', sessionIds: [], queuedFor: { at: ago(25 * MIN), needs: ['lothlaptop'] } });
  assert.deepEqual(agents.moveAwayWork(NOW), [['w2542', 'no longer waits for lothlaptop (offline 30 min) (w2544)']]);
  const w = store.work.get('w2542')!;
  assert.deepEqual(w.queuedFor?.needs, undefined);
  assert.equal(w.awayMove?.line, 'no longer waits for lothlaptop (offline 30 min)');
  // Named: it stays, said once.
  request({ id: 'w2542', status: 'queued', sessionIds: [], queuedFor: { at: ago(25 * MIN), needs: ['lothlaptop'] }, machinePin: { ids: ['lothlaptop'], why: 'G-SYNC' } });
  assert.deepEqual(agents.moveAwayWork(NOW), []);
  assert.deepEqual(agents.moveAwayWork(NOW), []);
  assert.deepEqual(store.work.get('w2542')!.queuedFor?.needs, ['lothlaptop']);
  assert.equal(told(), 1);
});

test('w2544: a message held for a worker on a computer offline past the grace moves with its work; within the grace it waits', async (t) => {
  const { agents, x, laptop, worker, request, starts, settled } = await setup(t);
  const info = worker('e6d3dfe1');
  request();
  const q = (at: string): QueuedSend => ({ uuid: 'u1', id: 'e6d3dfe1', text: 'CI on #900 is green', from: 'system', at, why: 'lothlaptop is offline' });
  laptop({ lastSeen: ago(60_000) });
  assert.equal(x.roomMove({ info } as SessionHandle, q(ago(30_000)), 'lothlaptop is offline', NOW), undefined, 'a 1 min drop waits');
  laptop({ lastSeen: new Date(Date.now() - 7 * MIN).toISOString() });
  assert.equal(x.roomMove({ info } as SessionHandle, q(ago(30_000)), 'lothlaptop is offline', Date.now()), true);
  await settled();
  assert.deepEqual(starts.map((s) => s.to), ['lothdesktop']);
  assert.equal(agents.isMoving('e6d3dfe1'), false);
});

test("w2544: a person's named computer for timed work is honoured by the timing order (w2542 to LothDesktop)", async (t) => {
  const { store, agents, x, request } = await setup(t);
  // 2026-10-29 ~15:10Z: lothdesktop busy and big, m3 idle and small; the timing order offered m3.
  x.places = () => [pcx('lothdesktop', { maxAgents: 10, live: 6, midTurn: 4, freeSandboxes: 1 }), pcx('m3', { maxAgents: 2, sandboxes: 1, maxSandboxes: 1, freeSandboxes: 1, platform: 'win32' })];
  const w = request({ brief: 'Timed A/B of frame pacing: frame times on the Windows player, both sides on one computer.' });
  const before = x.timedOrderProblem('lothdesktop', w);
  assert.ok(before, 'unpinned, the timing order refuses the busy big computer');
  agents.orchestrators.pinByPerson(w, 'LothDesktop', 'lothsahn: "w2542 should move to LothDesktop"');
  const after = store.work.get('w2542')!;
  assert.deepEqual(after.machinePin, { ids: ['lothdesktop'], why: 'a person\'s words, passed by the dispatcher: lothsahn: "w2542 should move to LothDesktop"' });
  assert.equal(x.timedOrderProblem('lothdesktop', after), undefined);
  assert.ok(after.log.some((l) => /pinned to lothdesktop \(w2544\)/.test(l)));
});
