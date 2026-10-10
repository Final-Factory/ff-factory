import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOLD_PLACE_MS, agentState, agentStateText, holdsItsPlace, holdsSandbox, isBetweenTurns, sortAgents, sortPlaces, utcTime } from '../shared/agentState.ts';
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
import { createTestMachine, until } from './testMachine.ts';

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

test('w509, w643: between turns says on what: a running job first (with its check-in), a queued message, or a check-in and its note; Working, Queued or Blocked', () => {
  const job = st(s('a', { backgroundTasks: 1, backgroundJobs: [{ type: 'local_bash', description: 'CI on PR #1098' }], wakeAt: iso(10), wakeNote: 'merge #1098 if green' }));
  assert.deepEqual([job.state, job.label, job.kind, job.waitsOn], ['between_turns', 'Working', 'job', 'CI on PR #1098 · check-in 06:10 UTC']);
  const two = st(s('a', { backgroundTasks: 3, backgroundJobs: [{ type: 'local_bash', description: 'player build' }, { type: 'local_bash', description: 'nightly scenario' }] }));
  assert.equal(two.waitsOn, 'player build, nightly scenario (+1 more)');
  assert.equal(st(s('a', { backgroundTasks: 1 })).waitsOn, 'a background task', 'a daemon from before w509 sends no descriptions');
  const queued = st(s('a', { queuedSend: 'all 4 slots busy' }));
  assert.deepEqual([queued.label, queued.kind, queued.waitsOn], ['Queued', 'queued', 'a queued message (all 4 slots busy)'], 'a slot: capacity');
  const held = st(s('a', { queuedSend: 'lothdesktop is offline: it is placed again once its daemon is back', queuedOn: 'machine' }));
  assert.equal(held.label, 'Blocked', 'its machine: a thing');
  const timer = st(s('a', { wakeAt: iso(30), wakeNote: 'check PR #1103 CI (Test in editmode); if green merge it, then publish' }));
  assert.deepEqual([timer.label, timer.kind, timer.waitsOn], ['Working', 'timer', 'check-in 06:30 UTC: “check PR #1103 CI (Test in editmode);…”']);
  assert.equal(agentStateText(s('a', { wakeAt: iso(30) }), undefined, NOW), 'Working: check-in 06:30 UTC', 'no note: the time alone');
  for (const x of [job, two, queued, held, timer]) assert.notEqual(x.label, 'Waiting', 'never Waiting: no person must act (w643)');
});

test('w509: a stopped agent is never Waiting; it says what will resume it, and still holds its sandbox', () => {
  // 49c5dc06 and 6c4fe619: stopped, with check-ins ahead they had set themselves ("Nothing to do; ignore this reminder").
  const a = s('49c5dc06', { status: 'stopped', wakeAt: '2026-10-06T16:29:23.055Z', wakeNote: 'w413/w414 done (PR #1064 merged ede697a08). Nothing to do; ignore this reminder.' });
  assert.equal(st(a).state, 'stopped');
  assert.equal(agentStateText(a, undefined, NOW), 'Stopped (resumes at check-in 16:29 UTC)');
  assert.equal(agentStateText(s('6c4fe619', { status: 'stopped', wakeAt: '2026-10-07T00:08:26.319Z' }), undefined, NOW), 'Stopped (resumes at check-in tomorrow 00:08 UTC)');
  assert.equal(isBetweenTurns(a, NOW), false);
  assert.equal(holdsItsPlace(a, NOW), true, 'the check-in resumes it in its sandbox');
  assert.equal(agentStateText(s('a', { status: 'stopped', queuedSend: 'slots busy' }), undefined, NOW), 'Stopped (resumes at a queued message)');
  assert.equal(st(s('a', { status: 'stopped', backgroundTasks: 1 })).state, 'stopped', 'a stop ends its background jobs');
  assert.equal(holdsItsPlace(s('a', { status: 'stopped' }), NOW), false);
});

