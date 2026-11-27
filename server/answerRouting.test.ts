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
import { isWith, latestWorker } from '../shared/blockers.ts';
import { holdsOf } from '../shared/workState.ts';

/**
 * w6047 (the w6253 review asked for it): one table of where answerNeedsYou sends a person's [answer], over every shape the
 * w6214 to w6253 review files exercised: the asking worker kept, moved or handed back; another worker linked before or after;
 * an old or a live hand-off; shared w1812 twins. Each row says who is resumed with it, who never is, and which hand-offs carry
 * it. Setup as in server/zRev18.test.ts.
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
    agents.close(); // w6152: Agents' timers stop before the folder goes (w5915: a release pass wrote into a removed transcript, ENOENT).
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
  const sent: { id: string; text: string; from: string; images?: unknown[] }[] = [];
  const realSend = sessions.send.bind(sessions);
  sessions.send = ((id: string, text: string, from: 'human' | 'orchestrator' | 'system' = 'human', images?: unknown[]) => {
    sent.push({ id, text, from, ...(images ? { images } : {}) });
    return 'queued';
  }) as SessionManager['send'];
  return { store, sessions, agents, machines, starts, worker, request, queued, roomMove, settled, sent, realSend };
}

const pausedHb = { machine: 'biscuit', sandbox: 'slot1', why: 'paused by lothsahn', note: 'n', how: 'handed back: its computer is paused (w1532)' };
type Timers = Map<string, { note: string; resumeOf?: string }>;
const answer = (env: Awaited<ReturnType<typeof setup>>, w: WorkItem, note: string) =>
  (env.agents.orchestrators as unknown as { answerNeedsYou: (w: WorkItem, by: Requester, note: string) => string }).answerNeedsYou(w, LOTH, note);
const timersOf = (env: Awaited<ReturnType<typeof setup>>) => (env.agents as unknown as { waker: { timers: Timers } }).waker.timers;
const ask = () => ({ kind: 'question', key: 'declared:ship', question: 'Ship it?', worker: '5449aaaa', at: OLD, raisedAt: OLD }) as unknown as WorkItem['needsYou'];

const T = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
function reached(env: Awaited<ReturnType<typeof setup>>, id: string) {
  const timers = timersOf(env);
  return !!timers.get(id) || env.sent.some((s) => s.id === id && /ship it/.test(s.text));
}

const A = '5449aaaa'; // the asking worker
const E = '3333aaaa'; // a worker on the request before (or beside) the asker
const N = '7777aaaa'; // a worker placed after the asker left
const M = '8888aaaa'; // a second such worker
const Z = '1111aaaa'; // a worker that handed the request back long ago
type Env = Awaited<ReturnType<typeof setup>>;
type Kit = {
  req: (ids: string[], id?: string, links?: Record<string, number>) => WorkItem;
  moveOff: (w: WorkItem, sid?: string) => void;
  handBack: (w: WorkItem, sid?: string) => void;
  place: (w: WorkItem, sid: string, msAgo?: number) => void;
  oldHandBack: (w: WorkItem) => void;
  merge: (into: WorkItem, ids: string[], links: Record<string, number>) => void;
};
type Row = {
  name: string;
  /** Builds the requests (w5869 and, for twins, w5871) and returns the one the person answers on. */
  build: (k: Kit) => WorkItem;
  resumed: string[];
  never: string[];
  /** Requests whose hand-off carries the answer, and those whose hand-off must not. */
  handOff?: string[];
  noHandOff?: string[];
  said?: RegExp;
};

