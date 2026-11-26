import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { PoolHeldError, Vault, fingerprintOf, newKeyText, type KeySource, type VaultContext } from './vault.ts';
import { machineRunEnv } from './secrets.ts';
import { poolForRef, type GatePoolToken } from './usageGate.ts';
import { UsageTracker, withOut } from './usage.ts';
import { TokenSwitch, dispatcherMove, dispatcherWait, orchestratorOut, refusedWindow, type DispatcherAccount, type TokenSwitchDeps } from './tokenSwitch.ts';
import type { Config } from './config.ts';
import type { PlanUsage, SessionInfo, UserInfo } from '../shared/types.ts';

// w1745 (lothsahn, 2026-10-22): "we do want to run that account out. Can we have it run the account out and then have the
// dispatcher notice and change them once out?" An agent keeps its token while it works; once Claude refuses it (or the pool
// retires it) every agent on it moves to the best token of the same person's pool at its next turn, one the limit stopped is
// resumed there, nothing mid-turn is interrupted, no token with room holds it as before, and no other person's pool is used.
// Every token here is a fake.

const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PEOPLE: UserInfo[] = [
  { userId: 'ben', displayName: 'Ben', role: 'owner' },
  { userId: 'lothsahn', displayName: 'lothsahn', role: 'owner' },
];
const fakeToken = (c: string) => `sk-ant-oat01-${c.repeat(48)}`;
const B1 = fakeToken('a');
const B2 = fakeToken('b');
const L1 = fakeToken('l');
const key = (t: string) => `token:${fingerprintOf(t)}`;
const LIMIT_LINE = "You've hit your weekly limit · resets 3am (UTC)";

const reading = (session: number, weekly: number, weeklyHours = 40): PlanUsage => ({
  available: true,
  asOf: iso(NOW),
  models: [],
  session: { label: 'Session (5 h)', percent: session, resetsAt: iso(NOW + 3 * HOUR) },
  weekly: { label: 'Weekly', percent: weekly, resetsAt: iso(NOW + weeklyHours * HOUR) },
});

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

function world(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-switch-'));
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
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    agents.close(); // w6152: Agents' timers stop before the folder goes (w5915: a release pass wrote into a removed transcript, ENOENT).
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  // The vault: Ben's two tokens and lothsahn's one, with the usage tracker's meters, as server/index.ts reads them.
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const vault = new Vault({ file: path.join(dir, 'vault.json'), key: (): KeySource => ({ file: keyFile }) });
  vault.add({ name: 'vault-ben-1', kind: 'claude', value: B1, owner: 'ben', share: 'owner' });
  vault.add({ name: 'vault-ben-2', kind: 'claude', value: B2, owner: 'ben', share: 'owner' });
  vault.add({ name: 'vault-lothsahn-1', kind: 'claude', value: L1, owner: 'lothsahn', share: 'owner' });
  const logs: string[] = [];
  const usage = new UsageTracker(cfg, () => {}, { log: (l) => logs.push(l) });
  const meter = (token: string, u: PlanUsage) => void usage.entries.set(key(token), { kind: 'token', label: token.slice(-4), usage: u, direct: true });
  const poolSetting: Record<string, string> = {};
  const poolOf = (person: string) => poolSetting[person] ?? person;
  const ctx: VaultContext = { vault, usageOf: (fp) => usage.usageOf(`token:${fp}`), liveOn: () => 0, poolOf };
  const pools = () => vault.pools({ usageOf: (fp) => usage.usageOf(`token:${fp}`), liveOn: () => 0 });
  const gate = () => [...pools()].map(([p, list]): [string, GatePoolToken[]] => [p, list.map((x) => ({ name: x.entry.name, last4: x.entry.last4, priority: x.priority, view: x.view }))]);
  const views = () => [...pools()].map(([p, list]) => [p, list.map((x) => ({ key: `token:${x.entry.fingerprint}`, label: `${x.entry.name} …${x.entry.last4}`, state: x.view.state, why: x.view.why }))] as const);
  const label = (account: string) => {
    const e = vault.list().find((x) => `token:${x.fingerprint}` === account);
    return e ? `${e.name} …${e.last4}` : undefined;
  };
  // As server/index.ts wires them.
  agents.tokenUnusable = (account) => {
    for (const list of pools().values()) for (const x of list) if (`token:${x.entry.fingerprint}` === account && (x.view.state === 'retired' || x.view.state === 'exhausted')) return `vault token ${x.entry.name} …${x.entry.last4} (${x.view.why})`;
    return undefined;
  };
  agents.orchestratorTokenOut = (account, pool) => orchestratorOut(views(), account, pool);
  const resumed: { id: string; text: string }[] = [];
  const held: { id: string; ref: string; what: string }[] = [];
  const notes: string[] = [];
  const deps: TokenSwitchDeps = {
    label,
    meters: (account) => usage.usageOf(account),
    markOut: (account, mark, l) => usage.markOut(account, mark, l),
    out: (account) => !!agents.tokenUnusable?.(account),
    serves: (s) => {
      const person = s.requestedBy?.userId;
      return person ? poolForRef(poolOf(person), gate())?.serves : undefined;
    },
    resume: (s, text) => {
      resumed.push({ id: s.id, text });
      sessions.send(s.id, text, 'system');
    },
    hold: (s, ref, what) => {
      held.push({ id: s.id, ref, what });
      return ['w9001'];
    },
    note: (_s, line) => {
      notes.push(line);
      return ['w9001'];
    },
    log: (l) => logs.push(l),
  };
  const sw = new TokenSwitch(deps);
  agents.accountMoving = (i, why) => sw.moving(i, why);
  const add = (i: SessionInfo, live = true) => {
    const h = fake(i, live);
    sessions.adopt(h as unknown as SessionHandle);
    return h;
  };
  const runEnv = (sid: string, person: string) => machineRunEnv({ machines: [] } as never, { id: 'lothdesktop' } as never, { role: 'workers', requestedBy: { userId: person, displayName: person }, sessionId: sid }, ctx);
  const ownerOf = (account: string) => vault.list().find((x) => `token:${x.fingerprint}` === account)?.owner;
  agents.tokenOwner = ownerOf;
  agents.tokenLabel = label;
  // The dispatcher's config, as server/index.ts reads claudeAccounts.dispatcher (w5891, w5921); unset: the payer's (Ben's) pool.
  const dispatcherCfg: { now: DispatcherAccount } = { now: { pool: 'ben', named: false } };
  // Room as index.ts's dispatcherRoomIn reads it: another token of the pool not used up, retired, held or capped.
  const roomIn = (pool: string, except: string) => views().some(([p, list]) => p === pool && list.some((t) => t.key !== except && !['exhausted', 'retired', 'held'].includes(t.state)));
  agents.dispatcherAccountMove = (account) => dispatcherMove(dispatcherCfg.now, views(), account, { label: label(account), owner: ownerOf(account), room: !dispatcherCfg.now.pinned && roomIn(dispatcherCfg.now.pool, account) });
  const dispatcherServes = deps.serves;
  deps.serves = (s) => (s.kind === 'orchestrator' && s.orchestratorRole === 'dispatcher' ? !!s.account && !!agents.dispatcherAccountMove?.(s.account) : dispatcherServes(s));
  deps.dispatcherWait = () => dispatcherWait(dispatcherCfg.now, [...pools()].find(([p]) => p === dispatcherCfg.now.pool)?.[1].map((x) => ({ label: `${x.entry.name} …${x.entry.last4}`, until: x.view.until ? Date.parse(x.view.until) : undefined })) ?? [], Date.now());
  const pin = (token: string) => ({ pinned: { name: label(key(token))!.split(' ')[0], key: key(token), label: label(key(token)) }, pool: '', named: false });
  return { dir, store, sessions, agents, usage, meter, sw, deps, add, runEnv, resumed, held, notes, logs, poolSetting, views, label, dispatcherCfg, pin };
}

