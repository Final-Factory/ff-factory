import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DispatcherStop, INTERRUPT_AFTER_MS, stopMessage, stopMeters } from './dispatcherStop.ts';
import { POOL_DEFAULTS, checkPoolConfig, judge, pickPool, poolLimits, reserveOf, reserveReason, type PoolToken } from './tokenPool.ts';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { blockerVerdict } from '../shared/blockers.ts';
import type { Config } from './config.ts';
import type { PlanUsage, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

// w1109 (lothsahn, 2026-10-12): "at 95%+ session or weekly usage the dispatcher asks all workers using the dispatcher key to
// stop, save their work and push". server/dispatcherStop.ts; docs/vault.md section 4, "The stop line".

const NOW = Date.parse('2026-10-12T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const KEY = 'token:dispatcherfp';
const OTHER = 'token:otherfp';
const NAME = 'vault-lothsahn-1 …EAAA';

const usage = (weekly: number, session = 10, weeklyDays = 2): PlanUsage => ({
  available: true,
  asOf: iso(NOW),
  models: [],
  session: { label: '5-hour', percent: session, resetsAt: iso(NOW + 3 * 3_600_000) },
  weekly: { label: 'weekly', percent: weekly, resetsAt: iso(NOW + weeklyDays * DAY) },
});

const info = (id: string, kind: SessionInfo['kind'], account: string, status: SessionInfo['status'], role?: SessionInfo['orchestratorRole']): SessionInfo =>
  ({ id, kind, title: id, status, account, permissionMode: 'default', createdAt: iso(NOW), lastActivityAt: iso(NOW), turns: 1, costUsd: 0, pendingPermissions: [], ...(role ? { orchestratorRole: role } : {}) }) as SessionInfo;

/** Everything that can be on the dispatcher's token, and a worker on another token. */
function world(file?: string) {
  const sessions = [
    info('disp', 'orchestrator', KEY, 'running', 'dispatcher'),
    info('lothorch', 'orchestrator', KEY, 'running'),
    info('ops1', 'ops', KEY, 'running'),
    info('stand1', 'standing', KEY, 'running'),
    info('wA', 'worker', KEY, 'running'),
    info('wB', 'worker', KEY, 'waiting_permission'),
    info('wIdle', 'worker', KEY, 'idle'),
    info('wGone', 'worker', KEY, 'stopped'),
    info('wOther', 'worker', OTHER, 'running'),
  ];
  const by = new Map(sessions.map((s) => [s.id, s]));
  let meters = usage(90);
  let clock = NOW;
  let pinned: { key: string; name: string; owner?: string } | undefined = { key: KEY, name: NAME, owner: 'lothsahn' };
  const told: { sid: string; text: string }[] = [];
  const interrupted: string[] = [];
  const blocked: string[] = [];
  const stop = new DispatcherStop({
    token: () => pinned,
    usageOf: (k) => (k === KEY ? meters : usage(10)),
    limits: () => POOL_DEFAULTS,
    sessions: () => sessions,
    requestsOf: (sid) => [`w-${sid}`],
    tell: (sid, text) => void told.push({ sid, text }),
    interrupt: (sid) => {
      interrupted.push(sid);
      by.get(sid)!.status = 'idle';
    },
    block: (sid) => {
      blocked.push(sid);
      return [`w-${sid}`];
    },
    log: () => {},
    now: () => clock,
    ...(file ? { file } : {}),
  });
  return {
    stop,
    by,
    told,
    interrupted,
    blocked,
    set meters(u: PlanUsage) {
      meters = u;
    },
    set clock(ms: number) {
      clock = ms;
    },
    unpin() {
      pinned = undefined;
    },
  };
}

test('w1109: a crossing of the stop line asks only the workers mid-turn on the dispatcher\'s token, each once; not other tokens\' workers, not the dispatcher, not the orchestrators', () => {
  const w = world();
  // Below the line: nothing.
  for (const pct of [90, 94, 94.9]) {
    w.meters = usage(pct);
    w.stop.tick();
  }
  assert.equal(w.told.length, 0, 'under 95% nobody is asked');
  assert.equal(w.stop.current, undefined);

  // The crossing (weekly 95%): wA and wB (mid-turn on the dispatcher's token) are asked; nobody else.
  w.meters = usage(95);
  w.stop.tick();
  assert.deepEqual(w.told.map((t) => t.sid).sort(), ['wA', 'wB']);
  assert.match(w.told[0].text, /^\[token stop\] The dispatcher's Claude token vault-lothsahn-1 …EAAA, which this session runs on, is at weekly 95% \(stop line 95%/);
  assert.match(w.told[0].text, /Commit your work in progress on your own branch .* and push it\. If the push is refused .* keep the commit local and say so/);
  assert.match(w.told[0].text, /`w-wA: still open: stopped at the dispatcher token's stop line; resumes on a token with room`/);
  assert.match(w.told[0].text, /another of lothsahn's tokens with room, or after the reset/);

  // Each once per crossing: more ticks, and a higher reading, ask nobody again.
  for (const pct of [95, 96, 97.5, 98]) {
    w.meters = usage(pct);
    w.stop.tick();
  }
  assert.equal(w.told.length, 2, 'each worker is asked once per crossing');
  assert.equal(w.blocked.length, 0, 'still mid-turn: not blocked yet');

  // wA saves its work and ends its turn: its requests are blocked on the token's limit.
  w.by.get('wA')!.status = 'idle';
  w.stop.tick();
  assert.deepEqual(w.blocked, ['wA']);
  // wB ignores it: interrupted INTERRUPT_AFTER_MS after it was asked, then blocked.
  w.clock = NOW + INTERRUPT_AFTER_MS - 1000;
  w.stop.tick();
  assert.deepEqual(w.interrupted, []);
  w.clock = NOW + INTERRUPT_AFTER_MS;
  w.stop.tick();
  return new Promise<void>((r) => setImmediate(r)).then(() => {
    assert.deepEqual(w.interrupted, ['wB']);
    w.stop.tick();
    assert.deepEqual(w.blocked, ['wA', 'wB']);
    assert.equal(w.told.length, 2, 'nothing more was sent');
    assert.match(w.stop.statusLine() ?? '', /asked 2|2 worker\(s\) asked/);

    // The reset ends the crossing; the next crossing asks the workers on the token again (once each).
    w.meters = usage(2);
    w.stop.tick();
    assert.equal(w.stop.current, undefined);
    w.by.get('wA')!.status = 'running';
    w.meters = usage(96);
    w.stop.tick();
    w.stop.tick();
    assert.equal(w.told.filter((t) => t.sid === 'wA').length, 2, 'a new crossing asks again, once');
  });
});

test('w1109: the 5-hour meter crosses too; an unpinned dispatcher or no reading asks nobody', () => {
  const w = world();
  w.meters = usage(40, 95);
  w.stop.tick();
  assert.deepEqual(w.told.map((t) => t.sid).sort(), ['wA', 'wB']);
  assert.match(w.told[0].text, /is at 5-hour 95%/);

  const u = world();
  u.unpin();
  u.meters = usage(99, 99);
  u.stop.tick();
  assert.equal(u.told.length, 0, 'no pinned token, no stop line (the dispatcher is on a pool whose own caps hold it)');
  assert.deepEqual(stopMeters({ available: false, asOf: iso(NOW), models: [] }, POOL_DEFAULTS), [], 'no reading is no crossing');
});

test('w1109: a portal restart during a crossing does not ask the same workers again', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokstop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'dispatcher-stop.json');
  const a = world(file);
  a.meters = usage(96);
  a.stop.tick();
  assert.equal(a.told.length, 2);
  const b = world(file);
  b.meters = usage(96);
  b.stop.tick();
  assert.equal(b.told.length, 0, 'the crossing and who was asked survive the restart');
});

test('w1109: the stop line is a pool config key, settable and checked like the others', () => {
  assert.equal(POOL_DEFAULTS.dispatcherStop, 95);
  assert.equal(poolLimits({ vault: { pool: { dispatcherStopPercent: 90 } } }).dispatcherStop, 90);
  assert.equal(poolLimits({ vault: { pool: { dispatcherStopPercent: 900 } } }).dispatcherStop, 95, 'out of range is the default');
  assert.equal(checkPoolConfig({ dispatcherStopPercent: 97 }), undefined);
  assert.match(checkPoolConfig({ dispatcherStopPercent: 101 }) ?? '', /percent from 0 to 100/);
  assert.equal(stopMeters(usage(89), poolLimits({ vault: { pool: { dispatcherStopPercent: 90 } } })).length, 0);
  assert.equal(stopMeters(usage(90), poolLimits({ vault: { pool: { dispatcherStopPercent: 90 } } })).length, 1);
});

test('w1109: no new worker is placed on the dispatcher\'s token at the stop line, even where the reserve buffer is smaller', () => {
  // Half a day before the weekly reset the buffer is 2.5% (5% a day), so weekly 96% is outside it: before w1109 the token was
  // one-at-a-time with its slot free (the dispatcher takes no slot), and a worker could start on it.
  const t = (weekly: number, others = 0): PoolToken => {
    const u = usage(weekly, 10, 0.5);
    return { id: 'disp', name: 'disp', fingerprint: 'disp', owner: 'lothsahn', usage: u, others, reserve: reserveOf(u, POOL_DEFAULTS, NOW), reserveFor: 'the dispatcher' };
  };
  const before = { ...POOL_DEFAULTS, dispatcherStop: 101 };
  const u96 = usage(96, 10, 0.5);
  const old = judge({ ...t(96), reserve: reserveOf(u96, before, NOW) }, before, NOW);
  assert.equal(old.state, 'one-at-a-time', 'the gap this closes');
  assert.equal(old.slotTaken, false);
  const r = reserveOf(u96, POOL_DEFAULTS, NOW);
  assert.equal(r.weeklyIn, false, 'outside the 2.5% buffer');
  assert.equal(r.stopWeekly, true);
  assert.equal(r.inReserve, true);
  assert.equal(r.until, iso(NOW + 0.5 * DAY), 'held until the weekly reset');
  assert.match(reserveReason(r, u96, NOW), /^weekly 96% \(stop line 95%\), resets in 12 h$/);
  assert.equal(judge(t(96), POOL_DEFAULTS, NOW).state, 'reserved');
  // A worker is held; the person's own orchestrator still uses it when nothing else has room (the reserve's rule, unchanged).
  assert.ok(pickPool([t(96)], { orchestrator: false, limits: POOL_DEFAULTS, now: NOW }).held);
  assert.equal(pickPool([t(96)], { orchestrator: true, limits: POOL_DEFAULTS, now: NOW }).how, 'in-reserve');
  // Another token of the person with room takes the worker.
  const spare: PoolToken = { id: 'spare', name: 'spare', fingerprint: 'spare', owner: 'lothsahn', usage: usage(30, 10, 3), others: 0 };
  assert.equal(pickPool([t(96), spare], { orchestrator: false, limits: POOL_DEFAULTS, now: NOW }).token?.id, 'spare');
  // Below the line nothing changes.
  assert.equal(judge(t(94), POOL_DEFAULTS, NOW).state, 'ok');
});

test('w1109: the stop message says how to save, what happens to the request and when it is interrupted', () => {
  const m = stopMessage({ token: NAME, meters: 'weekly 96%', line: 95, owner: 'lothsahn', requests: ['w12', 'w13'], resets: 'Tue 14:00Z', interruptAt: '12:15Z' });
  assert.match(m, /w12, w13 are Blocked on that token's limit/);
  assert.match(m, /or after the reset \(Tue 14:00Z\)/);
  assert.match(m, /Do not set a wake_me/);
  assert.match(m, /still mid-turn at 12:15Z you are interrupted/);
});

// ---------------------------------------------------------------- with the real ledger and Agents

const PEOPLE: UserInfo[] = [
  { userId: 'ben', displayName: 'Ben', role: 'owner' },
  { userId: 'lothsahn', displayName: 'Lothsahn', role: 'owner' },
];

function ledger(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokstop-ledger-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
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
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { store, agents };
}

test('w1109: a stopped worker\'s requests are Blocked on the token\'s limit by a gate of its own, which clears when its person\'s pool has room', (t) => {
  const { store, agents } = ledger(t);
  const o = agents.orchestrators;
  const by = { userId: 'lothsahn', displayName: 'Lothsahn' };
  // No requesters: a notice to a person's orchestrator would start a real agent session in this harness.
  const item = (id: string, sid: string, status: WorkItem['status'] = 'active'): WorkItem => ({ id, title: `${id} work`, brief: 'Do it.', priority: 'normal', keys: [], requestedBy: by, requesters: [], humanAsked: true, status, createdAt: iso(NOW), updatedAt: iso(NOW), sessionIds: [sid], overlaps: [], asks: 0, log: [] });
  store.putSession(info('wA', 'worker', KEY, 'idle'));
  store.putSession(info('wOther', 'worker', OTHER, 'idle'));
  const a = item('w1', 'wA');
  const other = item('w2', 'wOther');
  store.putWork(a);
  store.putWork(other);
  store.workSeq = 2;
  const gate = { ref: NAME, what: `the dispatcher's token ${NAME} at its stop line (weekly 96%); resumes on a token with room` };
  assert.deepEqual(o.tokenStopBlocked('wA', gate), ['w1']);
  const w1 = store.work.get('w1')!;
  assert.equal(w1.status, 'blocked', 'a usage limit is a thing: Blocked, not Queued (docs/orchestrators.md)');
  assert.equal(w1.blocked?.kind, 'usage');
  assert.equal(w1.blocked?.ref, NAME);
  assert.equal(w1.blocked?.by, 'worker wA', 'its own gate: the worker is the one resumed when it clears');
  assert.match(String(w1.log.at(-1) ?? ''), /worker wA stopped at the dispatcher's token's stop line: blocked on vault-lothsahn-1 …EAAA's usage limit/);
  assert.equal(store.work.get('w2')!.status, 'active', 'another token\'s worker\'s request is untouched');
  assert.deepEqual(o.tokenStopBlocked('wA', gate), [], 'only active requests: blocking twice does nothing');
  // The gate clears on the pool's answer (index.ts usageClear: ownerPoolServes), open while the pool cannot serve a worker.
  const f = (clear: boolean) => ({ now: NOW, work: (id: string) => store.work.get(id), usageClear: () => clear });
  assert.equal(blockerVerdict(w1.blocked!, f(false)).state, 'open');
  assert.equal(blockerVerdict(w1.blocked!, f(true)).state, 'clear');
});

test('w1109: between turns, a worker whose process runs on the stopped token restarts on another before its next message; mid-turn it is left alone', (t) => {
  const { agents } = ledger(t);
  agents.tokenStopped = (account) => (account === KEY ? NAME : undefined);
  const move = (i: SessionInfo, live = true) => (agents as unknown as { accountMove(s: SessionHandle): string | undefined }).accountMove({ info: { ...i, machineId: 'lothdesktop' }, live } as unknown as SessionHandle);
  assert.match(move(info('wA', 'worker', KEY, 'idle')) ?? '', /runs on the dispatcher's token vault-lothsahn-1 …EAAA, which is at its stop line, so it restarts on a token with room/);
  assert.equal(move(info('wA', 'worker', KEY, 'running')), undefined, 'mid-turn: the stop message must reach the running process');
  assert.equal(move(info('wA', 'worker', OTHER, 'idle')), undefined, 'another token');
  assert.equal(move(info('wA', 'worker', KEY, 'idle'), false), undefined, 'no live process: the next start picks a token anyway');
  agents.tokenStopped = () => undefined;
  assert.equal(move(info('wA', 'worker', KEY, 'idle')), undefined, 'below the line');
});
