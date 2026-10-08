// w691 (w665): a message to a worker on a machine whose agent host could not be started. The daemon used to mark the session
// running anyway and its next report put that back on the portal, so the ledger showed the request mid-turn for hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager, RemoteSession } from './machines.ts';
import { HostedSession, type HostDeps } from '../machine/agentHost.ts';
import { workLive } from '../shared/workState.ts';
import { agentState } from '../shared/agentState.ts';
import type { Config } from './config.ts';
import type { FromDaemon } from './machineProtocol.ts';
import type { MachineSandbox, SessionInfo, WorkItem } from '../shared/types.ts';

const ERR = 'could not start its agent host: the agent host did not start';
const BEN = { userId: 'ben', displayName: 'Ben' };

const tmpdir = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-hostfail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
};

const info = (id: string): SessionInfo => ({ id, kind: 'worker', title: 'w665: GPU page fault', status: 'idle', permissionMode: 'default', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), turns: 3, costUsd: 1, pendingPermissions: [], machineId: 'm3' });

test('w691: the daemon does not mark a session running when no agent host started, and tells the portal why', (t) => {
  const root = tmpdir(t);
  const out: FromDaemon[] = [];
  const deps: HostDeps = {
    root,
    out: (m) => out.push(m),
    events: new EventEmitter(),
    handlers: () => ({}),
    spec: () => ({ cwd: root, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: root, protectedPaths: [], gameRepos: [] } }),
    editorUp: () => undefined,
    changed: () => undefined,
    log: () => undefined,
    launch: () => {
      throw new Error('the agent host did not start');
    },
  };
  const s = new HostedSession(info('d558ba14'), 0, deps);
  s.send('re-send');
  assert.deepEqual(out, [{ type: 'failed', sessionId: 'd558ba14', error: ERR, reason: 'host_start' }]);
  assert.equal(s.live, false, 'not live: nothing runs');
  assert.equal(s.info.status, 'error', 'not running (the report that hid the failure from the ledger, w665)');
  assert.equal(s.info.statusDetail, ERR);
  assert.equal(s.info.turnOpenSince, undefined, 'no turn was opened');
  // A second message tries again, and fails the same way.
  s.send('again');
  assert.equal(out.length, 2);
  // And once a host can start, the next message runs it as before.
  let pid = 0;
  deps.launch = () => ++pid + 1000;
  const ok = new HostedSession(info('d2'), 0, deps);
  ok.send('hello');
  assert.equal(ok.live, true);
  assert.equal(ok.info.status, 'running');
  assert.equal(out.length, 2, 'no failure for it');
  ok.detach();
});

