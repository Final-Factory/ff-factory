import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.ts';
import {
  accountLines,
  addSpend,
  buildAccounts,
  HOST_LOGIN,
  hostToken,
  sessionSource,
  tokenKey,
  tokenLabel,
  fetchTokenLimits,
  fetchTokenUsage,
  MESSAGES_URL,
  USAGE_URL,
  UsageFetchError,
  UsageTracker,
  type UsageEntry,
  credentialsFile,
  describeReset,
  LOGIN_ACTION,
  loginProblem,
  parseUsage,
  readStoredLogin,
  usageEnv,
  usageSummary,
  machineToken,
  weekSpend,
  type StoredLogin,
  type UsageReply,
} from './usage.ts';

// Trimmed from a real reply on this host (2026-09-24, a Max plan).
const REAL: UsageReply = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 33, resets_at: '2026-09-24T04:30:00.222384+00:00' },
    seven_day: { utilization: 33, resets_at: '2026-09-28T05:00:00.222404+00:00' },
    model_scoped: [{ display_name: 'Fable', utilization: 22, resets_at: '2026-09-28T05:00:00.222567+00:00' }],
    limits: [
      { kind: 'session', group: 'session', percent: 33, severity: 'normal', resets_at: '2026-09-24T04:30:00.222384+00:00', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 33, severity: 'normal', resets_at: '2026-09-28T05:00:00.222404+00:00', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 22, severity: 'normal', resets_at: '2026-09-28T05:00:00.222567+00:00', scope: { model: { display_name: 'Fable' }, surface: null } },
    ],
  },
};

const AS_OF = '2026-09-24T02:38:00Z';

test('usage: the server rows become weekly, session and per-model meters', () => {
  const u = parseUsage(REAL, AS_OF);
  assert.equal(u.available, true);
  assert.equal(u.plan, 'max');
  assert.deepEqual(u.weekly, { label: 'Weekly', percent: 33, resetsAt: '2026-09-28T05:00:00.222404+00:00', severity: 'normal' });
  assert.equal(u.session?.label, 'Session (5 h)');
  assert.deepEqual(u.models.map((m) => [m.label, m.percent]), [['Weekly Fable', 22]]);
});

test('usage: without server rows it falls back to the named windows', () => {
  const u = parseUsage({ ...REAL, rate_limits: { ...REAL.rate_limits!, limits: null } }, AS_OF);
  assert.equal(u.weekly?.percent, 33);
  assert.equal(u.session?.percent, 33);
  assert.deepEqual(u.models.map((m) => m.label), ['Weekly Fable']);
  // Out-of-range values are clamped, nulls dropped.
  const odd = parseUsage({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 140, resets_at: null }, five_hour: { utilization: null, resets_at: null } } }, AS_OF);
  assert.equal(odd.weekly?.percent, 100);
  assert.equal(odd.session, undefined);
});

test('usage: API keys and scope-less tokens report unavailable, never a made-up number', () => {
  for (const r of [{ rate_limits_available: false, rate_limits: null }, { rate_limits_available: true, rate_limits: null }, { rate_limits_available: true, rate_limits: { limits: [] } }] as UsageReply[]) {
    const u = parseUsage(r, AS_OF);
    assert.equal(u.available, false);
    assert.equal(u.weekly, undefined);
    assert.ok(u.why);
  }
});

test('usage: the system_status lines', () => {
  const now = new Date('2026-09-24T02:40:00Z');
  const line = usageSummary(parseUsage(REAL, AS_OF), now);
  assert.match(line, /^Claude plan \(max\) usage, as of .+: Weekly 33% used, resets .+; Session \(5 h\) 33% used, resets in 2 h; Weekly Fable 22% used/);
  assert.match(usageSummary(undefined, now), /not fetched yet/);
  const fb = usageSummary({ available: false, asOf: AS_OF, models: [], why: 'no scope', spendWeekUsd: 12.5 }, now);
  assert.match(fb, /unavailable \(no scope\).*\$12\.50 \(spend, not the plan limit\)/);
});

test('usage: reset wording', () => {
  const now = new Date('2026-09-24T02:40:00Z');
  assert.equal(describeReset('2026-09-24T03:10:00Z', now), 'resets in 30 min');
  assert.equal(describeReset('2026-09-24T04:40:00Z', now), 'resets in 2 h');
  assert.match(describeReset('2026-09-28T05:00:00Z', now), /^resets \w+ /);
  assert.equal(describeReset('2026-09-24T02:00:00Z', now), 'resets now');
  assert.equal(describeReset(undefined, now), '');
});

test('spend ledger: daily buckets, 8 kept, 7-day window', () => {
  let l: Record<string, number> = {};
  for (let d = 1; d <= 10; d++) l = addSpend(l, `2026-09-${String(d).padStart(2, '0')}`, 1);
  assert.equal(Object.keys(l).length, 8);
  l = addSpend(l, '2026-09-10', 0.5);
  l = addSpend(l, '2026-09-10', -3); // never subtracts
  assert.equal(l['2026-09-10'], 1.5);
  assert.equal(weekSpend(l, '2026-09-10'), 7.5); // 09-04 .. 09-10
  assert.equal(weekSpend(l, '2026-09-20'), 0);
});

// ---------------------------------------------------------------- the credential the usage request uses

const NOW = Date.parse('2026-09-24T03:00:00Z');
const HOUR = 3_600_000;
const INTERACTIVE: StoredLogin = {
  present: true,
  hasAccessToken: true,
  hasRefreshToken: true,
  scopes: ['user:file_upload', 'user:inference', 'user:mcp_servers', 'user:profile', 'user:sessions:claude_code'],
  expiresAt: NOW + 5 * HOUR,
  refreshTokenExpiresAt: NOW + 28 * 24 * HOUR,
};

test('usage credential: the agents token and API keys are removed for the usage request only', () => {
  const agents = { CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_API_KEY: 'y', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference', CLAUDE_CONFIG_DIR: 'C:/cfg', PATH: 'p' };
  const env = usageEnv(agents);
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: 'C:/cfg', PATH: 'p' });
  assert.equal(agents.CLAUDE_CODE_OAUTH_TOKEN, 'x'); // the agents' copy is untouched
  assert.equal(credentialsFile(env), path.join('C:/cfg', '.credentials.json'));
  assert.equal(credentialsFile({}), path.join(os.homedir(), '.claude', '.credentials.json'));
});

test('usage credential: only metadata is read from the stored login, never the token values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cred-'));
  const file = path.join(dir, '.credentials.json');
  assert.equal(readStoredLogin(file).present, false); // missing
  fs.writeFileSync(file, '{"claudeAiOauth":{"accessToken":"SECRET-A"'); // truncated
  assert.deepEqual(readStoredLogin(file), { present: false, hasAccessToken: false, hasRefreshToken: false, scopes: [] });
  fs.writeFileSync(
    file,
    JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET-A', refreshToken: 'SECRET-R', expiresAt: NOW, refreshTokenExpiresAt: NOW + HOUR, scopes: ['user:inference', 'user:profile'] } }),
  );
  const l = readStoredLogin(file);
  assert.deepEqual(l, { present: true, hasAccessToken: true, hasRefreshToken: true, scopes: ['user:inference', 'user:profile'], expiresAt: NOW, refreshTokenExpiresAt: NOW + HOUR });
  assert.doesNotMatch(JSON.stringify(l), /SECRET/);
  fs.rmSync(dir, { recursive: true });
});

