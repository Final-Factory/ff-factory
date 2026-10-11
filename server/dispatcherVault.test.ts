import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolHeldError, Vault, fingerprintOf, newKeyText, setVaultContext, type VaultContext } from './vault.ts';
import { accountSetupLines, hostAccount, hostAccountsInUse, hostProcessEnv, liveOnAccount, machineRunEnv, pinnedDispatcherEntry, pinnedDispatcherEnv, reserveLines, reservedCredentials } from './secrets.ts';
import { checkAccountConfig } from './config.ts';
import { normalizeSetting } from './appConfig.ts';
import { poolLimits } from './tokenPool.ts';
import { tokenKey } from './usage.ts';
import type { PlanUsage } from '../shared/types.ts';

// w996: claudeAccounts.dispatcher "vault:<entry name>": the dispatcher on one named vault token, its reserve kept there.

const NOW = Date.parse('2026-10-11T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const claudeTok = (c: string) => `sk-ant-oat01-${c.repeat(48)}`;
const L1 = claudeTok('a'); // vault-lothsahn-1, ...aaaa: the dispatcher's
const L2 = claudeTok('b'); // vault-lothsahn-2
const FILE = claudeTok('f'); // the token file
const HOST = claudeTok('g'); // config claudeEnv: the host token
const API_KEY = ['sk-ant-api03-', 'z'.repeat(40)].join('');
const fp = (v: string) => fingerprintOf(v);

const usage = (session: number, weekly: number, o: { weeklyDays?: number; sessionHours?: number } = {}): PlanUsage => ({
  available: true,
  asOf: iso(NOW),
  models: [],
  session: { label: '5-hour', percent: session, ...(o.sessionHours !== undefined ? { resetsAt: iso(NOW + o.sessionHours * 3_600_000) } : {}) },
  weekly: { label: 'weekly', percent: weekly, ...(o.weeklyDays !== undefined ? { resetsAt: iso(NOW + o.weeklyDays * DAY) } : {}) },
});

function setup(t: { after: (fn: () => void) => void }, pool: 'two' | 'one' = 'two') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-dvault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'vault.key');
  fs.writeFileSync(keyFile, newKeyText(), { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const tokenFile = path.join(dir, 'claude-oauth-token');
  fs.writeFileSync(tokenFile, `${FILE}\n`, { mode: 0o600 });
  const vault = new Vault({ file: path.join(dir, 'vault.json'), key: () => ({ file: keyFile }) });
  vault.add({ name: 'vault-lothsahn-1', kind: 'claude', value: L1, owner: 'lothsahn', share: 'owner' });
  if (pool === 'two') vault.add({ name: 'vault-lothsahn-2', kind: 'claude', value: L2, owner: 'lothsahn', share: 'owner' });
  return { vault, tokenFile, dir };
}

const PINNED = { orchestrator: 'vault', dispatcher: 'vault:vault-lothsahn-1' } as const;
const cfgOf = (tokenFile: string, extra: Record<string, unknown> = {}) =>
  ({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST, ANTHROPIC_API_KEY: API_KEY, CLAUDE_CONFIG_DIR: '/x' }, userClaudeEnv: {}, machines: { claudeFromVault: true }, claudeTokenFile: tokenFile, claudeAccounts: PINNED, ...extra }) as never;

/** The vault context the portal builds (server/index.ts): the reserve comes from config, the live counts from liveOnAccount. */
function ctxOf(vault: Vault, cfg: never, meters: Record<string, PlanUsage | undefined>, sessions: Parameters<typeof liveOnAccount>[0] = []): VaultContext & { problems: string[] } {
  const problems: string[] = [];
  const list = [...sessions];
  return {
    vault,
    usageOf: (f) => meters[f],
    liveOn: (f, except) => liveOnAccount(list, `token:${f}`, except),
    reservedFor: (f) => {
      const c = reservedCredentials(cfg, { vault }).find((x) => x.key === `token:${f}`);
      return c ? (c.role === 'dispatcher' ? 'the dispatcher' : 'its own roles') : undefined;
    },
    payer: () => 'lothsahn',
    onProblem: (l) => problems.push(l),
    problems,
    limits: () => poolLimits(undefined),
    now: () => NOW,
  };
}
const loth = { userId: 'lothsahn', displayName: 'Lothsahn' };
const worker = (cfg: never, ctx: VaultContext, sessionId: string) => machineRunEnv(cfg, { id: 'm3' }, { role: 'workers', requestedBy: loth, sessionId }, ctx);

