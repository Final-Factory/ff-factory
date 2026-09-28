import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountLines,
  addSpend,
  buildAccounts,
  HOST_LOGIN,
  hostToken,
  sessionSource,
  tokenKey,
  tokenLabel,
  tokenUsageEnv,
  UsageTracker,
  type UsageEntry,
  credentialsFile,
  describeReset,
  LOGIN_ACTION,
  loginProblem,
  parseUsage,
  readStoredLogin,
  usageEnv,
  usageLines,
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
  const [line] = usageLines(parseUsage(REAL, AS_OF), now);
  assert.match(line, /^Claude plan \(max\) usage, as of .+: Weekly 33% used, resets .+; Session \(5 h\) 33% used, resets in 2 h; Weekly Fable 22% used/);
  assert.match(usageLines(undefined, now)[0], /not fetched yet/);
  const [fb] = usageLines({ available: false, asOf: AS_OF, models: [], why: 'no scope', spendWeekUsd: 12.5 }, now);
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

test('accounts: the token is polled with the profile scope, the agents keep theirs', () => {
  const agents = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_SCOPES: 'user:inference', PATH: 'p' };
  assert.deepEqual(tokenUsageEnv(agents, TOKEN), { PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:profile' });
  assert.equal(agents.CLAUDE_CODE_OAUTH_SCOPES, 'user:inference');
  // claudeEnv wins over the server's own environment, as for the agents.
  assert.equal(hostToken({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN2 }), TOKEN);
  assert.equal(hostToken({}, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN2 }), TOKEN2);
  assert.equal(hostToken({}, {}), undefined);
});

test('accounts: each session is attributed to the credential it runs on', () => {
  const onlyM3OwnLogin = (id: string) => id !== 'm3';
  assert.equal(sessionSource({}, TOKEN, onlyM3OwnLogin), tokenKey(TOKEN));
  assert.equal(sessionSource({}, undefined, onlyM3OwnLogin), HOST_LOGIN);
  assert.equal(sessionSource({ machineId: 'm5' }, TOKEN, onlyM3OwnLogin), tokenKey(TOKEN));
  assert.equal(sessionSource({ machineId: 'm3' }, TOKEN, onlyM3OwnLogin), 'login:m3', 'machines.useHostClaudeEnv false: the Mac login');
  assert.equal(sessionSource({ machineId: 'm5' }, undefined, onlyM3OwnLogin), 'login:m5', 'no host token: the Mac login');
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
      { id: 'orch', source: tokenKey(TOKEN) },
      { id: 'w1', source: tokenKey(TOKEN) },
      { id: 'm3-w', source: 'login:m3' },
    ],
  });
  assert.deepEqual(
    accounts.map((a) => [a.id, a.label, a.sources, a.where, a.sessionIds, a.usage?.weekly?.percent]),
    [
      [tokenKey(TOKEN), 'host token …9AAA', [tokenKey(TOKEN)], ["the agents' token on BEAST, m5"], ['orch', 'w1'], 98],
      ['email:other@example.com', 'other@example.com', ['login:m3'], ['m3 login'], ['m3-w'], 12],
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
    sessions: [{ id: 'm3-w', source: 'login:m3' }],
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
