import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { addSpend, admit, advanceSchedule, dayKey, MAX_WAIT_MS, nextCron, normalizeBudget, runCap, triggerProblem, waitDeadline } from './schedule.ts';
import { StandingAgents, type SessionLike, type SessionPort } from './standing.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';

const at = (s: string) => new Date(s); // local time: no "Z"

// ---------------------------------------------------------------- schedule (pure)

test('cron: next match, lists, ranges, steps, day-of-week', () => {
  assert.deepEqual(nextCron('*/15 * * * *', at('2026-09-23T10:07:30')), at('2026-09-23T10:15:00'));
  assert.deepEqual(nextCron('0 9 * * *', at('2026-09-23T09:00:00')), at('2026-09-24T09:00:00'), 'strictly after');
  assert.deepEqual(nextCron('0 9 * * 1-5', at('2026-09-25T10:00:00')), at('2026-09-28T09:00:00'), 'Friday 10:00 -> Monday 09:00');
  assert.deepEqual(nextCron('30 8,20 * * *', at('2026-09-23T09:00:00')), at('2026-09-23T20:30:00'));
  assert.deepEqual(nextCron('0 0 1 * *', at('2026-12-15T00:00:00')), at('2027-01-01T00:00:00'), 'rolls the year');
  assert.deepEqual(nextCron('0 12 * * 7', at('2026-09-23T00:00:00')), at('2026-09-27T12:00:00'), '7 is Sunday');
  // Both day fields restricted: either matches (the 1st, or any Monday).
  assert.deepEqual(nextCron('0 0 1 * 1', at('2026-09-23T00:00:00')), at('2026-09-28T00:00:00'));
});

test('cron: bad expressions are refused with a reason', () => {
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', 'x * * * *', '5-1 * * * *', '0 0 31 2 *']) {
    assert.ok(triggerProblem({ kind: 'cron', expr: bad }), bad);
  }
  assert.equal(triggerProblem({ kind: 'cron', expr: '0 9 * * 1-5' }), undefined);
  assert.ok(triggerProblem({ kind: 'interval', minutes: 2 }), 'interval floor');
  assert.equal(triggerProblem({ kind: 'interval', minutes: 30 }), undefined);
  assert.equal(triggerProblem({ kind: 'manual' }), undefined);
});

test('schedule: an interval keeps its phase, and a long outage catches up with ONE run', () => {
  const t = { kind: 'interval' as const, minutes: 30 };
  assert.deepEqual(advanceSchedule(t, at('2026-09-23T10:00:00'), at('2026-09-23T10:00:05')), at('2026-09-23T10:30:00'));
  // Server down from 10:00 to 13:10: next slot is 13:30, not 10:30 (which would fire at once, then again…).
  assert.deepEqual(advanceSchedule(t, at('2026-09-23T10:00:00'), at('2026-09-23T13:10:00')), at('2026-09-23T13:30:00'));
  assert.deepEqual(advanceSchedule({ kind: 'cron', expr: '0 * * * *' }, at('2026-09-23T10:00:00'), at('2026-09-23T13:10:00')), at('2026-09-23T14:00:00'));
  assert.equal(advanceSchedule({ kind: 'manual' }, at('2026-09-23T10:00:00'), at('2026-09-23T10:00:00')), undefined);
});

test('budget: the daily spend rolls over at local midnight and caps the run', () => {
  const budget = { perRunUsd: 2, perDayUsd: 5, maxMinutes: 30 };
  let spend = addSpend({ day: '', usd: 0 }, 1.5, at('2026-09-23T10:00:00'));
  spend = addSpend(spend, 2.25, at('2026-09-23T23:59:00'));
  assert.deepEqual(spend, { day: '2026-09-23', usd: 3.75 });
  assert.equal(runCap({ budget, spend }, at('2026-09-23T23:59:30')), 1.25, 'what is left today, below the per-run cap');
  assert.equal(runCap({ budget, spend }, at('2026-09-24T00:00:10')), 2, 'a new day: the per-run cap again');
  assert.equal(dayKey(at('2026-09-24T00:00:10')), '2026-09-24');
  assert.deepEqual(addSpend(spend, 1, at('2026-09-24T08:00:00')), { day: '2026-09-24', usd: 1 });
});

