import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolHeldError, Vault, fingerprintOf, newKeyText, type KeySource, type VaultContext } from './vault.ts';
import { hostAccount, machineRunEnv, pinnedDispatcherEnv, poolRunEnv, reserveLines, reservedCredentials } from './secrets.ts';
import { checkAccountConfig } from './config.ts';
import { OWNER_ONLY_KEYS, normalizeSetting, setAppConfig } from './appConfig.ts';
import { clock, poolLabel, poolLimits } from './tokenPool.ts';
import { tokenKey } from './usage.ts';
import type { PlanUsage } from '../shared/types.ts';
import type { Config } from './config.ts';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const claudeTok = (c: string) => `sk-ant-oat01-${c.repeat(48)}`;
const B1 = claudeTok('b');
const B2 = claudeTok('c');
const L1 = claudeTok('d');
const SHARED = claudeTok('e');
const DISP = claudeTok('f'); // the vault token the dispatcher is pinned to (w996)

const usage = (session: number, weekly: number, o: { weeklyDays?: number; sessionHours?: number } = {}): PlanUsage => ({
  available: true,
  asOf: iso(NOW),
  models: [],
  session: { label: '5-hour', percent: session, ...(o.sessionHours !== undefined ? { resetsAt: iso(NOW + o.sessionHours * 3_600_000) } : {}) },
  weekly: { label: 'weekly', percent: weekly, ...(o.weeklyDays !== undefined ? { resetsAt: iso(NOW + o.weeklyDays * DAY) } : {}) },
});

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-pool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const make = (key: () => KeySource = () => ({ file: keyFile })) => new Vault({ file: path.join(data, 'vault.json'), key });
  return { dir, data, keyFile, make };
}

/** A vault with ben's two tokens, lothsahn's one, and a Claude entry nobody owns. */
function poolVault(make: ReturnType<typeof setup>['make']) {
  const v = make();
  v.add({ name: 'ben-a', kind: 'claude', value: B1, owner: 'ben', share: 'owner' });
  v.add({ name: 'ben-b', kind: 'claude', value: B2, owner: 'ben', share: 'owner' });
  v.add({ name: 'loth-a', kind: 'claude', value: L1, owner: 'lothsahn', share: 'owner' });
  v.add({ name: 'nobody', kind: 'claude', value: SHARED, share: 'anyone' });
  return v;
}

/** Meters by fingerprint, and live counts by fingerprint, the way server/index.ts supplies them. */
function world(meters: Record<string, PlanUsage | undefined>, live: Record<string, number> = {}) {
  return {
    usageOf: (fp: string) => meters[fp],
    liveOn: (fp: string) => live[fp] ?? 0,
    now: () => NOW,
  };
}
const fp = (v: string) => fingerprintOf(v);
const run = (userId: string | undefined, role: 'workers' | 'standing' | 'ops' | 'orchestrator' = 'workers', sessionId?: string) => ({ machineId: role === 'ops' || role === 'orchestrator' ? 'portal' : 'm3', role, userId, ...(sessionId ? { sessionId } : {}) });

test("pool: a person's runs use that person's own tokens only: no shared token, no one else's", (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const w = world({});
  for (const role of ['workers', 'standing', 'ops', 'orchestrator'] as const) {
    const ben = v.forRun(run('ben', role), { claude: true, ...w });
    assert.ok([B1, B2].includes(ben.claude?.token ?? ''), `ben's ${role} run is on one of ben's tokens`);
    assert.equal(ben.poolSize, 2);
    const loth = v.forRun(run('lothsahn', role), { claude: true, ...w });
    assert.equal(loth.claude?.token, L1);
  }
  // A person with no token of their own gets nothing from the vault, whatever else it holds: today's account (the caller's).
  const nobody = v.forRun(run('sam'), { claude: true, ...w });
  assert.equal(nobody.claude, undefined);
  assert.equal(nobody.claudeHold, undefined);
  assert.equal(nobody.poolSize ?? 0, 0);
  const unasked = v.forRun(run(undefined), { claude: true, ...w });
  assert.equal(unasked.claude, undefined, 'a run with no person has no pool');
  // The tokens that nobody owns are listed for the meters but never picked.
  assert.equal(v.claudeTokens().length, 4);
});

test('pool: the token with the most weekly headroom per hour to its reset is used first (w971); a held or retired one is skipped', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const m = {
    [fp(B1)]: usage(10, 30, { weeklyDays: 5, sessionHours: 3 }),
    [fp(B2)]: usage(10, 60, { weeklyDays: 2, sessionHours: 3 }),
  };
  assert.equal(v.forRun(run('ben'), { claude: true, ...world(m) }).claude?.entry.name, 'ben-b', '40% over 2 days beats 70% over 5');
  m[fp(B2)] = usage(85, 60, { weeklyDays: 2, sessionHours: 3 });
  assert.equal(v.forRun(run('ben'), { claude: true, ...world(m) }).claude?.entry.name, 'ben-a', 'ben-b is at 85% of its 5-hour window: held');
  m[fp(B2)] = usage(10, 99.4, { weeklyDays: 2 });
  assert.equal(v.forRun(run('ben'), { claude: true, ...world(m) }).claude?.entry.name, 'ben-a', 'ben-b retired until its week resets');
  // The limits are the config's (system-wide), read at each pick.
  m[fp(B1)] = usage(10, 90, { weeklyDays: 5 }); // little headroom left, so ben-b still scores higher at 60% of its 5-hour window
  m[fp(B2)] = usage(60, 60, { weeklyDays: 2 });
  const strict = () => poolLimits({ vault: { pool: { sessionHoldPercent: 50 } } });
  assert.equal(v.forRun(run('ben'), { claude: true, ...world(m), limits: strict }).claude?.entry.name, 'ben-a', 'held at 50% with the changed limit');
  assert.equal(v.forRun(run('ben'), { claude: true, ...world(m) }).claude?.entry.name, 'ben-b', 'and not at the default 80%');
});

