import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentState, agentStateText, isWaitingAgent, sortAgents } from '../shared/agentState.ts';
import { workLive } from '../shared/workState.ts';
import { fleetOf } from '../shared/fleet.ts';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { SandboxManager } from './sandboxes.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * An agent's state (w475, asked by Lothsahn): Working, Waiting (between turns, but a wake_me, a background task or a
 * queued message will bring it back), Idle (available), Stopped; listed in that order. The derivation, the server's copy
 * of the wakes and the queue onto the sessions, list_sandboxes, the free sandbox, the ledger's request state and the
 * Overview's order.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const T = '2026-10-05T22:00:00.000Z';
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const s = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({ id, kind: 'worker', title: `Worker ${id}`, status: 'idle', permissionMode: 'default', createdAt: T, lastActivityAt: T, turns: 1, costUsd: 0, pendingPermissions: [], ...o });

test('agent state: Working, Needs you, Waiting on a check-in, a queued message or a background task, Idle, Stopped', () => {
  assert.equal(agentState(s('a', { status: 'running' })).state, 'working');
  assert.equal(agentState(s('a', { status: 'starting' })).state, 'working');
  assert.equal(agentState(s('a', { status: 'waiting_permission' })).state, 'needs_you');
  assert.equal(agentState(s('a', { status: 'error' })).state, 'error');
  const wake = agentState(s('a', { wakeAt: '2026-10-05T23:12:00.000Z' }));
  assert.deepEqual(wake, { state: 'waiting', label: 'Waiting', waitsOn: 'check-in at 23:12 UTC', until: '2026-10-05T23:12:00.000Z' });
  assert.equal(agentStateText(s('a', { status: 'stopped', wakeAt: '2026-10-05T23:12:00.000Z' })), 'Waiting: check-in at 23:12 UTC', 'a stopped agent its wake will resume');
  assert.equal(agentStateText(s('a', { status: 'stopped', queuedSend: 'all 4 slots busy' })), 'Waiting: a queued message (all 4 slots busy)');
  assert.equal(agentStateText(s('a', { backgroundTasks: 1 })), 'Waiting: a background task');
  assert.equal(agentStateText(s('a', { backgroundTasks: 2 })), 'Waiting: 2 background tasks');
  assert.equal(agentState(s('a', { status: 'stopped', backgroundTasks: 1 })).state, 'stopped', 'a restart ended its background tasks');
  assert.equal(agentState(s('a')).state, 'idle');
  assert.equal(agentState(s('a', { status: 'stopped' })).state, 'stopped');
  assert.equal(isWaitingAgent(s('a', { wakeAt: T })), true);
  assert.equal(isWaitingAgent(s('a')), false);
});

test('agent order: Working, then Waiting, then Idle, then Stopped; the most recent activity first in each', () => {
  const at = (h: number) => `2026-10-05T${String(h).padStart(2, '0')}:00:00.000Z`;
  const list = [
    s('idle-old', { lastActivityAt: at(1) }),
    s('stopped', { status: 'stopped', lastActivityAt: at(9) }),
    s('waiting', { wakeAt: at(23), lastActivityAt: at(2) }),
    s('working-old', { status: 'running', lastActivityAt: at(3) }),
    s('idle-new', { lastActivityAt: at(8) }),
    s('working-new', { status: 'running', lastActivityAt: at(7) }),
    s('needs-you', { status: 'waiting_permission', lastActivityAt: at(5) }),
  ];
  assert.deepEqual(
    sortAgents(list).map((x) => x.id),
    ['working-new', 'needs-you', 'working-old', 'waiting', 'idle-new', 'idle-old', 'stopped'],
  );
});

test("a request whose worker is Waiting shows Waiting with the worker's check-in, not Stalled", () => {
  const w = { id: 'w448', title: 'x', brief: '', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: T, updatedAt: T, sessionIds: ['eb9632fd'], overlaps: [], asks: 0, log: [] } as WorkItem;
  const worker = s('eb9632fd', { wakeAt: '2026-10-05T23:12:00.000Z' });
  assert.deepEqual(workLive(w, { items: [w], session: () => worker, now: Date.parse(T) }), { state: 'pending', why: "worker eb9632fd's check-in at 23:12 UTC" });
  assert.equal(workLive(w, { items: [w], session: () => s('eb9632fd'), now: Date.parse(T) })?.state, 'stalled', 'Idle with nothing pending: stalled, as before');
});

