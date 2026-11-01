import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, poolHeld, type SessionHandle } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { Waker } from './wake.ts';
import { PoolHeldError, Vault, fingerprintOf, newKeyText, type KeySource, type VaultContext } from './vault.ts';
import { machineRunEnv } from './secrets.ts';
import { holdReason } from './placement.ts';
import { poolForRef } from './usageGate.ts';
import { outOfPool, poolLimits } from './tokenPool.ts';
import { agentState } from '../shared/agentState.ts';
import type { Config } from './config.ts';
import type { PlanUsage, SessionInfo, UserInfo } from '../shared/types.ts';

// w1375 (Ben, 2026-10-15): "Resuming a worker whose vault account is retired must move it to the person's usable account, not loop".
// w1376 (Ben, 2026-10-15): "dont use the m5 i need to shut it down", yet workers resumed and ran there.
// Every resume (a limit or restart resume, the ledger cleanup, a CI or blocker unblock, a dispatch, message_agent, a check-in)
// is one SessionManager.send, so the two rules sit there: Agents.accountMove (the account) and Agents.machineHold (the hold).

const NOW = Date.parse('2026-10-15T13:15:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PEOPLE: UserInfo[] = [{ userId: 'ben', displayName: 'Ben', role: 'owner' }];

const usage = (session: number, weekly: number, weeklyDays = 4): PlanUsage => ({
  available: true,
  asOf: iso(NOW),
  models: [],
  session: { label: '5-hour', percent: session, resetsAt: iso(NOW + 3 * 3_600_000) },
  weekly: { label: 'weekly', percent: weekly, resetsAt: iso(NOW + weeklyDays * DAY) },
});

// ---------------------------------------------------------------- w1375: the pool rule on a resume

const claudeTok = (c: string) => `sk-ant-oat01-${c.repeat(48)}`;
const B2 = claudeTok('b');
const B3 = claudeTok('c');

function benVault(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const vault = new Vault({ file: path.join(dir, 'vault.json'), key: (): KeySource => ({ file: keyFile }) });
  vault.add({ name: 'vault-ben-2', kind: 'claude', value: B2, owner: 'ben', share: 'owner' });
  vault.add({ name: 'vault-ben-3', kind: 'claude', value: B3, owner: 'ben', share: 'owner' });
  const meters: Record<string, PlanUsage | undefined> = {};
  const ctx: VaultContext = { vault, usageOf: (fp) => meters[fp], liveOn: () => 0, now: () => NOW, payer: () => 'ben' };
  const on = (token: string, u: PlanUsage) => void (meters[fingerprintOf(token)] = u);
  return { vault, ctx, on };
}

test('w1375: a worker whose saved account is retired resumes on the person\'s usable account; no token keeps it queued on the pool, never a loop', (t) => {
  const { ctx, on } = benVault(t);
  const resume = (sid: string) => machineRunEnv({ machines: [] } as never, { id: 'lothdesktop' } as never, { role: 'workers', requestedBy: { userId: 'ben', displayName: 'Ben' }, sessionId: sid }, ctx);
  // The worker started on vault-ben-3 (the best score: most headroom), and kept it while it still passed.
  on(B2, usage(0, 40, 4));
  on(B3, usage(10, 20, 2));
  const first = resume('19939b45');
  assert.match(first.account, /vault token vault-ben-3 …/);
  assert.match(resume('19939b45').account, /vault-ben-3/, 'a token that still passes is kept (sticky)');
  // 2026-10-15: vault-ben-3 reached its weekly limit (retired until Mon 05:00Z). The resume does not reuse it.
  on(B3, usage(2, 100, 4));
  const retired = resume('19939b45');
  assert.match(retired.account, /vault token vault-ben-2 …/, 'saved account at its weekly limit: the usable account');
  assert.equal(retired.env.CLAUDE_CODE_OAUTH_TOKEN, B2);
  on(B3, usage(2, 99.4, 4));
  assert.match(resume('b2').account, /vault-ben-2/, 'retired (weekly 99 and over) is skipped for a worker never on it too');
  assert.match(resume('19939b45').account, /vault-ben-2/, 'and it stays on the usable one');
  // Both accounts at a limit: the start is held on the pool (queued, then goes when a token frees), as a new job.
  on(B2, usage(0, 100, 3));
  let err: unknown;
  try {
    resume('19939b45');
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof PoolHeldError, 'no usable account: the pool holds the worker');
  assert.ok(poolHeld(err), 'the send queue waits for the pool (on: pool) instead of failing');
});

test("w1375: a person's pool answers a ledger-cleanup or usage-gate resume by its pick, not by the account that hit its limit", () => {
  const view = (state: 'ok' | 'retired' | 'exhausted') => ({ state, until: iso(NOW + DAY) });
  const tokens = (b2: 'ok' | 'retired' | 'exhausted', b3: 'ok' | 'retired' | 'exhausted') => [
    { name: 'vault-ben-2', last4: 'dAAA', priority: b2 === 'ok', view: view(b2) },
    { name: 'vault-ben-3', last4: 'CAAA', priority: false, view: view(b3) },
  ];
  assert.equal(poolForRef('ben', [['ben', tokens('ok', 'retired')]])?.serves, true, 'ben-3 retired, ben-2 usable: a worker cut off on ben-3 may resume');
  assert.equal(poolForRef('ben', [['ben', tokens('retired', 'exhausted')]])?.serves, false, 'nothing usable: it does not resume, so it cannot loop');
});

const KEY3 = `token:${fingerprintOf(B3)}`;
const KEY2 = `token:${fingerprintOf(B2)}`;
const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, kind: 'worker', title: id, status: 'idle', machineId: 'lothdesktop', machineSandbox: 'slot6', account: KEY3, permissionMode: 'default', createdAt: iso(NOW), lastActivityAt: iso(NOW), turns: 1, costUsd: 0, pendingPermissions: [], ...over }) as SessionInfo;