function kit(env: Env): Kit {
  const machine: Record<string, string> = { [A]: 'biscuit', [E]: 'beast', [N]: 'beast', [M]: 'lothdesktop', [Z]: 'biscuit' };
  const slot: Record<string, string> = { [A]: 'slot1', [E]: 'slot2', [N]: 'slot3', [M]: 'slot4', [Z]: 'slot5' };
  const infos = new Map<string, SessionInfo>();
  for (const id of [A, E, N, M, Z]) {
    const info = env.worker(id, { machineId: machine[id], machineSandbox: slot[id] });
    env.sessions.adopt({ info, live: false, stop: () => {} } as unknown as SessionHandle);
    infos.set(id, info);
  }
  const put = (w: WorkItem) => env.store.putWork(w);
  return {
    req: (ids, id = 'w5869', links = {}) => {
      const w = env.request(ids, id);
      if (Object.keys(links).length) w.links = Object.fromEntries(Object.entries(links).map(([s, ago]) => [s, { at: T(ago), how: 'sent' as const }]));
      w.needsYou = ask();
      put(w);
      return w;
    },
    moveOff: (w, sid = A) => env.agents.orchestrators.moveOff(w, sid, 'moved for room (test)'),
    handBack: (w, sid = A) => env.agents.orchestrators.handBack(w, infos.get(sid)!, pausedHb),
    // A placement as the dispatcher makes it: on the request again, linked now (or msAgo ago), the request active.
    place: (w, sid, msAgo = -1000) => {
      w.sessionIds = [...w.sessionIds.filter((s) => s !== sid), sid];
      w.links = { ...w.links, [sid]: { at: T(msAgo), how: 'sent' } };
      w.status = 'active';
      delete (w as { queuedFor?: unknown }).queuedFor;
      put(w);
    },
    // Another request (w5871, no question of its own) with these workers, merged into this one through decide_work merge.
    merge: (into, ids, links) => {
      const w = env.request(ids, 'w5871');
      w.links = Object.fromEntries(Object.entries(links).map(([s, ago]) => [s, { at: T(ago), how: 'sent' as const }]));
      w.status = 'blocked'; // merge takes a request that is new, question, queued or blocked: a worker waiting on CI, say
      put(w);
      env.agents.orchestrators.decide({ id: 'w5871', action: 'merge', into: into.id, note: 'it repeats w5869 (test)' });
    },
    // Handed back by Z two hours ago, then placed again (its handedBack record stays).
    oldHandBack: (w) => {
      w.sessionIds = [Z, ...w.sessionIds];
      put(w);
      env.agents.orchestrators.handBack(w, infos.get(Z)!, pausedHb);
      w.handedBack = { ...w.handedBack!, at: T(7200_000) };
      w.movedOff = { [Z]: T(7200_000) };
      w.status = 'active';
      delete (w as { queuedFor?: unknown }).queuedFor;
      put(w);
    },
  };
}