test('usage credential: when the stored login can read plan usage, and the one fix when it cannot', () => {
  const f = 'C:/Users/dev/.claude/.credentials.json';
  assert.equal(loginProblem(INTERACTIVE, NOW, f), undefined);
  // An expired access token is fine while the refresh token lives: the CLI refreshes it.
  assert.equal(loginProblem({ ...INTERACTIVE, expiresAt: NOW - HOUR }, NOW, f), undefined);
  // No expiry recorded: let the CLI decide.
  assert.equal(loginProblem({ ...INTERACTIVE, expiresAt: undefined, refreshTokenExpiresAt: undefined }, NOW, f), undefined);

  const missing = loginProblem({ present: false, hasAccessToken: false, hasRefreshToken: false, scopes: [] }, NOW, f);
  assert.match(missing!, /no claude\.ai login is stored.*credentials\.json.*run `claude`.*\/login/);
  // macOS keeps the login in the Keychain: a missing file proves nothing there.
  assert.equal(loginProblem({ present: false, hasAccessToken: false, hasRefreshToken: false, scopes: [] }, NOW, f, true), undefined);

  // A setup-token style credential: inference only.
  assert.match(loginProblem({ ...INTERACTIVE, scopes: ['user:inference'] }, NOW, f)!, /lacks the user:profile scope \(it has: user:inference\)\. Fix: .*\/login/);

  const dead = loginProblem({ ...INTERACTIVE, expiresAt: NOW - 2 * HOUR, refreshTokenExpiresAt: NOW - HOUR }, NOW, f);
  assert.match(dead!, /expired on 2026-09-24 02:00 UTC\. Fix: .*\/login/);
  assert.match(loginProblem({ ...INTERACTIVE, expiresAt: NOW - HOUR, hasRefreshToken: false }, NOW, f)!, /expired/);
});

test('usage credential: a reply without plan limits names the fix', () => {
  const u = parseUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }, AS_OF);
  assert.equal(u.available, false);
  assert.ok(u.why?.includes(LOGIN_ACTION));
});

// ---------------------------------------------------------------- every account in use

// Made up, the shape of a setup-token; never a real one.
const TOKEN = `sk-ant-oat01-${'x'.repeat(60)}9AAA`;
const TOKEN2 = `sk-ant-oat01-${'y'.repeat(60)}7BBB`;

test('accounts: a token is known by a hash prefix and its last 4 characters, never by its value', () => {
  assert.match(tokenKey(TOKEN), /^token:[0-9a-f]{12}$/);
  assert.notEqual(tokenKey(TOKEN), tokenKey(TOKEN2));
  assert.equal(tokenLabel(TOKEN), 'host token …9AAA');
  assert.doesNotMatch(tokenKey(TOKEN) + tokenLabel(TOKEN), /xxxx/);
});

test('accounts: the host token is config claudeEnv over the server environment', () => {
  // claudeEnv wins over the server's own environment, as for the agents.
  assert.equal(hostToken({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN2 }), TOKEN);
  assert.equal(hostToken({}, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN2 }), TOKEN2);
  assert.equal(hostToken({}, {}), undefined);
});

test('accounts: each session is attributed to the credential it runs on', () => {
  // m3 is set to its own login (machines.useHostClaudeEnv { m3: false }); the others take config claudeEnv.
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } };
  const toMachine = (id: string) => machineToken(cfg, id !== 'm3');
  assert.equal(sessionSource({}, TOKEN, toMachine), tokenKey(TOKEN));
  assert.equal(sessionSource({}, undefined, toMachine), HOST_LOGIN);
  assert.equal(sessionSource({ machineId: 'm5' }, TOKEN, toMachine), tokenKey(TOKEN));
  assert.equal(sessionSource({ machineId: 'm3' }, TOKEN, toMachine), 'login:m3', 'machines.useHostClaudeEnv false: the Mac login');
  // A token only in the server's own environment is not sent to machines: their agents are on the Mac login.
  const envOnly = (id: string) => machineToken({}, id !== 'm3');
  assert.equal(sessionSource({}, TOKEN2, envOnly), tokenKey(TOKEN2));
  assert.equal(sessionSource({ machineId: 'm5' }, TOKEN2, envOnly), 'login:m5');
  // A machine may be called "host": its login is not this host's.
  assert.notEqual(sessionSource({ machineId: 'host' }, undefined, envOnly), HOST_LOGIN);
});

const usageOf = (weekly: number, asOf = AS_OF) => ({ ...parseUsage(REAL, asOf), weekly: { label: 'Weekly', percent: weekly } });

test('accounts: one login on several computers is one account; the token is its own; stale machines drop out', () => {
  const entries = new Map<string, UsageEntry>([
    [HOST_LOGIN, { kind: 'login', account: { email: 'Owner@Example.com' }, usage: usageOf(33, '2026-09-24T02:30:00Z') }],
    [tokenKey(TOKEN), { kind: 'token', label: tokenLabel(TOKEN), usage: usageOf(98) }],
    ['login:m5', { kind: 'login', account: { email: 'owner@example.com' }, usage: usageOf(34, '2026-09-24T02:35:00Z') }],
    ['login:m3', { kind: 'login', account: { email: 'other@example.com' }, usage: usageOf(12) }],
    ['login:gone', { kind: 'login', account: { email: 'gone@example.com' }, usage: usageOf(1) }],
  ]);
  const accounts = buildAccounts(entries, {
    hostName: 'BEAST',
    token: { key: tokenKey(TOKEN), label: tokenLabel(TOKEN) },
    machines: [
      { id: 'm3', usesToken: false },
      { id: 'm5', usesToken: true },
    ],
    sessions: [
      { id: 'orch', source: tokenKey(TOKEN), live: true },
      { id: 'w1', source: tokenKey(TOKEN), live: true },
      { id: 'm3-w', source: 'login:m3', live: true },
      { id: 'old', source: 'login:m3' },
      { id: 'older', source: 'login:m3' },
    ],
  });
  assert.deepEqual(
    accounts.map((a) => [a.id, a.label, a.sources, a.where, a.sessionIds, a.usage?.weekly?.percent]),
    [
      [tokenKey(TOKEN), 'host token …9AAA', [tokenKey(TOKEN)], ["the agents' token on BEAST, m5"], ['orch', 'w1'], 98],
      // Ranked by agents running now (2 vs 1), not by every session it ever had (3).
      ['email:other@example.com', 'other@example.com', ['login:m3'], ['m3 login'], ['m3-w', 'old', 'older'], 12],
      // Merged by email (case-insensitive); the newer reading wins.
      ['email:owner@example.com', 'Owner@Example.com', [HOST_LOGIN, 'login:m5'], ['BEAST login', 'm5 login'], [], 34],
    ],
  );
  assert.doesNotMatch(JSON.stringify(accounts), /xxxx|sk-ant/);
});

