import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolHeldError, Vault, fingerprintOf, newKeyText, setVaultContext, type VaultContext } from './vault.ts';
import { accountSetupLines, hostAccount, liveOnAccount, machineRunEnv, pinnedDispatcherEntry, pinnedDispatcherEnv, reserveLines, reservedCredentials } from './secrets.ts';
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
  const vault = new Vault({ file: path.join(dir, 'vault.json'), key: () => ({ file: keyFile }) });
  vault.add({ name: 'vault-lothsahn-1', kind: 'claude', value: L1, owner: 'lothsahn', share: 'owner' });
  if (pool === 'two') vault.add({ name: 'vault-lothsahn-2', kind: 'claude', value: L2, owner: 'lothsahn', share: 'owner' });
  return { vault, dir };
}

const PINNED = { orchestrator: 'vault', dispatcher: 'vault:vault-lothsahn-1' } as const;
const cfgOf = (extra: Record<string, unknown> = {}) => ({ claudeAccounts: PINNED, ...extra }) as never;

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
    limits: () => poolLimits(cfg),
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
  checkAccountConfig({ claudeAccounts: { dispatcher: 'vault' } } as never);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { dispatcher: 'keychain' } } as never), /claudeAccounts\.dispatcher is "vault" .* or "vault:<entry name>"/);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { dispatcher: 'tokenfile' } } as never), /every Claude process runs on a vault token \(w1078\)/, 'retired (w1078)');
});