const H = 3600_000;
const ROWS: Row[] = [
  { name: 'asker holds it alone', build: (k) => k.req([A], 'w5869', { [A]: H }), resumed: [A], never: [] },
  { name: 'asker holds it beside an earlier worker', build: (k) => k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H }), resumed: [A], never: [E] },
  { name: 'asker moved, a worker placed after', build: (k) => { const w = k.req([A], 'w5869', { [A]: 2 * H }); k.moveOff(w); k.place(w, N); return w; }, resumed: [N], never: [A] },
  { name: 'asker moved, a co-worker linked before it still on it (w6253 R1)', build: (k) => { const w = k.req([E, A], 'w5869', { [E]: H, [A]: H / 2 }); k.moveOff(w); return w; }, resumed: [E], never: [A] },
  { name: 'asker moved, the worker on it has no link time (w6214 F1)', build: (k) => { const w = k.req([N]); w.movedOff = { [A]: T(0) }; return w; }, resumed: [N], never: [A] },
  { name: 'asker handed it back, nobody since', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); return w; }, resumed: [], never: [A], handOff: ['w5869'] },
  { name: 'asker handed it back, an earlier worker linked before', build: (k) => { const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H }); k.handBack(w); return w; }, resumed: [], never: [A, E], handOff: ['w5869'] },
  { name: 'asker handed it back, an earlier worker with no link time (w6248 A)', build: (k) => { const w = k.req([E, A]); k.handBack(w); return w; }, resumed: [], never: [A, E], handOff: ['w5869'] },
  { name: 'asker handed it back, then a worker placed after (w6253 R3)', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); k.place(w, N); return w; }, resumed: [N], never: [A], noHandOff: ['w5869'] },
  { name: 'an old hand-off, then a co-worker and the asker placed, the asker moved (w6253 R2)', build: (k) => { const w = k.req([], 'w5869'); k.oldHandBack(w); k.place(w, E, H); k.place(w, A, H / 2); k.moveOff(w); return w; }, resumed: [E], never: [A, Z], noHandOff: ['w5869'] },
  { name: 'an old hand-off, the asker placed then moved, nobody on it', build: (k) => { const w = k.req([], 'w5869'); k.oldHandBack(w); k.place(w, A, H); k.moveOff(w); return w; }, resumed: [], never: [A, Z], noHandOff: ['w5869'], said: /nobody is on it/ },
  { name: 'asker handed it back, then a request with a working worker merged in (w6271)', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); k.merge(w, [N], { [N]: 2 * H }); return w; }, resumed: [N], never: [A], noHandOff: ['w5869'] },
  // w6277 review probes: the merged links keep their order, one with no link stays last, a gone worker leaves the hand-off live.
  { name: 'merged in after a hand-back, its worker sent again after its co-worker keeps the lead (w6277 F1)', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); k.merge(w, [N, M], { [N]: 2 * H, [M]: 3 * H }); return w; }, resumed: [N], never: [A, M], noHandOff: ['w5869'] },
  { name: 'merged in after a hand-back, the later-listed of two workers is older and stays behind (w6277 F1)', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); k.merge(w, [M, N], { [N]: 2 * H, [M]: 3 * H }); return w; }, resumed: [N], never: [A, M], noHandOff: ['w5869'] },
  { name: 'merged in after a hand-back, a worker with no link stays behind the linked one (w6277 F2)', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); k.merge(w, [N, M], { [N]: 2 * H }); return w; }, resumed: [N], never: [A, M], noHandOff: ['w5869'] },
  { name: 'merged in after a hand-back, a worker that no longer exists leaves the hand-off to carry it (w6277 F3)', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); k.merge(w, ['deadbeef'], { deadbeef: 2 * H }); return w; }, resumed: [], never: [A], handOff: ['w5869'] },
  { name: 'a worker placed after the hand-back stays newest over one merged in later (w6277)', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); k.place(w, N); k.merge(w, [M], { [M]: 2 * H }); return w; }, resumed: [N], never: [A, M], noHandOff: ['w5869'] },
  { name: 'a worker moved off it before the hand-back comes back with a merged request and must not take the answer (w6288 F4, w2079)', build: (k) => { const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H }); k.moveOff(w, E); k.handBack(w); k.merge(w, [E], { [E]: 3 * H }); return w; }, resumed: [], never: [A, E], handOff: ['w5869'] },
  // w6302 review probes (w6309): a moved-off worker merged back never takes the answer, whatever its merged link's time (R1).
  { name: 'P5 moved off before the hand-back, comes back with a merged request sent after the hand-back', build: (k) => { const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H }); k.moveOff(w, E); k.handBack(w); k.merge(w, [E], { [E]: -1000 }); return w; }, resumed: [], never: [A, E], handOff: ['w5869'] },
  { name: 'P7 moved off, merged back beside a working worker: the working one is shifted and takes it', build: (k) => { const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H }); k.moveOff(w, E); k.handBack(w); k.merge(w, [E, N], { [E]: 3 * H, [N]: 2 * H }); return w; }, resumed: [N], never: [A, E], noHandOff: ['w5869'] },
  { name: 'P8 moved off, merged back as the newer of two: the other is still shifted', build: (k) => { const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H }); k.moveOff(w, E); k.handBack(w); k.merge(w, [E, N], { [E]: 2 * H, [N]: 3 * H }); return w; }, resumed: [N], never: [A, E], noHandOff: ['w5869'] },
  { name: 'moved off, merged back, then placed on it again: it is its worker and takes it (w6309)', build: (k) => { const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H }); k.moveOff(w, E); k.handBack(w); k.merge(w, [E], { [E]: -1000 }); k.place(w, E, -2000); return w; }, resumed: [E], never: [A], noHandOff: ['w5869'] },
  // w1812 twins: the same question from the asker on w5869 and w5871.
  { name: 'twins: answered on the kept one, the other moved to a new worker', build: (k) => { const w = k.req([A], 'w5869', { [A]: 2 * H }); k.moveOff(w); k.place(w, N); return k.req([A], 'w5871', { [A]: H }); }, resumed: [A, N], never: [] },
  { name: 'twins: answered on the kept one, the other handed back', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); return k.req([A], 'w5871', { [A]: H }); }, resumed: [A], never: [], handOff: ['w5869'] },
  { name: 'twins: answered on the kept one, the other handed back with an earlier worker (w6248 B)', build: (k) => { const w = k.req([E, A]); k.handBack(w); return k.req([A], 'w5871'); }, resumed: [A], never: [E], handOff: ['w5869'] },
  { name: 'twins: moved to two workers', build: (k) => { const w = k.req([A], 'w5869', { [A]: 2 * H }); k.moveOff(w); k.place(w, N); const x = k.req([A], 'w5871', { [A]: 2 * H }); k.moveOff(x); k.place(x, M); return w; }, resumed: [N, M], never: [A] },
  { name: 'twins: answered on the moved one, the asker keeps the other', build: (k) => { const w = k.req([A], 'w5869', { [A]: 2 * H }); k.moveOff(w); k.place(w, N); k.req([A], 'w5871', { [A]: H }); return w; }, resumed: [N, A], never: [] },
  { name: 'twins: both handed back', build: (k) => { const w = k.req([A], 'w5869', { [A]: H }); k.handBack(w); const x = k.req([A], 'w5871', { [A]: H }); k.handBack(x); return w; }, resumed: [], never: [A], handOff: ['w5869', 'w5871'] },
  { name: 'twins: the other has an old hand-off and a co-worker on it, the asker moved off it', build: (k) => { const x = k.req([], 'w5871'); k.oldHandBack(x); k.place(x, E, H); k.place(x, A, H / 2); k.moveOff(x); return k.req([A], 'w5869', { [A]: H }); }, resumed: [A, E], never: [Z], noHandOff: ['w5871'] },
];

