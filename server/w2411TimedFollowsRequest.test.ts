import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { TimedRuns } from './timedRuns.ts';
import { timedRoute } from './timedDelivery.ts';
import { TIMED_DEFAULTS, type TimedRunOrder } from '../shared/timedRun.ts';
import type { AttachmentStore } from './attachments.ts';
import type { Config } from './config.ts';
import type { AttachmentRef, Machine, Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

/**
 * w2411: a timed run's result follows its request to its new worker. lothsahn, 2026-10-27: "File a fix so timed-run results
 * follow the request to its new worker". w2257's tr_0d985b752b finished at 10:25Z on 2026-10-26 after w2257 had moved from
 * worker 5e988861 to 6155c459; its result went to 5e988861, and the w2079 rule dropped it ("a message for its old worker
 * 5e988861 on beast/slot3 did not move it again"). w2363's tr_0ed821dfd1 and tr_84cc11005b were filed by 604e4321, which
 * w2363 was moved off at 14:11Z on 2026-10-27.
 */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'lothsahn' };
const PEOPLE: UserInfo[] = [{ ...LOTH, role: 'owner' }];
const OLD = new Date(Date.now() - 3 * 3600_000).toISOString();
const SHA = (c: string) => c.repeat(64);

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, runs: { id: string; state: string; save?: boolean }[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w2411-'));
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
  // What reaches each worker: the real routing, a recorded send (no process starts here).
  const sent: { to: string; text: string; files: AttachmentRef[] }[] = [];
  (agents as unknown as { sendWithAttachments: Agents['sendWithAttachments'] }).sendWithAttachments = async (id, text, _from, opts) => {
    sent.push({ to: id, text, files: opts?.attachments ?? [] });
    return `uuid-${sent.length}`;
  };
  const worker = (id: string): SessionInfo => {
    const s: SessionInfo = { id, kind: 'worker', title: 'w2363: Interpolation OverwriteJob rest skip', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 3, costUsd: 0, pendingPermissions: [], machineId: 'lothdesktop', machineSandbox: 'slot3' };
    store.putSession(s);
    return s;
  };
  const w: WorkItem = { id: 'w2363', title: 'World interpolation OverwriteJob: skip chunks at rest', brief: 'Do it.', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'active', createdAt: OLD, updatedAt: OLD, sessionIds: ['604e4321'], overlaps: [], asks: 0, log: [] };
  worker('604e4321');
  store.putWork(w);
  store.workSeq = Math.max(store.workSeq, 2363);

  // The portal's store: the build's two pieces and the save, unless a run's save is gone.
  const files: Record<string, { id: string; sha256: string; name: string; size: number }> = {
    att_p1: { id: 'att_p1', sha256: SHA('1'), name: 'p1', size: 1 },
    att_p2: { id: 'att_p2', sha256: SHA('2'), name: 'p2', size: 1 },
    att_save: { id: 'att_save', sha256: SHA('5'), name: 'bench.zip', size: 1 },
  };
  const order = (id: string, save = true): TimedRunOrder =>
    ({ id, what: 'w2363 A/B', requests: ['w2363'], session: '604e4321', variants: [], save: { id: save ? 'att_save' : 'att_gone', name: 'bench.zip', size: 1, sha256: SHA('5') }, pieceIds: { [SHA('1')]: 'att_p1', [SHA('2')]: 'att_p2' }, settings: { ...TIMED_DEFAULTS } }) as unknown as TimedRunOrder;
  fs.mkdirSync(path.join(dir, 'portal'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'portal', 'timed-runs.json'), JSON.stringify({ runs: runs.map((r) => ({ id: r.id, session: '604e4321', requests: ['w2363'], what: 'w2363 A/B', from: 'lothdesktop', machine: 'lothlaptop', state: r.state, createdAt: now, updatedAt: now, order: order(r.id, r.save !== false) })), pieces: {} }));
  let online = false;
  const posted: { type: string; id?: string }[] = [];
  const logs: string[] = [];
  const tr = new TimedRuns({
    dataDir: path.join(dir, 'portal'),
    store: { get: (id: string) => files[id], grant: () => {}, forget: () => {}, begin: () => ({ uploadId: 'u', chunkBytes: 1 }) } as unknown as AttachmentStore,
    machines: () => [{ id: 'lothlaptop', platform: 'win32', playOnly: 'test' } as unknown as Machine],
    isOnline: () => online,
    offers: () => true,
    post: (_id, msg) => (posted.push(msg as never), true),
    deliver: (session, text, f, run) => agents.timedRunDelivered(session, text, f, run),
    note: (requests, line) => requests.forEach((id) => agents.orchestrators.noteMove(id, line)),
    log: (l) => logs.push(l),
  });
  agents.timedRuns = tr;
  /** FF Factory moves w2363 off its worker; `to` is the new worker it starts, if any. */
  const move = (from: string, to?: string) => {
    agents.orchestrators.moveOff(store.work.get('w2363')!, from, 'moved: it moves to beast (test)');
    if (to) agents.orchestrators.linkWorker('w2363', worker(to), `started worker ${to} in beast/slot3: moved from worker ${from}`);
  };
  const done = (id: string) => tr.onReport('lothlaptop', { type: 'timed_run_done', id, ok: true, summary: 'base 16.2 ms, fix 14.9 ms', legs: [{ ok: true } as never] });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const log = () => store.work.get('w2363')!.log.join('\n');
  return { store, agents, tr, sent, posted, logs, move, done, settle, log, worker, online: (v: boolean) => (online = v) };
}

