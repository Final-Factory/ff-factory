import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolHeldError, Vault, fingerprintOf, newKeyText, type KeySource, type VaultContext } from './vault.ts';
import { hostAccount, hostProcessEnv, machineRunEnv, poolRunEnv, reserveLines, reservedCredentials } from './secrets.ts';
import { checkAccountConfig } from './config.ts';
import { OWNER_ONLY_KEYS, normalizeSetting, setAppConfig } from './appConfig.ts';
import { poolLimits } from './tokenPool.ts';
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
const FILE = claudeTok('f'); // the token file: the dispatcher's
const HOST = claudeTok('g'); // config claudeEnv: the host token
const API_KEY = ['sk-ant-api03-', 'z'.repeat(40)].join('');

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
  const tokenFile = path.join(dir, 'claude-oauth-token');
  fs.writeFileSync(tokenFile, `${FILE}\n`, { mode: 0o600 });
  const make = (key: () => KeySource = () => ({ file: keyFile })) => new Vault({ file: path.join(data, 'vault.json'), key });
  return { dir, data, keyFile, tokenFile, make };
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

test('pool: the token whose weekly window resets first is used first; a held or retired one is skipped', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const m = {
    [fp(B1)]: usage(10, 30, { weeklyDays: 5, sessionHours: 3 }),
    [fp(B2)]: usage(10, 60, { weeklyDays: 2, sessionHours: 3 }),
  };
  assert.equal(v.forRun(run('ben'), { claude: true, ...world(m) }).claude?.entry.name, 'ben-b', 'resets sooner');
  m[fp(B2)] = usage(85, 60, { weeklyDays: 2, sessionHours: 3 });
  assert.equal(v.forRun(run('ben'), { claude: true, ...world(m) }).claude?.entry.name, 'ben-a', 'ben-b is at 85% of its 5-hour window: held');
  m[fp(B2)] = usage(10, 99.4, { weeklyDays: 2 });
  assert.equal(v.forRun(run('ben'), { claude: true, ...world(m) }).claude?.entry.name, 'ben-a', 'ben-b retired until its week resets');
  // The limits are the config's (system-wide), read at each pick.
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
  assert.match(s3.claudeHold?.why ?? '', /^no token is free for a new job right now \(ben-a: weekly 96%, one job at a time until 99%: 3% left before it stops; the slot is taken now/);
  // Live counts from the portal do the same once the processes show.
  const live = { [fp(B1)]: 1, [fp(B2)]: 1 };
  assert.equal(v.forRun(run('ben', 'workers', 's9'), { claude: true, ...world(m, live) }).claude, undefined);
  // The session that is on ben-a does not count itself: it may start again on it (a resume).
  const mine = { [fp(B1)]: 0, [fp(B2)]: 1 };
  assert.equal(v.forRun(run('ben', 'workers', 's1'), { claude: true, ...world(m, mine) }).claude?.entry.name, 'ben-a', 'sticky, and alone on it');
});

