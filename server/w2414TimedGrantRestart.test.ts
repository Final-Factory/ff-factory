import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents, movedText } from './agents.ts';
import { Identity } from './identity.ts';
import { TimedRuns } from './timedRuns.ts';
import { TIMED_DEFAULTS, type TimedRunOrder } from '../shared/timedRun.ts';
import type { AttachmentStore } from './attachments.ts';
import type { Config } from './config.ts';
import type { AttachmentRef, Machine, Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

/**
 * w2414: a timed run queued on its daemon survives a portal restart and its request's move. lothsahn, 2026-10-27: "Timed
 * run tr_e93675645e's results were lost when w2369 moved workers, after w2411's fix went live". tr_e93675645e was filed
 * at 16:34Z for lothlaptop and waited in its daemon's queue behind other runs; the portal restarted at 17:08Z (an update)
 * and lost every grant (attachments.ts keeps them in memory), and the hello did not grant again a run its daemon listed
 * as its own. At 17:18Z its turn came, its pieces were refused ("the portal has no such attachment for this machine"),
 * and the failure went to worker 70e02d13 as w2369 moved to 9328fb8b; the run never played.
 */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'lothsahn' };
const PEOPLE: UserInfo[] = [{ ...LOTH, role: 'owner' }];
const OLD = new Date(Date.now() - 3 * 3600_000).toISOString();
const SHA = (c: string) => c.repeat(64);
const REFUSED = 'the portal has no such attachment for this machine (expired, or not handed to it)';

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, runs: { id: string; state: string; save?: boolean }[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w2414-'));
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
    const s: SessionInfo = { id, kind: 'worker', title: 'w2369: Interpolation OverwriteJob rest skip', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 3, costUsd: 0, pendingPermissions: [], machineId: 'lothdesktop', machineSandbox: 'slot3' };
    store.putSession(s);
    return s;
  };
  const w: WorkItem = { id: 'w2369', title: 'World interpolation OverwriteJob: skip chunks at rest', brief: 'Do it.', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'active', createdAt: OLD, updatedAt: OLD, sessionIds: ['604e4321'], overlaps: [], asks: 0, log: [] };
  worker('604e4321');
  store.putWork(w);
  store.workSeq = Math.max(store.workSeq, 2369);

  // The portal's store: the build's two pieces and the save, unless a run's save is gone.
  const files: Record<string, { id: string; sha256: string; name: string; size: number }> = {
    att_p1: { id: 'att_p1', sha256: SHA('1'), name: 'p1', size: 1 },
    att_p2: { id: 'att_p2', sha256: SHA('2'), name: 'p2', size: 1 },
    att_save: { id: 'att_save', sha256: SHA('5'), name: 'bench.zip', size: 1 },
  };
  const order = (id: string, save = true): TimedRunOrder =>
    ({ id, what: 'w2369 A/B', requests: ['w2369'], session: '604e4321', variants: [], save: { id: save ? 'att_save' : 'att_gone', name: 'bench.zip', size: 1, sha256: SHA('5') }, pieceIds: { [SHA('1')]: 'att_p1', [SHA('2')]: 'att_p2' }, settings: { ...TIMED_DEFAULTS } }) as unknown as TimedRunOrder;
  fs.mkdirSync(path.join(dir, 'portal'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'portal', 'timed-runs.json'), JSON.stringify({ runs: runs.map((r) => ({ id: r.id, session: '604e4321', requests: ['w2369'], what: 'w2369 A/B', from: 'lothdesktop', machine: 'lothlaptop', state: r.state, createdAt: now, updatedAt: now, order: order(r.id, r.save !== false) })), pieces: {} }));
  let online = false;
  // The portal's grants, in memory like attachments.ts's: a restart empties them.
  const grants = new Set<string>();
  const posted: { type: string; id?: string }[] = [];
  const logs: string[] = [];
  const tr = new TimedRuns({
    dataDir: path.join(dir, 'portal'),
    store: { get: (id: string) => files[id], grant: (m: string, ids: string[]) => ids.forEach((id) => grants.add(`${m}/${id}`)), forget: () => {}, begin: () => ({ uploadId: 'u', chunkBytes: 1 }) } as unknown as AttachmentStore,
    machines: () => [{ id: 'lothlaptop', platform: 'win32', playOnly: 'test' } as unknown as Machine],
    isOnline: () => online,
    offers: () => true,
    post: (_id, msg) => (posted.push(msg as never), true),
    deliver: (session, text, f, run) => agents.timedRunDelivered(session, text, f, run),
    note: (requests, line) => requests.forEach((id) => agents.orchestrators.noteMove(id, line)),
    log: (l) => logs.push(l),
  });
  agents.timedRuns = tr;
  /** FF Factory moves w2369 off its worker; `to` is the new worker it starts, if any. */
  const move = (from: string, to?: string) => {
    agents.orchestrators.moveOff(store.work.get('w2369')!, from, 'moved: it moves to beast (test)');
    if (to) agents.orchestrators.linkWorker('w2369', worker(to), `started worker ${to} in beast/slot3: moved from worker ${from}`);
  };
  const done = (id: string) => tr.onReport('lothlaptop', { type: 'timed_run_done', id, ok: true, summary: 'base 16.2 ms, fix 14.9 ms', legs: [{ ok: true } as never] });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const log = () => store.work.get('w2369')!.log.join('\n');
  return { store, agents, tr, sent, posted, logs, move, done, settle, log, worker, online: (v: boolean) => (online = v), grants };
}


