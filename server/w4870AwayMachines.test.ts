// w4870: nothing is placed, queued or planned on a computer that is offline or paused, and what waits on one moves; only
// work pinned to it (decide_work pin, WorkItem.machinePin) waits for it, Blocked. A paused computer counts as an offline one
// at once (shared/availability.ts). lothsahn, 2026-11-20: "Paused machines should be treated as offline--we don't know when
// they'll come back"; "Let's have list machines report it as "paused; unavailable" instead of online".
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
import { awayOf, longAway } from './machineAway.ts';
import { TimedRuns, type TimedRunRecord } from './timedRuns.ts';
import { pinnedAway, workLive } from '../shared/workState.ts';
import { PAUSED_STATE, needsAwayText, unavailableAs } from '../shared/availability.ts';
import type { Config } from './config.ts';
import type { Machine, Requester, UserInfo, WorkItem } from '../shared/types.ts';

const MIN = 60_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];
const OLD = ago(3 * 3600_000);

test('w4870: a pause counts as away at once, whatever its end; the state reads "paused; unavailable"', () => {
  assert.equal(PAUSED_STATE, 'paused; unavailable');
  const justNow = { paused: true, since: new Date(NOW).toISOString() };
  assert.equal(longAway(awayOf({ online: true, pause: justNow }, NOW), { pause: justNow }, 5 * MIN, NOW), true, 'a pause a moment old');
  const ending = { paused: true, since: ago(MIN), until: new Date(NOW + 2 * MIN).toISOString() };
  assert.equal(longAway(awayOf({ online: true, pause: ending }, NOW), { pause: ending }, 5 * MIN, NOW), true, 'a pause said to end in 2 min');
  assert.equal(longAway(awayOf({ online: true, pause: { paused: true } }, NOW), {}, 5 * MIN, NOW), true, 'a pause with no since');
  assert.equal(unavailableAs({ online: true, pause: { paused: true } }), 'paused');
  assert.equal(unavailableAs({ online: false }), 'offline');
  assert.equal(unavailableAs({ online: false, offlineLong: false }), undefined, 'a blip');
  assert.equal(unavailableAs({ online: true, pause: { paused: false } }), undefined);
  assert.equal(needsAwayText('lothlaptop', 'paused'), 'needs lothlaptop, which is paused');
});

test('w4870: pinned work whose every computer is away is Blocked on it; work pinned to a running computer or unpinned is not', () => {
  const pin = { machinePin: { ids: ['lothlaptop'], why: 'the dispatcher: its own repair' } };
  assert.deepEqual(pinnedAway(pin, { away: { lothlaptop: 'paused' } }), ['needs lothlaptop, which is paused']);
  assert.equal(pinnedAway(pin, { away: { beast: 'offline' } }), undefined);
  assert.equal(pinnedAway({ machinePin: { ids: ['lothlaptop', 'beast'], why: 'x' } }, { away: { lothlaptop: 'paused' } }), undefined, 'one of its computers runs');
  assert.equal(pinnedAway({}, { away: { lothlaptop: 'paused' } }), undefined);
  const w = { id: 'w9', title: 'Repair LothLaptop', brief: 'b', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'queued', createdAt: OLD, updatedAt: OLD, sessionIds: [], log: [], queuedFor: { at: OLD, needs: ['lothlaptop'] }, ...pin } as unknown as WorkItem;
  const live = workLive(w, { session: () => undefined, away: { lothlaptop: 'paused' }, now: NOW } as never);
  assert.equal(live?.state, 'blocked');
  assert.match(live?.why ?? '', /^needs lothlaptop, which is paused: it is pinned there \(the dispatcher: its own repair\) and starts by itself when one is back/);
});

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w4870-'));
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
  const online = new Set(['lothdesktop', 'lothlaptop', 'beast']);
  machines.isOnline = (id: string) => online.has(id.toLowerCase());
  const machine = (id: string, o: Partial<Machine> = {}) =>
    store.putMachine({ id, host: id, purpose: 'unused', status: 'ready', online: online.has(id), repoPath: '/r', home: '/h', portalUrl: 'http://x', sessionIds: [], createdAt: '', ...o } as Machine);
  machine('lothdesktop');
  machine('beast');
  machine('lothlaptop', { pause: { paused: true, reason: 'manual', since: new Date().toISOString() } as never });
  const request = (o: Partial<WorkItem> = {}): WorkItem => {
    const w: WorkItem = { id: 'w4871', title: 'Bench A/B', brief: 'Compare the branch.', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'new', createdAt: OLD, updatedAt: OLD, sessionIds: [], log: [], ...o } as WorkItem;
    store.putWork(w);
    store.workSeq = Math.max(store.workSeq, 4871);
    return w;
  };
  return { store, agents, request };
}