test('pool: one process at a time at 95% weekly, counting processes starting now and not the asking session', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const m = { [fp(B1)]: usage(10, 96, { weeklyDays: 1 }), [fp(B2)]: usage(10, 96, { weeklyDays: 3 }) };
  // Idle: the first run takes ben-a (resets first).
  const s1 = v.forRun(run('ben', 'workers', 's1'), { claude: true, ...world(m) });
  assert.equal(s1.claude?.entry.name, 'ben-a');
  // A start in progress counts: the second run takes ben-b, the third finds both taken.
  const s2 = v.forRun(run('ben', 'workers', 's2'), { claude: true, ...world(m) });
  assert.equal(s2.claude?.entry.name, 'ben-b');
  const s3 = v.forRun(run('ben', 'workers', 's3'), { claude: true, ...world(m) });
  assert.equal(s3.claude, undefined);
  assert.match(s3.claudeHold?.why ?? '', /^no token is free for a new job right now \(ben-a: weekly 96%, one job at a time; its slot is taken \(1 running\)/);
  // Live counts from the portal do the same once the processes show.
  const live = { [fp(B1)]: 1, [fp(B2)]: 1 };
  assert.equal(v.forRun(run('ben', 'workers', 's9'), { claude: true, ...world(m, live) }).claude, undefined);
  // The session that is on ben-a does not count itself: it may start again on it (a resume).
  const mine = { [fp(B1)]: 0, [fp(B2)]: 1 };
  assert.equal(v.forRun(run('ben', 'workers', 's1'), { claude: true, ...world(m, mine) }).claude?.entry.name, 'ben-a', 'sticky, and alone on it');
});

test('pool: every token over its caps holds a worker; the orchestrator and the ops worker (w1112) use the pool up; used up stops them too', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const m: Record<string, PlanUsage> = {
    [fp(B1)]: usage(90, 40, { weeklyDays: 3, sessionHours: 2 }),
    [fp(B2)]: usage(85, 30, { weeklyDays: 5, sessionHours: 4 }),
  };
  for (const role of ['workers', 'standing'] as const) {
    const r = v.forRun(run('ben', role), { claude: true, ...world(m) });
    assert.equal(r.claude, undefined, role);
    assert.equal(r.poolSize, 2);
    assert.match(r.claudeHold?.why ?? '', /^every token is at a limit \(ben-a: .*\): the first frees up Fri 14:00Z$/, role);
    assert.equal(r.claudeHold?.next, iso(NOW + 2 * 3_600_000));
  }
  for (const role of ['orchestrator', 'ops'] as const) {
    const orch = v.forRun(run('ben', role), { claude: true, ...world(m) });
    assert.equal(orch.claude?.entry.name, 'ben-b', `${role}: the most room (85 against 90)`);
    assert.equal(orch.claude?.how, 'over-cap');
  }
  // Both used up: nobody, the orchestrator and the ops worker included.
  m[fp(B1)] = usage(100, 40, { sessionHours: 2 });
  m[fp(B2)] = usage(10, 100, { weeklyDays: 4 });
  for (const role of ['orchestrator', 'ops'] as const) {
    const o2 = v.forRun(run('ben', role), { claude: true, ...world(m) });
    assert.equal(o2.claude, undefined, role);
    assert.match(o2.claudeHold?.why ?? '', /^every token is used up \(/);
  }
  // lothsahn's pool is her own: ben's being held does not touch it.
  assert.equal(v.forRun(run('lothsahn'), { claude: true, ...world(m) }).claude?.token, L1);
});

test('pool: the ops worker takes the workers grants; the orchestrator takes none; a granted-nowhere token is not a worker token', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'ben-a', kind: 'claude', value: B1, owner: 'ben', share: 'owner', roles: ['standing'], machines: ['m5'] });
  const w = world({});
  assert.equal(v.forRun(run('ben', 'workers'), { claude: true, ...w }).claude, undefined, 'granted to standing agents on m5 only');
  assert.equal(v.forRun(run('ben', 'standing'), { claude: true, ...w }).claude, undefined, 'standing on m3: not granted');
  assert.equal(v.forRun(run('ben', 'orchestrator'), { claude: true, ...w }).claude?.token, B1, "the orchestrator's account setting is its consent");
  v.update('ben-a', { roles: ['workers'], machines: ['*'] });
  assert.equal(v.forRun(run('ben', 'ops'), { claude: true, ...w }).claude?.token, B1);
});

test("pool: lastPickOf names the token a session ran on, for the stopped session's meter; a removed token is forgotten", (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const r = v.forRun(run('ben', 'orchestrator', 'orch-ben'), { claude: true, ...world({}) });
  assert.equal(v.lastPickOf('orch-ben'), r.claude?.entry.fingerprint);
  assert.equal(v.lastPickOf('nobody-at-all'), undefined);
  v.remove(r.claude!.entry.name);
  assert.equal(v.lastPickOf('orch-ben'), undefined);
});

test('pools(): every person pool as the rules read it, no token in it', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const m = { [fp(B1)]: usage(85, 20, { sessionHours: 1, weeklyDays: 3 }), [fp(B2)]: usage(10, 96, { weeklyDays: 2 }) };
  const pools = v.pools({ ...world(m, { [fp(B2)]: 1 }), now: () => NOW });
  assert.deepEqual([...pools.keys()].sort(), ['ben', 'lothsahn'], 'the owner-less token is in no pool');
  const ben = pools.get('ben')!;
  assert.deepEqual(ben.map((x) => [x.entry.name, x.view.state]), [['ben-a', 'held'], ['ben-b', 'one-at-a-time']]);
  assert.equal(ben.find((x) => x.entry.name === 'ben-b')!.live, 1);
  assert.ok(!JSON.stringify([...pools]).includes(B1.slice(13, 40)), 'no value in it');
  assert.equal(pools.get('lothsahn')![0].view.state, 'ok');
});

