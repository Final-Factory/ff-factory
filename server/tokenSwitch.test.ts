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
import { TokenSwitch, orchestratorOut, refusedWindow, type TokenSwitchDeps } from './tokenSwitch.ts';
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
  return { dir, store, sessions, agents, usage, meter, sw, add, runEnv, resumed, held, notes, logs, poolSetting, views, label };
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

test('w1745: the dispatcher and the ops worker are not resumed; one whose process could not move is not resumed or held in a loop', (t) => {
  const w = world(t);
  w.meter(B1, reading(50, 97));
  w.meter(B2, reading(0, 0));
  const disp = w.add({ ...worker('disp', key(B1), { lastResult: LIMIT_LINE }), kind: 'orchestrator', orchestratorRole: 'dispatcher', machineId: undefined } as SessionInfo);
  w.sw.turnEnded(disp.info);
  assert.equal(w.resumed.length, 0);
  assert.match(w.logs.at(-1)!, /the dispatcher stays on its own token/);
  w.sessions.send('disp', 'next', 'system');
  assert.equal(disp.stops, 0, 'the dispatcher keeps the token it is pinned to');
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