const worker = (id: string, account: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, kind: 'worker', title: id, status: 'idle', machineId: 'lothdesktop', machineSandbox: 'slot2', account, permissionMode: 'default', createdAt: iso(NOW), lastActivityAt: iso(NOW), turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: { userId: 'ben', displayName: 'Ben' }, ...over }) as SessionInfo;

test('w1745: an agent stays on its token while it works, however high the meter (it is not moved early)', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 97));
  w.meter(B2, reading(0, 0));
  const h = w.add(worker('w-a', key(B1)));
  w.sessions.send('w-a', 'hello', 'human');
  assert.equal(h.stops, 0, 'one-at-a-time at 97% still works: the live process keeps it');
  assert.equal(h.sent.length, 1);
  // A turn that ended normally on that token changes nothing.
  w.sw.turnEnded({ ...h.info, lastResult: 'Done. PR #12 merged.' });
  assert.equal(w.usage.outOf(key(B1)), undefined);
  assert.equal(w.resumed.length, 0);
});

test('w1745: token out → the agent the limit stopped resumes at once, its next turn on a fresh token of its pool, and the switch is logged', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 97));
  w.meter(B2, reading(10, 20));
  const h = w.add(worker('w-a', key(B1), { lastResult: LIMIT_LINE }));
  w.sw.turnEnded(h.info);
  // The refusal marks vault-ben-1 used up until its weekly reset, whatever its 97% reading said.
  const u = w.usage.usageOf(key(B1))!;
  assert.equal(u.weekly?.percent, 100);
  assert.equal(u.weekly?.resetsAt, iso(NOW + 40 * HOUR), 'until the weekly window resets');
  // It is resumed: the idle process on the out token stops first, and the message waits for the new one.
  assert.equal(w.resumed.length, 1);
  assert.match(w.resumed[0].text, /^\[token switch\] Your last turn stopped because vault-ben-1 …\w{4} ran out/);
  assert.equal(h.stops, 1, 'its process on vault-ben-1 stops between turns');
  assert.equal(h.sent.length, 0, 'the resume does not run on the out token');
  assert.match(w.sessions.queued()[0].why, /vault-ben-1 …\w{4}.*restarts on its person's usable account/);
  // The next process starts on the pool's pick: vault-ben-2, never vault-ben-1.
  const env = w.runEnv('w-a', 'ben');
  assert.match(env.account, /vault token vault-ben-2 …/);
  assert.equal(env.env.CLAUDE_CODE_OAUTH_TOKEN, B2);
  assert.equal(w.sessions.drain(), 1);
  assert.equal(h.sent.length, 1, 'the same message reaches the new process, in the same conversation');
  // The new process reports its account: the switch is logged on the request and kept for system_status.
  w.sw.seen({ ...h.info, status: 'starting', account: key(B2) });
  const s = w.sw.switches();
  assert.equal(s.length, 1);
  assert.match(s[0].from, /^vault-ben-1 …\w{4}$/);
  assert.match(s[0].to, /^vault-ben-2 …\w{4}$/);
  assert.match(s[0].why, /ran out/);
  assert.deepEqual(s[0].requests, ['w9001']);
  assert.match(w.notes[0], /^token switch \(w1745\): worker w-a moved from vault-ben-1 …\w{4} to vault-ben-2 …\w{4}: vault-ben-1 …\w{4} ran out/);
  const status = w.sw.statusLines(w.usage.outsNow(), () => []).join('\n');
  assert.match(status, /Token out \(w1745\): vault-ben-1 …\w{4}/);
  assert.match(status, /worker w-a \(w9001\): vault-ben-1 …\w{4} → vault-ben-2 …\w{4}/);
  // Never a token: only names and last four characters.
  for (const line of [...w.logs, ...w.notes, status]) for (const tok of [B1, B2]) assert.ok(!line.includes(tok) && !line.includes(fingerprintOf(tok)), `no token or key in "${line.slice(0, 80)}"`);
});