test('accounts: before anything is fetched, the host login and token still show, and a Mac login its agents use', () => {
  const accounts = buildAccounts(new Map(), {
    hostName: 'BEAST',
    token: { key: tokenKey(TOKEN), label: tokenLabel(TOKEN) },
    machines: [{ id: 'm3', usesToken: false }],
    sessions: [{ id: 'm3-w', source: 'login:m3', live: true }],
  });
  assert.deepEqual(
    accounts.map((a) => [a.id, a.label, a.usage]),
    [
      ['login:m3', 'm3 login', undefined],
      [tokenKey(TOKEN), 'host token …9AAA', undefined],
      [HOST_LOGIN, 'BEAST login', undefined],
    ],
  );
});

test('accounts: the system_status lines name each account, where it is used and who runs on it', () => {
  const now = new Date('2026-09-24T02:40:00Z');
  const accounts = buildAccounts(new Map<string, UsageEntry>([[tokenKey(TOKEN), { kind: 'token', label: tokenLabel(TOKEN), usage: usageOf(98) }]]), {
    hostName: 'BEAST',
    token: { key: tokenKey(TOKEN), label: tokenLabel(TOKEN) },
    machines: [],
    sessions: [
      { id: 'orch', source: tokenKey(TOKEN) },
      { id: 'w1', source: tokenKey(TOKEN) },
      { id: 'w2', source: tokenKey(TOKEN) },
    ],
  });
  const sessions = new Map([
    ['orch', { id: 'orch', kind: 'orchestrator' as const, status: 'idle' as const }],
    ['w1', { id: 'w1', kind: 'worker' as const, status: 'running' as const }],
    ['w2', { id: 'w2', kind: 'worker' as const, status: 'stopped' as const }],
  ]);
  const lines = accountLines(accounts, sessions, now);
  assert.equal(lines[0], 'Claude accounts in use (2):');
  assert.match(lines[1], /^- host token …9AAA \[the agents' token on BEAST; agents on it: the orchestrator, w1\]: Claude plan \(max\) usage, as of .+: Weekly 98% used/);
  assert.match(lines[2], /^- BEAST login \[BEAST login; agents on it: no agent right now\]: Claude plan usage: not fetched yet/);
  assert.deepEqual(accountLines([], sessions, now), ['Claude accounts: none known yet']);
});

test('accounts: the tracker reads a usage.json from before accounts, keeps Mac reports, and survives a failed fetch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-accounts-'));
  const cfg = { dataDir: dir } as never;
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(parseUsage(REAL, AS_OF)));
  let changes = 0;
  const t = new UsageTracker(cfg, () => changes++);
  assert.equal(t.usage?.weekly?.percent, 33, "the old file is this host's login");

  t.report('m5', { email: 'owner@example.com' }, usageOf(40));
  assert.equal(changes, 1);
  // A machine called "host" is not this host's login.
  t.report('host', { email: 'mac@example.com' }, usageOf(7));
  assert.equal(t.usage?.weekly?.percent, 33);
  t.forget('host');
  assert.equal(t.usage?.weekly?.percent, 33);
  // A failed fetch on the Mac keeps the last good numbers and who it was, flagged.
  t.report('m5', {}, { available: false, asOf: AS_OF, models: [], why: 'could not fetch plan usage on this Mac: timed out after 60 s' });
  const e = t.entries.get('login:m5')!;
  assert.equal(e.account?.email, 'owner@example.com');
  assert.equal(e.usage?.weekly?.percent, 40);
  assert.match(e.usage?.error ?? '', /timed out/);
  // A lasting answer (no plan on that login) replaces them.
  t.report('m5', { email: 'owner@example.com' }, { available: false, asOf: AS_OF, models: [], why: 'the Claude login used for usage reports no plan limits' });
  assert.equal(t.entries.get('login:m5')!.usage?.available, false);

  // Saved in the new shape, and read back.
  const again = new UsageTracker(cfg, () => undefined);
  assert.equal(again.entries.get('login:m5')?.account?.email, 'owner@example.com');
  assert.equal(again.usage?.weekly?.percent, 33);
  again.forget('m5');
  assert.equal(again.entries.has('login:m5'), false);
  fs.rmSync(dir, { recursive: true });
});

// ---------------------------------------------------------------- each account asked with its own credential

/** The raw endpoint's reply (the shape of GET /api/oauth/usage, trimmed): weekly, session and Fable. */
const endpointBody = (weekly: number, session: number, fable: number) => ({
  five_hour: { utilization: session, resets_at: '2026-09-28T04:40:00+00:00' },
  seven_day: { utilization: weekly, resets_at: '2026-10-02T03:00:00+00:00' },
  limits: [
    { kind: 'session', group: 'session', percent: session, severity: 'normal', resets_at: '2026-09-28T04:40:00+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: weekly, severity: 'normal', resets_at: '2026-10-02T03:00:00+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: fable, severity: 'normal', resets_at: '2026-10-02T03:00:00+00:00', scope: { model: { display_name: 'Fable' }, surface: null } },
  ],
});

test('token usage: asked of the endpoint with that token alone; failures never carry the token', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify(endpointBody(41, 33, 0)), { status: 200 });
  }) as unknown as typeof fetch;
  const u = parseUsage(await fetchTokenUsage(TOKEN, ok), AS_OF);
  assert.deepEqual(seen, [{ url: USAGE_URL, auth: `Bearer ${TOKEN}` }]);
  assert.deepEqual([u.available, u.weekly?.percent, u.session?.percent, u.models.map((m) => [m.label, m.percent])], [true, 41, 33, [['Weekly Fable', 0]]]);

  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
  const failure = async (f: typeof fetch) => {
    try {
      await fetchTokenUsage(TOKEN, f);
    } catch (e) {
      assert.ok(e instanceof UsageFetchError);
      assert.doesNotMatch(e.message, /sk-ant-oat01-x|9AAA/);
      return e;
    }
    assert.fail('no error');
  };
  const limited = await failure(answer(429, { error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } }, { 'retry-after': '3463' }));
  assert.equal(limited.retryAfterMs, 3_463_000);
  assert.match(limited.message, /rate-limits this token, next try in 58 min \(HTTP 429: Rate limited/);
  assert.match((await failure(answer(401, { error: { message: 'Invalid bearer token' } }))).message, /the token was rejected .*HTTP 401/);
  assert.equal((await failure(answer(401, {}))).retryAfterMs, undefined);
  // A network error that quotes the credential is scrubbed.
  const leaky = (async () => {
    throw new Error(`connect failed for ${TOKEN}`);
  }) as unknown as typeof fetch;
  assert.match((await failure(leaky)).message, /could not be reached: connect failed for sk-ant-…$/);
});