test('pool: every token over its caps holds a worker and the ops worker; the orchestrator uses the pool up; used up stops it too', (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const m: Record<string, PlanUsage> = {
    [fp(B1)]: usage(90, 40, { weeklyDays: 3, sessionHours: 2 }),
    [fp(B2)]: usage(85, 30, { weeklyDays: 5, sessionHours: 4 }),
  };
  for (const role of ['workers', 'standing', 'ops'] as const) {
    const r = v.forRun(run('ben', role), { claude: true, ...world(m) });
    assert.equal(r.claude, undefined, role);
    assert.equal(r.poolSize, 2);
    assert.match(r.claudeHold?.why ?? '', /^every token is at a limit \(ben-a: .*\): the first frees up Fri 14:00Z$/, role);
    assert.equal(r.claudeHold?.next, iso(NOW + 2 * 3_600_000));
  }
  const orch = v.forRun(run('ben', 'orchestrator'), { claude: true, ...world(m) });
  assert.equal(orch.claude?.entry.name, 'ben-b', 'the most room (85 against 90)');
  assert.equal(orch.claude?.how, 'over-cap');
  // Both used up: nobody, the orchestrator included.
  m[fp(B1)] = usage(100, 40, { sessionHours: 2 });
  m[fp(B2)] = usage(10, 100, { weeklyDays: 4 });
  const o2 = v.forRun(run('ben', 'orchestrator'), { claude: true, ...world(m) });
  assert.equal(o2.claude, undefined);
  assert.match(o2.claudeHold?.why ?? '', /^every token is used up \(/);
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
  return { vault: v, usageOf: (f) => meters[f], liveOn: (f) => live[f] ?? 0, payer: () => 'lothsahn', onProblem: (l) => problems.push(l), problems, limits: () => poolLimits(undefined) };
}
const cfgOf = (extra: Record<string, unknown> = {}) =>
  ({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST, ANTHROPIC_API_KEY: API_KEY, CLAUDE_CONFIG_DIR: '/x' }, userClaudeEnv: {}, machines: { claudeFromVault: true }, ...extra }) as never;

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
  // Never the host token, the machine's login, nor another person's token (the dispatcher's token file is not a worker's at all).
  assert.equal(ctx.problems.length, 0, 'held is not a fallback: nothing reported as one');
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

test("the transition: a person with no vault tokens keeps today's account, and so does one whose vault cannot be opened", (t) => {
  const { make } = setup(t);
  const v = poolVault(make);
  const ctx = ctxOf(v);
  const sam = { userId: 'sam', displayName: 'Sam' };
  const r = machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: sam, sessionId: 'w1' }, ctx);
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, HOST, "the host token, as before the pool");
  assert.equal(r.login, false);
  assert.match(ctx.problems.at(-1) ?? '', /no vault Claude token for a workers run on m3 for sam; it runs on host token/);
  // Ben has tokens but the vault key is gone: not a hold (nothing the person can wait for), today's account with a warning.
  const nokey = ctxOf(make(() => ({ why: 'no vault key: test' })));
  const r2 = machineRunEnv(cfgOf(), { id: 'm3' }, { role: 'workers', requestedBy: { userId: 'ben', displayName: 'Ben' }, sessionId: 'w3' }, nokey);
  assert.equal(r2.env.CLAUDE_CODE_OAUTH_TOKEN, HOST);
  assert.match(nokey.problems.join('\n'), /the vault cannot open ben-a, ben-b: no vault key: test/);
});