/** A session handle that records what was sent to it and whether it was stopped. */
function fake(i: SessionInfo, live = true) {
  const h = {
    info: i,
    live,
    lastFrom: 'system' as const,
    sent: [] as string[],
    stops: 0,
    send(text: string) {
      h.sent.push(text);
      return 'sent';
    },
    interrupt: async () => {},
    setMode: async () => {},
    stop() {
      h.stops++;
      h.live = false;
    },
  };
  return h;
}

function world(t: { after: (fn: () => void | Promise<void>) => void }, placement?: Config['placement']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-rules-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'master',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    ...(placement ? { placement } : {}),
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
  const add = (i: SessionInfo, live = true) => {
    const h = fake(i, live);
    sessions.adopt(h as unknown as SessionHandle);
    return h;
  };
  return { cfg, store, sessions, agents, add, dir };
}

test('w1375: a live worker on a retired or used-up account restarts on the usable one before any message (limit, restart, cleanup, dispatch, check-in all send)', (t) => {
  const { agents, sessions, add } = world(t);
  const bad = new Set<string>([KEY3]);
  agents.tokenUnusable = (account) => (bad.has(account) ? `vault token vault-ben-3 …CAAA (weekly 100%: used up until Mon 05:00Z)` : undefined);
  const idle = add(info('w-idle'));
  const queued = sessions.send('w-idle', '[ledger cleanup] carry on', 'system');
  assert.equal(idle.stops, 1, 'idle on a retired account: its process is stopped, so the next start picks the pool\'s account');
  assert.equal(idle.sent.length, 0, 'the message waits for the new process, it does not run on the retired account');
  assert.match(sessions.queued()[0].why, /runs on vault token vault-ben-3 …CAAA.*restarts on its person's usable account/);
  assert.equal(sessions.queued()[0].uuid, queued);
  // The process is gone: the same message is delivered, and the new process starts on the pool's pick (machineRunEnv, above).
  assert.equal(sessions.drain(), 1);
  assert.equal(idle.sent.length, 1);

  const mid = add(info('w-mid', { status: 'running' }));
  sessions.send('w-mid', 'a stop-and-save request', 'system');
  assert.equal(mid.stops, 0, 'mid-turn the message reaches the running process (it ends on its own, then moves)');
  assert.equal(mid.sent.length, 1);
  const other = add(info('w-other', { account: KEY2 }));
  sessions.send('w-other', 'hello', 'human');
  assert.equal(other.sent.length, 1, 'a usable account is left alone');
  assert.equal(other.stops, 0);
  const busy = add(info('w-bg', { backgroundTasks: 1 } as Partial<SessionInfo>));
  sessions.send('w-bg', 'hello', 'human');
  assert.equal(busy.stops, 0, 'a background build is not killed for it');
  bad.clear();
  const ok = add(info('w-ok'));
  sessions.send('w-ok', 'hello', 'human');
  assert.equal(ok.sent.length, 1, 'once the account passes again nothing moves');
});

// ---------------------------------------------------------------- w1376: a hold stops resumes there

const HOLD = { m5: 'Ben, dont use the m5 i need to shut it down, 2026-10-15' };

test('w1376: holdReason names the hold of a computer whatever the case of its id, and nothing for a computer that is not held', () => {
  assert.match(holdReason('m5', { hold: HOLD }) ?? '', /^m5 is on hold \(Ben, dont use the m5.*\): nothing resumes there until the hold is lifted/);
  assert.match(holdReason('M5', { hold: HOLD }) ?? '', /on hold/);
  assert.equal(holdReason('lothdesktop', { hold: HOLD }), undefined);
  assert.equal(holdReason('m5', {}), undefined);
  assert.equal(holdReason('m5'), undefined);
});

test('w1376: every resume path (dispatch, cleanup, CI/blocker unblock, limit or restart resume, message_agent, check-in) waits when its computer is on hold, Blocked on its machine', (t) => {
  const { sessions, store, agents, add } = world(t, { hold: HOLD });
  const paths: { path: string; from: 'human' | 'orchestrator' | 'system'; opts?: Parameters<SessionManager['send']>[4] }[] = [
    { path: 'dispatch follow-up (dispatcher message)', from: 'orchestrator' },
    { path: 'ledger cleanup revival', from: 'system' },
    { path: 'CI / blocker unblock (resumeOf)', from: 'system', opts: { resumeOf: { work: 'w1262', note: 'CI finished' } } },
    { path: 'limit or restart resume (host guard, bypassGate)', from: 'system', opts: { bypassGate: true } },
    { path: 'message_agent', from: 'human', opts: { requestedBy: { userId: 'ben', displayName: 'Ben' } } },
    { path: 'wake_me check-in', from: 'system', opts: { ops: 'wake' } },
  ];
  // The live idle worker (the process stays up) and the stopped one (a send would start a process on the m5).
  for (const live of [true, false]) {
    for (const p of paths) {
      const id = `${live ? 'live' : 'stopped'}-${paths.indexOf(p)}`;
      const h = add(info(id, { machineId: 'm5', status: live ? 'idle' : 'stopped', account: KEY2 }), live);
      if (p.opts?.resumeOf) agents.orchestrators.staleResume = () => undefined;
      const uuid = sessions.send(id, `resume via ${p.path}`, p.from, undefined, p.opts);
      assert.equal(h.sent.length, 0, `${p.path} (${live ? 'live' : 'stopped'}): nothing runs on the held m5`);
      const q = sessions.queued().find((x) => x.uuid === uuid);
      assert.ok(q, `${p.path}: the message stays queued`);
      assert.equal(q!.on, 'machine');
      assert.match(q!.why, /^m5 is on hold \(Ben, dont use the m5/);
      assert.equal(h.stops, 0, 'a held computer restarts nothing either');
    }
  }
  agents.syncWaiting();
  const worker = store.sessions.get('live-0')!;
  assert.equal(worker.queuedOn, 'machine');
  const view = agentState(worker);
  assert.equal(view.label, 'Blocked', 'the request reads Blocked on its machine, not Working or Queued for a slot');
  assert.match(view.waitsOn ?? '', /m5 is on hold/);
});

test('w1376: a worker mid-turn on a held computer, and a worker on another computer, are not held', (t) => {
  const { sessions, add } = world(t, { hold: HOLD });
  const mid = add(info('mid', { machineId: 'm5', status: 'running' }));
  sessions.send('mid', 'save your work and stop', 'system');
  assert.equal(mid.sent.length, 1, 'a message to a running turn must reach it');
  const elsewhere = add(info('else', { machineId: 'lothdesktop', account: KEY2 }));
  sessions.send('else', 'resume', 'system');
  assert.equal(elsewhere.sent.length, 1);
});

test('w1376: the queued resume goes once the hold is lifted, and the check-in that fired during the hold is kept', async (t) => {
  const { sessions, cfg, add, store } = world(t, { hold: HOLD });
  const h = add(info('held-worker', { machineId: 'm5', status: 'idle', account: KEY2 }));
  const waker = new Waker(sessions, store);
  waker.schedule('held-worker', 1, 'check CI');
  (waker as unknown as { fire(id: string, tries: number): void }).fire('held-worker', 0);
  assert.equal(h.sent.length, 0, 'the check-in does not wake a worker on a held computer');
  assert.equal(sessions.queued().length, 1);
  assert.equal(sessions.drain(), 0, 'still held: the queue keeps it, with no give-up while the hold stands');
  assert.match(sessions.queued()[0].why, /m5 is on hold/);
  // Ben lifts the hold (set_app_config placement.hold null): the next drain delivers it.
  delete cfg.placement!.hold;
  assert.equal(sessions.drain(), 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /\[wake_me\] Time is up.*check CI/);
  assert.equal(sessions.queued().length, 0);
});

// ---------------------------------------------------------------- w1863: a hold may let named requests through

// lothsahn, 2026-10-23: "stop all work on LothDesktop except w1785 until it's done". The hold set for it at 15:15 queued a
// message to w1785's own worker dec9a619 ("lothdesktop is on hold … nothing resumes there until the hold is lifted").
const LOTH_HOLD = { lothdesktop: "lothsahn: w1785 timing runs, \"stop all work on LothDesktop except w1785 until it's done\"" };
const workOn = (id: string, session: string) => ({ id, title: `Request ${id}`, brief: 'Do it.', priority: 'normal' as const, keys: [], requestedBy: PEOPLE[0], requesters: [PEOPLE[0]], humanAsked: true, status: 'active' as const, createdAt: iso(NOW), updatedAt: iso(NOW), sessionIds: [session], overlaps: [], asks: 0, log: [] });

test('w1863: holdReason lets a request the hold names through, and nothing else; a plain hold still holds everyone (w1376)', () => {
  const prefs = { hold: LOTH_HOLD, holdExcept: { lothdesktop: ['w1785'] } };
  assert.equal(holdReason('lothdesktop', prefs, ['w1785']), undefined);
  assert.equal(holdReason('LothDesktop', prefs, ['W1785', 'w1826']), undefined, 'any request of its worker the hold names');
  assert.match(holdReason('lothdesktop', prefs, ['w1826']) ?? '', /^lothdesktop is on hold \(lothsahn: w1785 timing runs, .*; except w1785\): nothing resumes there/);
  assert.match(holdReason('lothdesktop', prefs) ?? '', /on hold/);
  assert.match(holdReason('lothdesktop', { hold: LOTH_HOLD }, ['w1785']) ?? '', /on hold/, 'without except, w1376 as before');
});

test('w1863: on a computer held except w1785, a message to w1785’s own worker goes, one to another worker there waits Blocked on the machine', (t) => {
  const { sessions, store, add } = world(t, { hold: LOTH_HOLD, holdExcept: { lothdesktop: ['w1785'] } });
  store.putWork(workOn('w1785', 'dec9a619'));
  store.putWork(workOn('w1826', 'd0ea49a2'));
  const own = add(info('dec9a619', { machineId: 'lothdesktop', status: 'idle', account: KEY2 }));
  const other = add(info('d0ea49a2', { machineId: 'lothdesktop', status: 'idle', account: KEY2 }));
  for (const [opts, from] of [[undefined, 'orchestrator'], [{ ops: 'wake' as const }, 'system']] as const) {
    sessions.send('dec9a619', 'carry on with the A/B', from, undefined, opts);
    sessions.send('d0ea49a2', 'carry on', from, undefined, opts);
  }
  assert.equal(own.sent.length, 2, "w1785's worker gets its dispatch and its check-in");
  assert.equal(other.sent.length, 0);
  const q = sessions.queued().filter((x) => x.id === 'd0ea49a2');
  assert.equal(q.length, 2);
  assert.ok(q.every((x) => x.on === 'machine' && /^lothdesktop is on hold \(.*except w1785\)/.test(x.why)));
});

test('w2785: a token at its own weekly cap (vault-ben-3 at 90%) gets no new work; a worker on it moves at its next turn; it comes back after its weekly reset', (t) => {
  const { vault, ctx, on } = benVault(t);
  const limits = poolLimits({ vault: { pool: { weeklyCapPercent: { 'vault-ben-3': 90 } } } });
  const capped: VaultContext = { ...ctx, limits: () => limits };
  const resume = (sid: string) => machineRunEnv({ machines: [] } as never, { id: 'lothdesktop' } as never, { role: 'workers', requestedBy: { userId: 'ben', displayName: 'Ben' }, sessionId: sid }, capped);
  // Under its cap vault-ben-3 serves as before (its weekly window resets first, so the pick takes it).
  on(B2, usage(0, 40, 4));
  on(B3, usage(0, 89.9, 2));
  assert.match(resume('w-cap').account, /vault-ben-3/, 'below the cap: no change');
  // At the cap: no new work, and the worker that ran on it resumes on vault-ben-2.
  on(B3, usage(0, 90, 2));
  assert.match(resume('w-new').account, /vault-ben-2/, 'a new job never gets the capped token');
  assert.match(resume('w-cap').account, /vault-ben-2/, 'the worker that ran on it is not kept there (sticky does not hold a capped token)');
  // The move between turns: Agents.accountMove reads tokenUnusable, built from the pool's views as server/index.ts builds it.
  const unusable = (account: string) => {
    for (const list of vault.pools({ usageOf: ctx.usageOf, now: () => NOW, limits: () => limits }).values())
      for (const x of list) if (`token:${x.entry.fingerprint}` === account && outOfPool(x.view)) return `vault token ${x.entry.name} …${x.entry.last4} (${x.view.why})`;
    return undefined;
  };
  assert.match(unusable(KEY3) ?? '', /weekly 90% \(cap 90%\): retired until/);
  assert.equal(unusable(KEY2), undefined);
  const { agents, sessions, add } = world(t);
  agents.tokenUnusable = unusable;
  const idle = add(info('w-on-ben-3'));
  sessions.send('w-on-ben-3', 'carry on', 'system');
  assert.equal(idle.stops, 1, 'idle on the capped token: its process stops, so the next start picks vault-ben-2');
  assert.match(sessions.queued()[0].why, /vault-ben-3 .*cap 90%.*restarts on its person's usable account/);
  // Without a cap the same 90% is an ordinary token (today's behaviour).
  assert.match(machineRunEnv({ machines: [] } as never, { id: 'lothdesktop' } as never, { role: 'workers', requestedBy: { userId: 'ben', displayName: 'Ben' }, sessionId: 'w-nocap' }, ctx).account, /vault-ben-3/, 'no cap: 90% weekly still serves');
  // The weekly reset: the reading falls below the cap and the token takes work again.
  on(B3, usage(0, 3, 7));
  on(B2, usage(0, 100, 4));
  assert.match(resume('w-after').account, /vault-ben-3/, 'after its reset vault-ben-3 takes new work again');
  assert.equal(unusable(KEY3), undefined, 'after the reset it is usable again');
});
