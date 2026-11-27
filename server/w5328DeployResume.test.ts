// w5328: a worker that waits on blocked_on deploys:[<machine>] for another computer than its own resumes on that computer.
// w5319 (2026-11-23): its worker, moved m5 -> lothdesktop for a free seat (w2046), merged ff-factory #1109 (macOS only) and
// waited on deploys ["m5"]; m5's update resumed it on lothdesktop, where the check after it cannot run (handed up as w5327).
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
import { DEPLOY_WAIT_MARK, deployResumeOn } from './deployResume.ts';
import type { Computer, PlacementPrefs } from './placement.ts';
import type { Config } from './config.ts';
import type { Machine, Requester, SessionInfo, UserInfo, WorkBlocker, WorkItem } from '../shared/types.ts';

const MIN = 60_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];
const OLD = ago(3 * 3600_000);
const pcx = (id: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 2, platform: 'win32', maxEditors: 3, ...o });
const gate = (o: Partial<WorkBlocker>): WorkBlocker => ({ kind: 'deploy', what: "m5's daemon update", at: OLD, by: 'worker 5319aaaa', ...o }) as WorkBlocker;

test('deployResumeOn: a deploy gate on another known computer names it; its own computer, the portal or the rollout name none', () => {
  const known = ['m5', 'lothdesktop', 'biscuit'];
  assert.deepEqual(deployResumeOn([gate({ ref: 'm5' })], 'lothdesktop', known), ['m5']);
  assert.deepEqual(deployResumeOn([gate({ ref: 'M5' })], 'LothDesktop', known), ['m5'], 'any case');
  assert.equal(deployResumeOn([gate({ ref: 'm5' })], 'm5', known), undefined, 'its own computer: it resumes where it is');
  assert.equal(deployResumeOn([gate({ ref: 'm5' }), gate({ ref: 'lothdesktop' })], 'lothdesktop', known), undefined, 'one of them is its own');
  assert.deepEqual(deployResumeOn([gate({ ref: 'm5' }), gate({ ref: 'biscuit' })], 'lothdesktop', known), ['m5', 'biscuit']);
  assert.equal(deployResumeOn([gate({ ref: undefined, what: 'a portal deploy' })], 'lothdesktop', known), undefined, 'the portal names no computer');
  assert.equal(deployResumeOn([gate({ ref: 'machines' })], 'lothdesktop', known), undefined, "the machines' rollout names none");
  assert.equal(deployResumeOn([{ kind: 'pr', ref: 'o/r#1', what: 'x', at: OLD, by: 'w' } as WorkBlocker], 'lothdesktop', known), undefined);
});