/** A tracker on a temp dir with a usable stored login, the token in claudeEnv, and fake fetchers. */
function trackerWith(
  fetchToken: (t: string) => Promise<UsageReply>,
  fetchTokenLimits: (t: string) => Promise<UsageReply> = async () => {
    throw new UsageFetchError('no headers here');
  },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-creds-'));
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'login-secret', refreshToken: 'r', scopes: ['user:inference', 'user:profile'] } }));
  const calls = { login: [] as Record<string, string | undefined>[], token: [] as string[], limits: [] as string[] };
  const logs: string[] = [];
  const cfg = { dataDir: dir, claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: dir } } as never;
  const t = new UsageTracker(cfg, () => undefined, {
    // The host login (BEAST's claude.ai account): 98% of its week gone.
    fetchLogin: async (env) => {
      calls.login.push(env);
      return { reply: { subscription_type: 'max', rate_limits_available: true, rate_limits: endpointBody(98, 0, 22) }, account: { email: 'owner@example.com' } };
    },
    fetchToken: async (tok) => {
      calls.token.push(tok);
      return fetchToken(tok);
    },
    fetchTokenLimits: async (tok) => {
      calls.limits.push(tok);
      return fetchTokenLimits(tok);
    },
    log: (line) => logs.push(line),
  });
  return { t, dir, calls, logs };
}

const tokenOnly = (t: UsageTracker) =>
  buildAccounts(t.entries, { hostName: 'BEAST', token: { key: tokenKey(TOKEN), label: tokenLabel(TOKEN) }, machines: [], sessions: [] });

test('tracker: two accounts, each asked with its own credential, each keeps its own numbers', async () => {
  // The token's account: 41% of the week, 33% of the session.
  const { t, dir, calls, logs } = trackerWith(async () => ({ rate_limits_available: true, rate_limits: endpointBody(41, 33, 0) }));
  await t.refresh();
  const login = t.entries.get(HOST_LOGIN)!;
  const tok = t.entries.get(tokenKey(TOKEN))!;
  assert.deepEqual([login.usage?.weekly?.percent, login.usage?.session?.percent, login.account?.email], [98, 0, 'owner@example.com']);
  assert.deepEqual(
    [tok.kind, tok.label, tok.direct, tok.usage?.weekly?.percent, tok.usage?.session?.percent, tok.usage?.models[0]?.percent],
    ['token', 'host token …9AAA', true, 41, 33, 0],
  );
  // The login's request never sees the token; the token's request is that token.
  assert.equal(calls.login.length, 1);
  assert.equal(calls.login[0].CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(calls.login[0].CLAUDE_CODE_OAUTH_SCOPES, undefined);
  assert.deepEqual(calls.token, [TOKEN]);
  // One log line per credential, saying which and whether it answered, with no secret in it.
  assert.equal(logs.length, 2);
  assert.ok(logs.some((l) => /login \(the claude\.ai login stored in .*, owner@example\.com\): ok, Weekly 98%, Session \(5 h\) 0%, Weekly Fable 22%$/.test(l)), logs.join('\n'));
  assert.ok(logs.includes(`usage: host token …9AAA (${tokenKey(TOKEN)}, asked with that token itself, via the usage endpoint): ok, Weekly 41%, Session (5 h) 33%, Weekly Fable 0%`), logs.join('\n'));
  assert.doesNotMatch(logs.join('\n'), /sk-ant|login-secret|xxxx/);
  // The accounts built from them keep the two apart.
  assert.deepEqual(
    tokenOnly(t).map((a) => [a.label, a.usage?.weekly?.percent, a.usage?.session?.percent]),
    [
      ['host token …9AAA', 41, 33],
      ['owner@example.com', 98, 0],
    ],
  );
  fs.rmSync(dir, { recursive: true });
});

test("tracker: a token whose request fails is unknown with the reason, never another account's or older numbers", async () => {
  let fail: Error | undefined;
  const { t, dir, calls, logs } = trackerWith(async () => {
    if (fail) throw fail;
    return { rate_limits_available: true, rate_limits: endpointBody(41, 33, 0) };
  });
  const tokenLog = () => logs.filter((l) => l.includes('host token')).at(-1)!;
  await t.refresh();
  assert.equal(t.entries.get(tokenKey(TOKEN))?.usage?.weekly?.percent, 41);

  // Rejected: unknown, with the reason, and the older 41% is not kept.
  fail = new UsageFetchError('the token was rejected (expired or revoked?) (HTTP 401)');
  await t.refresh();
  let u = t.entries.get(tokenKey(TOKEN))!.usage!;
  assert.deepEqual([u.available, u.weekly, u.session], [false, undefined, undefined]);
  assert.match(u.why!, /^usage unknown: the token was rejected/);
  assert.match(tokenLog(), /host token …9AAA .*via the usage endpoint\): failed, no numbers: usage unknown: .*HTTP 401/);
  assert.equal(calls.limits.length, 0, 'only a rate limit turns to the headers');
  // The login still has its own numbers.
  assert.equal(t.usage?.weekly?.percent, 98);
  assert.match(accountLines(tokenOnly(t), new Map(), new Date(AS_OF))[1], /^- host token …9AAA .*: Claude plan usage: unavailable \(usage unknown: the token was rejected/);

  // Rate-limited, and the headers fail too: unknown with both reasons.
  fail = new UsageFetchError('the usage endpoint rate-limits this token, next try in 58 min (HTTP 429)', 3_463_000);
  await t.refresh();
  u = t.entries.get(tokenKey(TOKEN))!.usage!;
  assert.deepEqual([u.available, u.weekly], [false, undefined]);
  assert.match(u.why!, /^usage unknown: the usage endpoint rate-limits this token.*HTTP 429\); no headers here$/);
  assert.deepEqual(calls.limits, [TOKEN]);

  // Within the Retry-After the endpoint is not asked again.
  await t.refresh();
  assert.equal(calls.token.length, 3);
  assert.equal(calls.limits.length, 2);
  assert.match(tokenLog(), /via the API's rate-limit headers \(the usage endpoint rate-limits this token until /);

  // Any other failure: unknown too, and the next poll asks again.
  const again = trackerWith(async () => {
    throw new Error('socket hang up');
  });
  await again.t.refresh();
  await again.t.refresh();
  assert.equal(again.calls.token.length, 2);
  assert.match(again.t.entries.get(tokenKey(TOKEN))!.usage!.why!, /^usage unknown: socket hang up/);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(again.dir, { recursive: true });
});

test("tracker: while the endpoint rate-limits the token, the same token's rate-limit headers give weekly and session", async () => {
  const headers = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 43, resets_at: '2026-09-28T04:40:00.000Z' }, seven_day: { utilization: 42, resets_at: '2026-10-02T03:00:00.000Z' } } };
  const { t, dir, calls, logs } = trackerWith(
    async () => {
      throw new UsageFetchError('the usage endpoint rate-limits this token, next try in 58 min (HTTP 429)', 3_463_000);
    },
    async () => headers,
  );
  await t.refresh();
  const u = t.entries.get(tokenKey(TOKEN))!.usage!;
  assert.deepEqual([u.available, u.weekly?.percent, u.session?.percent, u.models, u.source], [true, 42, 43, [], 'rate limits']);
  assert.deepEqual([calls.token, calls.limits], [[TOKEN], [TOKEN]]);
  assert.equal(t.usage?.weekly?.percent, 98, 'the login is untouched');
  assert.ok(
    logs.includes(
      `usage: host token …9AAA (${tokenKey(TOKEN)}, asked with that token itself, via the API's rate-limit headers (the usage endpoint rate-limits this token, next try in 58 min (HTTP 429))): ok, Weekly 42%, Session (5 h) 43%`,
    ),
    logs.join('\n'),
  );
  assert.match(accountLines(tokenOnly(t), new Map(), new Date(AS_OF))[1], /^- host token …9AAA .*: Claude plan usage, as of .*, from rate limits: Weekly 42% used/);
  fs.rmSync(dir, { recursive: true });
});