// ---------------------------------------------------------------- machineRunEnv and poolRunEnv

function ctxOf(v: Vault, meters: Record<string, PlanUsage | undefined> = {}, live: Record<string, number> = {}): VaultContext & { problems: string[] } {
  const problems: string[] = [];
  return { vault: v, usageOf: (f) => meters[f], liveOn: (f) => live[f] ?? 0, payer: () => 'lothsahn', onProblem: (l) => problems.push(l), problems, limits: () => poolLimits(undefined), now: () => NOW };
}
const cfgOf = (extra: Record<string, unknown> = {}) => ({ machines: {}, ...extra }) as never;

/** A vault where the dispatcher is pinned to its own token "disp" (config claudeAccounts.dispatcher, w996): the only reserve there is (w1078). */
function pinned(make: ReturnType<typeof setup>['make']) {
  const vault = make();
  vault.add({ name: 'disp', kind: 'claude', value: DISP, owner: 'lothsahn', share: 'owner' });
  return { vault, cfg: { claudeAccounts: { orchestrator: 'vault', dispatcher: 'vault:disp' } } as never };
}

test('machineRunEnv: a worker waits (PoolHeldError) when its person pool is over its caps, and falls back to no one', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const m = { [fp(B1)]: usage(90, 40, { weeklyDays: 3, sessionHours: 2 }), [fp(B2)]: usage(95, 30, { weeklyDays: 5, sessionHours: 4 }) };
  const ctx = ctxOf(v, m);
  const ben = { userId: 'ben', displayName: 'Ben' };
  assert.throws(
    () => machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: ben, sessionId: 'w1' }, ctx),
    (e: unknown) => e instanceof PoolHeldError && /ben's Claude token pool is held: every token is at a limit \(.*\): the first frees up Fri 14:00Z$/.test(e.message) && e.next === iso(NOW + 2 * 3_600_000) && !e.message.includes(B1.slice(13, 40)),
  );
  // Never another credential, nor another person's token.
  assert.equal(ctx.problems.length, 0, 'held is not a problem: nothing reported');
  // Ben's pool frees up: he gets his token, alone, with the daemon's other credentials dropped.
  m[fp(B1)] = usage(30, 40, { weeklyDays: 3 });
  const ok = machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: ben, sessionId: 'w1' }, ctx);
  assert.equal(ok.env.CLAUDE_CODE_OAUTH_TOKEN, B1);
  assert.equal(ok.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(ok.login, true);
  assert.match(ok.account, /^vault token ben-a …bbbb \(ben's pool, docs\/vault.md\)$/);
  // Work nobody asked for runs on the system payer's pool (lothsahn here), not on a shared token.
  const unasked = machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', sessionId: 'w2' }, ctx);
  assert.equal(unasked.env.CLAUDE_CODE_OAUTH_TOKEN, L1);
});

test("w1078: a person with no vault tokens gets no run on any other credential; one with a pool whose vault cannot be opened waits (w1031)", (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const ctx = ctxOf(v);
  const sam = { userId: 'sam', displayName: 'Sam' };
  assert.throws(
    () => machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: sam, sessionId: 'w1' }, ctx),
    (e: unknown) => e instanceof PoolHeldError && /sam has no Claude token in the vault, so a workers run on m3 cannot start/.test(e.message),
  );
  assert.match(ctx.problems.at(-1) ?? '', /sam has no Claude token in the vault/);
  // Ben has tokens but the vault key is gone: the run waits for the vault to be fixed, with the reason (lothsahn, w1031: their
  // work "NEVER falls back to the host token or to Ben's pool"; w1078: there is no host token).
  const nokey = ctxOf(make(() => ({ why: 'no vault key: test' })));
  assert.throws(
    () => machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: { userId: 'ben', displayName: 'Ben' }, sessionId: 'w3' }, nokey),
    (e: unknown) => e instanceof PoolHeldError && /ben's Claude token pool cannot serve a workers run on m3: the vault cannot open ben-a, ben-b: no vault key: test/.test(e.message),
  );
  assert.match(nokey.problems.join('\n'), /the vault cannot open ben-a, ben-b: no vault key: test/);
});

