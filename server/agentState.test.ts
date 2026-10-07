import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOLD_PLACE_MS, agentState, agentStateText, holdsItsPlace, isWaitingAgent, sortAgents, sortPlaces, utcTime } from '../shared/agentState.ts';
import { workLive } from '../shared/workState.ts';
import { fleetOf } from '../shared/fleet.ts';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager, type RemoteSession } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { createTestMachine } from './testMachine.ts';

/**
 * An agent's state (w475, w509): Working, Waiting (alive between turns with a running job, a queued message or a
 * check-in still ahead, and on what), Idle (available), Stopped (with what will resume it); listed in that order, and
 * sandboxes in the order of their agents. The derivation, the server's copy of the wakes and the queue onto the
 * sessions, list_sandboxes, the free sandbox, the ledger's request state and the Overview's order.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const NOW = Date.parse('2026-10-06T06:00:00.000Z');
const iso = (minutesFromNow: number, from = NOW) => new Date(from + minutesFromNow * 60_000).toISOString();
const T = iso(-60);
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const s = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({ id, kind: 'worker', title: `Worker ${id}`, status: 'idle', permissionMode: 'default', createdAt: T, lastActivityAt: T, turns: 1, costUsd: 0, pendingPermissions: [], ...o });
const st = (x: SessionInfo) => agentState(x, undefined, NOW);

test('agent state: Working, Needs you, Error, Idle and Stopped as before', () => {
  assert.equal(st(s('a', { status: 'running' })).state, 'working');
  assert.equal(st(s('a', { status: 'starting' })).state, 'working');
  assert.equal(st(s('a', { status: 'waiting_permission' })).state, 'needs_you');
  assert.equal(st(s('a', { status: 'error' })).state, 'error');
  assert.equal(st(s('a')).state, 'idle');
  assert.equal(st(s('a', { status: 'stopped' })).state, 'stopped');
});

test('w509: Waiting says on what: a running job first (with its check-in), a queued message, or a check-in and its note', () => {
  const job = st(s('a', { backgroundTasks: 1, backgroundJobs: [{ type: 'local_bash', description: 'CI on PR #1098' }], wakeAt: iso(10), wakeNote: 'merge #1098 if green' }));
  assert.deepEqual([job.state, job.kind, job.waitsOn], ['waiting', 'job', 'CI on PR #1098 · check-in 06:10 UTC']);
  const two = st(s('a', { backgroundTasks: 3, backgroundJobs: [{ type: 'local_bash', description: 'player build' }, { type: 'local_bash', description: 'nightly scenario' }] }));
  assert.equal(two.waitsOn, 'player build, nightly scenario (+1 more)');
  assert.equal(st(s('a', { backgroundTasks: 1 })).waitsOn, 'a background task', 'a daemon from before w509 sends no descriptions');
  const queued = st(s('a', { queuedSend: 'all 4 slots busy' }));
  assert.deepEqual([queued.kind, queued.waitsOn], ['queued', 'a queued message (all 4 slots busy)']);
  const timer = st(s('a', { wakeAt: iso(30), wakeNote: 'check PR #1103 CI (Test in editmode); if green merge it, then publish' }));
  assert.deepEqual([timer.kind, timer.waitsOn], ['timer', 'check-in 06:30 UTC: “check PR #1103 CI (Test in editmode);…”']);
  assert.equal(agentStateText(s('a', { wakeAt: iso(30) }), undefined, NOW), 'Waiting: check-in 06:30 UTC', 'no note: the time alone');
});

test('w509: a stopped agent is never Waiting; it says what will resume it, and still holds its sandbox', () => {
  // 49c5dc06 and 6c4fe619: stopped, with check-ins ahead they had set themselves ("Nothing to do; ignore this reminder").
  const a = s('49c5dc06', { status: 'stopped', wakeAt: '2026-10-06T16:29:23.055Z', wakeNote: 'w413/w414 done (PR #1064 merged ede697a08). Nothing to do; ignore this reminder.' });
  assert.equal(st(a).state, 'stopped');
  assert.equal(agentStateText(a, undefined, NOW), 'Stopped (resumes at check-in 16:29 UTC)');
  assert.equal(agentStateText(s('6c4fe619', { status: 'stopped', wakeAt: '2026-10-07T00:08:26.319Z' }), undefined, NOW), 'Stopped (resumes at check-in tomorrow 00:08 UTC)');
  assert.equal(isWaitingAgent(a, NOW), false);
  assert.equal(holdsItsPlace(a, NOW), true, 'the check-in resumes it in its sandbox');
  assert.equal(agentStateText(s('a', { status: 'stopped', queuedSend: 'slots busy' }), undefined, NOW), 'Stopped (resumes at a queued message)');
  assert.equal(st(s('a', { status: 'stopped', backgroundTasks: 1 })).state, 'stopped', 'a stop ends its background jobs');
  assert.equal(holdsItsPlace(s('a', { status: 'stopped' }), NOW), false);
});

test('w509: a check-in that is overdue (it should have fired) is not pending: not Waiting, not resuming', () => {
  assert.equal(st(s('a', { wakeAt: iso(-1) })).state, 'waiting', 'a minute late: firing now');
  assert.equal(st(s('a', { wakeAt: iso(-5) })).state, 'idle');
  assert.equal(st(s('a', { status: 'stopped', wakeAt: iso(-5) })).resumes, undefined);
  assert.equal(utcTime(iso(-60 * 24), NOW), `yesterday ${iso(-60 * 24).slice(11, 16)} UTC`);
  assert.equal(utcTime(iso(60 * 50), NOW), `${iso(60 * 50).slice(5, 10)} ${iso(60 * 50).slice(11, 16)} UTC`);
});

test('agent order: Working, then Waiting, then Idle, then Stopped; the most recent activity first in each', () => {
  const at = (m: number) => iso(-m);
  const list = [
    s('idle-old', { lastActivityAt: at(50) }),
    s('stopped', { status: 'stopped', lastActivityAt: at(1) }),
    s('waiting', { wakeAt: iso(30), lastActivityAt: at(40) }),
    s('working-old', { status: 'running', lastActivityAt: at(30) }),
    s('idle-new', { lastActivityAt: at(2) }),
    s('working-new', { status: 'running', lastActivityAt: at(3) }),
    s('needs-you', { status: 'waiting_permission', lastActivityAt: at(10) }),
  ];
  assert.deepEqual(
    sortAgents(list, NOW).map((x) => x.id),
    ['working-new', 'needs-you', 'working-old', 'waiting', 'idle-new', 'idle-old', 'stopped'],
  );
});

test('w509: sandboxes by status: Working, Waiting, Idle, then empty or unused; the most recent activity first in each', () => {
  const places = [
    { id: 'mp-r2', agents: [s('x', { status: 'stopped', lastActivityAt: iso(-600) })] },
    { id: 'idle-old', agents: [s('i1', { lastActivityAt: iso(-90) })] },
    { id: 'empty', agents: [] },
    { id: 'waiting', agents: [s('w', { backgroundTasks: 1, lastActivityAt: iso(-30) })] },
    { id: 'idle-new', agents: [s('i2', { lastActivityAt: iso(-5) })] },
    { id: 'slot-5', agents: [s('r', { status: 'running', lastActivityAt: iso(-1) }), s('i3')] },
  ];
  assert.deepEqual(
    sortPlaces(places, (p) => p.agents, NOW).map((p) => p.id),
    ['slot-5', 'waiting', 'idle-new', 'idle-old', 'mp-r2', 'empty'],
  );
});

test("a request whose worker is Waiting shows Waiting with the worker's check-in, not Stalled", () => {
  const w = { id: 'w448', title: 'x', brief: '', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: T, updatedAt: T, sessionIds: ['eb9632fd'], overlaps: [], asks: 0, log: [] } as WorkItem;
  const worker = s('eb9632fd', { wakeAt: iso(12) });
  assert.deepEqual(workLive(w, { items: [w], session: () => worker, now: NOW }), { state: 'pending', why: "worker eb9632fd's check-in 06:12 UTC" });
  assert.equal(workLive(w, { items: [w], session: () => s('eb9632fd', { status: 'stopped', wakeAt: iso(12) }), now: NOW })?.state, 'stalled', 'stopped: not Waiting (w509)');
  assert.equal(workLive(w, { items: [w], session: () => s('eb9632fd'), now: NOW })?.state, 'stalled', 'Idle with nothing pending: stalled, as before');
});

test("the Overview lists a place's agents Working, Waiting, Idle, a stopped one its check-in will resume, and the places by status", () => {
  const now = Date.now();
  const sessions = [
    s('i1', { lastActivityAt: new Date(now - 3_600_000).toISOString() }),
    s('w1', { wakeAt: new Date(now + 3_600_000).toISOString() }),
    s('r1', { status: 'running' }),
    s('x1', { status: 'stopped' }),
    s('z1', { status: 'stopped', wakeAt: new Date(now + 3_600_000).toISOString() }),
    s('q1', { lastActivityAt: new Date(now - 60_000).toISOString() }),
  ];
  const sb = (id: string, ids: string[], purpose = 'work') => ({ id, branch: 'b', base: 'origin/develop', path: `/${id}`, purpose, status: 'ready', createdAt: T, unity: { state: 'stopped' }, sessionIds: ids });
  // The sandboxes are a machine's (w510: the portal holds none of its own).
  const pc = { id: 'pc', host: 'pc', purpose: 'unused', status: 'ready', online: true, repoPath: '/r', home: '/h', portalUrl: 'http://x', maxSessions: 3, sandboxRoot: '/s', sessionIds: [], createdAt: T, sandboxes: [sb('mp-r2', ['x1']), sb('unused', [], 'unused'), sb('quiet', ['q1']), sb('alpha', ['i1', 'w1', 'r1', 'z1'])] };
  const app = { sessions, machines: [pc] } as never;
  const host = fleetOf(app)[1];
  const alpha = host.sandboxes.find((x) => x.id === 'alpha')!;
  assert.deepEqual(alpha.agents.live.map((x) => x.id), ['r1', 'w1', 'i1', 'z1']);
  assert.deepEqual(host.sandboxes.map((x) => x.id), ['alpha', 'quiet', 'mp-r2', 'unused']);
});

// ---------------------------------------------------------------- the server: wakes and the queue onto the sessions

const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-agent-state-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  // Sandboxes alpha and beta are on a machine (pc/alpha, pc/beta, on its in-process daemon), with the workers the portal kept there.
  const pc = await createTestMachine({ sandboxes: ['alpha', 'beta'] });
  store.putMachine(pc.record({ alpha: ['eb9632fd'], beta: ['b1'] }));
  store.putSession(s('eb9632fd', { status: 'stopped', machineId: 'pc', machineSandbox: 'alpha', title: 'w448: merge #1083' }));
  store.putSession(s('b1', { status: 'stopped', machineId: 'pc', machineSandbox: 'beta', title: 'w490' }));
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  // A worker alive between turns (boot marks a session without a process stopped).
  store.sessions.get('eb9632fd')!.status = 'idle';
  t.after(async () => {
    await pc.stop();
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await pc.connect(machines);
  return { store, sessions, agents };
}

type WakerLike = { schedule: (id: string, m: number, n: string) => string; cancel: (id: string) => boolean };

test('the server copies a pending wake_me (time and note) and a queued message onto the session, and clears them when they go', async (t) => {
  const { store, sessions, agents } = await setup(t);
  const waker = (agents as unknown as { waker: WakerLike }).waker;
  assert.equal(store.sessions.get('eb9632fd')?.wakeAt, undefined);
  waker.schedule('eb9632fd', 15, 'merge #1083 when the tests pass');
  const at = store.sessions.get('eb9632fd')?.wakeAt;
  assert.ok(at && Date.parse(at) > Date.now() + 14 * 60_000, 'the wake time');
  assert.equal(store.sessions.get('eb9632fd')?.wakeNote, 'merge #1083 when the tests pass');
  waker.cancel('eb9632fd');
  assert.equal(store.sessions.get('eb9632fd')?.wakeAt, undefined, 'cleared');
  assert.equal(store.sessions.get('eb9632fd')?.wakeNote, undefined);
  let held: { id: string; why: string }[] = [{ id: 'eb9632fd', why: 'all 4 slots busy' }];
  Object.defineProperty(sessions, 'queued', { value: () => held });
  agents.syncWaiting();
  assert.equal(store.sessions.get('eb9632fd')?.queuedSend, 'all 4 slots busy');
  held = [];
  agents.syncWaiting();
  assert.equal(store.sessions.get('eb9632fd')?.queuedSend, undefined);
});

test('list_sandboxes: Waiting and on what, sandboxes by status, and a sandbox whose worker is Waiting is not free', async (t) => {
  const { agents } = await setup(t);
  const waker = (agents as unknown as { waker: WakerLike }).waker;
  const before = agents.describeAllSandboxes();
  assert.match(before, /- pc\/alpha FREE/, 'an idle agent with nothing pending: free');
  // Labels say nothing about use (w575): beta, with no live agent, is free too.
  assert.equal(agents.places().find((p) => p.id === 'pc')?.freeSandboxes, 2);
  waker.schedule('eb9632fd', 15, 'merge #1083 when CI is green');
  const text = agents.describeAllSandboxes();
  assert.doesNotMatch(text, /alpha FREE/, 'its worker will come back to it');
  assert.match(text, /- eb9632fd "w448: merge #1083" \[Waiting: check-in [^\]]*: “merge #1083 when CI is green”, idle\]/);
  assert.ok(text.indexOf('- pc/alpha') < text.indexOf('- pc/beta'), 'the sandbox with a Waiting agent before the one with none live');
  assert.equal(agents.places().find((p) => p.id === 'pc')?.freeSandboxes, 1, 'the capacity block and placement do not count it free');
});

test("w613: an agent whose daemon went away under it keeps its sandbox until it is messaged, stopped on purpose, or a day passes", async (t) => {
  // LothDesktop, 2026-10-07 08:29 UTC: the worker update restarted the daemon, Ben's 77956901 (no check-in) stopped, and
  // its slot2 showed FREE to the dispatcher.
  const { store, sessions, agents } = await setup(t);
  const alpha = sessions.get('eb9632fd') as unknown as RemoteSession;
  alpha.liveFlag = true; // its process ran on the daemon, idle between turns
  assert.doesNotMatch(agents.describeAllSandboxes(), /alpha FREE/, 'before: its live agent has it');
  const detach = (id: string) => (agents.machines as unknown as { detach(id: string): void }).detach(id);
  detach('pc');
  const info = store.sessions.get('eb9632fd')!;
  assert.equal(info.status, 'stopped');
  assert.ok(info.heldSince, 'held: its daemon went away under it');
  assert.equal(store.sessions.get('b1')!.heldSince, undefined, 'beta had no process: nothing to hold');
  const text = agents.describeAllSandboxes();
  assert.doesNotMatch(text, /alpha FREE/, 'its sandbox stays its');
  assert.match(text, /- pc\/beta FREE/);
  assert.match(agentStateText(info), /^Stopped \(its daemon restarted at .*; its sandbox is kept for it\)$/);
  assert.equal(agents.places().find((p) => p.id === 'pc')?.freeSandboxes, 1, 'placement does not count it free');
  assert.equal(holdsItsPlace(info, Date.parse(info.heldSince!) + HOLD_PLACE_MS + 1), false, 'a day later it is released');
  // stop_agent (on purpose) releases it at once.
  agents.machines.stoppedOnPurpose(alpha);
  assert.equal(store.sessions.get('eb9632fd')!.heldSince, undefined);
  assert.match(agents.describeAllSandboxes(), /- pc\/alpha FREE/);
  // A daemon stopped on purpose (machine_daemon stop, a migration) holds nothing.
  delete store.sessions.get('eb9632fd')!.stoppedOnPurpose;
  alpha.liveFlag = true;
  agents.machines.expectDrop('pc', false);
  detach('pc');
  assert.equal(store.sessions.get('eb9632fd')!.heldSince, undefined);
});