test('poolRunEnv: on "vault" the orchestrator and the ops worker run on that person token alone; every other Claude credential is gone', (t) => {
  const { make, tokenFile } = setup(t);
  const v = poolVault(make);
  const ctx = ctxOf(v, { [fp(B1)]: usage(10, 50, { weeklyDays: 4 }), [fp(B2)]: usage(10, 50, { weeklyDays: 2 }) });
  const cfg = cfgOf({ claudeAccounts: { orchestrator: 'vault' }, claudeTokenFile: tokenFile });
  const fallback = () => hostProcessEnv(cfg, 'orchestrator', { PATH: '/bin', ANTHROPIC_API_KEY: API_KEY, CLAUDE_CODE_OAUTH_TOKEN: 'server-own' });
  for (const role of ['orchestrator', 'ops'] as const) {
    const r = poolRunEnv(cfg, { role, personId: 'ben', sessionId: `s-${role}` }, fallback, ctx);
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, B2, `${role}: ben's token that resets first`);
    assert.equal(r.env.ANTHROPIC_API_KEY, undefined, 'an API key would outrank the token: gone');
    assert.equal(r.env.CLAUDE_CONFIG_DIR, '/x', 'settings that are not credentials stay');
    assert.match(r.account, /^vault token ben-b …cccc \(ben's pool/);
    assert.ok(!JSON.stringify(r.account).includes(B2.slice(13, 40)));
  }
  assert.equal(poolRunEnv(cfg, { role: 'orchestrator', personId: 'lothsahn' }, fallback, ctx).env.CLAUDE_CODE_OAUTH_TOKEN, L1, "each person's orchestrator on their own");
  // A new token in the vault applies to the next session start, no restart: ben-c resets sooner than anything.
  v.add({ name: 'ben-c', kind: 'claude', value: claudeTok('h'), owner: 'ben', share: 'owner' });
  const meters = { [fp(claudeTok('h'))]: usage(10, 50, { weeklyDays: 1 }), [fp(B1)]: usage(10, 50, { weeklyDays: 4 }), [fp(B2)]: usage(10, 50, { weeklyDays: 2 }) };
  const ctx2 = ctxOf(v, meters);
  assert.equal(poolRunEnv(cfg, { role: 'orchestrator', personId: 'ben' }, fallback, ctx2).env.CLAUDE_CODE_OAUTH_TOKEN, claudeTok('h'));
});

test('poolRunEnv: no pool token yet (the transition) is the token file; not on "vault" it is the fallback whatever the vault holds', (t) => {
  const { make, tokenFile } = setup(t);
  const v = poolVault(make);
  const ctx = ctxOf(v);
  const cfg = cfgOf({ claudeAccounts: { orchestrator: 'vault' }, claudeTokenFile: tokenFile });
  const fallback = () => hostProcessEnv(cfg, 'orchestrator', { PATH: '/bin' });
  const r = poolRunEnv(cfg, { role: 'orchestrator', personId: 'sam' }, fallback, ctx);
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, FILE, 'the token file, as today');
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(r.account, 'token file');
  assert.equal(poolRunEnv(cfg, { role: 'ops', personId: undefined }, fallback, ctx).env.CLAUDE_CODE_OAUTH_TOKEN, FILE, 'the ops worker with no caller');
  // Another account setting: the pool is not used.
  const tokenAccount = cfgOf({ claudeAccounts: { orchestrator: 'token' } });
  assert.equal(poolRunEnv(tokenAccount, { role: 'orchestrator', personId: 'ben' }, () => ({ CLAUDE_CODE_OAUTH_TOKEN: HOST }), ctx).env.CLAUDE_CODE_OAUTH_TOKEN, HOST);
  // The vault cannot open ben's tokens: the fallback, with the problem named (never a value).
  const nokey = ctxOf(make(() => ({ why: 'no vault key: test' })));
  const r2 = poolRunEnv(cfg, { role: 'orchestrator', personId: 'ben' }, fallback, nokey);
  assert.equal(r2.env.CLAUDE_CODE_OAUTH_TOKEN, FILE);
  assert.match(nokey.problems.join('\n'), /no vault key: test/);
});