type Internals = {
  deployMove: (h: SessionHandle, q: QueuedSend, now: number) => true | string | undefined;
  startMoved: (info: SessionInfo, w: WorkItem, to: string, why: string, hold: string, branch: string | undefined, lead: string | undefined, hb: Parameters<Agents['orchestrators']['movedForRoom']>[2]) => Promise<string>;
  places: () => Computer[];
  placement: () => PlacementPrefs;
};

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, needs: 'game' | 'agent' = 'agent') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w5328-'));
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
    agents.close(); // w6152: Agents' timers stop before the folder goes (w5915: a release pass wrote into a removed transcript, ENOENT).
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const online = new Set(['lothdesktop', 'm5', 'biscuit']);
  machines.isOnline = (id: string) => online.has(id.toLowerCase());
  const x = agents as unknown as Internals;
  let places = [pcx('lothdesktop'), pcx('m5', { platform: 'darwin' }), pcx('biscuit')];
  x.places = () => places.map((p) => ({ ...p, online: online.has(p.id) }));
  let prefs: PlacementPrefs = {};
  x.placement = () => prefs;
  for (const id of ['lothdesktop', 'm5', 'biscuit']) store.putMachine({ id, host: id, purpose: 'unused', status: 'ready', online: true, repoPath: '/r', home: '/h', portalUrl: 'http://x', sessionIds: [], createdAt: '' } as Machine);
  const starts: { to: string; lead?: string; branch?: string; message?: string }[] = [];
  x.startMoved = async (info, w, to, _why, _hold, branch, lead, hb) => {
    const id = `new${starts.length + 1}`;
    starts.push({ to, ...(lead ? { lead } : {}), ...(branch ? { branch } : {}), ...(hb.message ? { message: hb.message } : {}) });
    agents.orchestrators.movedForRoom(w, info, hb);
    const s: SessionInfo = { id, kind: 'worker', title: info.title, status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 1, costUsd: 0, pendingPermissions: [], machineId: to, machineSandbox: 'slot1' };
    store.putSession(s);
    agents.orchestrators.linkWorker(w.id, s, `started worker ${id} in ${to}/slot1: moved from worker ${info.id}`, { moved: true });
    return `${to}/slot1 as worker ${id}`;
  };
  // w5319's worker on lothdesktop, its sandbox released while it waited on the deploy (w890).
  const info: SessionInfo = {
    id: '5319aaaa',
    kind: 'worker',
    title: 'w5319: ff-leftovers folders',
    status: 'stopped',
    permissionMode: 'default',
    createdAt: OLD,
    lastActivityAt: OLD,
    turns: 9,
    costUsd: 0,
    pendingPermissions: [],
    machineId: 'lothdesktop',
    machineSandbox: 'slot3',
    placeReleased: { at: ago(30 * MIN), sandbox: 'slot3', branch: 'w5319-apfs-clones', why: 'it released it while it waited on the deploy (w890)', wait: true },
  };
  store.putSession(info);
  // The gate resume as FF Factory hands it to the worker (its wake, then SessionManager.send's queue).
  const woke: { id: string; note: string; resumeOf?: string }[] = [];
  (agents.orchestrators as unknown as { d: { restoreWake: (id: string, note: string, resumeOf?: string) => boolean } }).d.restoreWake = (id, note, resumeOf) => (woke.push({ id, note, ...(resumeOf ? { resumeOf } : {}) }), true);
  const w: WorkItem = {
    id: 'w5319',
    title: 'ff-leftovers folders: APFS clones',
    brief: 'Fix where a seed Library\'s APFS clones are counted in server/apfsPrivate.ts.',
    needs,
    priority: 'normal',
    keys: [],
    requestedBy: BEN,
    requesters: [BEN],
    humanAsked: true,
    status: 'blocked',
    blocked: gate({ ref: 'm5', at: ago(30 * MIN) }),
    createdAt: OLD,
    updatedAt: OLD,
    sessionIds: [info.id],
    overlaps: [],
    asks: 0,
    log: [],
  } as WorkItem;
  store.putWork(w);
  store.workSeq = Math.max(store.workSeq, 5319);
  const settled = async () => {
    for (let n = 0; n < 200 && agents.isMoving(info.id); n++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(agents.isMoving(info.id), false, 'the move finished');
  };
  // The resume as the gate's clearing queues it (Orchestrators.resumeGatedWorker -> wake -> SessionManager.send).
  const resume = (): QueuedSend => {
    const r = woke.at(-1);
    assert.ok(r?.resumeOf, 'the gate resume was queued');
    return { uuid: 'u1', id: r.id, text: `[wake_me] ${r.note}`, from: 'system', at: new Date().toISOString(), why: 'queued', resumeOf: { work: r.resumeOf, note: r.note } };
  };
  const h = { info } as SessionHandle;
  return { store, agents, x, online, info, h, woke, starts, settled, resume, setPlaces: (p: Computer[]) => (places = p), setPrefs: (p: PlacementPrefs) => (prefs = p) };
}