test('admission: no overlap, daily budget, and the agent limit (wait, then skip at the deadline)', () => {
  const agent = { budget: { perRunUsd: 2, perDayUsd: 5, maxMinutes: 30 }, spend: { day: '2026-09-23', usd: 1 } };
  const now = at('2026-09-23T10:00:00');
  const deadline = at('2026-09-23T10:30:00');
  const base = { agent, now, busy: false, liveAgents: 3, maxAgents: 6, deadline };
  assert.deepEqual(admit(base), { action: 'start', capUsd: 2 });
  assert.equal(admit({ ...base, busy: true }).action, 'skip');
  assert.equal(admit({ ...base, agent: { ...agent, spend: { day: '2026-09-23', usd: 4.99 } } }).action, 'skip', 'under MIN_RUN_USD left');
  assert.equal(admit({ ...base, liveAgents: 6 }).action, 'wait');
  assert.equal(admit({ ...base, liveAgents: 6, now: deadline }).action, 'skip');
});

test('wait deadline: the next scheduled slot, or an hour, whichever is sooner', () => {
  const from = at('2026-09-23T10:00:00');
  assert.deepEqual(waitDeadline(at('2026-09-23T10:15:00'), from), at('2026-09-23T10:15:00'));
  assert.deepEqual(waitDeadline(at('2026-09-23T15:00:00'), from), new Date(from.getTime() + MAX_WAIT_MS));
  assert.deepEqual(waitDeadline(undefined, from), new Date(from.getTime() + MAX_WAIT_MS));
});

test('budget input: defaults, partial updates, and nonsense refused', () => {
  assert.deepEqual(normalizeBudget(undefined), { perRunUsd: 2, perDayUsd: 10, maxMinutes: 45 });
  assert.deepEqual(normalizeBudget({ perDayUsd: 20 }, { perRunUsd: 3, perDayUsd: 10, maxMinutes: 30 }), { perRunUsd: 3, perDayUsd: 20, maxMinutes: 30 });
  assert.throws(() => normalizeBudget({ perRunUsd: 5, perDayUsd: 4 }));
  assert.throws(() => normalizeBudget({ perRunUsd: -1 }));
  assert.throws(() => normalizeBudget({ maxMinutes: 0 }));
});

// ---------------------------------------------------------------- the manager, on a fake session layer

class FakeSession implements SessionLike {
  info: SessionInfo;
  live = false;
  sent: string[] = [];
  private readonly port: FakePort;
  constructor(info: SessionInfo, port: FakePort) {
    this.info = info;
    this.port = port;
  }
  stop() {
    if (!this.live) return;
    this.live = false;
    this.info.status = 'stopped';
    this.port.events.emit('ended', this);
  }
  /** The run's turn ends with `text`, having cost `usd` more. */
  finishTurn(text: string, usd: number, subtype = 'success') {
    this.info.costUsd += usd;
    this.port.events.emit('result', this, subtype);
    if (!this.live) return;
    this.info.status = 'idle';
    this.port.events.emit('turnEnd', this, text);
  }
}