test('w1745: a rejected rate-limit answer marks the token out for that window until its reset; a warning or overage does not', (t) => {
  const w = world(t);
  w.meter(B1, reading(70, 60));
  w.meter(B2, reading(0, 0));
  const info = worker('w-a', key(B1));
  w.sw.rateLimit(info, { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 });
  w.sw.rateLimit(info, { status: 'rejected', rateLimitType: 'overage' });
  assert.equal(w.usage.outOf(key(B1)), undefined);
  const reset = Math.floor((NOW + 2 * HOUR) / 1000);
  w.sw.rateLimit(info, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset });
  const o = w.usage.outOf(key(B1))!;
  assert.equal(o.field, 'session');
  assert.equal(o.until, reset * 1000);
  assert.equal(w.usage.usageOf(key(B1))?.session?.percent, 100);
  assert.equal(w.usage.usageOf(key(B1))?.weekly?.percent, 60, 'the other window is as read');
  // A turn that ended after the refusal (whatever its last words) resumes the agent on a token with room.
  w.add(info);
  w.sw.turnEnded({ ...info, lastResult: 'API Error: 429' });
  assert.equal(w.resumed.length, 1);
  assert.equal(refusedWindow(undefined, "You've hit your session limit · resets 7pm", undefined), 'session');
  assert.equal(refusedWindow('seven_day_opus', '', undefined), 'weekly');
});

test('w1745: the out mark is not lowered by a poll and outlives a restart; it ends at the reset', (t) => {
  const w = world(t);
  w.meter(B1, reading(20, 97));
  w.usage.markOut(key(B1), { field: 'weekly', until: NOW + 40 * HOUR, at: NOW, why: 'test' }, 'vault-ben-1 …AAAA');
  w.meter(B1, reading(20, 98));
  assert.equal(w.usage.usageOf(key(B1))?.weekly?.percent, 100, 'a later poll at 98% does not put it back in the pool');
  assert.equal(withOut(reading(20, 98), { field: 'weekly', until: NOW - 1, at: NOW - HOUR, why: 'x' }, NOW)?.weekly?.percent, 98, 'past its end the reading is as read');
  const again = new UsageTracker({ dataDir: w.dir } as Config, () => {}, { log: () => {} });
  assert.equal(again.outOf(key(B1))?.field, 'weekly', 'a portal restart keeps the mark (usage.json)');
  assert.equal(again.outOf(key(B1), NOW + 41 * HOUR), undefined, 'it ends at the reset');
});

test('w1745: a mid-turn agent is never interrupted; it moves only once its turn has ended', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 97));
  w.meter(B2, reading(0, 10));
  const mid = w.add(worker('w-mid', key(B1), { status: 'running' }));
  // Another agent's turn ended on the limit: vault-ben-1 is out.
  w.sw.turnEnded(w.add(worker('w-other', key(B1), { lastResult: LIMIT_LINE })).info);
  assert.equal(w.usage.usageOf(key(B1))?.weekly?.percent, 100);
  w.sessions.send('w-mid', 'a note from Ben', 'human');
  assert.equal(mid.stops, 0, 'mid-turn: the process is not stopped');
  assert.equal(mid.sent.length, 1, 'the message reaches the running turn');
  // Its own limit line while a queued message has already started its next turn: no resume, no stop.
  w.sw.turnEnded({ ...mid.info, status: 'running', lastResult: LIMIT_LINE });
  assert.equal(w.resumed.filter((r) => r.id === 'w-mid').length, 0);
  assert.equal(mid.stops, 0);
  // Its turn ends: now it moves.
  mid.info.status = 'idle';
  w.sw.turnEnded({ ...mid.info, lastResult: LIMIT_LINE });
  assert.equal(w.resumed.filter((r) => r.id === 'w-mid').length, 1);
  assert.equal(mid.stops, 1);
  // A person's orchestrator mid-turn on the out token is not moved either; idle, it is.
  const orch = w.add({ ...worker('o-ben', key(B1), { status: 'running' }), kind: 'orchestrator', orchestratorRole: 'personal', machineId: undefined } as SessionInfo);
  w.sessions.send('o-ben', 'hi', 'human');
  assert.equal(orch.stops, 0);
  orch.info.status = 'idle';
  w.sessions.send('o-ben', 'hi again', 'human');
  assert.equal(orch.stops, 1, "idle on an out token, with room in Ben's pool: it restarts before the message");
  assert.match(w.sessions.queued().find((q) => q.id === 'o-ben')!.why, /restarts on a token with room in its person's pool .*\(w1745\)/);
});