test('poolRunEnv: the orchestrator and the ops worker run on that person token alone; every other Claude credential is gone', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const ctx = ctxOf(v, { [fp(B1)]: usage(10, 50, { weeklyDays: 4 }), [fp(B2)]: usage(10, 50, { weeklyDays: 2 }) });
  const was = { key: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = ['sk-ant-api03-', 'z'.repeat(40)].join('');
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'server-own';
  t.after(() => {
    for (const [k, x] of [['ANTHROPIC_API_KEY', was.key], ['CLAUDE_CODE_OAUTH_TOKEN', was.oauth]] as const) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  });
  for (const role of ['orchestrator', 'ops'] as const) {
    const r = poolRunEnv({ role, personId: 'ben', sessionId: `s-${role}` }, ctx);
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, B2, `${role}: ben's token that resets first`);
    assert.equal(r.env.ANTHROPIC_API_KEY, undefined, 'an API key would outrank the token: gone');
    assert.match(r.account, /^vault token ben-b …cccc \(ben's pool/);
    assert.ok(!JSON.stringify(r.account).includes(B2.slice(13, 40)));
  }
  assert.equal(poolRunEnv({ role: 'orchestrator', personId: 'lothsahn' }, ctx).env.CLAUDE_CODE_OAUTH_TOKEN, L1, "each person's orchestrator on their own");
  // A new token in the vault applies to the next session start, no restart: ben-c resets sooner than anything.
  v.add({ name: 'ben-c', kind: 'claude', value: claudeTok('h'), owner: 'ben', share: 'owner' });
  const meters = { [fp(claudeTok('h'))]: usage(10, 50, { weeklyDays: 1 }), [fp(B1)]: usage(10, 50, { weeklyDays: 4 }), [fp(B2)]: usage(10, 50, { weeklyDays: 2 }) };
  const ctx2 = ctxOf(v, meters);
  assert.equal(poolRunEnv({ role: 'orchestrator', personId: 'ben' }, ctx2).env.CLAUDE_CODE_OAUTH_TOKEN, claudeTok('h'));
});

test('poolRunEnv (w1078): no pool token, no person, or tokens the vault cannot open stop the start with the reason, on no other credential', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const ctx = ctxOf(v);
  assert.throws(() => poolRunEnv({ role: 'orchestrator', personId: 'sam' }, ctx), (e: unknown) => e instanceof PoolHeldError && /sam has no Claude token in the vault, so an orchestrator cannot start/.test(e.message));
  assert.throws(() => poolRunEnv({ role: 'ops', personId: undefined }, ctx), (e: unknown) => e instanceof PoolHeldError && /the orchestration worker is for nobody/.test(e.message), 'the ops worker with no caller');
  // The vault cannot open ben's tokens: the problem is named (never a value).
  const nokey = ctxOf(make(() => ({ why: 'no vault key: test' })));
  assert.throws(() => poolRunEnv({ role: 'orchestrator', personId: 'ben' }, nokey), (e: unknown) => e instanceof PoolHeldError && /ben's Claude token pool cannot serve an orchestrator: .*no vault key: test/.test(e.message));
  assert.match(nokey.problems.join('\n'), /no vault key: test/);
});

test("poolRunEnv: the orchestrator and the ops worker stop when its pool is used up and the error shows the reset, never a token; capped holds neither (w1112)", (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const used = ctxOf(v, { [fp(B1)]: usage(100, 40, { sessionHours: 2 }), [fp(B2)]: usage(10, 100, { weeklyDays: 3 }) });
  assert.throws(
    () => poolRunEnv({ role: 'orchestrator', personId: 'ben' }, used),
    (e: unknown) => e instanceof PoolHeldError && /ben's Claude token pool is used up: every token is used up \(.*\): the first frees up Fri 14:00Z$/.test(e.message) && !e.message.includes(B1.slice(13, 40)) && !e.message.includes(DISP.slice(13, 40)),
  );
  const capped = ctxOf(v, { [fp(B1)]: usage(90, 40, { sessionHours: 2 }), [fp(B2)]: usage(85, 30, { weeklyDays: 3, sessionHours: 4 }) });
  // The orchestrator and (w1112) the ops worker on the same pool still run: over its cap, on the token with the most room.
  assert.equal(poolRunEnv({ role: 'orchestrator', personId: 'ben' }, capped).env.CLAUDE_CODE_OAUTH_TOKEN, B2);
  const ops = poolRunEnv({ role: 'ops', personId: 'ben' }, capped);
  assert.equal(ops.env.CLAUDE_CODE_OAUTH_TOKEN, B2);
  assert.match(ops.account, /over its caps: used up first/);
  // Used up stops the ops worker too, and says so.
  assert.throws(() => poolRunEnv({ role: 'ops', personId: 'ben' }, used), (e: unknown) => e instanceof PoolHeldError && /^ben's Claude token pool is used up, so the orchestration worker cannot start until a token resets/.test(e.message));
  // Neither falls to another credential: the stop is the stop.
});

// ---------------------------------------------------------------- the dispatcher and its reserve

test('hostAccount: "vault" for the orchestrators; the dispatcher that is not pinned runs on the system payer\'s pool, also "vault"', () => {
  const cfg = { claudeAccounts: { orchestrator: 'vault' } } as never;
  assert.equal(hostAccount(cfg, 'orchestrator'), 'vault');
  assert.equal(hostAccount(cfg, 'dispatcher'), 'vault');
  assert.equal(hostAccount({} as never, 'dispatcher'), 'vault');
  assert.equal(hostAccount({ claudeAccounts: { orchestrator: 'vault', dispatcher: 'vault:disp' } } as never, 'dispatcher'), 'vault:disp');
});

test('the reserve is the dispatcher\'s pinned vault token alone: unpinned there is none, and a pin the vault cannot give has none', (t) => {
  const { make } = setup(t);
  const { vault, cfg } = pinned(make);
  const a = reservedCredentials(cfg, { vault });
  assert.deepEqual(a.map((c) => [c.role, c.key]), [['dispatcher', tokenKey(DISP)]]);
  assert.match(a[0].what, /^the dispatcher's vault token disp …ffff$/);
  assert.deepEqual(reservedCredentials({ claudeAccounts: { orchestrator: 'vault' } } as never, { vault }), [], 'unpinned: the system payer\'s pool, held by its own limits like anyone\'s');
  vault.update('disp', { disabled: true });
  assert.deepEqual(reservedCredentials(cfg, { vault }), [], 'no usable token to name');
  assert.deepEqual(reservedCredentials(cfg, undefined), [], 'no vault at all');
});

test("reserveLines: the dispatcher's token shows its reserve; runs inside it raise the warning; none without readings or users", (t) => {
  const { make } = setup(t);
  const { vault, cfg } = pinned(make);
  const key = tokenKey(DISP);
  const meters: Record<string, PlanUsage | undefined> = { [key]: usage(12, 41, { weeklyDays: 5 }) };
  const none = (_: string) => 0;
  const calm = reserveLines(cfg, (k) => meters[k], none, NOW, { vault });
  assert.equal(calm.length, 1);
  assert.equal(calm[0].line, "dispatcher's vault token disp …ffff: weekly 41%, reserve 25% (5 days to reset); 5-hour 12%, reserve 20%");
  assert.equal(calm[0].warning, undefined);
  // Inside the buffer with another person's orchestrator on it (a person with no vault token yet): a warning, not a refusal.
  meters[key] = usage(12, 83, { weeklyDays: 5 });
  const busy = reserveLines(cfg, (k) => meters[k], (k, role) => (k === key && role === 'dispatcher' ? 2 : 0), NOW, { vault });
  assert.equal(busy[0].line, `dispatcher's vault token disp …ffff: weekly 83%, reserve 25% (5 days to reset); 5-hour 12%, reserve 20%; inside its reserve (weekly 83% (buffer 25%), resets ${clock(iso(NOW + 5 * DAY))}), kept for the dispatcher; 2 other runs using it`);
  assert.equal(busy[0].warning, `dispatcher's vault token disp …ffff is the last token with room for 2 runs and is inside the buffer kept for the dispatcher: weekly 83% (buffer 25%), resets ${clock(iso(NOW + 5 * DAY))}`);
  // Inside the buffer and nobody else on it: the dispatcher alone uses it, as intended: no warning.
  const alone = reserveLines(cfg, (k) => meters[k], none, NOW, { vault });
  assert.match(alone[0].line, /inside its reserve \(weekly 83% .*\), kept for the dispatcher$/);
  assert.equal(alone[0].warning, undefined);
  // No reading yet: counted as inside its reserve.
  const unread = reserveLines(cfg, () => undefined, none, NOW, { vault });
  assert.match(unread[0].line, /no reading yet \(counted as inside its reserve\)/);
  // 5 days to the reset gives 25; the figure per day is the system-wide config.
  const slow = reserveLines({ ...(cfg as object), vault: { pool: { reservePerDayPercent: 2 } } } as never, (k) => meters[k], none, NOW, { vault });
  assert.match(slow[0].line, /reserve 10% \(5 days to reset\)/);
  assert.ok(![calm, busy, alone, unread].some((x) => x.some((l) => l.line.includes(DISP.slice(13, 40)))), 'a line shows the last four characters only');
});

test("w828: the warning names the limit that put the token inside its buffer: 5-hour only, weekly only, both, no reading", (t) => {
  const { make } = setup(t);
  const { vault, cfg } = pinned(make);
  const two = (k: string, role: string) => (k === tokenKey(DISP) && role === 'dispatcher' ? 2 : 0);
  const warn = (u: PlanUsage | undefined) => reserveLines(cfg, (k) => (k === tokenKey(DISP) ? u : undefined), two, NOW, { vault })[0];
  const tail = /^dispatcher's vault token disp …ffff is the last token with room for 2 runs and is inside the buffer kept for the dispatcher: /;
  // The live case: weekly 51% (buffer 26%, not inside it) and 5-hour 93% (buffer 20%, inside it). The week is not blamed.
  const sessionOnly = warn(usage(93, 51, { weeklyDays: 5.2, sessionHours: 1 / 6 }));
  assert.match(sessionOnly.warning ?? '', tail);
  assert.equal((sessionOnly.warning ?? '').replace(tail, ''), '5-hour 93% (buffer 20%), resets in 10 min');
  assert.doesNotMatch(sessionOnly.warning ?? '', /weekly/);
  assert.match(sessionOnly.line, /inside its reserve \(5-hour 93% \(buffer 20%\), resets in 10 min\), kept for the dispatcher/);
  // Weekly only: 5-hour at 12% is not a reason.
  const weeklyOnly = warn(usage(12, 83, { weeklyDays: 5, sessionHours: 2 }));
  assert.equal((weeklyOnly.warning ?? '').replace(tail, ''), `weekly 83% (buffer 25%), resets ${clock(iso(NOW + 5 * DAY))}`);
  assert.doesNotMatch(weeklyOnly.warning ?? '', /5-hour/);
  // Both inside: both named, the 5-hour first.
  const both = warn(usage(93, 97, { weeklyDays: 1, sessionHours: 1.5 }));
  // Weekly 97% is past the stop line (95%, w1109), which is named instead of the buffer.
  assert.equal((both.warning ?? '').replace(tail, ''), '5-hour 93% (buffer 20%), resets in 1 h 30 min; weekly 97% (stop line 95%), resets in 24 h');
  // No reading: said plainly, with no figure invented.
  const unread = warn(undefined);
  assert.equal((unread.warning ?? '').replace(tail, ''), 'no reading yet (counted as inside the buffer)');
  assert.doesNotMatch(unread.warning ?? '', /\d%/);
  // A meter with no reset time says so rather than inventing one.
  assert.match(warn(usage(93, 10)).warning ?? '', /5-hour 93% \(buffer 20%\), resets at an unknown time$/);
});

test("the dispatcher is never held by its own reserve: its environment is its pinned token whatever the meters say", (t) => {
  const { make } = setup(t);
  const { vault, cfg } = pinned(make);
  // pinnedDispatcherEnv consults no meter: at 99.9% weekly and 100% of the 5-hour window the dispatcher still starts on it.
  const env = pinnedDispatcherEnv(cfg, { vault, usageOf: () => usage(100, 99.9, { weeklyDays: 0.1 }) })!.env;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, DISP);
  // And the reserve is a line and a warning, never an exception: reserveLines returns even at 100%.
  const full = reserveLines(cfg, () => usage(100, 99.9, { weeklyDays: 0.1 }), () => 0, NOW, { vault });
  assert.equal(full.length, 1);
  assert.match(full[0].line, /inside its reserve \(.*\), kept for the dispatcher/);
});

// ---------------------------------------------------------------- config

test('config: "vault" is the account of the orchestrators and the unpinned dispatcher; workers have none; vault.pool is checked at load', () => {
  checkAccountConfig({ claudeAccounts: { orchestrator: 'vault', dispatcher: 'vault' } } as never);
  checkAccountConfig({ claudeAccounts: { orchestrator: 'vault', dispatcher: 'vault:disp' } } as never);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { dispatcher: 'tokenfile' } } as never), /every Claude process runs on a vault token \(w1078\)/, 'retired (w1078)');
  assert.throws(() => checkAccountConfig({ claudeAccounts: { workers: 'vault' } } as never), /claudeAccounts\.workers: no such role/, 'retired (w755): not a role any more');
  checkAccountConfig({ vault: { pool: { sessionHoldPercent: 70, reservePerDayPercent: 0 } } } as never);
  assert.throws(() => checkAccountConfig({ vault: { pool: { sessionHoldPercent: 101 } } } as never), /percent from 0 to 100/);
  assert.throws(() => checkAccountConfig({ vault: { pool: { onePerWeeklyPercent: 99.9 } } } as never), /above retireWeeklyPercent/);
  assert.throws(() => checkAccountConfig({ vault: { pool: { retireWeeklyPercent: 90, onePerWeeklyPercent: 95 } } } as never), /above retireWeeklyPercent/);
});