test('w4870: the queue refuses a paused computer; a pin to it makes the work wait Blocked there', async (t) => {
  const { store, agents, request } = await setup(t);
  const o = agents.orchestrators;
  request();
  assert.throws(() => o.decide({ id: 'w4871', action: 'queue', note: 'wait for it', needs: ['lothlaptop'] }), /lothlaptop is paused; unavailable: nothing is queued or planned on a computer that is offline or paused.*decide_work pin/);
  assert.equal(store.work.get('w4871')!.status, 'new', 'nothing was queued');
  assert.throws(() => o.decide({ id: 'w4871', pin: 'lothlaptop', note: '' }), /pin needs a note/);
  const pinned = o.decide({ id: 'w4871', action: 'queue', note: 'its own repair: only LothLaptop has the fault', pin: 'lothlaptop', needs: ['lothlaptop'] });
  assert.match(pinned, /w4871 is pinned to lothlaptop: it runs there and nowhere else, and waits Blocked \(needs lothlaptop, which is paused\) until it is back/);
  const w = store.work.get('w4871')!;
  assert.equal(w.status, 'queued');
  assert.deepEqual(w.machinePin?.ids, ['lothlaptop']);
  const live = (agents as unknown as { workLiveNow: () => Map<string, { state: string; why?: string }> }).workLiveNow().get('w4871')!;
  assert.equal(live.state, 'blocked');
  assert.match(live.why ?? '', /^needs lothlaptop, which is paused/);
  assert.match(o.decide({ id: 'w4871', pin: 'none', note: 'any computer will do' }), /pinned nowhere now/);
  assert.equal(store.work.get('w4871')!.machinePin, undefined);
});

test('w4870: work queued for a computer that pauses moves off it at once; pinned work stays', async (t) => {
  const { store, agents, request } = await setup(t);
  request({ status: 'queued', queuedFor: { at: ago(MIN), needs: ['lothlaptop'] } });
  const moved = agents.moveAwayWork(Date.now());
  assert.equal(moved.length, 1);
  assert.match(moved[0][1], /no longer waits for lothlaptop \(paused/);
  assert.equal(store.work.get('w4871')!.queuedFor?.needs, undefined);
  request({ status: 'queued', queuedFor: { at: ago(MIN), needs: ['lothlaptop'] }, machinePin: { ids: ['lothlaptop'], why: 'the dispatcher: its own repair' } });
  assert.deepEqual(agents.moveAwayWork(Date.now()), []);
  assert.deepEqual(store.work.get('w4871')!.queuedFor?.needs, ['lothlaptop']);
});

test('w4870: start_agent and list_machines treat a paused computer as unavailable', async (t) => {
  const { store, agents, request } = await setup(t);
  const x = agents as unknown as { awayProblem: (on: string, w: WorkItem | undefined) => string | undefined; describeMachine: (m: Machine) => string };
  const w = request();
  assert.match(x.awayProblem('lothlaptop', w) ?? '', /lothlaptop \(paused[^)]*\) is paused; unavailable: no new work goes there\..*decide_work pin lothlaptop/);
  assert.equal(x.awayProblem('lothdesktop', w), undefined);
  const pinned = request({ machinePin: { ids: ['lothlaptop'], why: 'the dispatcher: its own repair' } });
  assert.equal(x.awayProblem('lothlaptop', pinned), undefined, 'work pinned there may start there');
  const line = x.describeMachine(store.machines.get('lothlaptop')!);
  assert.match(line, /: paused; unavailable/);
  assert.doesNotMatch(line, /: online/);
  assert.match(x.describeMachine(store.machines.get('lothdesktop')!), /: online/);
});

test('w4870: a timed run queued on a paused computer moves at once; none is sent there', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4870-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const posted: string[] = [];
  const held: Record<string, string> = { lothlaptop: 'lothlaptop is paused (manual)' };
  const machine = (id: string): Machine => ({ id, online: true, sandboxRoot: 'F:/ffw', platform: 'win32' }) as unknown as Machine;
  const r = new TimedRuns({
    dataDir: dir,
    store: { get: (id: string) => (id === 'x' ? { id, sha256: '0'.repeat(64) } : undefined), grant: () => {}, begin: () => ({ uploadId: 'u', chunkBytes: 1 }), forget: () => {} } as never,
    machines: () => ['lothlaptop', 'play1'].map(machine),
    isOnline: () => true,
    offers: () => true,
    held: (id) => held[id],
    post: (id) => (posted.push(id), true),
    deliver: async () => {},
    smallWorker: (m) => (m.id === 'lothlaptop' ? { agents: 1 } : { agents: 2 }),
    unavailableWait: () => ({ ms: 30 * MIN, why: '30 min' }),
    now: () => NOW,
  });
  const runs = (r as unknown as { runs: Map<string, TimedRunRecord> }).runs;
  runs.set('tr_p', { id: 'tr_p', session: 's1', requests: ['w9'], what: 'A/B', from: 'beast', machine: 'lothlaptop', state: 'queued', createdAt: ago(30 * MIN), updatedAt: ago(MIN), order: { id: 'tr_p', what: 'A/B', requests: ['w9'], session: 's1', variants: [], save: { id: 'x', name: 's.zip', sha256: '0'.repeat(64), size: 1 }, pieceIds: {}, settings: { rounds: 4, settleS: 25, sampleS: 20, res: '1920x1080' } } as never });
  assert.deepEqual(r.retarget(), ['tr_p'], 'moved without waiting out the 30 min');
  assert.equal(runs.get('tr_p')!.machine, 'play1');
  assert.match(runs.get('tr_p')!.movedFrom?.[0] ?? '', /lothlaptop is paused; unavailable/);
  assert.ok(!posted.includes('lothlaptop'));
});
