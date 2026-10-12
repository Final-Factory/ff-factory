import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAccountConfig, currentAccounts, retiredConfigKeys, withDefaults, type Config } from './config.ts';
import { accountSetupLines, hostAccount, hostBaseEnv, hostRole, hostRoleOf, machineRunEnv, pinnedDispatcherEnv, poolRunEnv, runsOnThisHost, shownRoles } from './secrets.ts';
import { OWNER_ONLY_KEYS, SETTABLE_KEYS, setAppConfig, type SettableKey } from './appConfig.ts';
import { PoolHeldError, setVaultContext, type VaultContext } from './vault.ts';
import { buildOptions, type LaunchSpec } from './launch.ts';
import { HOST_LOGIN, accountKeyOf, sessionSource, tokenKey } from './usage.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { Store } from './store.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { fakeToken, useFakeVault } from './testVault.ts';
import type { Requester, SessionInfo } from '../shared/types.ts';

/** Which Claude token each kind of agent runs on (docs/accounts.md): every one a vault token, nothing else (w1078). */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const SERVER_ENV = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-server-env-token', ANTHROPIC_API_KEY: 'k', HOME: '/home/b' };
const PINNED: Pick<Config, 'claudeAccounts'> = { claudeAccounts: { dispatcher: 'vault:vault-lothsahn-1' } };

/** A vault context that gives `forRun` a fixed answer, recording what it was asked and what it reported as a problem. */
function vaultAnswering(answer: Record<string, unknown>, over: Partial<VaultContext> = {}) {
  const asked: { run: Record<string, unknown>; o: Record<string, unknown> }[] = [];
  const problems: string[] = [];
  const ctx = useFakeVault({ onProblem: (l) => problems.push(l), ...over, vault: { forRun: (run: never, o: never) => (asked.push({ run, o }), { env: {}, problems: [], ...answer }) } as never });
  return { ctx, asked, problems };
}

test('accounts: every role on this host is on the vault; only the dispatcher can be pinned to one named token', () => {
  assert.equal(hostAccount({}, 'orchestrator'), 'vault');
  assert.equal(hostAccount({}, 'dispatcher'), 'vault', 'unset: the system payer\'s pool');
  assert.equal(hostAccount(PINNED, 'dispatcher'), 'vault:vault-lothsahn-1');
  assert.equal(hostAccount(PINNED, 'orchestrator'), 'vault', 'a pin on the dispatcher is not the orchestrators\'');
  assert.equal(hostAccount({ claudeAccounts: { orchestrator: 'vault:x' } }, 'orchestrator'), 'vault', 'a pin is for the dispatcher alone');
  // Only the orchestrators run here (w510): the ops worker and any record without a machine read as the orchestrator's.
  assert.deepEqual([hostRole('orchestrator'), hostRole('ops'), hostRole('worker')], ['orchestrator', 'orchestrator', 'orchestrator']);
  assert.deepEqual([runsOnThisHost('orchestrator'), runsOnThisHost('ops'), runsOnThisHost('worker')], [true, true, false]);
});

test('accounts: hostBaseEnv is the server\'s environment without any Claude credential', () => {
  const env = hostBaseEnv(SERVER_ENV);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'no other credential either');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/b');
});

test("accounts (w1078): an orchestrator's or the ops worker's run gets its person's pool token over a base without any other credential", (t) => {
  t.after(() => setVaultContext(undefined));
  const { asked } = vaultAnswering({ poolSize: 1, claude: { entry: { name: 'vault-lothsahn-1', last4: 'xxxx' }, token: fakeToken('lothsahn'), how: 'normal' } });
  const r = poolRunEnv({ role: 'orchestrator', personId: 'lothsahn', sessionId: 's1' });
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, fakeToken('lothsahn'));
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN === SERVER_ENV.CLAUDE_CODE_OAUTH_TOKEN, false);
  assert.match(r.account, /^vault token vault-lothsahn-1 …xxxx \(lothsahn's pool/);
  assert.deepEqual(asked[0].run, { machineId: 'portal', role: 'orchestrator', userId: 'lothsahn', sessionId: 's1' });
  assert.equal(asked[0].o.claude, true);
  assert.equal(poolRunEnv({ role: 'ops', personId: 'lothsahn' }).env.CLAUDE_CODE_OAUTH_TOKEN, fakeToken('lothsahn'));
});