test("poolRunEnv: the orchestrator stops when its pool is used up and the error shows the reset, never a token; the ops worker is held when capped", (t) => {
  const { make, tokenFile } = setup(t);
  const v = poolVault(make);
  const cfg = cfgOf({ claudeAccounts: { orchestrator: 'vault' }, claudeTokenFile: tokenFile });
  const fallback = () => hostProcessEnv(cfg, 'orchestrator', {});
  const used = ctxOf(v, { [fp(B1)]: usage(100, 40, { sessionHours: 2 }), [fp(B2)]: usage(10, 100, { weeklyDays: 3 }) });
  assert.throws(
    () => poolRunEnv(cfg, { role: 'orchestrator', personId: 'ben' }, fallback, used),
    (e: unknown) => e instanceof PoolHeldError && /ben's Claude token pool is used up: every token is used up \(.*\): the first frees up Fri 14:00Z$/.test(e.message) && !e.message.includes(B1.slice(13, 40)) && !e.message.includes(FILE.slice(13, 40)),
  );
  const capped = ctxOf(v, { [fp(B1)]: usage(90, 40, { sessionHours: 2 }), [fp(B2)]: usage(85, 30, { weeklyDays: 3, sessionHours: 4 }) });
  assert.throws(() => poolRunEnv(cfg, { role: 'ops', personId: 'ben' }, fallback, capped), (e: unknown) => e instanceof PoolHeldError && /ben's Claude token pool is held/.test(e.message));
  // The orchestrator on the same pool still runs: over its cap, on the token with the most room.
  assert.equal(poolRunEnv(cfg, { role: 'orchestrator', personId: 'ben' }, fallback, capped).env.CLAUDE_CODE_OAUTH_TOKEN, B2);
  // Neither falls to the dispatcher's token file: the stop is the stop.
});

// ---------------------------------------------------------------- the dispatcher and its reserve

test('hostAccount: "vault" is the orchestrators only; the dispatcher that inherits it stays on the token file (else the host token)', () => {
  const cfg = { claudeAccounts: { orchestrator: 'vault' }, claudeTokenFile: '/srv/fff/secrets/t', claudeEnv: {} } as never;
  assert.equal(hostAccount(cfg, 'orchestrator'), 'vault');
  assert.equal(hostAccount(cfg, 'dispatcher'), 'tokenfile');
  assert.equal(hostAccount({ claudeAccounts: { orchestrator: 'vault' }, claudeEnv: {} } as never, 'dispatcher'), 'token');
  assert.equal(hostAccount({ claudeAccounts: { orchestrator: 'vault', dispatcher: 'tokenfile' }, claudeTokenFile: '/x', claudeEnv: {} } as never, 'dispatcher'), 'tokenfile');
});

test('the reserve follows the dispatcher account and covers the host token; one credential is the dispatcher', (t) => {
  const { tokenFile } = setup(t);
  const base = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST }, claudeTokenFile: tokenFile } as const;
  // The token file is the dispatcher's, the host token is reserved for its own roles.
  const a = reservedCredentials({ ...base, claudeAccounts: { orchestrator: 'vault', dispatcher: 'tokenfile' } } as never);
  assert.deepEqual(a.map((c) => [c.role, c.key]), [['dispatcher', tokenKey(FILE)], ['host-token', tokenKey(HOST)]]);
  assert.match(a[0].what, /^the dispatcher's token file …ffff$/);
  assert.match(a[1].what, /^the host token …gggg$/);
  // Switch the dispatcher's account to the host token: the reserve moves and the two are one credential, the dispatcher's.
  const b = reservedCredentials({ ...base, claudeAccounts: { dispatcher: 'token' } } as never);
  assert.deepEqual(b.map((c) => [c.role, c.key]), [['dispatcher', tokenKey(HOST)]]);
  assert.match(b[0].what, /^the dispatcher's host token …gggg$/);
  // The dispatcher on this host's login.
  const c = reservedCredentials({ ...base, claudeAccounts: { dispatcher: 'login' } } as never);
  assert.deepEqual(c.map((x) => [x.role, x.key]), [['dispatcher', 'host:login'], ['host-token', tokenKey(HOST)]]);
  // No token file readable: no reserve on it (nothing to name).
  assert.deepEqual(reservedCredentials({ claudeEnv: {}, claudeAccounts: { dispatcher: 'tokenfile' }, claudeTokenFile: '/nonexistent/x' } as never), []);
});

test("reserveLines: the dispatcher's token shows its reserve; runs inside it raise the warning; none without readings or users", (t) => {
  const { tokenFile } = setup(t);
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST }, claudeTokenFile: tokenFile, claudeAccounts: { orchestrator: 'vault', dispatcher: 'tokenfile' } } as never;
  const file = tokenKey(FILE);
  const meters: Record<string, PlanUsage | undefined> = { [file]: usage(12, 41, { weeklyDays: 5 }), [tokenKey(HOST)]: usage(5, 10, { weeklyDays: 5 }) };
  const none = (_: string) => 0;
  const calm = reserveLines(cfg, (k) => meters[k], none, NOW);
  assert.equal(calm[0].line, "dispatcher's token file …ffff: weekly 41%, reserve 25% (5 days to reset); 5-hour 12%, reserve 20%");
  assert.equal(calm[0].warning, undefined);
  assert.match(calm[1].line, /^host token …gggg: weekly 10%, reserve 25% \(5 days to reset\)/);
  // Inside the buffer with another person's orchestrator on it (a person with no vault token yet): a warning, not a refusal.
  meters[file] = usage(12, 83, { weeklyDays: 5 });
  const busy = reserveLines(cfg, (k) => meters[k], (k, role) => (k === file && role === 'dispatcher' ? 2 : 0), NOW);
  assert.match(busy[0].line, /inside its reserve, kept for the dispatcher; 2 other runs using it/);
  assert.match(busy[0].warning ?? '', /dispatcher's token file …ffff is the last token with room for 2 runs and is inside the buffer kept for the dispatcher \(weekly 83%, reserve 25%, resets \w{3} \d\d:\d\dZ\)/);
  // Inside the buffer and nobody else on it: the dispatcher alone uses it, as intended: no warning.
  const alone = reserveLines(cfg, (k) => meters[k], none, NOW);
  assert.match(alone[0].line, /inside its reserve, kept for the dispatcher$/);
  assert.equal(alone[0].warning, undefined);
  // No reading yet: counted as inside its reserve.
  const unread = reserveLines(cfg, () => undefined, none, NOW);
  assert.match(unread[0].line, /no reading yet \(counted as inside its reserve\)/);
  // 5 days to the reset gives 25; the figure per day is the system-wide config.
  const slow = reserveLines({ ...(cfg as object), vault: { pool: { reservePerDayPercent: 2 } } } as never, (k) => meters[k], none, NOW);
  assert.match(slow[0].line, /reserve 10% \(5 days to reset\)/);
  assert.ok(![calm, busy, alone, unread].some((x) => x.some((l) => l.line.includes(FILE.slice(13, 40)))), 'a line shows the last four characters only');
});