test('config: the dispatcher alone takes "vault:<entry name>"; the orchestrator, a bad name and other roles are refused', () => {
  checkAccountConfig({ claudeAccounts: PINNED } as never);
  checkAccountConfig({ claudeAccounts: { dispatcher: 'vault:ben.max_2' } } as never);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { orchestrator: 'vault:vault-lothsahn-1' } } as never), /claudeAccounts\.orchestrator cannot be "vault:vault-lothsahn-1": only dispatcher/);
  for (const bad of ['vault:', 'vault:Upper', 'vault: x', 'vault:a/b', `vault:${'x'.repeat(41)}`]) {
    assert.throws(() => checkAccountConfig({ claudeAccounts: { dispatcher: bad } } as never), /vault entry's name|"vault:<entry name>"/, bad);
  }
  assert.throws(() => checkAccountConfig({ claudeAccounts: { dispatcher: 'vault' } } as never), /claudeAccounts\.dispatcher cannot be "vault"/, 'the plain pool value is still the orchestrators\'');
  assert.throws(() => checkAccountConfig({ claudeAccounts: { dispatcher: 'keychain' } } as never), /"vault:<entry name>" for dispatcher/);
});

test('set_app_config: "vault:<entry name>" is accepted for the dispatcher when the vault holds that Claude token, refused otherwise', (t) => {
  assert.equal(normalizeSetting('claudeAccounts.dispatcher', ' vault:vault-lothsahn-1 '), 'vault:vault-lothsahn-1', 'no vault in this process (tests): the name shape is checked');
  assert.throws(() => normalizeSetting('claudeAccounts.orchestrator', 'vault:vault-lothsahn-1'), /only dispatcher can run on one named vault token/);
  assert.throws(() => normalizeSetting('claudeAccounts.dispatcher', 'vault:Not A Name'), /vault entry name/);
  assert.throws(() => normalizeSetting('claudeAccounts.dispatcher', 'sideways'), /or "vault:<vault entry name>" \(one named vault Claude token\)/);
  const { vault } = setup(t);
  vault.add({ name: 'github-x', kind: 'github', value: 'ghp_' + 'x'.repeat(36), owner: 'lothsahn', share: 'owner' });
  vault.add({ name: 'off', kind: 'claude', value: claudeTok('c'), owner: 'lothsahn', share: 'owner' });
  vault.update('off', { disabled: true });
  setVaultContext({ vault });
  t.after(() => setVaultContext(undefined));
  assert.equal(normalizeSetting('claudeAccounts.dispatcher', 'vault:vault-lothsahn-1'), 'vault:vault-lothsahn-1');
  for (const name of ['nonexistent', 'github-x', 'off']) {
    assert.throws(() => normalizeSetting('claudeAccounts.dispatcher', `vault:${name}`), new RegExp(`no enabled Claude token named "${name}"`), name);
  }
});

test('the dispatcher on a vault token: hostAccount says so, the orchestrators keep "vault", and the fallback is the token file', (t) => {
  const { tokenFile } = setup(t);
  const cfg = cfgOf(tokenFile);
  assert.equal(hostAccount(cfg, 'dispatcher'), 'vault:vault-lothsahn-1');
  assert.equal(hostAccount(cfg, 'orchestrator'), 'vault');
  assert.equal(pinnedDispatcherEntry(cfg), 'vault-lothsahn-1');
  assert.equal(pinnedDispatcherEntry(cfgOf(tokenFile, { claudeAccounts: { dispatcher: 'tokenfile' } })), undefined);
  assert.equal(pinnedDispatcherEntry(cfgOf(tokenFile, { claudeAccounts: { orchestrator: 'vault' } })), undefined, 'inheriting "vault" is not a pin');
  assert.equal(hostProcessEnv(cfg, 'dispatcher', { PATH: '/bin' }).CLAUDE_CODE_OAUTH_TOKEN, FILE, 'the base account, used when the vault cannot give the token');
  const noFile = cfgOf(tokenFile, { claudeTokenFile: undefined });
  assert.equal(hostProcessEnv(noFile, 'dispatcher', { PATH: '/bin' }).CLAUDE_CODE_OAUTH_TOKEN, HOST);
  assert.equal(hostAccountsInUse(cfg).vault, true, 'the accounts list keeps the vault tokens');
});

