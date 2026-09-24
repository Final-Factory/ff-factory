import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addSpend,
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