test('w509: a check-in that is overdue (it should have fired) is not pending: not Waiting, not resuming', () => {
  assert.equal(st(s('a', { wakeAt: iso(-1) })).state, 'between_turns', 'a minute late: firing now');
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

test("a request whose worker is between turns on its own check-in shows Working with it, not Stalled or Waiting (w643)", () => {
  const w = { id: 'w448', title: 'x', brief: '', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: T, updatedAt: T, sessionIds: ['eb9632fd'], overlaps: [], asks: 0, log: [] } as WorkItem;
  const worker = s('eb9632fd', { wakeAt: iso(12) });
  assert.deepEqual(workLive(w, { items: [w], session: () => worker, now: NOW }), { state: 'working', why: 'eb9632fd between turns: check-in 06:12 UTC' });
  assert.deepEqual(workLive(w, { items: [w], session: () => s('eb9632fd', { status: 'stopped', wakeAt: iso(12) }), now: NOW }), { state: 'working', why: 'eb9632fd stopped until its check-in 06:12 UTC' }, 'stopped until its check-in: it comes back by itself');
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
  return { store, sessions, agents, pc };
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

test('list_sandboxes: between turns (Working) and on what, sandboxes by status, and a sandbox whose worker is between turns is not free', async (t) => {
  const { agents } = await setup(t);
  const waker = (agents as unknown as { waker: WakerLike }).waker;
  const before = agents.describeAllSandboxes();
  assert.match(before, /- pc\/alpha FREE/, 'an idle agent with nothing pending: free');
  // Labels say nothing about use (w575): beta, with no live agent, is free too.
  assert.equal(agents.places().find((p) => p.id === 'pc')?.freeSandboxes, 2);
  waker.schedule('eb9632fd', 15, 'merge #1083 when CI is green');
  const text = agents.describeAllSandboxes();
  assert.doesNotMatch(text, /alpha FREE/, 'its worker will come back to it');
  assert.match(text, /- eb9632fd "w448: merge #1083" \[Working: check-in [^\]]*: “merge #1083 when CI is green”, between turns\]/);
  assert.ok(text.indexOf('- pc/alpha') < text.indexOf('- pc/beta'), 'the sandbox with a Waiting agent before the one with none live');
  assert.equal(agents.places().find((p) => p.id === 'pc')?.freeSandboxes, 1, 'the capacity block and placement do not count it free');
});

test('w799: a sandbox where an old agent host still runs is not free: its daemon reports it, the portal counts it taken, and the daemon refuses a new agent there', async (t) => {
  // BEAST, 2026-10-09: the daemon dropped worker 38a203f0's host while its tree ran on in slot1, and the portal gave
  // slot1 to a new worker (6cc70ea1).
  const { store, agents, pc } = await setup(t);
  const d = pc.daemon as unknown as { setLingering(l: object, on: boolean): void; startRefusal(spec: object, id: string): string | undefined };
  const beta = () => store.machines.get('pc')!.sandboxes!.find((x) => x.id === 'beta')!;
  assert.match(agents.describeAllSandboxes(), /- pc\/beta FREE/);
  const free = () => agents.places().find((p) => p.id === 'pc')?.freeSandboxes;
  const before = free();
  const old = { sessionId: '38a203f0', pid: 43380, sandbox: 'beta', since: '2026-10-09T20:01:56.098Z' };
  d.setLingering(old, true);
  await until('the portal has it from the daemon', () => (beta().lingering?.length ?? 0) === 1);
  const text = agents.describeAllSandboxes();
  assert.doesNotMatch(text, /pc\/beta FREE/);
  assert.match(text, /- pc\/beta \(not free: the old agent host of 38a203f0, pid 43380 still runs while its daemon stops it\)/);
  assert.equal(free(), before! - 1, 'placement does not count it free');
  const spec = { cwd: beta().path, sandbox: 'beta' };
  assert.match(d.startRefusal(spec, '6cc70ea1') ?? '', /the agent host of session 38a203f0 \(pid 43380\) that worked in sandbox beta is still being stopped/);
  assert.doesNotMatch(d.startRefusal(spec, '38a203f0') ?? '', /still being stopped/, 'its own session waits for it instead');
  d.setLingering(old, false);
  await until('free again once the tree is gone', () => !beta().lingering);
  assert.match(agents.describeAllSandboxes(), /- pc\/beta FREE/);
  assert.equal(d.startRefusal(spec, '6cc70ea1'), undefined);
});

test('w656: a worker stopped on purpose keeps its sandbox until the release pass saves and releases it', async (t) => {
  const { store, sessions, agents } = await setup(t);
  const alpha = sessions.get('eb9632fd') as unknown as RemoteSession;
  alpha.liveFlag = true;
  alpha.stop();
  alpha.liveFlag = false;
  const info = store.sessions.get('eb9632fd')!;
  info.status = 'stopped';
  assert.equal(info.releaseDue?.why, 'it was stopped on purpose');
  assert.equal(holdsSandbox(info), true);
  assert.doesNotMatch(agents.describeAllSandboxes(), /pc\/alpha FREE/, 'not FREE until released');
  // A message resumes it: nothing is due any more.
  alpha.send('go on');
  assert.equal(store.sessions.get('eb9632fd')!.releaseDue, undefined);
});

test("w613, w656: an agent whose daemon went away under it keeps its sandbox until it is messaged, stopped on purpose, or released 30 min later", async (t) => {
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
  assert.match(agentStateText(info), /^Stopped \(its daemon restarted at (\d\d:\d\d) UTC; its sandbox is kept for it until \d\d:\d\d UTC\)$/);
  assert.equal(agents.places().find((p) => p.id === 'pc')?.freeSandboxes, 1, 'placement does not count it free');
  assert.equal(HOLD_PLACE_MS, 30 * 60_000, 'w656: half an hour, not a day');
  const later = Date.parse(info.heldSince!) + HOLD_PLACE_MS + 1;
  assert.equal(holdsItsPlace(info, later), false, 'half an hour later the ledger no longer counts it as coming back');
  assert.equal(holdsSandbox(info, later), true, 'but its sandbox stays its until the release pass releases it, its worktree clean');
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

test('w691: an agent whose agent host did not start is Blocked on its machine, whatever its status says, and not mid-turn', () => {
  const failed = { machineId: 'm3', hostFailure: { at: iso(-12), error: 'could not start its agent host: the agent host did not start' } };
  for (const status of ['running', 'starting', 'error', 'idle', 'stopped'] as const) {
    const a = st(s('a', { status, ...failed }));
    assert.deepEqual([a.state, a.label, a.waitsOn], ['error', 'Blocked', 'its agent host did not start on m3'], status);
  }
  assert.equal(agentStateText(s('a', { status: 'running', ...failed }), undefined, NOW), 'Blocked: its agent host did not start on m3');
  assert.equal(st(s('a', { status: 'running', machineId: 'm3' })).state, 'working', 'once the failure is cleared it is what its status says');
  assert.equal(holdsItsPlace(s('a', { status: 'running', ...failed }), NOW), false, 'a dead host holds no place');
});

test('w898: a sandbox in cleanup (its caches are being trimmed) is not free, placement does not count it, and no worker starts there', async (t) => {
  const { store, agents } = await setup(t);
  const beta = () => store.machines.get('pc')!.sandboxes!.find((x) => x.id === 'beta')!;
  const free = () => agents.places().find((p) => p.id === 'pc')?.freeSandboxes;
  assert.match(agents.describeAllSandboxes(), /- pc\/beta FREE/);
  const before = free();
  Object.assign(beta(), { status: 'cleanup', statusDetail: 'trimming the Burst and Build caches (released)' });
  const text = agents.describeAllSandboxes();
  assert.doesNotMatch(text, /pc\/beta FREE/);
  assert.match(text, /- pc\/beta: cleanup \(trimming the Burst and Build caches \(released\)\)/, 'list_sandboxes shows the state');
  assert.equal(free(), before! - 1, 'the capacity count and placement do not count it free');
  assert.throws(() => agents.startWorker({ sandbox: 'pc/beta', prompt: 'x', from: 'orchestrator' }), /is being cleaned up .* use another free sandbox/);
  Object.assign(beta(), { status: 'ready', statusDetail: undefined });
  assert.match(agents.describeAllSandboxes(), /- pc\/beta FREE/, 'free again when the trim ends');
  assert.equal(free(), before);
});