test('set_app_config: the pool limits are anyone\'s, checked, applied live and cleared by null', (t) => {
  assert.equal(normalizeSetting('claudeAccounts.dispatcher', 'vault'), undefined, 'the account setting is the owner\'s only (w1078)');
  assert.equal(OWNER_ONLY_KEYS.has('claudeAccounts.dispatcher'), true);
  // Not owner-only keys: the pool limits are one system-wide set that any person's orchestrator may change.
  for (const k of ['vault.pool.sessionHoldPercent', 'vault.pool.onePerWeeklyPercent', 'vault.pool.retireWeeklyPercent', 'vault.pool.reservePerDayPercent', 'vault.pool.reserveSessionPercent', 'vault.pool.dispatcherStopPercent', 'vault.pool.nearResetHours', 'vault.pool.nearResetFloorTokens', 'vault.pool.resetOffsetHours'] as const) {
    assert.equal(OWNER_ONLY_KEYS.has(k), false, k);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8790 }));
  const cfg = { voice: { vocabulary: [], ttsVoice: 'af_heart', device: 'auto' } } as unknown as Config;
  assert.deepEqual(setAppConfig(file, cfg, 'vault.pool.sessionHoldPercent', 70), { before: undefined, after: 70 });
  assert.equal(poolLimits(cfg).sessionHold, 70, 'live: the next pick reads it');
  setAppConfig(file, cfg, 'vault.pool.reservePerDayPercent', '8');
  assert.equal(poolLimits(cfg).reservePerDay, 8, 'a number given as text');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).vault.pool, { sessionHoldPercent: 70, reservePerDayPercent: 8 }, 'written to config.json');
  // Invalid values are refused; the other limit in the pair is read from the config.
  for (const bad of [101, -1, 'lots', NaN, '']) assert.throws(() => setAppConfig(file, cfg, 'vault.pool.sessionHoldPercent', bad as never), /percent from 0 to 100|is a percent/, String(bad));
  assert.throws(() => setAppConfig(file, cfg, 'vault.pool.onePerWeeklyPercent', 99.5), /cannot be above vault.pool.retireWeeklyPercent \(99\)/);
  assert.throws(() => setAppConfig(file, cfg, 'vault.pool.retireWeeklyPercent', 90), /cannot be below vault.pool.onePerWeeklyPercent \(95\)/);
  setAppConfig(file, cfg, 'vault.pool.onePerWeeklyPercent', 85);
  assert.equal(poolLimits(cfg).onePerWeekly, 85);
  setAppConfig(file, cfg, 'vault.pool.retireWeeklyPercent', 90);
  assert.throws(() => setAppConfig(file, cfg, 'vault.pool.onePerWeeklyPercent', 95), /cannot be above vault.pool.retireWeeklyPercent \(90\)/);
  assert.throws(() => setAppConfig(file, cfg, 'vault.pool.retireWeeklyPercent', 80), /cannot be below vault.pool.onePerWeeklyPercent \(85\)/);
  // null puts a limit back to its default.
  setAppConfig(file, cfg, 'vault.pool.sessionHoldPercent', null);
  assert.equal(poolLimits(cfg).sessionHold, 80);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).vault.pool.sessionHoldPercent, undefined);
  // The near-reset rule's two settings (w1539): hours from 0 (off) to 168, a whole number of tokens from 0 to 10.
  setAppConfig(file, cfg, 'vault.pool.nearResetHours', '8');
  assert.equal(poolLimits(cfg).nearResetHours, 8);
  setAppConfig(file, cfg, 'vault.pool.nearResetFloorTokens', 2);
  assert.equal(poolLimits(cfg).nearResetFloor, 2);
  for (const bad of [169, -1, 'soon', '']) assert.throws(() => setAppConfig(file, cfg, 'vault.pool.nearResetHours', bad as never), /nearResetHours is a number of hours from 0 \(off\) to 168/, String(bad));
  for (const bad of [1.5, 11, -1]) assert.throws(() => setAppConfig(file, cfg, 'vault.pool.nearResetFloorTokens', bad as never), /nearResetFloorTokens is a whole number of tokens from 0 to 10/, String(bad));
  // The score's soft offset (w1659): hours from 0 (off) to 168.
  assert.equal(poolLimits(cfg).resetOffsetHours, 24);
  setAppConfig(file, cfg, 'vault.pool.resetOffsetHours', '18');
  assert.equal(poolLimits(cfg).resetOffsetHours, 18);
  setAppConfig(file, cfg, 'vault.pool.resetOffsetHours', 0);
  assert.equal(poolLimits(cfg).resetOffsetHours, 0);
  for (const bad of [169, -1, 'soon', '']) assert.throws(() => setAppConfig(file, cfg, 'vault.pool.resetOffsetHours', bad as never), /resetOffsetHours is a number of hours from 0 \(off\) to 168/, String(bad));
  setAppConfig(file, cfg, 'vault.pool.resetOffsetHours', null);
  assert.equal(poolLimits(cfg).resetOffsetHours, 24);
});