test("the dispatcher is never held by its own reserve: its environment is the token file whatever the meters say", (t) => {
  const { tokenFile } = setup(t);
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST }, claudeTokenFile: tokenFile, claudeAccounts: { orchestrator: 'vault', dispatcher: 'tokenfile' } } as never;
  // hostProcessEnv consults no meter: at 99.9% weekly and 100% of the 5-hour window the dispatcher still starts on it.
  const env = hostProcessEnv(cfg, 'dispatcher', { PATH: '/bin' });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, FILE);
  // And the reserve is a line and a warning, never an exception: reserveLines returns even at 100%.
  const full = reserveLines(cfg, () => usage(100, 99.9, { weeklyDays: 0.1 }), () => 0, NOW);
  assert.equal(full.length, 2);
  assert.match(full[0].line, /inside its reserve, kept for the dispatcher/);
});

// ---------------------------------------------------------------- config

test('config: "vault" is the orchestrator account; the dispatcher and workers refuse it; vault.pool is checked at load', () => {
  checkAccountConfig({ claudeAccounts: { orchestrator: 'vault' } } as never);
  checkAccountConfig({ claudeAccounts: { orchestrator: 'vault', dispatcher: 'tokenfile' }, claudeTokenFile: '/x' } as never);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { dispatcher: 'vault' } } as never), /claudeAccounts\.dispatcher cannot be "vault"/);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { workers: 'vault' } } as never), /claudeAccounts\.workers: no such role/, 'retired (w755): not a role any more');
  checkAccountConfig({ vault: { pool: { sessionHoldPercent: 70, reservePerDayPercent: 0 } } } as never);
  assert.throws(() => checkAccountConfig({ vault: { pool: { sessionHoldPercent: 101 } } } as never), /percent from 0 to 100/);
  assert.throws(() => checkAccountConfig({ vault: { pool: { onePerWeeklyPercent: 99.9 } } } as never), /above retireWeeklyPercent/);
  assert.throws(() => checkAccountConfig({ vault: { pool: { retireWeeklyPercent: 90, onePerWeeklyPercent: 95 } } } as never), /above retireWeeklyPercent/);
});

test('set_app_config: "vault" for the orchestrator only; the pool limits are anyone\'s, checked, applied live and cleared by null', (t) => {
  assert.equal(normalizeSetting('claudeAccounts.orchestrator', 'vault'), 'vault');
  assert.throws(() => normalizeSetting('claudeAccounts.dispatcher', 'vault'), /cannot be "vault"/);
  // Not owner-only keys: the pool limits are one system-wide set that any person's orchestrator may change.
  for (const k of ['vault.pool.sessionHoldPercent', 'vault.pool.onePerWeeklyPercent', 'vault.pool.retireWeeklyPercent', 'vault.pool.reservePerDayPercent', 'vault.pool.reserveSessionPercent'] as const) {
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
});