test("token limits: read from the API reply's rate-limit headers, asked with that token alone", async () => {
  const seen: { url: string; auth: string | null; body: string }[] = [];
  const reply = (headers: Record<string, string>, status = 200) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: String(init.body) });
      return new Response('{}', { status, headers });
    }) as unknown as typeof fetch;
  const u = parseUsage(
    await fetchTokenLimits(
      TOKEN,
      reply({
        'anthropic-ratelimit-unified-5h-utilization': '0.43',
        'anthropic-ratelimit-unified-5h-reset': '1790570400',
        'anthropic-ratelimit-unified-7d-utilization': '0.42',
        'anthropic-ratelimit-unified-7d-reset': '1790910000',
      }),
    ),
    AS_OF,
  );
  assert.deepEqual([u.weekly?.percent, u.weekly?.resetsAt, u.session?.percent, u.session?.resetsAt], [42, '2026-10-02T03:00:00.000Z', 43, '2026-09-28T04:40:00.000Z']);
  assert.equal(seen[0].url, MESSAGES_URL);
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  assert.equal(JSON.parse(seen[0].body).max_tokens, 1);
  // No headers (an API key, an error reply): an error, never a number.
  await assert.rejects(
    fetchTokenLimits(TOKEN, reply({}, 401)),
    (e: Error) => e instanceof UsageFetchError && /no rate-limit headers .*HTTP 401/.test(e.message) && !e.message.includes(TOKEN),
  );
});

test("tracker: a token's numbers saved before it was asked directly (the login's) are dropped on load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-old-'));
  const entries: Record<string, UsageEntry> = {
    [HOST_LOGIN]: { kind: 'login', usage: usageOf(98) },
    [tokenKey(TOKEN)]: { kind: 'token', label: tokenLabel(TOKEN), usage: usageOf(98) },
    [tokenKey(TOKEN2)]: { kind: 'token', label: tokenLabel(TOKEN2), usage: usageOf(41), direct: true },
  };
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ entries }));
  const t = new UsageTracker({ dataDir: dir } as never, () => undefined, { log: () => undefined });
  assert.equal(t.entries.has(tokenKey(TOKEN)), false);
  assert.equal(t.entries.get(tokenKey(TOKEN2))?.usage?.weekly?.percent, 41);
  assert.equal(t.usage?.weekly?.percent, 98);
  fs.rmSync(dir, { recursive: true });
});

test('tracker: every token shows numbers or "usage unknown: <reason>" after one poll, even when a request never answers', async () => {
  const never = () => new Promise<never>(() => undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-hang-'));
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'login-secret', refreshToken: 'r', scopes: ['user:profile'] } }));
  const cfg = { dataDir: dir, claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: dir } } as never;
  const summary = (t: UsageTracker) => accountLines(tokenOnly(t), new Map(), new Date(AS_OF)).find((l) => l.includes('host token'))!;
  // The request that wedged BEAST's portal (2026-09-28): it never settles, nor does the login's CLI.
  let hang = { token: never as () => Promise<UsageReply>, limits: never as () => Promise<UsageReply> };
  const logs: string[] = [];
  const t = new UsageTracker(cfg, () => undefined, {
    fetchLogin: never,
    fetchToken: () => hang.token(),
    fetchTokenLimits: () => hang.limits(),
    log: (line) => logs.push(line),
    answerMs: 30,
  });
  assert.match(summary(t), /not fetched yet/, 'before the first poll');
  await t.refresh();
  assert.doesNotMatch(summary(t), /not fetched yet/);
  assert.match(t.entries.get(tokenKey(TOKEN))!.usage!.why!, /^usage unknown: the usage endpoint gave no answer within 0 s$/);
  assert.match(t.usage!.why!, /could not fetch plan usage: the claude\.ai login \(through the CLI\) gave no answer/);

  // The next poll runs (the first no longer holds it), and a rate-limited endpoint whose headers hang is unknown too.
  hang = {
    token: async () => {
      throw new UsageFetchError('the usage endpoint rate-limits this token, next try in 58 min (HTTP 429)', 3_463_000);
    },
    limits: never,
  };
  await t.refresh();
  assert.match(t.entries.get(tokenKey(TOKEN))!.usage!.why!, /^usage unknown: the usage endpoint rate-limits .*HTTP 429\); the API's rate-limit headers gave no answer/);

  // An answer nothing can read is a reason as well, never an exception that leaves the entry unset.
  const odd = new UsageTracker({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'usage-odd-')), claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: dir } } as never, () => undefined, {
    fetchLogin: never,
    fetchToken: async () => ({ rate_limits_available: true, rate_limits: { limits: 7 as never } }),
    log: () => undefined,
    answerMs: 30,
  });
  await odd.refresh();
  assert.match(odd.entries.get(tokenKey(TOKEN))!.usage!.why!, /^usage unknown: /);
  assert.ok(logs.some((l) => /host token …9AAA .*: failed, no numbers: usage unknown: /.test(l)), logs.join('\n'));
  fs.rmSync(dir, { recursive: true });
});

test('tracker: a poll that has run longer than 5 minutes no longer blocks the next one', async (tc) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stuck-'));
  const logs: string[] = [];
  let calls = 0;
  // The login's request hangs for the whole test, then fails: left hanging, its 60 s deadline kept this file's process
  // alive for a minute on a Mac (where the stored-login check lets it start; w636).
  const hung: ((e: Error) => void)[] = [];
  tc.after(() => hung.forEach((fail) => fail(new Error('the test is over'))));
  const t = new UsageTracker({ dataDir: dir, claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: dir } } as never, () => undefined, {
    fetchLogin: () => new Promise((_, fail) => hung.push(fail)),
    fetchToken: async () => {
      calls++;
      return { rate_limits_available: true, rate_limits: endpointBody(41, 33, 0) };
    },
    log: (line) => logs.push(line),
    answerMs: 60_000,
  });
  void t.refresh();
  await t.refresh(); // still in flight, and recent: skipped
  assert.equal(calls, 1);
  (t as unknown as { inFlightSince: number }).inFlightSince -= 6 * 60_000;
  await Promise.race([t.refresh(), new Promise((r) => setTimeout(r, 20))]);
  assert.equal(calls, 2);
  assert.ok(logs.some((l) => /has not finished; polling again/.test(l)), logs.join('\n'));
  fs.rmSync(dir, { recursive: true });
});