/** A throwaway portal with one machine and one worker on it, driven with the daemon's messages. */
function portal(t: { after: (fn: () => void) => void }) {
  const dir = tmpdir(t);
  const cfg = { dataDir: path.join(dir, 'data'), limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  fs.mkdirSync(cfg.dataDir);
  const store = new Store(cfg.dataDir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  const sb: MachineSandbox = { id: 'sb', branch: 'sandbox/sb', base: 'origin/develop', path: path.join(dir, 'sb'), purpose: 'unused', status: 'ready', createdAt: '', unity: { state: 'stopped' }, sessionIds: [] };
  mm.register({ id: 'm3', host: 'm3', purpose: 'unused', status: 'ready', repoPath: dir, home: dir, portalUrl: 'http://127.0.0.1:1', sandboxes: [sb] });
  const worker = mm.createSession('m3', { kind: 'worker', sandbox: 'sb', title: 'w665', permissionMode: 'default' });
  const onMessage = (msg: FromDaemon) => (mm as unknown as { onMessage(id: string, msg: FromDaemon): void }).onMessage('m3', msg);
  const item = (): WorkItem => ({
    id: 'w665',
    title: 'Mac GPU page fault',
    brief: 'Fix it.',
    priority: 'urgent',
    keys: [],
    requestedBy: BEN,
    requesters: [BEN],
    humanAsked: true,
    status: 'active',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    sessionIds: [worker.info.id],
    overlaps: [],
    asks: 0,
    log: [],
  });
  const live = () => {
    const w = item();
    return workLive(w, { items: [w], session: (id) => store.sessions.get(id), now: Date.now() });
  };
  return { store, mm, worker, onMessage, live };
}

test('w691: a failed start is Blocked on its machine for the ledger, also when the daemon goes on reporting it mid-turn, and clears with the first event of a host that did start', (t) => {
  const { worker, onMessage, live, store } = portal(t);
  onMessage({ type: 'session', info: { ...worker.info, status: 'running', turnOpenSince: new Date().toISOString() }, live: true });
  assert.equal(live()?.state, 'working', 'mid-turn on a host that runs');

  onMessage({ type: 'failed', sessionId: worker.info.id, error: ERR, reason: 'host_start' });
  assert.equal(worker.info.status, 'error');
  assert.equal(worker.info.hostFailure?.error, ERR);
  assert.deepEqual([live()?.state, live()?.waitsOn], ['blocked', ['m3']]);
  assert.equal(agentState(worker.info).label, 'Blocked');

  // The older daemon's next report: running, live. The portal keeps what it knows; the daemon cannot take it back.
  onMessage({ type: 'session', info: { ...worker.info, status: 'running', turnOpenSince: new Date().toISOString(), hostFailure: undefined }, live: true });
  assert.equal(worker.info.status, 'running', 'the daemon owns run state');
  assert.ok(worker.info.hostFailure, 'the portal owns the failure');
  assert.deepEqual([live()?.state, live()?.waitsOn], ['blocked', ['m3']]);
  assert.equal(store.sessions.get(worker.info.id)?.hostFailure?.error, ERR, 'kept with the session');

  // A host started and said something: unblocked by itself.
  onMessage({ type: 'event', sessionId: worker.info.id, event: { kind: 'assistant', text: 'back', seq: 1, t: new Date().toISOString() } as never });
  assert.equal(worker.info.hostFailure, undefined);
  assert.equal(live()?.state, 'working');
});

test('w691: older daemons are read by their words: "could not start its agent host" in a failed message, and "its agent host did not start" in a stopped report', (t) => {
  const a = portal(t);
  a.onMessage({ type: 'failed', sessionId: a.worker.info.id, error: ERR });
  assert.equal(a.worker.info.hostFailure?.error, ERR, 'no reason sent: the words are enough');
  a.onMessage({ type: 'delta', sessionId: a.worker.info.id, text: 'x' });
  assert.equal(a.worker.info.hostFailure, undefined, 'a delta is a host talking');

  // Any other failed send (a refused start, a limit) is not a dead host.
  const b = portal(t);
  b.onMessage({ type: 'failed', sessionId: b.worker.info.id, error: "already 3 agents running in this machine's main clone" });
  assert.equal(b.worker.info.hostFailure, undefined);
  assert.equal(b.live()?.state, 'stalled');

  // The host that was launched but never came up: the daemon reports the session stopped.
  const c = portal(t);
  c.onMessage({ type: 'session', info: { ...c.worker.info, status: 'stopped', statusDetail: 'its agent host did not start (see /x/host.log)' }, live: false });
  assert.deepEqual([c.live()?.state, c.live()?.waitsOn], ['blocked', ['m3']]);
});

test('w691: a worker\'s next message ends its declaration that it waits on a person', (t) => {
  const posts: string[] = [];
  const link = { dispatchSend: () => posts.push('send'), touch: () => posts.push('touch') } as unknown as MachineManager;
  const i = { ...info('d'), waitingOn: { who: 'Ben', what: 'reboot the m3', at: new Date().toISOString() } };
  const s = new RemoteSession(i, link);
  s.send('the m3 is up');
  assert.equal(i.waitingOn, undefined);
  assert.deepEqual(posts, ['send', 'touch']);
  t.after(() => undefined);
});