test('pinnedDispatcherEnv: exactly the named token, every other Claude credential gone; a missing or disabled one falls back with a warning', (t) => {
  const { vault, tokenFile } = setup(t);
  const cfg = cfgOf(tokenFile);
  const ctx = ctxOf(vault, cfg, {});
  const fallback = () => hostProcessEnv(cfg, 'dispatcher', { PATH: '/bin' });
  const r = pinnedDispatcherEnv(cfg, fallback, ctx)!;
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, L1);
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined, 'an API key would outrank the token');
  assert.equal(r.env.CLAUDE_CONFIG_DIR, '/x', 'settings that are not credentials stay');
  assert.match(r.account, /^vault token vault-lothsahn-1 …aaaa \(the dispatcher's/);
  assert.equal(r.account.includes(L1.slice(13, 40)), false, 'the account line carries no token');
  assert.equal(ctx.problems.length, 0);
  // Not pinned: nothing to do here.
  assert.equal(pinnedDispatcherEnv(cfgOf(tokenFile, { claudeAccounts: { dispatcher: 'tokenfile' } }), fallback, ctx), undefined);
  // The entry is disabled: the dispatcher still starts, on the token file, and the problem is reported (not a stop).
  vault.update('vault-lothsahn-1', { disabled: true });
  const down = pinnedDispatcherEnv(cfg, fallback, ctx)!;
  assert.equal(down.env.CLAUDE_CODE_OAUTH_TOKEN, FILE);
  assert.equal(down.account, 'token file');
  assert.match(ctx.problems.at(-1) ?? '', /the dispatcher is pinned to vault token vault-lothsahn-1 .* runs on the token file instead/);
  // No vault in this process at all: the same.
  assert.equal(pinnedDispatcherEnv(cfg, fallback, undefined)!.env.CLAUDE_CODE_OAUTH_TOKEN, FILE);
});