test('tracker: one poll at start, then one every usagePollMinutes; Refresh polls at once and moves the next; system_status polls only when stale', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse(AS_OF) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-every-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const cfg = { dataDir: dir, usagePollMinutes: 15, claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: dir } } as never as Config;
  const tr = new UsageTracker(cfg, () => undefined, {
    fetchLogin: async () => {
      throw new UsageFetchError('no login here');
    },
    fetchToken: async () => {
      calls++;
      return { rate_limits_available: true, rate_limits: endpointBody(41, 33, 0) };
    },
    log: () => undefined,
  });
  t.after(() => tr.stop());
  const settle = () => new Promise((r) => setImmediate(r));
  const minutes = async (n: number) => {
    for (let i = 0; i < n; i++) {
      t.mock.timers.tick(60_000);
      await settle();
    }
  };
  tr.start();
  await settle();
  assert.equal(calls, 1, 'one poll at start, so the meters are not empty');
  await minutes(14);
  assert.equal(calls, 1, 'nothing before the interval (the 10 s token check polls only a new token)');
  await minutes(1);
  assert.equal(calls, 2, 'the next one 15 minutes after');

  // system_status: numbers under an interval old are used as they are.
  tr.ensureFresh();
  await settle();
  assert.equal(calls, 2);

  // The Refresh button polls now, not twice within seconds, and the next scheduled poll counts from it.
  await minutes(5);
  assert.equal(tr.refreshNow(), true);
  await settle();
  assert.equal(calls, 3);
  assert.equal(tr.refreshNow(), false, 'a second click within seconds does not poll again');
  await minutes(14);
  assert.equal(calls, 3, 'the scheduled poll moved to 15 minutes after the refresh');
  await minutes(1);
  assert.equal(calls, 4);

  // A new interval (set_app_config usagePollMinutes) applies at once.
  cfg.usagePollMinutes = 5;
  tr.reschedule();
  await minutes(5);
  assert.equal(calls, 5);

  // Stale numbers (the timer was held up): a look at system_status polls.
  tr.stop();
  await minutes(6);
  tr.ensureFresh();
  await settle();
  assert.equal(calls, 6);
});

// ---------------------------------------------------------------- w739: tokens without user:profile, near-limit polling, rate-limit events

test('tracker: a token without the user:profile scope (403) is read from the rate-limit headers, and the endpoint is not asked again for hours', async () => {
  // Every `claude setup-token` token answers the usage endpoint "403 oauth_scope_insufficient"; FFBox reads the same two windows
  // off a /v1/messages reply (ffbox scripts/claude_keys.py, measured 2026-09-04 there).
  const { t, calls, logs } = trackerWith(
    async () => {
      throw new UsageFetchError('the token may not read usage (HTTP 403: OAuth token does not meet scope requirement user:profile)', undefined, 403);
    },
    async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 33, resets_at: '2026-09-28T04:40:00+00:00' }, seven_day: { utilization: 41, resets_at: '2026-10-02T03:00:00+00:00' } } }),
  );
  await t.refresh();
  const u = t.entries.get(tokenKey(TOKEN))!.usage!;
  assert.deepEqual([u.available, u.weekly?.percent, u.session?.percent, u.source], [true, 41, 33, 'rate limits']);
  assert.equal(u.weekly?.resetsAt, '2026-10-02T03:00:00+00:00');
  assert.deepEqual([calls.token.length, calls.limits.length], [1, 1]);
  assert.match(logs.find((l) => l.includes(tokenKey(TOKEN))) ?? '', /via the API's rate-limit headers \(the usage endpoint needs the user:profile scope|via the API's rate-limit headers \(the token may not read usage/);
  await t.refresh();
  assert.deepEqual([calls.token.length, calls.limits.length], [1, 2], 'the endpoint is not asked again; the headers are');
  assert.ok(![...logs, JSON.stringify([...t.entries])].some((l) => l.includes(TOKEN.slice(13, 40))), 'no token in the log or the numbers');
});

test('tracker: a token near a pool limit is polled alone between the regular polls; one far from every limit is not', async () => {
  let session = 33;
  const { t, calls } = trackerWith(async () => ({ rate_limits_available: true, rate_limits: endpointBody(41, session, 0) }));
  await t.refresh();
  assert.deepEqual(t.nearTokens(), [], '33% of the 5-hour window and 41% of the week: far');
  await t.refreshNear();
  assert.equal(calls.token.length, 1, 'nothing near, nothing polled');
  session = 61;
  await t.refresh();
  assert.deepEqual(t.nearTokens().map((x) => tokenKey(x.token)), [tokenKey(TOKEN)], '61% of the 5-hour window: near');
  const logins = calls.login.length;
  session = 64;
  await t.refreshNear();
  assert.equal(calls.token.length, 3, 'the near token alone');
  assert.equal(calls.login.length, logins, "the host login's CLI is not run for it");
  assert.equal(t.entries.get(tokenKey(TOKEN))!.usage!.session?.percent, 64);
  // 90% of the week is near too.
  session = 10;
  const weekly = trackerWith(async () => ({ rate_limits_available: true, rate_limits: endpointBody(91, 10, 0) }));
  await weekly.t.refresh();
  assert.equal(weekly.t.nearTokens().length, 1);
});

test("tracker: a session's rate_limit_event raises its token's meter and never lowers it; the next poll replaces it", async () => {
  const { t } = trackerWith(async () => ({ rate_limits_available: true, rate_limits: endpointBody(41, 33, 0) }));
  await t.refresh();
  const key = tokenKey(TOKEN);
  const sess = () => t.entries.get(key)!.usage!.session!.percent;
  const week = () => t.entries.get(key)!.usage!.weekly!.percent;
  t.noteRateLimit(key, { rateLimitType: 'five_hour', utilization: 0.5, resetsAt: Date.parse('2026-09-28T05:00:00Z') / 1000 });
  assert.equal(sess(), 50, 'a fraction, as the headers carry it');
  assert.equal(t.entries.get(key)!.usage!.session!.resetsAt, '2026-09-28T05:00:00.000Z');
  t.noteRateLimit(key, { rateLimitType: 'five_hour', utilization: 0.2 });
  assert.equal(sess(), 50, 'never lowered between polls');
  t.noteRateLimit(key, { rateLimitType: 'seven_day', utilization: 85 });
  assert.equal(week(), 85, 'a value above 1 is a percent');
  for (const bad of [{ rateLimitType: 'seven_day_opus', utilization: 0.99 }, { rateLimitType: 'five_hour' }, { rateLimitType: 'five_hour', utilization: NaN }, { utilization: 0.99 }]) t.noteRateLimit(key, bad);
  assert.deepEqual([sess(), week()], [50, 85]);
  t.noteRateLimit(HOST_LOGIN, { rateLimitType: 'five_hour', utilization: 0.99 });
  t.noteRateLimit(undefined, { rateLimitType: 'five_hour', utilization: 0.99 });
  t.noteRateLimit('token:unknown', { rateLimitType: 'five_hour', utilization: 0.99 });
  assert.equal(t.entries.get(HOST_LOGIN)!.usage!.session?.percent, 0, "a login's meters are not touched");
  await t.refresh();
  assert.equal(sess(), 33, 'the poll replaces the floor');
});