for (const row of ROWS) {
  test(`answer routing: ${row.name}`, async (t) => {
    const env = await setup(t, 'on');
    const k = kit(env);
    const on = row.build(k);
    const said = answer(env, env.store.work.get(on.id)!, 'yes, ship it');
    for (const id of row.resumed) assert.ok(reached(env, id), `${id} never hears the answer: "${said}"`);
    for (const id of row.never) assert.ok(!reached(env, id), `${id} is resumed with the answer: "${said}"`);
    for (const id of row.handOff ?? []) assert.match(env.store.work.get(id)!.handedBack?.message ?? '', /ship it/, `${id}'s hand-off lacks the answer: "${said}"`);
    for (const id of row.noHandOff ?? []) assert.doesNotMatch(env.store.work.get(id)!.handedBack?.message ?? '', /ship it/, `${id}'s old hand-off took the answer: "${said}"`);
    if (row.said) assert.match(said, row.said);
    // Each worker is resumed once (one check-in per worker), and only those the row names.
    const resumed = [...timersOf(env).keys()].filter((id) => [A, E, N, M, Z].includes(id)).sort();
    assert.deepEqual(resumed, [...row.resumed].sort(), `resumed ${JSON.stringify(resumed)}: "${said}"`);
  });
}

// w6302 review R2 (w6309): a merge lists a moved-off worker on the request again, but its own stale resumes are still
// refused, before and after another worker is placed; a person's [answer] or [note] to it still goes (w2495).
test('P9 a moved-off worker merged back is refused its stale resume once another is placed', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H });
  k.moveOff(w, E);
  k.handBack(w);
  k.merge(w, [E], { [E]: 3 * H });
  const o = env.agents.orchestrators;
  assert.ok(env.store.work.get('w5869')!.sessionIds.includes(E), 'the merge keeps it listed (keep rather than kill)');
  assert.match(o.staleResume('w5869', E, 'CI on #9 finished') ?? '', /was moved off worker/);
  k.place(env.store.work.get('w5869')!, N);
  assert.match(o.staleResume('w5869', E, 'CI on #9 finished') ?? '', /was moved off worker/);
  assert.equal(o.staleResume('w5869', E, '[answer] yes, ship it'), undefined);
  assert.equal(o.staleResume('w5869', E, '[note] use the old flag'), undefined);
  assert.equal(o.staleResume('w5869', N, 'CI on #9 finished'), undefined);
});

test('a moved-off worker merged back, then placed on it again, is not refused its resumes (w6309)', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H });
  k.moveOff(w, E);
  k.handBack(w);
  k.merge(w, [E], { [E]: 3 * H });
  k.place(env.store.work.get('w5869')!, E);
  assert.equal(env.agents.orchestrators.staleResume('w5869', E, 'CI on #9 finished'), undefined);
});

// The w6318 review of #1430 (w6309). Q1 (F1): a second merge that brings a moved-off worker again, now with a link newer
// than its move, does not put it back on the request either. Q2, Q3 (F2): a moved-off worker a merge listed again never
// hides a worker really on it, for the answer (onNow) or the release pass (isWith).
const mergeAgain = (env: Env, into: string, id: string, ids: string[], links: Record<string, number>) => {
  const x = env.request(ids, id);
  x.links = Object.fromEntries(Object.entries(links).map(([s, ago]) => [s, { at: T(ago), how: 'sent' as const }]));
  x.status = 'blocked';
  env.store.putWork(x);
  env.agents.orchestrators.decide({ id, action: 'merge', into, note: 'a second repeat (test)' });
};