class FakePort implements SessionPort {
  readonly events = new EventEmitter();
  readonly all = new Map<string, FakeSession>();
  /** Live workers elsewhere on the machine. */
  others = 0;
  max = 2;
  private n = 0;
  create(opts: Parameters<SessionPort['create']>[0]) {
    const now = new Date().toISOString();
    const info: SessionInfo = { id: `s${++this.n}`, kind: opts.kind, standingId: opts.standingId, title: opts.title, status: 'stopped', model: opts.model, permissionMode: opts.permissionMode, createdAt: now, lastActivityAt: now, turns: 0, costUsd: 0, pendingPermissions: [] };
    const s = new FakeSession(info, this);
    this.all.set(info.id, s);
    return s;
  }
  get(id: string) {
    const s = this.all.get(id);
    if (!s) throw new Error(`no session "${id}"`);
    return s;
  }
  send(id: string, text: string) {
    const s = this.get(id);
    if (!s.live && this.liveAgents() >= this.max) throw new Error('limit');
    s.live = true;
    s.info.status = 'running';
    s.sent.push(text);
    return 'uuid';
  }
  liveAgents() {
    return this.others + [...this.all.values()].filter((s) => s.live).length;
  }
  remove(id: string) {
    this.get(id).stop();
    this.all.delete(id);
  }
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-standing-'));
  const cfg = {
    dataDir: path.join(tmp, 'data'),
    sandboxRoot: path.join(tmp, 'sb'),
    standingRoot: path.join(tmp, 'sb', '_agents'),
    protectedPaths: [],
    repo: { url: 'https://github.com/example-org/example-game.git', basePath: path.join(tmp, 'sb', '_base') },
    limits: { maxUnity: 1, maxSessions: 2, maxSandboxes: 1, minFreeGB: 1 },
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    worker: { permissionMode: 'bypassPermissions', effort: 'high' },
  } as unknown as Config;
  const store = new Store(cfg.dataDir);
  const port = new FakePort();
  const clock = { now: at('2026-09-23T10:00:00') };
  const notes: string[] = [];
  const st = new StandingAgents({
    cfg,
    store,
    sessions: port,
    notify: (t) => notes.push(t),
    sandboxes: { list: () => [], setPurpose: () => ({}) as never },
    startWorker: () => ({ info: {} as SessionInfo }),
    now: () => clock.now,
  });
  const advance = (min: number) => (clock.now = new Date(clock.now.getTime() + min * 60_000));
  return { st, store, port, clock, advance, notes, cleanup: () => (store.flush(), fs.rmSync(tmp, { recursive: true, force: true })) };
}

const def = { name: 'PR Watcher', charter: 'Watch things.', trigger: { kind: 'interval' as const, minutes: 30 }, budget: { perRunUsd: 1, perDayUsd: 2.5, maxMinutes: 20 } };

test('manager: a scheduled run starts at its slot, sleeps after its turn, and books the spend', (t) => {
  const { st, port, advance, cleanup } = setup();
  t.after(cleanup);
  const a = st.create(def);
  assert.equal(a.id, 'pr-watcher');
  assert.ok(fs.existsSync(path.join(a.folder, 'NOTES.md')), 'folder and notes seeded');
  assert.equal(a.nextRunAt, at('2026-09-23T10:30:00').toISOString());
  const s = port.get(a.sessionId);

  advance(29);
  st.tick();
  assert.equal(s.live, false, 'not due yet');

  advance(1);
  st.tick();
  assert.equal(s.live, true);
  assert.equal(st.require(a.id).state, 'running');
  assert.match(s.sent[0], /^\[run \w+\] .*scheduled \(every 30 min\)/);
  assert.match(s.sent[0], /this run stops at \$1\.00/);
  assert.equal(st.require(a.id).nextRunAt, at('2026-09-23T11:00:00').toISOString());

  s.finishTurn('Reviewed 2 PRs\nDetails…', 0.4);
  const after = st.require(a.id);
  assert.equal(s.live, false, 'asleep between runs: the process is stopped');
  assert.equal(after.state, 'asleep');
  const run = after.runs.at(-1)!;
  assert.equal(run.outcome, 'ok');
  assert.equal(run.costUsd, 0.4);
  assert.match(run.summary!, /^Reviewed 2 PRs/);
  assert.equal(after.spend.usd, 0.4);
});