// ---------------------------------------------------------------- w971: the reserve is enforced, the score orders

test("w971: the dispatcher's token in a person's pool, inside its reserve, goes to no worker, no ops worker and no orchestrator while another token has room", (t) => {
  const { make } = setup(t);
  const v = make();
  // ben-a is the dispatcher's pinned token (also in Ben's pool); ben-b is another token. The 04:32Z picture: 97% vs 27% weekly, 4 days to go.
  v.add({ name: 'ben-a', kind: 'claude', value: DISP, owner: 'ben', share: 'owner' });
  v.add({ name: 'ben-b', kind: 'claude', value: B2, owner: 'ben', share: 'owner' });
  const meters: Record<string, PlanUsage | undefined> = { [fp(DISP)]: usage(10, 97, { weeklyDays: 4, sessionHours: 3 }), [fp(B2)]: usage(10, 27, { weeklyDays: 4, sessionHours: 3 }) };
  const cfg = cfgOf({ claudeAccounts: { orchestrator: 'vault', dispatcher: 'vault:ben-a' } });
  const ctx = { ...ctxOf(v, meters), reservedFor: (f: string) => (f === fp(DISP) ? 'the dispatcher' : undefined) };
  const ben = { userId: 'ben', displayName: 'Ben' };
  const token = (e: { CLAUDE_CODE_OAUTH_TOKEN?: string }) => e.CLAUDE_CODE_OAUTH_TOKEN;
  assert.equal(token(machineRunEnv(cfg, { id: 'm3' }, { role: 'workers', requestedBy: ben, sessionId: 'w1' }, ctx).env), B2, 'a worker');
  assert.equal(token(poolRunEnv({ role: 'ops', personId: 'ben', sessionId: 'ops1' }, ctx).env), B2, 'the ops worker');
  assert.equal(token(poolRunEnv({ role: 'orchestrator', personId: 'ben', sessionId: 'orch1' }, ctx).env), B2, 'the orchestrator');
  // Without the reserve known (the old code), the token with the sooner... both reset together, so it would have been by name: the point is the reserve decides.
  const noReserve = { ...ctx, reservedFor: undefined };
  assert.equal(token(machineRunEnv(cfg, { id: 'm3' }, { role: 'workers', requestedBy: ben, sessionId: 'w2' }, noReserve).env), B2, 'by score alone ben-b wins too');
  // The other token fills up (5-hour window held): the worker waits, the orchestrator uses the reserve, the ops worker (w1112)
  // the held token, keeping the dispatcher's buffer.
  meters[fp(B2)] = usage(90, 27, { weeklyDays: 4, sessionHours: 2 });
  assert.throws(
    () => machineRunEnv(cfg, { id: 'm3' }, { role: 'workers', requestedBy: ben, sessionId: 'w3' }, ctx),
    (e: unknown) => e instanceof PoolHeldError && /inside the buffer kept for the dispatcher/.test(e.message) && e.next === iso(NOW + 2 * 3_600_000) && !e.message.includes(DISP.slice(13, 40)),
  );
  assert.equal(token(poolRunEnv({ role: 'ops', personId: 'ben', sessionId: 'ops2' }, ctx).env), B2, 'the ops worker: held by no cap, out of the buffer');
  const orch = poolRunEnv({ role: 'orchestrator', personId: 'ben', sessionId: 'orch2' }, ctx);
  assert.equal(token(orch.env), DISP, 'nothing else has room: today\'s behaviour for the orchestrator');
  assert.match(orch.account, /inside the dispatcher's reserve: no other token has room/);
  // The week runs out: the buffer (5% a day) shrinks below what is left and the token is an ordinary one again (94% at 0.5 days: buffer 2.5%).
  meters[fp(DISP)] = usage(10, 94, { weeklyDays: 0.5, sessionHours: 3 });
  meters[fp(B2)] = usage(10, 90, { weeklyDays: 4, sessionHours: 3 }); // little headroom: the score now favours the ex-reserved token
  assert.equal(token(machineRunEnv(cfg, { id: 'm3' }, { role: 'workers', requestedBy: ben, sessionId: 'w4' }, ctx).env), DISP);
  // A session already running on it is never touched: only the next start asks the pool.
});

test('w979: the pool listing orders by the picker, labels each token, and marks priority on exactly one token per pool', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'ben-a', kind: 'claude', value: DISP, owner: 'ben', share: 'owner' });
  v.add({ name: 'ben-b', kind: 'claude', value: B2, owner: 'ben', share: 'owner' });
  v.add({ name: 'ben-c', kind: 'claude', value: B1, owner: 'ben', share: 'owner' });
  v.add({ name: 'loth-a', kind: 'claude', value: L1, owner: 'lothsahn', share: 'owner' });
  const reservedFor = (f: string) => (f === fp(DISP) ? 'the dispatcher' : undefined);
  const labels = (m: Record<string, PlanUsage | undefined>, live: Record<string, number> = {}) => {
    const pools = v.pools({ ...world(m, live), reservedFor });
    return { pools, ben: pools.get('ben')!.map((x) => `${x.entry.name} ${poolLabel(x.view, x.priority)}`), loth: pools.get('lothsahn')!.map((x) => `${x.entry.name} ${poolLabel(x.view, x.priority)}`) };
  };
  // The 04:32Z picture: ben-a (the dispatcher's) at 97% inside its reserve, ben-b at 27%, ben-c at 60%.
  const m = { [fp(DISP)]: usage(0, 97, { weeklyDays: 3 }), [fp(B2)]: usage(0, 27, { weeklyDays: 4 }), [fp(B1)]: usage(0, 60, { weeklyDays: 4 }), [fp(L1)]: usage(0, 98, { weeklyDays: 1 }) };
  const r = labels(m);
  assert.deepEqual(r.ben, ['ben-b pool:ok priority', 'ben-c pool:ok', 'ben-a pool:reserved'], 'best first, priority on the one a new job gets');
  assert.deepEqual(r.loth, ['loth-a pool:one-at-a-time priority'], "one at a time with the slot free: priority still goes to it, it takes the next job");
  for (const [, list] of r.pools) assert.equal(list.filter((x) => x.priority).length, 1, 'exactly one per pool');
  // Its slot taken: one-at-a-time, and no priority (nothing may serve a worker): none, not two.
  const taken = labels(m, { [fp(L1)]: 1 });
  assert.deepEqual(taken.loth, ['loth-a pool:one-at-a-time']);
  assert.equal(taken.pools.get('lothsahn')!.filter((x) => x.priority).length, 0);
  // The best token fills its 5-hour window: priority moves to the next.
  const held = labels({ ...m, [fp(B2)]: usage(85, 27, { weeklyDays: 4, sessionHours: 2 }) });
  assert.deepEqual(held.ben, ['ben-c pool:ok priority', 'ben-b pool:held', 'ben-a pool:reserved']);
  assert.ok(!r.ben.concat(r.loth).join(' ').match(/score|%\/day|left over/));
});