test('Q1 a moved-off worker merged back twice: the second merge does not put it back on it (w6318 F1, w2079)', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H });
  k.moveOff(w, E);
  k.handBack(w);
  k.merge(w, [E], { [E]: 3 * H });
  mergeAgain(env, 'w5869', 'w5872', [E], { [E]: -1000 });
  const o = env.agents.orchestrators;
  assert.match(o.staleResume('w5869', E, 'CI on #9 finished') ?? '', /was moved off worker/);
  const said = answer(env, env.store.work.get('w5869')!, 'yes, ship it');
  assert.ok(!reached(env, E), `${E} is resumed with the answer: "${said}"`);
  assert.match(env.store.work.get('w5869')!.handedBack?.message ?? '', /ship it/, `the hand-off lacks the answer: "${said}"`);
});

const hiddenBehind = (k: Kit) => {
  // N is on it with no link time; E and the asker are moved off it; a merge lists E again.
  const w = k.req([N, E, A], 'w5869', { [E]: 2 * H, [A]: H });
  k.moveOff(w, E);
  k.moveOff(w);
  k.merge(w, [E], { [E]: 3 * H });
  return w;
};

test('Q2 a moved-off worker merged back does not hide an unlinked worker still on it from the answer (w6318 F2)', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  hiddenBehind(k);
  const said = answer(env, env.store.work.get('w5869')!, 'yes, ship it');
  assert.ok(reached(env, N), `${N} never hears the answer: "${said}"`);
  assert.ok(!reached(env, E), `${E} is resumed with the answer: "${said}"`);
  assert.ok(!reached(env, A), `${A} is resumed with the answer: "${said}"`);
});

test('Q3 a moved-off worker merged back is not the newest for the release pass over an unlinked worker on it (w6318 F2)', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  hiddenBehind(k);
  const x = env.store.work.get('w5869')!;
  assert.equal(latestWorker(x), N);
  assert.ok(isWith(x, N));
  assert.ok(!isWith(x, E));
});

test('a moved-off worker merged back alone is not on it: no newest worker, and not with it for the release pass (w6320, w2079)', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  const w = k.req([E, A], 'w5869', { [E]: 2 * H, [A]: H });
  k.moveOff(w, E);
  k.handBack(w);
  k.merge(w, [E], { [E]: 3 * H });
  const x = env.store.work.get('w5869')!;
  assert.ok(x.sessionIds.includes(E), "listed, so a person's [answer] to it still goes");
  assert.equal(latestWorker(x), undefined);
  assert.ok(!isWith(x, E));
});

// The w6320 review of #1430 (w6309): routes that take a request's first worker that exists never pick a merged-back
// moved-off worker alone on it (onRequest): a gate's end (F4), a held deploy (F3), a deploy's step after it (probe A).
const dispatcherSaid = (env: Awaited<ReturnType<typeof setup>>) => {
  const o = env.agents.orchestrators as unknown as { toDispatcher: (text: string, ...rest: unknown[]) => unknown };
  const said: string[] = [];
  const real = o.toDispatcher.bind(o);
  o.toDispatcher = (text: string, ...rest: unknown[]) => { said.push(text); return real(text, ...rest); };
  return said;
};

test('F4 a CI gate set by a worker since moved off and merged back: its end resumes nobody and tells the dispatcher (w6320)', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  const said = dispatcherSaid(env);
  const w = k.req([E], 'w5869', { [E]: 2 * H });
  w.status = 'blocked';
  w.blocked = { kind: 'ci', ref: 'Final-Factory/ff-factory#9', what: "#9's checks", by: `worker ${E}`, at: T(H) } as unknown as WorkItem['blocked'];
  env.store.putWork(w);
  k.moveOff(w, E);
  k.merge(env.store.work.get('w5869')!, [E], { [E]: -1000 });
  env.agents.orchestrators.unblock('w5869', 'its checks passed');
  const x = env.store.work.get('w5869')!;
  assert.equal(timersOf(env).get(E), undefined, 'E is not resumed');
  assert.ok(!isWith(x, E));
  assert.ok(said.some((m) => m.includes('w5869') && /unblocked/.test(m)), 'the dispatcher is told to start it');
});