test('manager: no overlap — a slot that comes due mid-run is skipped, and Run now refuses', (t) => {
  const { st, port, advance, cleanup } = setup();
  t.after(cleanup);
  const a = st.create({ ...def, budget: { ...def.budget, maxMinutes: 60 } });
  st.runNow(a.id);
  const s = port.get(a.sessionId);
  assert.equal(s.sent.length, 1);
  assert.throws(() => st.runNow(a.id), /already running/);

  advance(30);
  st.tick();
  assert.equal(s.sent.length, 1, 'no second run message');
  const runs = st.require(a.id).runs;
  assert.equal(runs.at(-1)!.outcome, 'skipped');
  assert.match(runs.at(-1)!.summary!, /previous run still going/);
  assert.equal(runs.filter((r) => r.outcome === 'running').length, 1);

  // A message from the user mid-run joins the run instead of starting another.
  assert.match(st.runNow(a.id, 'message', 'also check #12'), /Added to the run/);
  assert.equal(s.sent.at(-1), 'also check #12');
});

test('manager: with every agent slot taken a run waits, starts when one frees, or is skipped at its deadline', (t) => {
  const { st, port, advance, cleanup } = setup();
  t.after(cleanup);
  const a = st.create(def);
  const s = port.get(a.sessionId);
  port.others = 2; // the limit is 2

  assert.match(st.runNow(a.id), /Waiting/);
  assert.equal(st.require(a.id).state, 'waiting');
  assert.equal(s.live, false);
  assert.throws(() => st.runNow(a.id), /already has a run waiting/);

  advance(5);
  port.others = 1;
  st.tick();
  assert.equal(s.live, true, 'started once a slot freed');
  s.finishTurn('done', 0.1);

  // Next: the 10:30 slot waits and gives up when the 11:00 slot comes due (sooner than an hour).
  port.others = 2;
  advance(25); // 10:30
  st.tick();
  assert.equal(st.require(a.id).state, 'waiting');
  advance(30); // 11:00: the 10:30 run is skipped and the 11:00 one takes its place
  st.tick();
  const runs = st.require(a.id).runs;
  assert.equal(runs.at(-1)!.outcome, 'skipped');
  assert.match(runs.at(-1)!.summary!, /no free agent slot/);
  assert.equal(st.require(a.id).pending?.dueAt, at('2026-09-23T11:00:00').toISOString());
  assert.equal(s.live, false);
});

test('manager: budgets — the run cap reaches the SDK, a run over it is stopped, a spent day skips', (t) => {
  const { st, port, advance, cleanup } = setup();
  t.after(cleanup);
  const a = st.create(def);
  const s = port.get(a.sessionId);
  st.runNow(a.id);
  assert.equal(st.options(s.info).maxBudgetUsd, 1, 'per-run cap passed as maxBudgetUsd');

  s.finishTurn('partial', 1.2, 'success');
  let run = st.require(a.id).runs.at(-1)!;
  assert.equal(run.outcome, 'budget');
  assert.equal(s.live, false);
  assert.equal(st.require(a.id).spend.usd, 1.2);

  st.runNow(a.id);
  assert.equal(st.options(s.info).maxBudgetUsd, 1, 'min(per run $1, $1.30 left today)');
  s.finishTurn('stopped: error_max_budget_usd', 1.0, 'error_max_budget_usd');
  run = st.require(a.id).runs.at(-1)!;
  assert.equal(run.outcome, 'budget');
  assert.equal(Number(st.require(a.id).spend.usd.toFixed(2)), 2.2);

  st.runNow(a.id);
  assert.ok(Math.abs((st.options(s.info).maxBudgetUsd ?? 0) - 0.3) < 1e-9, 'only what is left today');
  s.finishTurn('ok', 0.3);

  // $2.50 of $2.50 spent: the next run is skipped, not started.
  assert.match(st.runNow(a.id), /Skipped: daily budget spent/);
  assert.equal(s.live, false);

  // Tomorrow the budget is back.
  advance(24 * 60);
  assert.match(st.runNow(a.id), /Started/);
});