test('w5328: a deploys:["m5"] wait set by a worker on lothdesktop resumes on m5', async (t) => {
  const { store, agents, x, h, starts, settled, resume } = await setup(t);
  agents.orchestrators.unblock('w5319', "m5's daemon runs a new commit");
  const w = store.work.get('w5319')!;
  assert.deepEqual(w.resumeOn && [w.resumeOn.machines, w.resumeOn.session], [['m5'], '5319aaaa'], JSON.stringify(w.resumeOn));
  assert.match(resume().text, /The check after m5's update runs there: FF Factory resumes this on m5, in a fresh session if you are on another computer \(w5328\)/);
  assert.equal(x.deployMove(h, resume(), Date.now()), true, 'the resume moves (lothdesktop had room: before w5328 it resumed there)');
  await settled();
  assert.deepEqual(starts.map((s) => s.to), ['m5'], 'to m5, not lothdesktop or biscuit');
  assert.match(starts[0].lead ?? '', /^\[moved, w5328\] FF Factory moved w5319 to this computer: its worker 5319aaaa on lothdesktop\/slot3 waited with blocked_on for m5's daemon update/);
  assert.equal(starts[0].branch, 'w5319-apfs-clones', 'it carries on from its pushed branch');
  assert.match(starts[0].message ?? '', /w5319 is unblocked/, 'the resume message goes with it');
  const after = store.work.get('w5319')!;
  assert.deepEqual(after.sessionIds, ['new1']);
  assert.equal(after.resumeOn, undefined, 'used once');
});

test('w5328: a deploy wait on its own computer records no move', async (t) => {
  const { store, agents, info } = await setup(t);
  store.putSession({ ...info, machineId: 'm5' });
  agents.orchestrators.unblock('w5319', "m5's daemon runs a new commit");
  assert.equal(store.work.get('w5319')!.resumeOn, undefined);
});

test('w5328: with no free sandbox or seat on m5 it waits Queued for m5 and never falls back to a computer with room', async (t) => {
  const { store, agents, x, h, starts, resume, setPlaces } = await setup(t, 'game');
  agents.orchestrators.unblock('w5319', "m5's daemon runs a new commit");
  setPlaces([pcx('lothdesktop'), pcx('m5', { platform: 'darwin', freeSandboxes: 0 }), pcx('biscuit')]);
  const line = x.deployMove(h, resume(), Date.now());
  assert.equal(typeof line, 'string');
  assert.ok((line as string).startsWith(`${DEPLOY_WAIT_MARK}: it waits for m5;`), String(line));
  assert.match(line as string, /m5: no free sandbox made yet/);
  assert.equal(starts.length, 0);
  assert.ok(store.work.get('w5319')!.resumeOn, 'still owed to m5');
  // A sandbox frees on m5: it goes there (game work: a fresh session in that sandbox, switched to its branch).
  setPlaces([pcx('lothdesktop'), pcx('m5', { platform: 'darwin', freeSandboxes: 1 }), pcx('biscuit')]);
  assert.equal(x.deployMove(h, resume(), Date.now()), true);
  for (let n = 0; n < 200 && agents.isMoving('5319aaaa'); n++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(starts.map((s) => [s.to, s.branch]), [['m5', 'w5319-apfs-clones']]);
});

test('w5328: m5 held or offline: it waits for m5 and says so; it goes once m5 is back', async (t) => {
  const { agents, x, h, online, starts, resume, setPrefs } = await setup(t);
  agents.orchestrators.unblock('w5319', "m5's daemon runs a new commit");
  setPrefs({ hold: { m5: 'Ben: crash hold' } });
  const held = x.deployMove(h, resume(), Date.now());
  assert.match(String(held), /^it resumes on the computer whose update it waited for \(w5328\): it waits for m5; .*m5 is on hold \(Ben: crash hold/);
  setPrefs({});
  online.delete('m5');
  assert.equal(x.deployMove(h, resume(), Date.now()), `${DEPLOY_WAIT_MARK}: it waits for m5; m5 is offline; it goes when one is back`);
  assert.equal(starts.length, 0, 'never to lothdesktop or biscuit');
  online.add('m5');
  assert.equal(x.deployMove(h, resume(), Date.now()), true);
});

test('w5328: work only on its own computer (unpushed commits) resumes where it is, told the check is on m5', async (t) => {
  const { store, agents, x, info, h, starts, resume } = await setup(t);
  store.putSession({ ...info, placeReleased: undefined });
  const m = store.machines.get('lothdesktop')!;
  store.putMachine({ ...m, sandboxes: [{ id: 'slot3', git: { branch: 'w5319-apfs-clones', upstream: 'origin/w5319-apfs-clones', ahead: 2, dirty: 0, untracked: 0, at: ago(MIN) } } as never] });
  agents.orchestrators.unblock('w5319', "m5's daemon runs a new commit");
  const q = resume();
  assert.equal(x.deployMove({ info: store.sessions.get(info.id)! } as SessionHandle, q, Date.now()), undefined);
  assert.match(q.text, /\[w5328\] The check after m5's update runs on m5, but FF Factory resumed you here on lothdesktop: 2 commit\(s\) on w5319-apfs-clones are not pushed/);
  assert.equal(starts.length, 0);
  assert.equal(store.work.get('w5319')!.resumeOn, undefined);
  void h;
});

test('w5328: other messages to the worker, and resumes of other requests, are not moved', async (t) => {
  const { agents, x, h, resume } = await setup(t);
  agents.orchestrators.unblock('w5319', "m5's daemon runs a new commit");
  const plain = { ...resume(), resumeOf: undefined };
  assert.equal(x.deployMove(h, plain, Date.now()), undefined, 'a person\'s message is delivered or held as any');
  assert.equal(x.deployMove(h, { ...resume(), resumeOf: { work: 'w9999', note: 'n' } }, Date.now()), undefined);
});