test('accounts (w1078): a run with no usable vault token does not start, with the reason, and never falls back to another credential', (t) => {
  t.after(() => setVaultContext(undefined));
  const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof PoolHeldError && re.test(e.message), String(re));

  // No vault context at all (a portal that never loaded one).
  setVaultContext(undefined);
  refused(() => poolRunEnv({ role: 'orchestrator', personId: 'ben' }), /token vault is not loaded on this portal/);
  refused(() => machineRunEnv({}, 'm3', { role: 'workers' }), /token vault is not loaded on this portal/);
  refused(() => pinnedDispatcherEnv(PINNED), /token vault is not loaded on this portal/);

  // A person with no Claude token in the vault (pool of 0).
  const none = vaultAnswering({ poolSize: 0 });
  refused(() => poolRunEnv({ role: 'orchestrator', personId: 'ben' }), /ben has no Claude token in the vault, so an orchestrator cannot start: add one with `sudo fffctl vault add-claude ben`/);
  refused(() => poolRunEnv({ role: 'ops', personId: 'ben' }), /so the orchestration worker cannot start/);
  refused(() => machineRunEnv({}, 'm3', { role: 'workers', requestedBy: BEN }), /ben has no Claude token in the vault, so a workers run on m3 cannot start/);
  assert.equal(none.problems.length, 3, 'each refusal is also reported for the log and system_status');

  // Tokens exist and none opens: the problems are named.
  vaultAnswering({ poolSize: 2, problems: ['vault-ben-1: the key does not open it'] });
  refused(() => poolRunEnv({ role: 'orchestrator', personId: 'ben' }), /ben's Claude token pool cannot serve an orchestrator: vault-ben-1: the key does not open it\. It never runs on another credential/);
  vaultAnswering({ poolSize: 2 });
  refused(() => machineRunEnv({}, 'm3', { role: 'standing', requestedBy: BEN }), /cannot serve a standing run on m3: none of their tokens opens/);

  // Nobody to pool for.
  vaultAnswering({ poolSize: 0 });
  refused(() => poolRunEnv({ role: 'orchestrator', personId: undefined }), /is for nobody, so it has no vault pool to run on/);

  // All their tokens held or capped: the run waits for the first to free up (orchestrator: used up and stops).
  vaultAnswering({ poolSize: 1, claudeHold: { why: 'every token is at its 5-hour limit', next: '2026-10-12T05:00:00.000Z' } });
  assert.throws(
    () => poolRunEnv({ role: 'orchestrator', personId: 'ben' }),
    (e: unknown) => e instanceof PoolHeldError && /ben's Claude token pool is used up: every token is at its 5-hour limit/.test(e.message) && e.next === '2026-10-12T05:00:00.000Z',
  );
  assert.throws(() => poolRunEnv({ role: 'ops', personId: 'ben' }), (e: unknown) => e instanceof PoolHeldError && /pool is held: /.test(e.message));
  assert.throws(() => machineRunEnv({}, 'm3', { role: 'workers', requestedBy: BEN }), (e: unknown) => e instanceof PoolHeldError && /ben's Claude token pool is held: /.test(e.message) && e.next === '2026-10-12T05:00:00.000Z');
});

test('accounts (w1078): a run on a machine always takes a vault token for the person its work is for, and drops the daemon\'s own credentials', (t) => {
  t.after(() => setVaultContext(undefined));
  const { asked } = vaultAnswering({ poolSize: 1, claude: { entry: { name: 'vault-ben-1', last4: 'yyyy' }, token: fakeToken('ben'), how: 'over-cap' }, env: { EXTRA_KEY: 'v' } });
  for (const machine of ['m3', { id: 'm5' }, { id: 'fff-portal', local: true }]) {
    const r = machineRunEnv({}, machine, { role: 'workers', requestedBy: BEN, sessionId: 's' });
    assert.equal(r.login, true, 'the daemon\'s own credentials are dropped, so the token is the only one');
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, fakeToken('ben'));
    assert.equal(r.env.EXTRA_KEY, 'v', "the vault's other secrets for the run ride along");
    assert.match(r.account, /^vault token vault-ben-1 …yyyy \(ben's pool, over its caps: used up first/);
    assert.equal(r.person, 'ben');
  }
  assert.equal(asked.every((a) => a.o.claude === true), true, 'the Claude token is always asked for');
  // Whose pool: the person the work is for, else its requester, else the system payer's.
  machineRunEnv({}, 'm3', { role: 'workers', tokenUser: 'lothsahn', requestedBy: BEN });
  assert.equal(asked.at(-1)!.run.userId, 'lothsahn');
  machineRunEnv({}, 'm3', { role: 'workers' });
  assert.equal(asked.at(-1)!.run.userId, 'ben', "unattributed: the system payer's");
});

test('accounts (w1078): a pinned dispatcher runs on exactly that vault token; an unpinned one is the system payer\'s pool', (t) => {
  t.after(() => setVaultContext(undefined));
  const asked: string[] = [];
  const ctx = useFakeVault({ vault: { claudeByName: (name: string) => (asked.push(name), name === 'vault-lothsahn-1' ? { entry: { name, last4: 'aaaa' }, token: fakeToken('pin') } : undefined) } as never });
  const r = pinnedDispatcherEnv(PINNED, ctx)!;
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, fakeToken('pin'));
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined, 'every other Claude credential is gone');
  assert.equal(Object.keys(r.env).includes('CLAUDE_CODE_OAUTH_TOKEN'), true);
  assert.match(r.account, /^vault token vault-lothsahn-1 …aaaa \(the dispatcher's/);
  assert.equal(pinnedDispatcherEnv({}, ctx), undefined, 'not pinned: the caller asks the payer\'s pool (Agents.orchestratorEnv)');
  assert.deepEqual(asked, ['vault-lothsahn-1'], 'not pinned asks the vault nothing');

  // The pinned token is unusable (no such entry, disabled, or the key does not open it): the dispatcher does not start.
  const problems: string[] = [];
  const bad = useFakeVault({ onProblem: (l) => problems.push(l), vault: { claudeByName: () => undefined } as never });
  assert.throws(
    () => pinnedDispatcherEnv({ claudeAccounts: { dispatcher: 'vault:gone' } }, bad),
    (e: unknown) => e instanceof PoolHeldError && /pinned to vault token gone .* does not start/.test(e.message),
  );
  assert.equal(problems.length, 1);
});

test('accounts: system_status says every agent is on a vault token, and names the dispatcher\'s pin or the payer\'s pool', (t) => {
  t.after(() => setVaultContext(undefined));
  const ctx = useFakeVault({ vault: { claudeByName: (name: string) => (name === 'vault-lothsahn-1' ? { entry: { name, last4: 'aaaa' }, token: fakeToken('pin') } : undefined) } as never });
  const lines = accountSetupLines({}, 'ben', ctx);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /every one a vault token/);
  assert.match(lines[0], /the dispatcher on the system payer's pool \(ben; claudeAccounts\.dispatcher pins none\)/);
  assert.doesNotMatch(lines[0], /Mac login|BEAST login/);
  assert.match(accountSetupLines(PINNED, 'ben', ctx)[0], /the dispatcher on vault token vault-lothsahn-1 …aaaa \(pinned; its dispatcher reserve is kept there\)/);
  assert.match(accountSetupLines({ claudeAccounts: { dispatcher: 'vault:gone' } }, 'ben', ctx)[0], /vault token gone \(pinned, but the vault has no usable Claude entry of that name: the dispatcher does not start until it is fixed\)/);
});

test('accounts: the dispatcher is named apart only when pinned, and a stopped pinned one is counted on its role', () => {
  assert.deepEqual(shownRoles({}), ['orchestrator']);
  assert.deepEqual(shownRoles(PINNED), ['orchestrator', 'dispatcher']);
  const dispatcher = { kind: 'orchestrator', orchestratorRole: 'dispatcher', requestedBy: LOTH } as SessionInfo;
  assert.equal(hostRoleOf(PINNED, dispatcher), 'dispatcher');
  assert.equal(hostRoleOf({}, dispatcher), 'orchestrator', 'unpinned: an orchestrator like any other');
  assert.equal(hostRoleOf(PINNED, { kind: 'orchestrator', orchestratorRole: 'personal' }), 'orchestrator');
});

const spec = (over: Partial<LaunchSpec>): LaunchSpec => ({ cwd: '/tmp', settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: '/tmp', protectedPaths: [], gameRepos: [] }, ...over });

test("accounts: a machine's run (login true) starts on the vault token alone, over any credential the daemon's environment holds", () => {
  const daemonEnv = { HOME: '/Users/b', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-left-in-the-daemons-env', ANTHROPIC_API_KEY: 'k' };
  const o = buildOptions(spec({ env: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('ben') }, login: true }), {}, daemonEnv);
  assert.equal(o.env?.CLAUDE_CODE_OAUTH_TOKEN, fakeToken('ben'));
  assert.equal(o.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(o.env?.HOME, '/Users/b');
});

test('accounts: a session records the account its process started on', async (t) => {
  setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-accounts-s-'));
  const store = new Store(dir);
  const sessions = new SessionManager({} as Config, store);
  t.after(async () => {
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const token = fakeToken('ben');
  const onToken = sessions.create({ kind: 'worker', title: 'w', permissionMode: 'bypassPermissions', options: () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } }) });
  sessions.send(onToken.info.id, 'hi');
  assert.equal(onToken.info.account, tokenKey(token));
  assert.equal(accountKeyOf({}), HOST_LOGIN, 'a record with no token (before w1078) reads as the old host login');
});

test('accounts: attribution is the account a process started on; a session that never started has none', () => {
  const key = tokenKey(fakeToken('ben'));
  assert.equal(sessionSource({ account: key }), key);
  assert.equal(sessionSource({ account: key, status: 'stopped' } as Partial<SessionInfo>), key, 'running or not: the one it started on');
  assert.equal(sessionSource({}), '');
});

function configFile(t: { after: (fn: () => void) => void }, raw: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-accounts-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return { dir, file };
}

test('accounts: config load checks claudeAccounts: only "vault", and "vault:<name>" for the dispatcher', () => {
  checkAccountConfig({ claudeAccounts: { orchestrator: 'vault', dispatcher: 'vault:vault-lothsahn-1' } });
  checkAccountConfig({});
  for (const old of ['login', 'token', 'tokenfile', 'apikey']) {
    assert.throws(() => checkAccountConfig({ claudeAccounts: { orchestrator: old } } as never), /claudeAccounts\.orchestrator is "vault" .*every Claude process runs on a vault token \(w1078\)/, old);
  }
  assert.throws(() => checkAccountConfig({ claudeAccounts: { worker: 'vault' } } as never), /claudeAccounts\.worker: no such role/);
  assert.throws(() => checkAccountConfig({ claudeAccounts: 'vault' } as never), /is an object/);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { orchestrator: 'vault:vault-lothsahn-1' } } as never), /claudeAccounts\.orchestrator cannot be "vault:vault-lothsahn-1": only dispatcher/);
  checkAccountConfig({ machines: { githubFromVault: { m3: false, '*': true } } });
  assert.throws(() => checkAccountConfig({ machines: { githubFromVault: { m3: 'false' } } } as never), /githubFromVault\.m3 is true or false/);
  assert.throws(() => checkAccountConfig({ machines: { githubFromVault: 'no' } } as never), /githubFromVault is true, false/);
});