test('w1745: no token with room → the agent is held as today (its requests blocked on the usage gate), never resumed on the out token', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 97));
  w.meter(B2, reading(10, 100));
  const h = w.add(worker('w-a', key(B1), { lastResult: LIMIT_LINE }));
  w.sw.turnEnded(h.info);
  assert.equal(w.resumed.length, 0, 'nothing to resume it on');
  assert.equal(w.held.length, 1);
  assert.match(w.held[0].ref, /^vault-ben-1 …\w{4}$/);
  assert.match(w.held[0].what, /ran out and no token in its pool has room/);
  assert.equal(h.stops, 0);
  assert.throws(() => w.runEnv('w-a', 'ben'), (e) => e instanceof PoolHeldError, 'a start is held on the pool, as a new job is');
  // An orchestrator stays where it is when its pool has nothing better.
  const orch = w.add({ ...worker('o-ben', key(B1)), kind: 'orchestrator', orchestratorRole: 'personal', machineId: undefined } as SessionInfo);
  w.sessions.send('o-ben', 'hi', 'human');
  assert.equal(orch.stops, 0);
});

test("w1745: another person's pool is never used: lothsahn's agent on his out token is held while Ben's pool has room", (t) => {
  const w = world(t);
  w.meter(B1, reading(0, 0));
  w.meter(B2, reading(0, 0));
  w.meter(L1, reading(20, 50));
  const h = w.add(worker('w-l', key(L1), { requestedBy: { userId: 'lothsahn', displayName: 'lothsahn' }, lastResult: LIMIT_LINE }));
  w.sw.turnEnded(h.info);
  assert.equal(w.resumed.length, 0);
  assert.equal(w.held.length, 1);
  assert.match(w.held[0].ref, /^vault-lothsahn-1 …\w{4}$/);
  assert.throws(() => w.runEnv('w-l', 'lothsahn'), (e) => e instanceof PoolHeldError, "never Ben's token, never the host's");
  assert.equal(orchestratorOut(w.views(), key(L1), 'lothsahn'), undefined, "an orchestrator rule reads only its person's pool");
  // Only when lothsahn's own pool setting names Ben's pool (w1717) is Ben's pool his.
  w.poolSetting.lothsahn = 'ben';
  w.held.length = 0;
  const h2 = w.add(worker('w-l2', key(L1), { requestedBy: { userId: 'lothsahn', displayName: 'lothsahn' }, lastResult: LIMIT_LINE }));
  w.sw.turnEnded(h2.info);
  assert.equal(w.resumed.length, 1);
  assert.match(w.runEnv('w-l2', 'lothsahn').account, /vault-ben-\d …\w{4} \(ben's pool, for lothsahn's work/);
  assert.match(orchestratorOut(w.views(), key(L1), 'ben') ?? '', /^vault token vault-lothsahn-1 …\w{4} \(.*used up/);
});

test('w1745: the ops worker is not resumed; one whose process could not move is not resumed or held in a loop', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 97));
  w.meter(B2, reading(0, 0));
  w.sw.turnEnded({ ...worker('ops-1', key(B1), { lastResult: LIMIT_LINE }), kind: 'ops' } as SessionInfo);
  assert.equal(w.resumed.length, 0);
  // A worker with a background build keeps its process (accountMove): resumed once, refused again there, it is held.
  const bg = w.add(worker('w-bg', key(B1), { lastResult: LIMIT_LINE, backgroundTasks: 1 } as Partial<SessionInfo>));
  w.sw.turnEnded(bg.info);
  assert.equal(w.resumed.length, 1);
  assert.equal(bg.stops, 0, 'the build is not killed');
  w.sw.turnEnded(bg.info);
  assert.equal(w.resumed.length, 1, 'not resumed a second time on the same out token');
  assert.equal(w.held.length, 0, 'nor held on a usage gate that would clear at once (its pool has room) and loop');
  assert.match(w.logs.at(-1)!, /w-bg stopped on vault-ben-1 …\w{4} again after its resume: .*a background task keeps it/);
  // The build done, its next message moves it.
  bg.info.backgroundTasks = 0;
  w.sessions.send('w-bg', 'the build finished', 'system');
  assert.equal(bg.stops, 1);
});

test('w5921: the dispatcher ending 2 turns in a row on the usage limit alerts the operators once, with the token, its reset and what was done', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 100, 4));
  w.meter(B2, reading(0, 3));
  const alerts: { id: string; line: string }[] = [];
  w.deps.alert = (s, line) => alerts.push({ id: s.id, line });
  w.dispatcherCfg.now = w.pin(B1);
  const sw = new TokenSwitch(w.deps);
  const disp = { ...worker('disp', key(B1), { lastResult: LIMIT_LINE }), kind: 'orchestrator', orchestratorRole: 'dispatcher', machineId: undefined } as SessionInfo;
  assert.equal(sw.dispatcherLimited(), undefined);
  sw.turnEnded(disp);
  assert.equal(alerts.length, 0, 'one limit turn alerts nobody (a turn the limit cut short before a switch took)');
  assert.match(sw.dispatcherLimited()!, /^the dispatcher is rate-limited on vault-ben-1 …\w{4} until \d{4}-\d\d-\d\d \d\d:\d\dZ$/);
  sw.turnEnded(disp);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].line, /^\[token alert\] The dispatcher ended 2 turns in a row on Claude's usage limit, on vault token vault-ben-1 …\w{4}; Claude counts that token's window used up until \d{4}-\d\d-\d\d \d\d:\d\dZ\. What FF Factory did: it is pinned to vault token vault-ben-1 …\w{4} \(claudeAccounts.dispatcher\), so it waits for that token's reset/);
  assert.doesNotMatch(alerts[0].line, new RegExp(B1.slice(0, 20)), 'never the token itself');
  sw.turnEnded(disp);
  assert.equal(alerts.length, 1, 'once per streak');
  assert.ok(sw.statusLines([], () => []).some((l) => /^Dispatcher rate-limited \(w5921\): The dispatcher is rate-limited on vault-ben-1/.test(l)));
  // A turn that ends normally ends the streak; the next two limit turns on the same token's window do not alert again.
  sw.turnEnded({ ...disp, lastResult: 'Started w5907 on lothdesktop.' });
  assert.equal(sw.dispatcherLimited(), undefined);
  sw.turnEnded(disp);
  sw.turnEnded(disp);
  assert.equal(alerts.length, 1, 'once per token window, a flapping token included');
});