test('w2411: a run queued when its request moves still goes out, and its result reaches the new worker', async (t) => {
  const x = await setup(t, [{ id: 'tr_0ed821dfd1', state: 'queued' }]);
  x.move('604e4321', '858983f7');
  assert.equal(x.tr.get('tr_0ed821dfd1')?.state, 'queued', 'the move drops nothing');
  // lothlaptop comes back: the run goes out as filed
  x.online(true);
  x.tr.onHello('lothlaptop', []);
  assert.equal(x.tr.get('tr_0ed821dfd1')?.state, 'sent');
  assert.deepEqual(x.posted.map((p) => p.type), ['timed_run']);
  x.done('tr_0ed821dfd1');
  await x.settle();
  assert.deepEqual(x.sent.map((s) => s.to), ['858983f7'], 'to the worker on w2363 now, not 604e4321');
  assert.match(x.sent[0].text, /^\[for w2363\] This timed run was filed by worker 604e4321, which the request was moved off since; its result is yours\.\n\[timed run tr_0ed821dfd1 on lothlaptop\] done: 1 of 1 legs/);
  assert.match(x.log(), /timed run tr_0ed821dfd1's result went to worker 858983f7, which holds w2363 now \(filed by worker 604e4321, moved off since\)/);
  assert.deepEqual(x.tr.get('tr_0ed821dfd1')?.delivered && { to: x.tr.get('tr_0ed821dfd1')!.delivered!.to, moved: x.tr.get('tr_0ed821dfd1')!.delivered!.moved }, { to: '858983f7', moved: true });
});

test('w2411: a run that is running when its request moves reports to the new worker', async (t) => {
  const x = await setup(t, [{ id: 'tr_84cc11005b', state: 'running' }]);
  x.online(true);
  x.move('604e4321', '858983f7');
  // its daemon still reports it: the portal waits for it there, so nothing is cancelled
  x.tr.onReport('lothlaptop', { type: 'timed_run_status', id: 'tr_84cc11005b', state: 'running', line: 'fix round 2' });
  assert.equal(x.posted.filter((p) => p.type === 'timed_run_cancel').length, 0);
  x.done('tr_84cc11005b');
  await x.settle();
  assert.deepEqual(x.sent.map((s) => s.to), ['858983f7']);
  assert.match(x.log(), /tr_84cc11005b's result went to worker 858983f7/);
});

test('w2411: with no worker on its request the result is kept, and the next worker gets it', async (t) => {
  const x = await setup(t, [{ id: 'tr_0d985b752b', state: 'running' }]);
  x.online(true);
  // w2257 at 09:00Z: moved off 5e988861 (here 604e4321), Queued for another computer, no new worker yet
  x.move('604e4321');
  x.done('tr_0d985b752b');
  await x.settle();
  assert.equal(x.sent.length, 0, 'not sent to the worker it was moved off');
  assert.match(x.tr.get('tr_0d985b752b')?.undelivered?.why ?? '', /w2363 has no worker now/);
  assert.match(x.log(), /timed run tr_0d985b752b's result is kept on the request: w2363 has no worker now .*; its next worker gets it/);
  // a tick before a worker holds it: still kept, logged once
  x.tr.tick();
  await x.settle();
  assert.equal(x.sent.length, 0);
  assert.equal(x.log().split('\n').filter((l) => /is kept on the request/.test(l)).length, 1);
  // the dispatcher starts the next worker on it: the next tick hands it the result
  x.move('none', '6155c459');
  x.tr.tick();
  await x.settle();
  assert.deepEqual(x.sent.map((s) => s.to), ['6155c459']);
  assert.equal(x.tr.get('tr_0d985b752b')?.undelivered, undefined);
  assert.match(x.log(), /tr_0d985b752b's result went to worker 6155c459, which holds w2363 now/);
  x.tr.tick();
  await x.settle();
  assert.equal(x.sent.length, 1, 'once');
});

test('w2411: a result dropped from its old worker\'s queue (w2079) goes again to the worker on the request now', async (t) => {
  const x = await setup(t, [{ id: 'tr_0d985b752b', state: 'running' }]);
  x.online(true);
  // delivered while 604e4321 still held w2363 (its message queued for room), then w2363 moved
  x.done('tr_0d985b752b');
  await x.settle();
  assert.deepEqual(x.sent.map((s) => s.to), ['604e4321']);
  assert.match(x.log(), /tr_0d985b752b's result went to worker 604e4321, which filed it/);
  x.move('604e4321', '6155c459');
  assert.equal(x.tr.dropped('uuid-1'), true);
  await x.settle();
  assert.deepEqual(x.sent.map((s) => s.to), ['604e4321', '6155c459']);
  assert.equal(x.tr.dropped('uuid-unknown'), false, 'another message is not a run');
});

test('w2411: a queued run whose build is gone fails and says so on its request', async (t) => {
  const x = await setup(t, [{ id: 'tr_00000000aa', state: 'queued', save: false }]);
  x.move('604e4321', '858983f7');
  x.online(true);
  x.tr.onHello('lothlaptop', []);
  await x.settle();
  assert.equal(x.tr.get('tr_00000000aa')?.state, 'failed');
  assert.equal(x.posted.length, 0, 'nothing sent to lothlaptop');
  assert.match(x.log(), /timed run tr_00000000aa for lothlaptop FAILED before it started: the build it needs is gone from the portal \(1 of its 3 pieces deleted, 555555555555…, the save among them\)/);
  assert.match(x.sent[0]?.text ?? '', /FAILED: 0 of 0 legs with numbers; the build it needs is gone/);
  assert.equal(x.sent[0]?.to, '858983f7');
});

test('w2411: timedRoute: the filer while it holds the request, else its newest live worker, else kept; closed requests go to the filer', () => {
  const s = (id: string, o: Partial<SessionInfo> = {}) => ({ id, kind: 'worker', status: 'stopped', ...o }) as SessionInfo;
  const sessions: Record<string, SessionInfo> = { a: s('a'), b: s('b'), c: s('c', { status: 'error' }), o: s('o', { kind: 'orchestrator' }) };
  const w = (o: Partial<WorkItem>) => ({ id: 'w1', status: 'active', sessionIds: [], log: [], ...o }) as WorkItem;
  const route = (item: WorkItem) => timedRoute('a', ['w1'], (id) => (id === 'w1' ? item : undefined), (id) => sessions[id]);
  assert.deepEqual(route(w({ sessionIds: ['a', 'b'] })), { to: 'a', moved: false, work: [w({ sessionIds: ['a', 'b'] })] });
  assert.equal((route(w({ sessionIds: ['b'], movedOff: { a: OLD } })) as { to: string }).to, 'b');
  assert.equal((route(w({ sessionIds: ['b', 'c'] })) as { to: string }).to, 'b', 'a failed worker takes nothing');
  assert.ok('keep' in route(w({ sessionIds: ['o'] })), 'an orchestrator is no worker');
  assert.ok('keep' in route(w({ sessionIds: [] })));
  assert.deepEqual(route(w({ status: 'done', sessionIds: ['b'] })), { to: 'a', moved: false, work: [] });
});