test("the reserve moves with the dispatcher: the named vault token is the dispatcher's, the host token keeps a reserve for its own roles", (t) => {
  const { vault, tokenFile } = setup(t);
  const cfg = cfgOf(tokenFile);
  const got = reservedCredentials(cfg, { vault });
  assert.deepEqual(got.map((c) => [c.role, c.key]), [['dispatcher', tokenKey(L1)], ['host-token', tokenKey(HOST)]]);
  assert.equal(tokenKey(L1), `token:${fp(L1)}`, 'the vault entry matches the meters by this fingerprint');
  assert.equal(got[0].what, "the dispatcher's vault token vault-lothsahn-1 …aaaa");
  // The token file is no longer reserved: it is nobody's dispatcher credential.
  assert.ok(!got.some((c) => c.key === tokenKey(FILE)));
  // The meters: the usual rule on the new token (5 days left = 25% weekly, 20% of the 5-hour window).
  const meters: Record<string, PlanUsage | undefined> = { [tokenKey(L1)]: usage(12, 41, { weeklyDays: 5 }), [tokenKey(HOST)]: usage(5, 10, { weeklyDays: 5 }) };
  const lines = reserveLines(cfg, (k) => meters[k], () => 0, NOW, { vault });
  assert.equal(lines[0].line, "dispatcher's vault token vault-lothsahn-1 …aaaa: weekly 41%, reserve 25% (5 days to reset); 5-hour 12%, reserve 20%");
  // system_status names it.
  setVaultContext({ vault });
  t.after(() => setVaultContext(undefined));
  assert.match(accountSetupLines(cfg, 'portal', HOST, [])[0], /the dispatcher here: vault token vault-lothsahn-1 …aaaa \(pinned/);
  // The vault cannot give it: the dispatcher runs on the token file, so that is where the reserve is.
  vault.update('vault-lothsahn-1', { disabled: true });
  assert.deepEqual(reservedCredentials(cfg, { vault }).map((c) => [c.role, c.key]), [['dispatcher', tokenKey(FILE)], ['host-token', tokenKey(HOST)]]);
  assert.deepEqual(reservedCredentials(cfgOf(tokenFile, { claudeTokenFile: undefined }), { vault }).map((c) => [c.role, c.key]), [['dispatcher', tokenKey(HOST)]], 'no token file: the host token');
  assert.match(accountSetupLines(cfg, 'portal', HOST, [])[0], /pinned, but the vault has no usable Claude entry of that name: it runs on the token file instead/);
});

test("lothsahn's workers stay off the dispatcher's token inside its buffer while another token has room; with none they wait", (t) => {
  const { vault, tokenFile } = setup(t);
  const cfg = cfgOf(tokenFile);
  // vault-lothsahn-1 (the dispatcher's) at 83% weekly with 5 days to go: inside the 25% buffer. vault-lothsahn-2 at 30%.
  const meters: Record<string, PlanUsage | undefined> = { [fp(L1)]: usage(10, 83, { weeklyDays: 5, sessionHours: 3 }), [fp(L2)]: usage(10, 30, { weeklyDays: 5, sessionHours: 3 }) };
  const ctx = ctxOf(vault, cfg, meters);
  assert.equal(worker(cfg, ctx, 'w1').env.CLAUDE_CODE_OAUTH_TOKEN, L2);
  // vault-lothsahn-2 is held (5-hour 90%): the worker waits rather than eating the dispatcher's buffer.
  meters[fp(L2)] = usage(90, 30, { weeklyDays: 5, sessionHours: 2 });
  assert.throws(
    () => worker(cfg, ctx, 'w2'),
    (e: unknown) => e instanceof PoolHeldError && /inside the buffer kept for the dispatcher/.test(e.message) && !e.message.includes(L1.slice(13, 40)),
  );
  // Outside the buffer (60% weekly, 25% buffer): an ordinary token again.
  meters[fp(L1)] = usage(10, 60, { weeklyDays: 5, sessionHours: 3 });
  assert.equal(worker(cfg, ctx, 'w3').env.CLAUDE_CODE_OAUTH_TOKEN, L1);
  // Before the move the same token was not reserved at all (the dispatcher was on the token file).
  const before = cfgOf(tokenFile, { claudeAccounts: { orchestrator: 'vault', dispatcher: 'tokenfile' } });
  meters[fp(L1)] = usage(10, 83, { weeklyDays: 5, sessionHours: 3 });
  meters[fp(L2)] = usage(90, 30, { weeklyDays: 5, sessionHours: 2 });
  assert.equal(worker(before, ctxOf(vault, before, meters), 'w4').env.CLAUDE_CODE_OAUTH_TOKEN, L1);
});

test("a pool of one token: the dispatcher's token inside its buffer holds the person's workers (said plainly)", (t) => {
  const { vault, tokenFile } = setup(t, 'one');
  const cfg = cfgOf(tokenFile);
  const meters: Record<string, PlanUsage | undefined> = { [fp(L1)]: usage(10, 80, { weeklyDays: 5, sessionHours: 3 }) };
  assert.throws(() => worker(cfg, ctxOf(vault, cfg, meters), 'w1'), (e: unknown) => e instanceof PoolHeldError && /inside the buffer kept for the dispatcher/.test(e.message));
  meters[fp(L1)] = usage(10, 70, { weeklyDays: 5, sessionHours: 3 });
  assert.equal(worker(cfg, ctxOf(vault, cfg, meters), 'w2').env.CLAUDE_CODE_OAUTH_TOKEN, L1);
});

test('the dispatcher takes no pool slot: liveOnAccount skips it, so the one-at-a-time slot of its token stays for a worker', (t) => {
  const key = tokenKey(L1);
  const sessions = [
    { id: 'disp', account: key, status: 'idle', kind: 'orchestrator', orchestratorRole: 'dispatcher' },
    { id: 'orch', account: key, status: 'running', kind: 'orchestrator', orchestratorRole: 'personal' },
    { id: 'w-old', account: key, status: 'stopped', kind: 'worker' },
    { id: 'w-err', account: key, status: 'error', kind: 'worker' },
    { id: 'w-other', account: tokenKey(L2), status: 'running', kind: 'worker' },
  ];
  assert.equal(liveOnAccount(sessions, key), 1, "only lothsahn's own orchestrator counts");
  assert.equal(liveOnAccount(sessions, key, 'orch'), 0, "the asking session's own process is never counted");
  assert.equal(liveOnAccount([sessions[0]], key), 0);

  // The last day of the week (12 hours left): the buffer is 2.5%, so 96% weekly is the one-at-a-time zone, not the buffer.
  const { vault, tokenFile } = setup(t, 'one');
  const cfg = cfgOf(tokenFile);
  const meters: Record<string, PlanUsage | undefined> = { [fp(L1)]: usage(10, 96, { weeklyDays: 0.5, sessionHours: 3 }) };
  const withDispatcher = ctxOf(vault, cfg, meters, [sessions[0]]);
  assert.equal(worker(cfg, withDispatcher, 'w1').env.CLAUDE_CODE_OAUTH_TOKEN, L1, 'the dispatcher is on the token and a worker still gets the one slot');
  // A worker already running on it does take the slot.
  const withWorker = ctxOf(vault, cfg, meters, [sessions[0], { id: 'w1', account: key, status: 'running', kind: 'worker' }]);
  assert.throws(() => worker(cfg, withWorker, 'w2'), (e: unknown) => e instanceof PoolHeldError && /one job at a time; its slot is taken \(1 running\)/.test(e.message));
});