test('w5921 review: a reset dispatcher (a new session) is not limited by the old one; a backlog read mid-turn still alerts; the reset is the usage mark\'s', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 100, 4));
  w.meter(B2, reading(0, 3));
  const alerts: string[] = [];
  w.deps.alert = (_s, line) => alerts.push(line);
  w.dispatcherCfg.now = w.pin(B1);
  let current = 'disp';
  w.deps.dispatcherId = () => current;
  const marks = new Map<string, number>();
  const at = Date.now();
  w.deps.outUntil = (account) => marks.get(account);
  const sw = new TokenSwitch(w.deps);
  const disp = { ...worker('disp', key(B1), { lastResult: LIMIT_LINE }), kind: 'orchestrator', orchestratorRole: 'dispatcher', machineId: undefined } as SessionInfo;
  marks.set(key(B1), at + 3 * 3_600_000);
  // A queued backlog: both turns read mid-turn, and the second alerts anyway.
  sw.turnEnded({ ...disp, status: 'running' });
  sw.turnEnded({ ...disp, status: 'running' });
  assert.equal(alerts.length, 1, 'alerted although every reading was mid-turn');
  assert.match(sw.dispatcherLimited()!, new RegExp(`until ${new Date(at + 3 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')}Z$`), "the usage tracker's mark, the time system_status shows");
  // The mark ends (or is cleared): not limited, whatever the streak's own guess said.
  marks.delete(key(B1));
  assert.equal(sw.dispatcherLimited(), undefined);
  marks.set(key(B1), at + 3 * 3_600_000);
  // The dispatcher is reset: a new session id; the old one's streak is not the new dispatcher's.
  current = 'disp-2';
  assert.equal(sw.dispatcherLimited(), undefined, 'a reset dispatcher is not rate-limited by its predecessor');
  sw.turnEnded({ ...disp, id: 'disp-2', account: key(B2), lastResult: 'Started w5907.' });
  current = 'disp';
  assert.equal(sw.dispatcherLimited(), undefined, "a dispatcher's normal turn clears every earlier dispatcher's streak");
  // A token that flaps alerts once per window, not every other turn.
  sw.turnEnded(disp);
  sw.turnEnded(disp);
  sw.turnEnded({ ...disp, lastResult: 'ok' });
  sw.turnEnded(disp);
  sw.turnEnded(disp);
  assert.equal(alerts.length, 1, 'one alert per agent and token window');
});

test("w5921: a person's orchestrator stuck on the limit twice alerts too, saying what was done; a worker never does", (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 100));
  w.meter(B2, reading(100, 100));
  const alerts: string[] = [];
  w.deps.alert = (_s, line) => alerts.push(line);
  const sw = new TokenSwitch(w.deps);
  const orch = { ...worker('orch-ben', key(B1), { lastResult: LIMIT_LINE, title: 'Ben' }), kind: 'orchestrator', orchestratorRole: 'personal', machineId: undefined } as SessionInfo;
  sw.turnEnded(orch);
  sw.turnEnded(orch);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^\[token alert\] Orchestrator orch-ben \(Ben\) ended 2 turns in a row .*What FF Factory did: (no token in its pool has room, so it waits|resumed on a token with room)/);
  assert.equal(sw.dispatcherLimited(), undefined, "only the dispatcher's limit is the ledger's reason");
  const wk = worker('w-1', key(B1), { lastResult: LIMIT_LINE });
  sw.turnEnded(wk);
  sw.turnEnded(wk);
  assert.equal(alerts.length, 1, 'workers are moved or held by w1745 and named in their requests, not alerted');
});