test('accounts (w1078): a config that still sets the retired keys loads, and they are ignored', () => {
  const old = {
    claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('old'), CLAUDE_CONFIG_DIR: '/cfg' },
    userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: fakeToken('lothsahn') } },
    claudeTokenFile: '/srv/fff/secrets/claude-oauth-token',
    machines: { useHostClaudeEnv: { m3: false }, claudeFromVault: true, githubFromVault: true },
    claudeAccounts: { orchestrator: 'login', dispatcher: 'tokenfile', workers: 'login' },
  };
  assert.deepEqual(retiredConfigKeys(old), ['claudeAccounts.workers', 'claudeEnv', 'userClaudeEnv', 'claudeTokenFile', 'machines.useHostClaudeEnv', 'machines.claudeFromVault']);
  const cfg = withDefaults(old) as Config & Record<string, unknown>;
  for (const k of ['claudeEnv', 'userClaudeEnv', 'claudeTokenFile']) assert.equal(cfg[k], undefined, `${k} is dropped`);
  assert.deepEqual(cfg.machines, { githubFromVault: true }, 'the live machines keys stay');
  assert.deepEqual(cfg.claudeAccounts, {}, 'the retired accounts (login, tokenfile) are dropped: the role runs on its vault default');
  checkAccountConfig(cfg);
  assert.equal(hostAccount(cfg, 'orchestrator'), 'vault');
  assert.equal(hostAccount(cfg, 'dispatcher'), 'vault');
  assert.deepEqual(shownRoles(cfg), ['orchestrator']);
  assert.equal(JSON.stringify(cfg).includes(fakeToken('old')), false, 'a token the old file held is not carried');
});