test('accounts (w748): only accounts something is set to use; a Mac login leaves while its machine is on the vault and returns when it is not', () => {
  const vaultKey = 'token:abc123abc123';
  const entries = new Map<string, UsageEntry>([
    [HOST_LOGIN, { kind: 'login', account: { email: 'portal@example.com' }, usage: usageOf(10) }],
    [tokenKey(TOKEN), { kind: 'token', label: tokenLabel(TOKEN), usage: usageOf(20) }],
    ['login:lothdesktop', { kind: 'login', account: { email: 'shamrock@example.com' }, usage: usageOf(30) }],
    ['login:m3', { kind: 'login', account: { email: 'm3@example.com' }, usage: usageOf(40) }],
    [vaultKey, { kind: 'token', label: 'lothsahn-1 …EAAA', usage: usageOf(95), direct: true }],
  ]);
  const ctx = (o: { lothVault: boolean; inUse?: { hostLogin: boolean; hostToken: boolean; vault: boolean }; sessions?: { id: string; source: string; live?: boolean }[] }) => ({
    hostName: 'fff-portal',
    token: { key: tokenKey(TOKEN), label: tokenLabel(TOKEN) },
    vault: [{ key: vaultKey, label: 'lothsahn-1 …EAAA' }],
    machines: [
      { id: 'lothdesktop', usesToken: false, onVault: o.lothVault },
      { id: 'm3', usesToken: false, onVault: false },
    ],
    inUse: o.inUse ?? { hostLogin: false, hostToken: true, vault: true },
    sessions: o.sessions ?? [],
  });
  const labels = (c: ReturnType<typeof ctx>) => buildAccounts(entries, c).map((a) => a.label).sort();
  // LothDesktop on the vault: its login is gone from the list, the portal's own login too (no role is set to it); m3's stays.
  assert.deepEqual(labels(ctx({ lothVault: true })), ['host token …9AAA', 'lothsahn-1 …EAAA', 'm3@example.com']);
  // Taken off the vault: it shows again, as "lothdesktop login".
  assert.deepEqual(labels(ctx({ lothVault: false })), ['host token …9AAA', 'lothsahn-1 …EAAA', 'm3@example.com', 'shamrock@example.com']);
  // A role set to the host login brings the portal's login back.
  assert.ok(labels(ctx({ lothVault: true, inUse: { hostLogin: true, hostToken: true, vault: true } })).includes('portal@example.com'));
  // Nothing set to the host token and nothing on the vault: both leave.
  assert.deepEqual(labels(ctx({ lothVault: true, inUse: { hostLogin: false, hostToken: false, vault: false } })), ['m3@example.com']);
  // An agent still running on a hidden account keeps it listed until it stops.
  assert.deepEqual(
    labels(ctx({ lothVault: true, sessions: [{ id: 'w9', source: 'login:lothdesktop', live: true }] })),
    ['host token …9AAA', 'lothsahn-1 …EAAA', 'm3@example.com', 'shamrock@example.com'],
  );
  assert.deepEqual(labels(ctx({ lothVault: true, sessions: [{ id: 'w9', source: 'login:lothdesktop', live: false }] })), ['host token …9AAA', 'lothsahn-1 …EAAA', 'm3@example.com']);
  // The machine daemon's own row for a machine on the host token goes too.
  const viaToken = { ...ctx({ lothVault: false }), machines: [{ id: 'lothdesktop', usesToken: true, onVault: false }, { id: 'm3', usesToken: false, onVault: false }] };
  assert.ok(!labels(viaToken).includes('shamrock@example.com'));
  // Without `inUse` (an older caller) everything is listed as before.
  const { inUse: _omit, ...bare } = ctx({ lothVault: true });
  assert.ok(buildAccounts(entries, bare).some((a) => a.label === 'shamrock@example.com'));
});

test('accounts (w748): a vault token is named by itself and the status line has no description, only the agents on it', () => {
  const key = 'token:abc123abc123';
  const entries = new Map<string, UsageEntry>([[key, { kind: 'token', label: 'lothsahn-1 …EAAA', usage: { ...usageOf(95), source: 'rate limits' } }]]);
  const accounts = buildAccounts(entries, { hostName: 'fff-portal', vault: [{ key, label: 'lothsahn-1 …EAAA' }], machines: [], inUse: { hostLogin: false, hostToken: false, vault: true }, sessions: [{ id: 'w1', source: key, live: true }] });
  assert.deepEqual(accounts.map((a) => [a.label, a.where]), [['lothsahn-1 …EAAA', []]]);
  const lines = accountLines(accounts, new Map([['w1', { id: 'w1', kind: 'worker' as const, status: 'running' as const }]]), new Date(AS_OF));
  assert.match(lines[1], /^- lothsahn-1 …EAAA \[agents on it: w1\]: Claude plan .*usage, as of .*, from rate limits: Weekly 95% used/);
  assert.doesNotMatch(lines.join('\n'), /vault:|the token vault|headers/);
});