test('w1745: a worker left idle on the out token after its resume is resumed again 10 min later, at most 3 times (7d4cb2df, 2026-10-22)', (t) => {
  // Worker 7d4cb2df (w1752): its resume went into an agent host that predated the daemon fix, ran on vault-ben-1 again, and it
  // then sat idle there from 18:31Z, waiting for "its next message", which nothing sent.
  const w = world(t);
  w.meter(B1, reading(50, 97));
  w.meter(B2, reading(0, 0));
  let clock = NOW;
  const sw = new TokenSwitch({ ...w.deps, now: () => clock });
  w.agents.accountMoving = (i, why) => sw.moving(i, why);
  const h = w.add(worker('w-stuck', key(B1), { lastResult: LIMIT_LINE, lastResultAt: iso(clock) }));
  sw.turnEnded(h.info);
  assert.equal(w.resumed.length, 1);
  assert.equal(h.stops, 1);
  /** Its process did not move: the message ran on vault-ben-1 again and its turn ended on the limit at once. */
  const failsAgain = () => {
    assert.equal(w.sessions.drain(), 1, 'the resume is delivered');
    h.live = true;
    h.info.lastResultAt = iso(clock);
    sw.turnEnded(h.info);
  };
  failsAgain();
  assert.equal(w.resumed.length, 1, 'not resumed at once: that would loop on the out token');
  assert.match(w.logs.at(-1)!, /w-stuck stopped on vault-ben-1 …\w{4} again after its resume: .*resumed again in 10 min/);
  clock += 5 * 60_000;
  sw.tick([h.info]);
  assert.equal(w.resumed.length, 1, 'not before 10 min');
  clock += 6 * 60_000;
  sw.tick([h.info]);
  assert.equal(w.resumed.length, 2, 'resumed again');
  assert.match(w.logs.at(-1)!, /^token switch \(w1745\): worker w-stuck is still idle on vault-ben-1 …\w{4}, which is out, 11 min after its turn stopped there; resumed again on a token with room in its pool \(1 of 3\)$/);
  assert.equal(h.stops, 2, 'its idle process on vault-ben-1 stops first, so the next one starts on the pool pick');
  assert.match(w.sessions.queued()[0].why, /restarts on its person's usable account/);
  sw.tick([h.info]);
  assert.equal(w.resumed.length, 2, 'one resume per failed turn');
  for (let k = 2; k <= 3; k++) {
    failsAgain();
    clock += 11 * 60_000;
    sw.tick([h.info]);
    assert.equal(w.resumed.length, k + 1);
  }
  failsAgain();
  clock += 11 * 60_000;
  sw.tick([h.info]);
  sw.tick([h.info]);
  assert.equal(w.resumed.length, 4, 'after 3 more tries it waits for its next message');
  assert.equal(w.logs.filter((l) => /is still on vault-ben-1 …\w{4} after 3 more resumes; not resumed again/.test(l)).length, 1, 'said once');
  // Never resumed: a worker whose background task keeps its process, one whose last turn did not end on the limit, one on a
  // token with room, one mid-turn, one a person stopped.
  const quiet = [
    worker('w-bg', key(B1), { lastResult: LIMIT_LINE, lastResultAt: iso(NOW), backgroundTasks: 1 } as Partial<SessionInfo>),
    worker('w-done', key(B1), { lastResult: 'Done. PR #12 merged.', lastResultAt: iso(NOW) }),
    worker('w-room', key(B2), { lastResult: LIMIT_LINE, lastResultAt: iso(NOW) }),
    worker('w-busy', key(B1), { lastResult: LIMIT_LINE, lastResultAt: iso(NOW), status: 'running' }),
    worker('w-stopped', key(B1), { lastResult: LIMIT_LINE, lastResultAt: iso(NOW), status: 'stopped' }),
  ];
  for (const q of quiet) w.add(q);
  sw.tick(quiet);
  assert.equal(w.resumed.length, 4);
  for (const line of w.logs) for (const tok of [B1, B2]) assert.ok(!line.includes(tok) && !line.includes(fingerprintOf(tok)), `no token or key in "${line.slice(0, 80)}"`);
});

test('w2785: an orchestrator moves off a token at its own weekly cap to any token not used up and not capped, a retired one included', () => {
  const v = (key: string, state: string, capped = false) => ({ key, label: `${key} …AAAA`, state, why: capped ? 'weekly 91% (cap 90%): retired until Mon 05:00Z' : state, ...(capped ? { capped } : {}) });
  const pools = (b2: string) => [['ben', [v('b2', b2), v('b3', 'retired', true)]] as const];
  assert.match(orchestratorOut(pools('ok'), 'b3', 'ben') ?? '', /^vault token b3 …AAAA \(weekly 91% \(cap 90%\)/);
  assert.ok(orchestratorOut(pools('retired'), 'b3', 'ben'), 'off a capped token even a token past the 99% line is better: the 10% is its person\'s');
  assert.equal(orchestratorOut(pools('exhausted'), 'b3', 'ben'), undefined, 'nothing better: it stays (its pick holds it at its next start)');
  assert.equal(orchestratorOut([['ben', [v('b2', 'retired', true), v('b3', 'retired', true)]]], 'b3', 'ben'), undefined, 'another capped token is not better');
});

/** What the sessions were sent (the [token move] lines), by id, beside the real send. */
function recordSends(w: ReturnType<typeof world>) {
  const got: Record<string, string[]> = {};
  const send = w.sessions.send.bind(w.sessions);
  w.sessions.send = ((id: string, text: string, ...rest: unknown[]) => {
    (got[id] ??= []).push(text);
    return (send as (...a: unknown[]) => unknown)(id, text, ...rest);
  }) as typeof w.sessions.send;
  return got;
}

/** The system lines Agents.applyAccountConfig appends when it stops an orchestrator, by session id (it sends no message). */
function recordStops(w: { store: Store }) {
  const got: Record<string, string[]> = {};
  const append = w.store.append.bind(w.store);
  w.store.append = ((id: string, e: { kind: string; text?: string }) => {
    if (e.kind === 'system' && e.text) (got[id] ??= []).push(e.text);
    return append(id, e as never);
  }) as typeof w.store.append;
  return got;
}

const dispatcherOn = (account: string, over: Partial<SessionInfo> = {}) => ({ ...worker('disp', account, { lastResult: LIMIT_LINE, ...over }), kind: 'orchestrator', orchestratorRole: 'dispatcher', machineId: undefined }) as SessionInfo;

test("w5921: the dispatcher on a used-up token moves to another of its pool's tokens with room, before its next turn", (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 100));
  w.meter(B2, reading(0, 3));
  w.dispatcherCfg.now = { pool: 'ben', named: true };
  const disp = w.add(dispatcherOn(key(B1)));
  w.sw.turnEnded(disp.info);
  assert.equal(w.resumed.length, 1, 'resumed: its pool has a token with room');
  assert.equal(disp.stops, 1, 'its process stopped before the resume, so the resume starts it on another token');
});