test('the Overview lists a place\'s agents Working, Waiting, Idle, and a stopped one its wake will resume among them', () => {
  const sessions = [s('i1', { lastActivityAt: '2026-10-05T21:00:00.000Z' }), s('w1', { status: 'stopped', wakeAt: '2026-10-05T23:00:00.000Z' }), s('r1', { status: 'running' }), s('x1', { status: 'stopped' })];
  const app = {
    sandboxes: [{ id: 'alpha', name: 'alpha', branch: 'b', base: 'origin/develop', path: '/x', purpose: 'w448', status: 'ready', createdAt: T, unity: { state: 'stopped' }, sessionIds: sessions.map((x) => x.id) }],
    sessions,
    machines: [],
  } as never;
  const sb = fleetOf(app)[0].sandboxes[0];
  assert.deepEqual(sb.agents.live.map((x) => x.id), ['r1', 'w1', 'i1']);
  assert.equal(sb.agents.stopped, 1);
});

// ---------------------------------------------------------------- the server: wakes and the queue onto the sessions

const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
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
  const sessions = new SessionManager(cfg, store);
  const sandboxes = new SandboxManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sandboxes, sessions, machines, new Identity(cfg, () => PEOPLE));
  store.putSandbox({ id: 'alpha', name: 'alpha', branch: 'sandbox/alpha', base: 'origin/develop', path: path.join(dir, 'alpha'), purpose: 'unused', status: 'ready', createdAt: T, unity: { state: 'stopped' }, sessionIds: ['eb9632fd'] });
  store.putSession(s('eb9632fd', { status: 'stopped', sandboxId: 'alpha', title: 'w448: merge #1083' }));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { store, sessions, agents };
}

test('the server copies a pending wake_me and a queued message onto the session, and clears them when they go', (t) => {
  const { store, sessions, agents } = setup(t);
  const waker = (agents as unknown as { waker: { schedule: (id: string, m: number, n: string) => string; cancel: (id: string) => boolean } }).waker;
  assert.equal(store.sessions.get('eb9632fd')?.wakeAt, undefined);
  waker.schedule('eb9632fd', 15, 'merge #1083 when the tests pass');
  const at = store.sessions.get('eb9632fd')?.wakeAt;
  assert.ok(at && Date.parse(at) > Date.now() + 14 * 60_000, 'the wake time');
  waker.cancel('eb9632fd');
  assert.equal(store.sessions.get('eb9632fd')?.wakeAt, undefined, 'cleared');
  // A message held for a free slot (the queue is the session manager's; stood in for here).
  let held: { id: string; why: string }[] = [{ id: 'eb9632fd', why: 'all 4 slots busy' }];
  Object.defineProperty(sessions, 'queued', { value: () => held });
  agents.syncWaiting();
  assert.equal(store.sessions.get('eb9632fd')?.queuedSend, 'all 4 slots busy');
  held = [];
  agents.syncWaiting();
  assert.equal(store.sessions.get('eb9632fd')?.queuedSend, undefined);
});

test('list_sandboxes says Waiting and on what, and a sandbox whose worker is Waiting is not free', (t) => {
  const { agents } = setup(t);
  const waker = (agents as unknown as { waker: { schedule: (id: string, m: number, n: string) => string } }).waker;
  assert.match(agents.describeAllSandboxes(), /- alpha FREE/, 'unused label and no live agent: free');
  waker.schedule('eb9632fd', 15, 'merge #1083');
  const text = agents.describeAllSandboxes();
  assert.doesNotMatch(text, /alpha FREE/, 'its worker will come back to it');
  assert.match(text, /- eb9632fd "w448: merge #1083" \[Waiting: check-in at \d\d:\d\d UTC, stopped\]/);
  assert.equal(agents.places()[0].freeSandboxes, 0, 'the capacity block and placement do not count it free');
});