test('F3 a held deploy of a PR whose worker was moved off and merged back wakes nobody (w6320)', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  const SHA = '5a1909756' + 'e'.repeat(31);
  const w = k.req([E], 'w5869', { [E]: 2 * H });
  w.prs = [{ repo: 'Final-Factory/ff-factory', number: 682, state: 'merged', at: T(H), sha: SHA }] as unknown as WorkItem['prs'];
  w.status = 'blocked';
  w.blocked = { kind: 'deploy', what: 'the next portal deploy', at: T(H), by: `worker ${E}`, sha: '3acc3147' } as unknown as WorkItem['blocked'];
  env.store.putWork(w);
  k.moveOff(w, E);
  k.merge(env.store.work.get('w5869')!, [E], { [E]: -1000 });
  const r = env.agents.orchestrators.deployHeld({ sha: SHA, text: 'deploy held: master CI failed', prs: [682], repo: 'Final-Factory/ff-factory' });
  assert.deepEqual(r.resumed, []);
  assert.equal(timersOf(env).get(E), undefined);
});

test("a deploy's step after it does not resume a worker moved off and merged back, and leaves the request to its caller (w6320 probe A)", async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  const w = k.req([E], 'w5869', { [E]: 2 * H });
  k.moveOff(w, E);
  k.merge(w, [E], { [E]: -1000 });
  const x = env.store.work.get('w5869')!;
  x.status = 'blocked'; env.store.putWork(x);
  assert.equal(env.agents.orchestrators.resumeAfterDeploy('w5869', 'portal deployed abc', 'check the dashboard'), false);
  assert.equal(timersOf(env).get(E), undefined);
  assert.equal(env.store.work.get('w5869')!.status, 'blocked');
});

// The w6323 review of #1430 (w6309): holdsOf, and every reader of it, uses onRequest too. A moved-off worker merged back
// alone holds nothing of it: a worker tool on it is refused, a room move leaves it behind (gone), the merge notice
// names no worker of it.
const aloneMergedBack = (env: Awaited<ReturnType<typeof setup>>) => {
  const k = kit(env);
  const w = k.req([E], 'w5869', { [E]: 2 * H });
  k.moveOff(w, E);
  k.merge(w, [E], { [E]: -1000 });
  return env.store.work.get('w5869')!;
};

test('w6323 PROBE1 a moved-off worker merged back alone holds nothing of it (holdsOf, servedBy)', async (t) => {
  const env = await setup(t, 'on');
  aloneMergedBack(env);
  const items = [...env.store.work.values()];
  const h = holdsOf(E, items);
  assert.ok(!h.held.has('w5869') && !h.served.has('w5869'));
  assert.ok(!env.agents.orchestrators.itemsOf(E).some((x) => x.id === 'w5869'));
});

test('w6323 PROBE2 a moved-off worker merged back alone is refused a worker tool on it (workerRequest)', async (t) => {
  const env = await setup(t, 'on');
  aloneMergedBack(env);
  assert.throws(() => env.agents.orchestrators.handUp(E, { items: [{ title: 'x', brief: 'y' }], request: 'w5869' }), /not on w5869/);
});

test('w6323 PROBE3 a room move of a moved-off worker merged back leaves the request behind (movableWorkOf gone)', async (t) => {
  const env = await setup(t, 'on');
  aloneMergedBack(env);
  const a = env.agents as unknown as { movableWorkOf: (i: SessionInfo) => { reqs: WorkItem[]; gone: WorkItem[] } };
  const m = a.movableWorkOf(env.store.sessions.get(E)!);
  assert.ok(m.gone.some((x) => x.id === 'w5869'));
  assert.ok(!m.reqs.some((x) => x.id === 'w5869'));
});

test('w6323 the merge notice names no moved-off worker it listed again (Low)', async (t) => {
  const env = await setup(t, 'on');
  const k = kit(env);
  const w = k.req([E], 'w5869', { [E]: 2 * H });
  k.moveOff(w, E);
  const m = env.request([E], 'w5871');
  m.links = { [E]: { at: T(-1000), how: 'sent' } };
  m.status = 'blocked';
  env.store.putWork(m);
  const said = env.agents.orchestrators.decide({ id: 'w5871', action: 'merge', into: 'w5869', note: 'it repeats w5869 (test)' });
  assert.match(said, /merged into w5869/);
  assert.ok(!said.includes(E), said);
});