test("w5921: the dispatcher never crosses pools: its pool used up, it waits, naming the first reset, while another pool has room", (t) => {
  const w = world(t);
  w.meter(B1, reading(0, 0));
  w.meter(B2, reading(0, 0));
  w.meter(L1, reading(20, 100, 7));
  const alerts: string[] = [];
  w.deps.alert = (_s, line) => alerts.push(line);
  w.dispatcherCfg.now = { pool: 'lothsahn', named: true };
  const sw = new TokenSwitch(w.deps);
  const disp = w.add(dispatcherOn(key(L1)));
  sw.turnEnded(disp.info);
  sw.turnEnded(disp.info);
  assert.equal(w.resumed.length, 0, "never resumed onto Ben's pool");
  assert.equal(disp.stops, 0);
  assert.equal(dispatcherMove(w.dispatcherCfg.now, w.views(), key(L1), { label: w.label(key(L1)), owner: 'lothsahn', room: false }), undefined, 'no move: only its own pool is read');
  assert.match(w.logs.join('\n'), /every token of lothsahn's pool \(claudeAccounts.dispatcher\) is out, so it waits and never runs on another pool; the first to reset is vault-lothsahn-1 …\w{4}, at /);
  assert.equal(alerts.length, 1, 'two turns on the limit alert');
  assert.match(alerts[0], /the first to reset is vault-lothsahn-1/);
  // The message it gets meanwhile does not move it to Ben's pool either.
  w.sessions.send('disp', 'next', 'system');
  assert.equal(disp.stops, 0);
});

test('w5921: a pinned dispatcher waits for its own token; its pin is never left for a free token', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 100));
  w.meter(B2, reading(0, 0));
  w.dispatcherCfg.now = w.pin(B1);
  const disp = w.add(dispatcherOn(key(B1)));
  w.sw.turnEnded(disp.info);
  assert.equal(w.resumed.length, 0);
  assert.equal(disp.stops, 0);
  assert.match(w.logs.at(-1)!, /it is pinned to vault token vault-ben-1 …\w{4} \(claudeAccounts.dispatcher\), so it waits for that token's reset/);
  // A pin the vault lacks: no move (its start would fail), it stays where it is.
  assert.equal(dispatcherMove({ pinned: { name: 'vault-gone' }, pool: '', named: false }, w.views(), key(B1), { label: 'x', owner: 'ben', room: true }), undefined);
});