test('set_app_config: "vault:<entry name>" is accepted for the dispatcher when the vault holds that Claude token, refused otherwise', (t) => {
  assert.equal(normalizeSetting('claudeAccounts.dispatcher', ' vault:vault-lothsahn-1 '), 'vault:vault-lothsahn-1', 'no vault in this process (tests): the name shape is checked');
  assert.equal(normalizeSetting('claudeAccounts.dispatcher', 'vault'), undefined, '"vault" is the system payer\'s pool: stored as no key (w1078)');
  assert.throws(() => normalizeSetting('claudeAccounts.dispatcher', 'vault:Not A Name'), /vault entry name/);
  assert.throws(() => normalizeSetting('claudeAccounts.dispatcher', 'sideways'), /is "vault:<vault entry name>".* or "vault" \(the system payer's pool\)/);
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

test('the dispatcher on a vault token: hostAccount says so, the orchestrators keep "vault", and unpinned it is the system payer\'s pool', () => {
  const cfg = cfgOf();
  assert.equal(hostAccount(cfg, 'dispatcher'), 'vault:vault-lothsahn-1');
  assert.equal(hostAccount(cfg, 'orchestrator'), 'vault');
  assert.equal(pinnedDispatcherEntry(cfg), 'vault-lothsahn-1');
  assert.equal(pinnedDispatcherEntry(cfgOf({ claudeAccounts: { dispatcher: 'vault' } })), undefined, '"vault" is not a pin');
  assert.equal(pinnedDispatcherEntry(cfgOf({ claudeAccounts: { orchestrator: 'vault' } })), undefined, 'inheriting "vault" is not a pin');
  assert.equal(pinnedDispatcherEntry(cfgOf({ claudeAccounts: undefined })), undefined);
});

test('pinnedDispatcherEnv: exactly the named token, every other Claude credential gone; a missing or disabled one stops the dispatcher with the reason', (t) => {
  const { vault } = setup(t);
  const cfg = cfgOf();
  const ctx = ctxOf(vault, cfg, {});
  const was = { key: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = API_KEY;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = claudeTok('h');
  t.after(() => {
    for (const [k, v] of [['ANTHROPIC_API_KEY', was.key], ['CLAUDE_CODE_OAUTH_TOKEN', was.oauth]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const r = pinnedDispatcherEnv(cfg, ctx)!;
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, L1);
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined, 'an API key would outrank the token');
  assert.match(r.account, /^vault token vault-lothsahn-1 …aaaa \(the dispatcher's/);
  assert.equal(r.account.includes(L1.slice(13, 40)), false, 'the account line carries no token');
  assert.equal(ctx.problems.length, 0);
  // Not pinned: nothing to do here (the system payer's pool, Agents.orchestratorEnv).
  assert.equal(pinnedDispatcherEnv(cfgOf({ claudeAccounts: { dispatcher: 'vault' } }), ctx), undefined);
  // The entry is disabled: the dispatcher does not start, on any other credential, and the problem is reported.
  vault.update('vault-lothsahn-1', { disabled: true });
  assert.throws(() => pinnedDispatcherEnv(cfg, ctx), (e: unknown) => e instanceof PoolHeldError && /the dispatcher is pinned to vault token vault-lothsahn-1 .* so it does not start/.test(e.message));
  assert.match(ctx.problems.at(-1) ?? '', /the dispatcher is pinned to vault token vault-lothsahn-1 /);
  // No vault in this process at all: the same.
  assert.throws(() => pinnedDispatcherEnv(cfg, undefined), (e: unknown) => e instanceof PoolHeldError && /token vault is not loaded/.test(e.message));
});

test("the reserve moves with the dispatcher: the named vault token is the dispatcher's, and nothing else is reserved", (t) => {
  const { vault } = setup(t);
  const cfg = cfgOf();
  const got = reservedCredentials(cfg, { vault });
  assert.deepEqual(got.map((c) => [c.role, c.key]), [['dispatcher', tokenKey(L1)]]);
  assert.equal(tokenKey(L1), `token:${fp(L1)}`, 'the vault entry matches the meters by this fingerprint');
  assert.equal(got[0].what, "the dispatcher's vault token vault-lothsahn-1 …aaaa");
  // The meters: the usual rule on the new token (5 days left = 25% weekly, 20% of the 5-hour window).
  const meters: Record<string, PlanUsage | undefined> = { [tokenKey(L1)]: usage(12, 41, { weeklyDays: 5 }) };
  const lines = reserveLines(cfg, (k) => meters[k], () => 0, NOW, { vault });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, "dispatcher's vault token vault-lothsahn-1 …aaaa: weekly 41%, reserve 25% (5 days to reset); 5-hour 12%, reserve 20%");
  // system_status names it.
  setVaultContext({ vault });
  t.after(() => setVaultContext(undefined));
  assert.match(accountSetupLines(cfg, 'ben')[0], /the dispatcher on vault token vault-lothsahn-1 …aaaa \(pinned/);
  // Unpinned, the dispatcher is on the system payer's pool, whose own limits hold it like anyone's: no reserve.
  assert.deepEqual(reservedCredentials(cfgOf({ claudeAccounts: {} }), { vault }), []);
  assert.match(accountSetupLines(cfgOf({ claudeAccounts: {} }), 'ben')[0], /the dispatcher on the system payer's pool \(ben; claudeAccounts\.dispatcher pins none\)/);
  // The vault cannot give it: the dispatcher does not start, so there is no reserve to keep.
  vault.update('vault-lothsahn-1', { disabled: true });
  assert.deepEqual(reservedCredentials(cfg, { vault }), []);
  assert.match(accountSetupLines(cfg, 'ben')[0], /pinned, but the vault has no usable Claude entry of that name: the dispatcher does not start until it is fixed/);
});

test("lothsahn's workers stay off the dispatcher's token inside its buffer while another token has room; with none they wait", (t) => {
  const { vault } = setup(t);
  const cfg = cfgOf();
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
  // Before the move (the dispatcher on the system payer's pool, unpinned) the same token was not reserved at all.
  const before = cfgOf({ claudeAccounts: { orchestrator: 'vault' } });
  meters[fp(L1)] = usage(10, 83, { weeklyDays: 5, sessionHours: 3 });
  meters[fp(L2)] = usage(90, 30, { weeklyDays: 5, sessionHours: 2 });
  assert.equal(worker(before, ctxOf(vault, before, meters), 'w4').env.CLAUDE_CODE_OAUTH_TOKEN, L1);
});

test("a pool of one token: the dispatcher's token inside its buffer holds the person's workers (said plainly)", (t) => {
  const { vault } = setup(t, 'one');
  const cfg = cfgOf();
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
  // w1109: 96% is past the dispatcher's stop line (95), which holds every worker off its token; with the line set above it
  // (98 here) the token is an ordinary one-at-a-time token, and the dispatcher still takes no slot there.
  const { vault } = setup(t, 'one');
  const meters: Record<string, PlanUsage | undefined> = { [fp(L1)]: usage(10, 96, { weeklyDays: 0.5, sessionHours: 3 }) };
  const atLine = cfgOf();
  assert.throws(() => worker(atLine, ctxOf(vault, atLine, meters, [sessions[0]]), 'w1'), (e: unknown) => e instanceof PoolHeldError && /weekly 96% \(stop line 95%\)/.test(e.message), 'w1109: at the stop line no worker starts on it');
  const cfg = cfgOf({ vault: { pool: { dispatcherStopPercent: 98 } } });
  const withDispatcher = ctxOf(vault, cfg, meters, [sessions[0]]);
  assert.equal(worker(cfg, withDispatcher, 'w1').env.CLAUDE_CODE_OAUTH_TOKEN, L1, 'the dispatcher is on the token and a worker still gets the one slot');
  // A worker already running on it does take the slot.
  const withWorker = ctxOf(vault, cfg, meters, [sessions[0], { id: 'w1', account: key, status: 'running', kind: 'worker' }]);
  assert.throws(() => worker(cfg, withWorker, 'w2'), (e: unknown) => e instanceof PoolHeldError && /one job at a time; its slot is taken \(1 running\)/.test(e.message));
});