test('w1539/w1659: a token near its reset takes priority in the listing by weight, on exactly one token per pool, and its caps read as lifted', (t) => {
  const { make } = setup(t);
  const v = make();
  v.add({ name: 'ben-a', kind: 'claude', value: B1, owner: 'ben', share: 'owner' });
  v.add({ name: 'ben-b', kind: 'claude', value: B2, owner: 'ben', share: 'owner' });
  v.add({ name: 'ben-c', kind: 'claude', value: SHARED, owner: 'ben', share: 'owner' });
  v.add({ name: 'loth-a', kind: 'claude', value: L1, owner: 'lothsahn', share: 'owner' });
  const H = 1 / 24;
  const labels = (m: Record<string, PlanUsage | undefined>, live: Record<string, number> = {}, cfg?: object) => {
    const pools = v.pools({ ...world(m, live), limits: () => poolLimits(cfg as never) });
    const one = (p: string) => pools.get(p)!.map((x) => `${x.entry.name} ${poolLabel(x.view, x.priority)}`);
    return { ben: one('ben'), loth: one('lothsahn'), priorities: [...pools.values()].map((list) => list.filter((x) => x.priority).length) };
  };
  // ben-a: 93% used, resets in 11 h; ben-b fresh (6 days); ben-c 60% (3 days). lothsahn's one token far from its reset.
  const m = { [fp(B1)]: usage(0, 93, { weeklyDays: 11 * H }), [fp(B2)]: usage(0, 1, { weeklyDays: 6 }), [fp(SHARED)]: usage(0, 60, { weeklyDays: 3 }), [fp(L1)]: usage(0, 40, { weeklyDays: 4 }) };
  const r = labels(m);
  assert.deepEqual(r.ben, ['ben-a pool:ok priority', 'ben-b pool:ok', 'ben-c pool:ok'], 'the near-reset token first, by the soft offset');
  assert.deepEqual(r.loth, ['loth-a pool:ok priority']);
  assert.deepEqual(r.priorities, [1, 1], 'exactly one priority per pool');
  // Both rules off: the score order of w971, priority on the fresh token.
  const off = labels(m, {}, { vault: { pool: { nearResetHours: 0, resetOffsetHours: 0 } } });
  assert.deepEqual(off.ben, ['ben-b pool:ok priority', 'ben-a pool:ok', 'ben-c pool:ok']);
  // At 97% with a job on it, inside the window: its one-at-a-time cap is lifted (pool:ok, not one-at-a-time), and its last 3%
  // 11 h out still outweighs the fresh token (1.38 against 0.82 %/h with the 24 h offset), on exactly one token. At 99% it no
  // longer does (0.46).
  const late = labels({ ...m, [fp(B1)]: usage(0, 97, { weeklyDays: 11 * H }) }, { [fp(B1)]: 1 });
  assert.deepEqual(late.ben, ['ben-a pool:ok priority', 'ben-b pool:ok', 'ben-c pool:ok']);
  assert.deepEqual(late.priorities, [1, 1]);
  const later = labels({ ...m, [fp(B1)]: usage(0, 99, { weeklyDays: 11 * H }) }, { [fp(B1)]: 1 });
  assert.deepEqual(later.ben, ['ben-b pool:ok priority', 'ben-c pool:ok', 'ben-a pool:ok']);
  // lothsahn's case (w1659, Ben's pool at ~06:00Z 2026-10-21): 12% left 26 h out takes priority over 58% left 119 h out.
  const ben = { [fp(B1)]: usage(4, 42, { weeklyDays: 119 * H }), [fp(B2)]: usage(0, 88, { weeklyDays: 26 * H }), [fp(SHARED)]: usage(8, 78, { weeklyDays: 45 * H }), [fp(L1)]: usage(0, 40, { weeklyDays: 4 }) };
  assert.deepEqual(labels(ben).ben, ['ben-b pool:ok priority', 'ben-c pool:ok', 'ben-a pool:ok']);
  assert.deepEqual(labels(ben, {}, { vault: { pool: { resetOffsetHours: 0 } } }).ben, ['ben-a pool:ok priority', 'ben-b pool:ok', 'ben-c pool:ok'], 'without the offset: the 58% token, as the portal showed');
});