test('w5921: a change of claudeAccounts.dispatcher (a pin, a pool) or of the payer\'s pool setting restarts the dispatcher between turns, never mid-turn', (t) => {
  const w = world(t);
  w.meter(B1, reading(10, 10));
  w.meter(B2, reading(10, 10));
  w.meter(L1, reading(10, 10));
  const disp = w.add(dispatcherOn(key(B1), { lastResult: 'ok' }));
  const got = recordStops(w);
  assert.deepEqual(w.agents.applyAccountConfig('test'), [], 'on its configured pool, with room: nothing moves');
  // A pin to another token: restarted at once, between turns.
  w.dispatcherCfg.now = w.pin(B2);
  assert.deepEqual(w.agents.applyAccountConfig('config claudeAccounts.dispatcher changed'), ['disp']);
  assert.equal(disp.stops, 1, 'stopped between turns, with no message (no turn spent): its next message starts it on the new token');
  assert.match(got.disp.at(-1)!, /^Stopped by FF Factory between turns to apply its account config: .*pins vault token vault-ben-2/);
  assert.deepEqual(w.agents.applyAccountConfig('again'), [], 'once: its stopped process is not stopped again');
  // Its process started again on the pinned token: its next message moves nothing.
  const moved = w.add(dispatcherOn(key(B2), { lastResult: 'ok' }));
  w.sessions.send('disp', 'hello', 'system');
  assert.equal(moved.stops, 0);
  // Mid-turn: nothing until the turn ends; the next check after it moves it.
  w.dispatcherCfg.now = { pool: 'lothsahn', named: true };
  const busy = w.add(dispatcherOn(key(B1), { lastResult: 'ok', status: 'running' }));
  assert.deepEqual(w.agents.applyAccountConfig('mid-turn'), [], 'a turn is never killed');
  assert.equal(busy.stops, 0);
  busy.info.status = 'idle';
  assert.deepEqual(w.agents.applyAccountConfig('after the turn'), ['disp']);
  assert.equal(busy.stops, 1);
  assert.match(got.disp.at(-1)!, /claudeAccounts.dispatcher names lothsahn's pool/);
  // Unset (the system payer's pool): Ben's pool setting naming lothsahn's moves it too (set_pool calls this).
  w.add(dispatcherOn(key(L1), { lastResult: 'ok' }));
  w.sessions.send('disp', 'hello', 'system');
  assert.deepEqual(w.agents.applyAccountConfig('on its pool'), []);
  // claudeAccounts.dispatcher cleared: the system payer's pool (Ben's, by his own pool setting).
  w.dispatcherCfg.now = { pool: 'ben', named: false };
  const again = w.add(dispatcherOn(key(L1), { lastResult: 'ok' }));
  assert.deepEqual(w.agents.applyAccountConfig('set_pool'), ['disp']);
  assert.equal(again.stops, 1);
  assert.match(got.disp.at(-1)!, /the system payer's pool, ben's by their pool setting/);
});

test('w6093: set_app_config claudeAccounts.dispatcher promises a restart only when one is due', (t) => {
  const w = world(t);
  w.meter(B1, reading(10, 10));
  w.meter(B2, reading(10, 10));
  w.meter(L1, reading(10, 10));
  w.store.orchestratorId = 'disp';
  // As seen live 2026-11-26 14:11:30 UTC: pool:ben set while the dispatcher ran, mid-turn, on a token of Ben's pool with room.
  w.dispatcherCfg.now = { pool: 'ben', named: true };
  const busy = w.add(dispatcherOn(key(B1), { lastResult: 'ok', status: 'running' }));
  const moved = w.agents.applyAccountConfig('config claudeAccounts.dispatcher changed');
  assert.deepEqual(moved, []);
  const said = w.agents.dispatcherConfigAnswer(moved);
  assert.match(said, /^the dispatcher already runs on vault-ben-1 …\w{4} of ben's pool, which has room: nothing to restart$/);
  assert.doesNotMatch(said, /mid-turn|restarts/);
  // A pin to the token it runs on: nothing to restart either.
  w.dispatcherCfg.now = w.pin(B1);
  assert.match(w.agents.dispatcherConfigAnswer(w.agents.applyAccountConfig('pin')), /already runs on vault-ben-1 …\w{4} of ben's pool, which has room: nothing to restart/);
  // A move due mid-turn (another pool named): the mid-turn text, with why.
  w.dispatcherCfg.now = { pool: 'lothsahn', named: true };
  const mid = w.agents.dispatcherConfigAnswer(w.agents.applyAccountConfig('mid-turn'));
  assert.match(mid, /^the dispatcher is mid-turn: it restarts within 30 s of that turn ending \(never mid-turn\), because .*claudeAccounts.dispatcher names lothsahn's pool/);
  assert.equal(busy.stops, 0);
  // Between turns: stopped at once, and the answer says so.
  busy.info.status = 'idle';
  const now = w.agents.applyAccountConfig('idle');
  assert.deepEqual(now, ['disp']);
  assert.equal(w.agents.dispatcherConfigAnswer(now), 'the dispatcher was stopped between turns and its next message starts it there');
});

test("w5921: a person's orchestrator moves at once when their pool setting changes, not at its next message", (t) => {
  const w = world(t);
  w.meter(B1, reading(10, 10));
  w.meter(L1, reading(10, 10));
  const orch = w.add({ ...worker('orch-l', key(L1), { requestedBy: { userId: 'lothsahn', displayName: 'lothsahn' }, lastResult: 'ok' }), kind: 'orchestrator', orchestratorRole: 'personal', machineId: undefined } as SessionInfo);
  const got = recordStops(w);
  w.agents.hasPool = () => true;
  assert.deepEqual(w.agents.applyAccountConfig('test'), []);
  assert.equal(w.agents.setPool('lothsahn', 'ben', 'test'), 'ben');
  assert.equal(orch.stops, 1, "set_pool restarted lothsahn's orchestrator between turns");
  assert.match(got['orch-l'].at(-1)!, /^Stopped by FF Factory between turns to apply its account config: .*lothsahn's pool setting names ben's now/);
});

test('w5921 review of #1312: a restart that lands on the same out token again (a sticky capped one) is not moved again for 30 min', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 100));
  w.meter(B2, reading(0, 3));
  w.dispatcherCfg.now = { pool: 'ben', named: true };
  let now = Date.parse('2026-11-26T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const move = (h: ReturnType<typeof w.add>) => (w.agents as unknown as { accountMoveWhy(s: unknown): string | undefined }).accountMoveWhy(h);
  const first = w.add(dispatcherOn(key(B1), { lastResult: 'ok' }));
  assert.match(move(first)!, /restarts on a token with room in ben's pool/, 'off the used-up token once');
  now += 60_000;
  assert.ok(move(first), 'the same move holds while its restart happens');
  // Its restart landed on vault-ben-1 again: no second move, no loop.
  now += 5 * 60_000;
  const again = w.add(dispatcherOn(key(B1), { lastResult: 'ok' }));
  assert.equal(move(again), undefined, 'not moved again onto the same token');
  now += 30 * 60_000;
  assert.ok(move(again), 'after 30 min it tries again');
});

test('w5921 review of #1312: the stop line moves the dispatcher only when its pool has room; with no room it stays', () => {
  const c: DispatcherAccount = { pool: 'ben', named: true };
  const on = { label: 'vault-ben-1 …1111', owner: 'ben' };
  assert.match(dispatcherMove(c, [], 'token:a', { ...on, room: true, atStop: true })!.why, /at the dispatcher's stop line, so it restarts on a token with room in ben's pool/);
  assert.equal(dispatcherMove(c, [], 'token:a', { ...on, room: true, atStop: true })!.out, true, 'an out move, not a config one');
  assert.equal(dispatcherMove(c, [], 'token:a', { ...on, room: false, atStop: true }), undefined, 'no room: it stays (the whole pool is out: it waits there)');
  assert.equal(dispatcherMove(c, [], 'token:a', { ...on, owner: 'lothsahn', room: false })!.out, false, 'a config move is never an out move');
});

test('w5921: dispatcherWait names the earliest reset of its pool', () => {
  const c: DispatcherAccount = { pool: 'ben', named: true };
  const now = Date.parse('2026-11-26T00:00:00Z');
  const line = dispatcherWait(c, [{ label: 'a …1111', until: now + 5 * 3_600_000 }, { label: 'b …2222', until: now + 2 * 3_600_000 }, { label: 'c …3333' }], now);
  assert.match(line, /every token of ben's pool \(claudeAccounts.dispatcher\) is out, so it waits and never runs on another pool; the first to reset is b …2222, at 2026-11-26 02:00Z$/);
});