test('manager: a run past maxMinutes is stopped as a timeout; Stop run records stopped', (t) => {
  const { st, port, advance, cleanup } = setup();
  t.after(cleanup);
  const a = st.create({ ...def, trigger: { kind: 'manual' } });
  assert.equal(a.nextRunAt, undefined, 'manual only: never scheduled');
  const s = port.get(a.sessionId);
  st.runNow(a.id);
  advance(21);
  st.tick();
  assert.equal(st.require(a.id).runs.at(-1)!.outcome, 'timeout');
  assert.equal(s.live, false);

  st.runNow(a.id);
  assert.equal(st.stop(a.id), 'Stopped.');
  assert.equal(st.require(a.id).runs.at(-1)!.outcome, 'stopped');
});

test('manager: a process that dies mid-run records an error; pause drops the schedule; boot marks a torn run interrupted', (t) => {
  const { st, store, port, advance, cleanup } = setup();
  t.after(cleanup);
  const a = st.create(def);
  const s = port.get(a.sessionId);
  st.runNow(a.id);
  s.info.statusDetail = 'CLI crashed';
  s.stop(); // not via the manager: looks like the process went away
  assert.equal(st.require(a.id).runs.at(-1)!.outcome, 'error');
  assert.match(st.require(a.id).runs.at(-1)!.summary!, /CLI crashed/);

  st.pause(a.id);
  assert.equal(st.require(a.id).state, 'paused');
  assert.equal(st.require(a.id).nextRunAt, undefined);
  advance(120);
  st.tick();
  assert.equal(s.live, false, 'paused: nothing scheduled');
  st.resume(a.id);
  assert.ok(st.require(a.id).nextRunAt);

  // Simulate a restart mid-run: the persisted run says "running".
  st.runNow(a.id);
  const fresh = new StandingAgents({
    cfg: { standingRoot: path.dirname(a.folder), limits: { maxSessions: 2 }, models: ['opus'], defaultModel: 'opus' } as unknown as Config,
    store,
    sessions: port,
    notify: () => undefined,
    sandboxes: { list: () => [], setPurpose: () => ({}) as never },
    startWorker: () => ({ info: {} as SessionInfo }),
  });
  fresh.boot();
  assert.equal(fresh.require(a.id).runs.at(-1)!.outcome, 'interrupted');
  assert.equal(fresh.require(a.id).state, 'asleep');
});

test('manager: definitions are validated', (t) => {
  const { st, cleanup } = setup();
  t.after(cleanup);
  st.create(def);
  assert.throws(() => st.create(def), /already exists/);
  assert.throws(() => st.create({ ...def, name: 'x', charter: ' ' }), /charter/);
  assert.throws(() => st.create({ ...def, name: 'y', model: 'gpt' }), /model/);
  assert.throws(() => st.create({ ...def, name: 'z', tools: ['root' as never] }), /tool group/);
  assert.throws(() => st.create({ ...def, name: 'w', trigger: { kind: 'cron', expr: 'nope' } }), /cron/);
  const u = st.update('PR Watcher', { name: 'Renamed', trigger: { kind: 'cron', expr: '0 * * * *' } });
  assert.equal(u.id, 'pr-watcher', 'the id and folder stay on rename');
  assert.equal(u.nextRunAt, at('2026-09-23T11:00:00').toISOString());
});

test('delegation: needs the tool group, notifies the orchestrator, and approval needs an unused sandbox', (t) => {
  const { st, notes, cleanup } = setup();
  t.after(cleanup);
  const plain = st.create(def);
  assert.throws(() => st.requestDelegation(plain.id, 't', 'do it'), /no delegate tool group/);
  const a = st.create({ ...def, name: 'Delegator', tools: ['delegate'] });
  const d = st.requestDelegation(a.id, 'Fix the belt', 'Fix the null ref in BeltSystem.');
  assert.equal(d.status, 'pending');
  assert.match(notes.at(-1)!, /asks for a sandbox worker/);
  assert.throws(() => st.approveDelegation(d.id), /no ready sandbox or machine labelled "unused"/);
  assert.equal(st.rejectDelegation(d.id, 'not now').status, 'rejected');
  assert.throws(() => st.rejectDelegation(d.id), /already rejected/);
});