test('accounts (w1078): currentAccounts drops "token", "login" and "tokenfile" and keeps "vault" and a pin', () => {
  assert.deepEqual(currentAccounts({ orchestrator: 'token', dispatcher: 'vault:vault-lothsahn-1' }), { dispatcher: 'vault:vault-lothsahn-1' });
  assert.deepEqual(currentAccounts({ orchestrator: 'vault' }), { orchestrator: 'vault' });
  const same = { orchestrator: 'vault' };
  assert.equal(currentAccounts(same), same, 'the same object when there is nothing to drop');
  assert.equal(currentAccounts(undefined), undefined);
});

test('set_app_config (w1078): the Claude credential keys are gone; claudeAccounts.dispatcher takes "vault:<name>" or "vault" and is the owner\'s only', (t) => {
  t.after(() => setVaultContext(undefined));
  const { file } = configFile(t, { claudeAccounts: { dispatcher: 'vault:vault-lothsahn-1' } });
  const cfg = { claudeAccounts: { dispatcher: 'vault:vault-lothsahn-1' } } as unknown as Config;
  for (const gone of ['claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN', 'claudeAccounts.orchestrator', 'claudeAccounts.workers', 'claudeTokenFile', 'machines.useHostClaudeEnv', 'machines.claudeFromVault']) {
    assert.equal(SETTABLE_KEYS.includes(gone as SettableKey), false, gone);
    assert.throws(() => setAppConfig(file, cfg, gone as SettableKey, 'vault'), /cannot be changed by an agent/, gone);
  }
  assert.equal(OWNER_ONLY_KEYS.has('claudeAccounts.dispatcher'), true);
  assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.dispatcher', 'login'), /is "vault:<vault entry name>".* or "vault" \(the system payer's pool\)/);
  assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.dispatcher', 'token'), /every Claude process runs on a vault token/);
  assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.dispatcher', 'vault:Not A Name'), /vault entry name/);

  // A vault holding the token: the pin is accepted and written.
  const named = new Map([['vault-lothsahn-2', true]]);
  setVaultContext({ vault: { claudeByName: (n: string) => (named.has(n) ? { entry: { name: n, last4: 'bbbb' }, token: fakeToken(n) } : undefined) } as never });
  assert.deepEqual(setAppConfig(file, cfg, 'claudeAccounts.dispatcher', 'vault:vault-lothsahn-2'), { before: 'vault:vault-lothsahn-1', after: 'vault:vault-lothsahn-2' });
  assert.deepEqual(cfg.claudeAccounts, { dispatcher: 'vault:vault-lothsahn-2' }, 'live');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAccounts, { dispatcher: 'vault:vault-lothsahn-2' });
  assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.dispatcher', 'vault:nobody-has-this'), /no enabled Claude token named "nobody-has-this"/);

  // "vault" is the system payer's pool: stored as no key.
  assert.deepEqual(setAppConfig(file, cfg, 'claudeAccounts.dispatcher', 'vault'), { before: 'vault:vault-lothsahn-2', after: undefined });
  assert.deepEqual(cfg.claudeAccounts, {});
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAccounts?.dispatcher, undefined);
  assert.equal(hostAccount(cfg, 'dispatcher'), 'vault');
});