test('accounts (w777): a vault token is always listed under its vault name, once, with the other roles on its subtext when it is also another account', () => {
  const T3 = 'sk-ant-oat01-' + 'c'.repeat(44);
  const key = tokenKey(TOKEN2);
  const vaultEntry = { key, label: 'vault-ben-2 …' + TOKEN2.slice(-4) };
  // The tracker keeps one entry per token and names it by its first holder: the token file's name here.
  const entries = (label: string) => new Map<string, UsageEntry>([[key, { kind: 'token', label, usage: usageOf(61), direct: true }]]);
  const base = { hostName: 'fff-portal', machines: [], inUse: { hostLogin: false, hostToken: true, vault: true } };
  const asRow = (a: { id: string; label: string; where: string[]; sessionIds: string[]; usage?: { weekly?: { percent: number } } }) => [a.id, a.label, a.where, a.sessionIds, a.usage?.weekly?.percent];

  // equal to the token file: one row named by the vault entry, the file's roles noted, its agents listed, one usage
  const fileAccounts = buildAccounts(entries('token file …' + TOKEN2.slice(-4)), {
    ...base,
    vault: [vaultEntry],
    tokenFile: { key, label: 'token file …' + TOKEN2.slice(-4), roles: ['orchestrator'] },
    sessions: [{ id: 'orch', source: key, live: true }],
  });
  assert.equal(fileAccounts.length, 1, 'one account, not two with the same usage');
  assert.deepEqual(asRow(fileAccounts[0]), [key, 'vault-ben-2 …' + TOKEN2.slice(-4), ["fff-portal's token file (the orchestrator)"], ['orch'], 61]);

  // equal to the host token: the vault name, the host token's use on the subtext
  const hostAccounts = buildAccounts(entries('host token …' + TOKEN2.slice(-4)), {
    ...base,
    token: { key, label: 'host token …' + TOKEN2.slice(-4) },
    vault: [vaultEntry],
    machines: [{ id: 'm5', usesToken: true }],
    sessions: [{ id: 'w1', source: key, live: true }],
  });
  assert.equal(hostAccounts.length, 1);
  assert.deepEqual(asRow(hostAccounts[0]), [key, 'vault-ben-2 …' + TOKEN2.slice(-4), ["the agents' token on fff-portal, m5"], ['w1'], 61]);

  // equal to a person's own token (userClaudeEnv)
  const personAccounts = buildAccounts(entries('Ben\'s token …' + TOKEN2.slice(-4)), {
    ...base,
    people: [{ key, label: 'Ben\'s token …' + TOKEN2.slice(-4), displayName: 'Ben' }],
    vault: [vaultEntry],
    sessions: [{ id: 'b1', source: key, live: true }],
  });
  assert.equal(personAccounts.length, 1);
  assert.deepEqual(asRow(personAccounts[0]), [key, 'vault-ben-2 …' + TOKEN2.slice(-4), ["agents working for Ben"], ['b1'], 61]);

  // equal to the host token and the token file at once: both noted
  const both = buildAccounts(entries('host token'), {
    ...base,
    token: { key, label: 'host token' },
    tokenFile: { key, label: 'token file', roles: ['orchestrator'] },
    vault: [vaultEntry],
    sessions: [],
  });
  assert.equal(both.length, 1);
  assert.equal(both[0].where.length, 2);

  // system_status names it by the vault entry first
  const line = accountLines(fileAccounts, new Map([['orch', { id: 'orch', kind: 'orchestrator' as const, status: 'running' as const }]]), new Date(AS_OF))[1];
  assert.match(line, /^- vault-ben-2 …\w{4} \[fff-portal's token file \(the orchestrator\); agents on it: .*\]: /);
  assert.doesNotMatch(line, /^- token file/);

  // the host token and the vault token still count as in use through the vault alone
  const notInUse = buildAccounts(entries('x'), { ...base, token: { key, label: 'host token' }, vault: [vaultEntry], inUse: { hostLogin: false, hostToken: false, vault: true }, sessions: [] });
  assert.equal(notInUse.length, 1, 'the vault role keeps it');
  const noneInUse = buildAccounts(entries('x'), { ...base, token: { key, label: 'host token' }, vault: [vaultEntry], inUse: { hostLogin: false, hostToken: false, vault: false }, sessions: [] });
  assert.equal(noneInUse.length, 0, 'nothing uses either role');
  // ...and a person's own token is never hidden
  assert.equal(buildAccounts(entries('x'), { ...base, people: [{ key, label: 'x', displayName: 'Ben' }], vault: [vaultEntry], inUse: { hostLogin: false, hostToken: false, vault: false }, sessions: [] }).length, 1);

  // distinct tokens are unchanged: each keeps its own row and name, with no "also"
  const k1 = tokenKey(TOKEN);
  const k3 = tokenKey(T3);
  const distinct = buildAccounts(
    new Map<string, UsageEntry>([[k1, { kind: 'token', label: 'host token', usage: usageOf(10) }], [k3, { kind: 'token', label: 'vault-ben-3 …cccc', usage: usageOf(20), direct: true }], [key, { kind: 'token', label: 'vault-ben-2', usage: usageOf(61), direct: true }]]),
    { ...base, token: { key: k1, label: 'host token …9AAA' }, vault: [{ key: k3, label: 'vault-ben-3 …cccc' }, vaultEntry], sessions: [] },
  );
  assert.deepEqual(distinct.map((a) => a.label).sort(), ['host token', 'vault-ben-2 …' + TOKEN2.slice(-4), 'vault-ben-3 …cccc']);
  assert.deepEqual(distinct.filter((a) => a.label.startsWith('vault-')).map((a) => a.where), [[], []], 'a vault token that is no other account has no subtext');
  assert.deepEqual(distinct.find((a) => a.id === k1)?.where, ["the agents' token on fff-portal"], 'a host token in no vault entry keeps its own row and subtext');
});

test('accounts (w777): a token file or host token that is in no vault entry keeps its own row, beside the vault tokens', () => {
  const kFile = tokenKey(TOKEN);
  const kVault = tokenKey(TOKEN2);
  const accounts = buildAccounts(
    new Map<string, UsageEntry>([[kFile, { kind: 'token', label: 'token file …9AAA', usage: usageOf(40) }], [kVault, { kind: 'token', label: 'vault-ben-2', usage: usageOf(61), direct: true }]]),
    { hostName: 'fff-portal', machines: [], tokenFile: { key: kFile, label: 'token file …9AAA', roles: ['orchestrator'] }, vault: [{ key: kVault, label: 'vault-ben-2 …7BBB' }], inUse: { hostLogin: false, hostToken: false, vault: true }, sessions: [] },
  );
  assert.deepEqual(accounts.map((a) => [a.label, a.where]).sort(), [['token file …9AAA', ["fff-portal's token file (the orchestrator)"]], ['vault-ben-2 …7BBB', []]]);
});

test('accounts (w785): a vault token shows the account email a person recorded on its subtext, before its other uses; none recorded shows nothing', () => {
  const key = tokenKey(TOKEN2);
  const entries = new Map<string, UsageEntry>([[key, { kind: 'token', label: 'token file …7BBB', usage: usageOf(61), direct: true }]]);
  const base = { hostName: 'fff-portal', machines: [], inUse: { hostLogin: false, hostToken: false, vault: true }, sessions: [{ id: 'w1', source: key, live: true }] };
  const label = 'vault-ben-2 …7BBB';
  // an email recorded: it is the subtext, as "m3 login" is for a Mac
  const withEmail = buildAccounts(entries, { ...base, vault: [{ key, label, email: 'ben@example.com' }] });
  assert.deepEqual(withEmail.map((a) => [a.label, a.where]), [[label, ['ben@example.com']]]);
  // none recorded: nothing is shown and nothing is invented
  const without = buildAccounts(entries, { ...base, vault: [{ key, label }] });
  assert.deepEqual(without.map((a) => [a.label, a.where]), [[label, []]]);
  // set after the token was added: the same token, the next list carries it
  const later = buildAccounts(entries, { ...base, vault: [{ key, label, email: 'later@example.com' }] });
  assert.deepEqual(later[0].where, ['later@example.com']);
  // beside another use of the same token: the email first, then the other use
  const alsoFile = buildAccounts(entries, { ...base, vault: [{ key, label, email: 'ben@example.com' }], tokenFile: { key, label: 'token file', roles: ['orchestrator'] } });
  assert.deepEqual(alsoFile[0].where, ['ben@example.com', "fff-portal's token file (the orchestrator)"]);
  // a login's own email is its label as before; a host token (not a vault entry) gets none
  const host = buildAccounts(new Map<string, UsageEntry>([[tokenKey(TOKEN), { kind: 'token', label: 'host token …9AAA' }]]), { ...base, sessions: [], inUse: { hostLogin: false, hostToken: true, vault: false }, token: { key: tokenKey(TOKEN), label: 'host token …9AAA' }, vault: [{ key, label, email: 'ben@example.com' }] });
  assert.deepEqual(host.map((a) => a.label), ['host token …9AAA']);
  // system_status carries it on the same line
  const lines = accountLines(withEmail, new Map([['w1', { id: 'w1', kind: 'worker' as const, status: 'running' as const }]]), new Date(AS_OF));
  assert.match(lines[1], /^- vault-ben-2 …7BBB \[ben@example\.com; agents on it: w1\]: /);
  assert.match(accountLines(without, new Map(), new Date(AS_OF))[1], /^- vault-ben-2 …7BBB \[agents on it: /);
});