/** lothlaptop's daemon fetches the run's pieces when its turn comes: what the portal answers (GET /machine/attachments/<id>). */
const fetchable = (grants: Set<string>) => ['att_p1', 'att_p2', 'att_save'].every((id) => grants.has(`lothlaptop/${id}`));

test('w2414: a run queued on its daemon through a portal restart can still fetch its pieces', async (t) => {
  const x = await setup(t, [{ id: 'tr_e93675645e', state: 'queued' }]);
  x.online(true);
  x.tr.onHello('lothlaptop', []);
  assert.equal(x.tr.get('tr_e93675645e')?.state, 'sent');
  x.tr.onReport('lothlaptop', { type: 'timed_run_status', id: 'tr_e93675645e', state: 'queued', line: 'queued behind tr_a8418b1a62' });
  // 17:08Z: the portal restarts; its grants go. The daemon's hello names the run as its own (still queued there).
  x.grants.clear();
  x.tr.onHello('lothlaptop', ['tr_a8418b1a62', 'tr_e93675645e']);
  assert.equal(x.posted.filter((p) => p.type === 'timed_run').length, 1, 'not sent twice');
  assert.ok(fetchable(x.grants), 'its pieces are granted again on the hello');
  // and a status of a run still going grants them again (a wait past the 6 h grant)
  x.grants.clear();
  x.tr.onReport('lothlaptop', { type: 'timed_run_status', id: 'tr_e93675645e', state: 'fetching', line: 'fetching 25 of 50 pieces' });
  assert.ok(fetchable(x.grants), 'its pieces are granted again on its status');
});

test('w2414: a run refused its pieces is sent again once, and its result reaches the worker its request moved to', async (t) => {
  const x = await setup(t, [{ id: 'tr_e93675645e', state: 'sent' }]);
  x.online(true);
  x.move('604e4321', '9328fb8b');
  x.grants.clear();
  x.tr.onReport('lothlaptop', { type: 'timed_run_done', id: 'tr_e93675645e', ok: false, error: REFUSED, summary: '', legs: [] });
  await x.settle();
  assert.equal(x.tr.get('tr_e93675645e')?.state, 'sent', 'sent again, not failed');
  assert.equal(x.posted.filter((p) => p.type === 'timed_run').length, 1);
  assert.ok(fetchable(x.grants));
  assert.equal(x.sent.length, 0, 'no failure goes to a worker');
  assert.match(x.logs.join('\n'), /tr_e93675645e: lothlaptop could not fetch its pieces .* granted and sent again/);
  x.done('tr_e93675645e');
  await x.settle();
  assert.deepEqual(x.sent.map((s) => s.to), ['9328fb8b'], 'to the worker on w2369 now');
  assert.match(x.sent[0].text, /\[timed run tr_e93675645e on lothlaptop\] done/);
});

test('w2414: a second refusal fails the run with words that say to redo it, to the worker on its request now', async (t) => {
  const x = await setup(t, [{ id: 'tr_e93675645e', state: 'sent' }]);
  x.online(true);
  x.move('604e4321', '9328fb8b');
  const refuse = () => x.tr.onReport('lothlaptop', { type: 'timed_run_done', id: 'tr_e93675645e', ok: false, error: REFUSED, summary: '', legs: [] });
  refuse();
  refuse();
  await x.settle();
  assert.equal(x.tr.get('tr_e93675645e')?.state, 'failed');
  assert.deepEqual(x.sent.map((s) => s.to), ['9328fb8b']);
  assert.match(x.sent[0].text, /it never played, twice: call timed_run again to redo it/);
});

test('w2414: a refused run whose pieces are gone from the portal fails at once', async (t) => {
  const x = await setup(t, [{ id: 'tr_e93675645e', state: 'sent', save: false }]);
  x.online(true);
  x.tr.onReport('lothlaptop', { type: 'timed_run_done', id: 'tr_e93675645e', ok: false, error: REFUSED, summary: '', legs: [] });
  await x.settle();
  assert.equal(x.tr.get('tr_e93675645e')?.state, 'failed');
  assert.equal(x.posted.filter((p) => p.type === 'timed_run').length, 0, 'not sent again');
});

test('w2414: a moved message names its attachments for fetch_attachment', () => {
  assert.equal(movedText({ text: 'hi' }), 'hi');
  const t = movedText({ text: '[timed run tr_e93675645e on lothlaptop] done', attachments: [{ id: 'att_0123456789abcdef', name: 'timed-tr_e93675645e.tar.gz', size: 9, sha256: SHA('a'), kind: 'file', mediaType: 'application/gzip', path: '/x/Inbox/a' }] });
  assert.match(t, /fetch_attachment gets each here by id: att_0123456789abcdef \(timed-tr_e93675645e\.tar\.gz\)\]$/);
});
