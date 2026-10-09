import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAccountConfig, type Config } from './config.ts';
import { accountSetupLines, hostAccount, hostAccountsInUse, shownRoles, workersHere, hostClaudeEnv, hostClaudeEnvFor, hostLoginProblem, hostProcessEnv, hostRole, hostRoleOf, machineUsesLogin, readTokenFile, redactSecrets, tokenFileToken } from './secrets.ts';
import { nextPerMachine, setAppConfig } from './appConfig.ts';
import { claudeEnvFor } from './identity.ts';
import { buildOptions, type LaunchSpec } from './launch.ts';
import { HOST_LOGIN, accountKeyOf, buildAccounts, sessionSource, tokenKey, tokenLabel } from './usage.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { Store } from './store.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import type { Requester, SessionInfo } from '../shared/types.ts';

/** Which Claude account each kind of agent runs on (docs/accounts.md): launch env per role and machine, attribution, config. */

const HOST_TOKEN = 'sk-ant-oat01-host-token-9AAA';
const ENV_TOKEN = 'sk-ant-oat01-server-env-token';
const LOTH_TOKEN = 'sk-ant-oat01-lothsahns-own-LLLL';
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const SERVER_ENV = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: ENV_TOKEN, ANTHROPIC_API_KEY: 'k', HOME: '/home/b' };
const split = (over: Partial<Config> = {}) =>
  ({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, CLAUDE_CONFIG_DIR: '/cfg' }, claudeAccounts: { orchestrator: 'login' }, userClaudeEnv: { lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: LOTH_TOKEN } }, ...over }) as Config;

test('accounts: each role on this host defaults to the token; "login" starts with no credential at all', () => {
  const cfg = split();
  assert.equal(hostAccount({}, 'orchestrator'), 'token', 'no config: the token');
  assert.equal(hostAccount(cfg, 'orchestrator'), 'login');
  assert.equal(hostAccount(cfg, 'workers'), 'token');
  assert.deepEqual([hostRole('orchestrator'), hostRole('worker')], ['orchestrator', 'workers']);

  // The orchestrator on "login": neither config claudeEnv's token nor one in the server's own environment.
  const orch = hostProcessEnv(cfg, 'orchestrator', SERVER_ENV);
  assert.equal(orch.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(orch.ANTHROPIC_API_KEY, undefined, 'no other credential either');
  assert.equal(orch.CLAUDE_CONFIG_DIR, '/cfg', "claudeEnv's other variables stay: the login is read from there");
  assert.equal(orch.PATH, '/bin');
  // Workers stay on the token, which wins over the server's environment.
  assert.equal(hostProcessEnv(cfg, 'workers', SERVER_ENV).CLAUDE_CODE_OAUTH_TOKEN, HOST_TOKEN);
  assert.deepEqual(hostClaudeEnv(cfg, 'workers'), cfg.claudeEnv);
  assert.deepEqual(hostClaudeEnv({ ...cfg, claudeAccounts: { workers: 'login' } }, 'workers'), { CLAUDE_CONFIG_DIR: '/cfg' });
});

test("accounts: a person's own token still wins for their work, on a role set to the login", () => {
  const cfg = split({ claudeAccounts: { workers: 'login' } });
  const env = claudeEnvFor(cfg, LOTH, hostProcessEnv(cfg, 'workers', SERVER_ENV));
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, LOTH_TOKEN);
  assert.equal(claudeEnvFor(cfg, BEN, hostProcessEnv(cfg, 'workers', SERVER_ENV)).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'Ben has none: the login');
});

const spec = (over: Partial<LaunchSpec>): LaunchSpec => ({ cwd: '/tmp', settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: '/tmp', protectedPaths: [], gameRepos: [] }, ...over });
const MAC_ENV = { HOME: '/Users/b', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-left-in-the-daemons-env' };

test('accounts: a Mac set to its own login drops any credential of the daemon; one on the host token gets it', () => {
  const cfg = split({ machines: { useHostClaudeEnv: { m3: false, m5: false } } });
  for (const id of ['m3', 'm5']) {
    assert.equal(machineUsesLogin(cfg, id), true);
    const o = buildOptions(spec({ env: claudeEnvFor(cfg, BEN, {}), login: machineUsesLogin(cfg, id) }), {}, MAC_ENV);
    assert.equal(o.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, `${id}: the Mac's keychain login`);
    assert.equal(o.env?.HOME, '/Users/b');
  }
  // Another Mac keeps the default: the host token.
  assert.equal(machineUsesLogin(cfg, 'mini'), false);
  assert.equal(buildOptions(spec({ env: { ...cfg.claudeEnv }, login: false }), {}, MAC_ENV).env?.CLAUDE_CODE_OAUTH_TOKEN, HOST_TOKEN);
  // Lothsahn's work on m3 runs on his token.
  assert.equal(buildOptions(spec({ env: claudeEnvFor(cfg, LOTH, {}), login: true }), {}, MAC_ENV).env?.CLAUDE_CODE_OAUTH_TOKEN, LOTH_TOKEN);
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
  const onToken = sessions.create({ kind: 'worker', title: 'w', permissionMode: 'bypassPermissions', options: () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN } }) });
  const onLogin = sessions.create({ kind: 'orchestrator', title: 'o', permissionMode: 'bypassPermissions', options: () => ({ env: { PATH: '/bin' } }) });
  sessions.send(onToken.info.id, 'hi');
  sessions.send(onLogin.info.id, 'hi');
  assert.equal(onToken.info.account, tokenKey(HOST_TOKEN));
  assert.equal(onLogin.info.account, HOST_LOGIN);
  assert.equal(accountKeyOf({}), HOST_LOGIN);
});

test('accounts: attribution follows the role, the machine, the person, and a running process its own start', () => {
  const cfg = split({ machines: { useHostClaudeEnv: { m3: false, m5: false } } });
  const toMachine = (id: string) => (machineUsesLogin(cfg, id) ? undefined : HOST_TOKEN);
  const person = (id: string) => (id === 'lothsahn' ? LOTH_TOKEN : undefined);
  const hostLogin = (kind: SessionInfo['kind']) => hostAccount(cfg, hostRole(kind)) === 'login';
  const src = (info: Partial<SessionInfo>) => sessionSource(info as SessionInfo, HOST_TOKEN, toMachine, person, hostLogin);
  assert.equal(src({ kind: 'orchestrator' }), HOST_LOGIN, 'the orchestrator: the host login');
  assert.equal(src({ kind: 'worker' }), tokenKey(HOST_TOKEN));
  assert.equal(src({ kind: 'standing' }), tokenKey(HOST_TOKEN));
  assert.equal(src({ kind: 'worker', machineId: 'm3' }), 'login:m3');
  assert.equal(src({ kind: 'standing', machineId: 'm5' }), 'login:m5');
  assert.equal(src({ kind: 'worker', machineId: 'mini' }), tokenKey(HOST_TOKEN), 'another Mac: the token');
  assert.equal(src({ kind: 'worker', machineId: 'm3', requestedBy: LOTH }), tokenKey(LOTH_TOKEN), "Lothsahn's work: his token");
  // The orchestrator set to "login" before its process restarted still runs on the token until then.
  assert.equal(src({ kind: 'orchestrator', status: 'idle', account: tokenKey(HOST_TOKEN) }), tokenKey(HOST_TOKEN));
  assert.equal(src({ kind: 'orchestrator', status: 'stopped', account: tokenKey(HOST_TOKEN) }), HOST_LOGIN, 'stopped: its next process follows the config');
  // Without the role hook (older callers) the host token as before.
  assert.equal(sessionSource({ kind: 'orchestrator' }, HOST_TOKEN, toMachine), tokenKey(HOST_TOKEN));
});

test("accounts: the meters say which of this host's agents are on the token and which on its login", () => {
  const ctx = {
    hostName: 'BEAST',
    token: { key: tokenKey(HOST_TOKEN), label: tokenLabel(HOST_TOKEN) },
    machines: [
      { id: 'm3', usesToken: false },
      { id: 'm5', usesToken: false },
    ],
    sessions: [
      { id: 'orch', source: HOST_LOGIN, live: true },
      { id: 'w1', source: tokenKey(HOST_TOKEN), live: true },
      { id: 'm3-w', source: 'login:m3', live: true },
    ],
  };
  const where = (roles?: ('orchestrator' | 'workers')[]) => Object.fromEntries(buildAccounts(new Map(), { ...ctx, hostLoginRoles: roles }).map((a) => [a.sources[0], a.where[0]]));
  assert.deepEqual(where(['orchestrator']), {
    [HOST_LOGIN]: 'BEAST login (the orchestrator)',
    [tokenKey(HOST_TOKEN)]: "the agents' token on BEAST (workers)",
    'login:m3': 'm3 login',
  });
  assert.equal(where()[tokenKey(HOST_TOKEN)], "the agents' token on BEAST", 'not split: as before');
  assert.equal(where()[HOST_LOGIN], 'BEAST login');
  assert.equal(where(['orchestrator', 'workers'])[tokenKey(HOST_TOKEN)], "the agents' token (no agent set to it)");
  const accounts = buildAccounts(new Map(), { ...ctx, hostLoginRoles: ['orchestrator'] });
  assert.deepEqual(accounts.find((a) => a.sources.includes(HOST_LOGIN))?.sessionIds, ['orch']);
});

function configFile(t: { after: (fn: () => void) => void }, raw: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-accounts-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return { dir, file };
}
const login = (dir: string, expiresAt: number, refreshTokenExpiresAt = expiresAt) =>
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt, refreshTokenExpiresAt, scopes: ['user:inference'] } }));

test('accounts: set_app_config sets a role to the login only when this host has one that can run it', (t) => {
  const { dir, file } = configFile(t, { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN } });
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, CLAUDE_CONFIG_DIR: dir } } as unknown as Config;
  assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.orchestrator', 'keychain'), /"login" .* or "token"/);
  login(dir, Date.now() - 60_000);
  assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.orchestrator', 'login'), /cannot be "login": the stored claude\.ai login expired/);
  assert.equal(cfg.claudeAccounts, undefined, 'nothing changed');
  // A live login without user:profile is fine for running agents (only the usage meters need that scope).
  login(dir, Date.now() + 3_600_000);
  assert.equal(hostLoginProblem(cfg), undefined);
  assert.deepEqual(setAppConfig(file, cfg, 'claudeAccounts.orchestrator', 'login'), { before: undefined, after: 'login' });
  assert.deepEqual(cfg.claudeAccounts, { orchestrator: 'login' }, 'live');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAccounts, { orchestrator: 'login' });
  setAppConfig(file, cfg, 'claudeAccounts.workers', 'token');
  setAppConfig(file, cfg, 'claudeAccounts.orchestrator', null);
  assert.deepEqual(cfg.claudeAccounts, { workers: 'token' });
  if (process.platform !== 'darwin') {
    // macOS keeps the login in the Keychain, where a missing file proves nothing.
    fs.rmSync(path.join(dir, '.credentials.json'));
    assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.workers', 'login'), /no claude\.ai login is stored/);
  }
});

test('accounts: set_app_config sets machines.useHostClaudeEnv for all machines or one', (t) => {
  const { file } = configFile(t, { machines: {} });
  const cfg = {} as Config;
  assert.deepEqual(setAppConfig(file, cfg, 'machines.useHostClaudeEnv', false, { machine: 'm3' }), { before: undefined, after: { m3: false } });
  setAppConfig(file, cfg, 'machines.useHostClaudeEnv', 'false', { machine: 'm5' });
  assert.deepEqual(cfg.machines?.useHostClaudeEnv, { m3: false, m5: false }, 'live');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).machines.useHostClaudeEnv, { m3: false, m5: false });
  assert.equal(machineUsesLogin({ ...cfg, claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN } }, 'm3'), true);
  assert.equal(machineUsesLogin({ ...cfg, claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN } }, 'mini'), false);
  assert.throws(() => setAppConfig(file, cfg, 'machines.useHostClaudeEnv', 'no'), /true .* or false/);
  assert.throws(() => setAppConfig(file, cfg, 'machines.useHostClaudeEnv', false, { machine: 'a.b' }), /machine id/);
  assert.throws(() => setAppConfig(file, cfg, 'ownerName', 'x', { machine: 'm3' }), /only for machines\.useHostClaudeEnv/);
  // Every machine not named, keeping the named ones.
  setAppConfig(file, cfg, 'machines.useHostClaudeEnv', true);
  assert.deepEqual(cfg.machines?.useHostClaudeEnv, { m3: false, m5: false, '*': true });

  assert.equal(nextPerMachine(undefined, undefined, false), false);
  assert.deepEqual(nextPerMachine(false, 'm5', true), { '*': false, m5: true }, 'a plain value becomes the rest');
  assert.equal(nextPerMachine({ '*': false, m5: true }, 'm5', undefined), false, 'collapses back');
  assert.equal(nextPerMachine({ m3: false }, 'm3', undefined), undefined);
});

test('accounts: config load refuses a malformed claudeAccounts or machines.useHostClaudeEnv', () => {
  checkAccountConfig({ claudeAccounts: { orchestrator: 'login', workers: 'token' }, machines: { useHostClaudeEnv: { m3: false, '*': true } } });
  checkAccountConfig({ machines: { useHostClaudeEnv: false } });
  checkAccountConfig({});
  assert.throws(() => checkAccountConfig({ claudeAccounts: { orchestrator: 'Login' } } as never), /claudeAccounts\.orchestrator is "login" or "token"/);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { worker: 'login' } } as never), /claudeAccounts\.worker: no such role/);
  assert.throws(() => checkAccountConfig({ claudeAccounts: 'login' } as never), /is an object/);
  assert.throws(() => checkAccountConfig({ machines: { useHostClaudeEnv: { m3: 'false' } } } as never), /useHostClaudeEnv\.m3 is true or false/);
  assert.throws(() => checkAccountConfig({ machines: { useHostClaudeEnv: 'no' } } as never), /useHostClaudeEnv is true, false/);
});

test("accounts: system_status names each kind of agent's account", (t) => {
  const { dir } = configFile(t, {});
  login(dir, Date.now() + 3_600_000);
  const cfg = split({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, CLAUDE_CONFIG_DIR: dir }, machines: { useHostClaudeEnv: { m3: false, m5: false } } });
  const [line, ...rest] = accountSetupLines(cfg, 'BEAST', HOST_TOKEN, [{ id: 'beast', local: true }, 'm3', 'm5', 'mini'], ['Lothsahn']);
  assert.equal(
    line,
    'Claude account per agent (config claudeAccounts, machines.useHostClaudeEnv): the orchestrator here: BEAST login; workers here: host token …9AAA; agents on beast: host token …9AAA; agents on m3: Mac login; agents on m5: Mac login; agents on mini: host token …9AAA; work asked for by Lothsahn: their own token',
  );
  assert.deepEqual(rest, [], 'the login is usable: no warning');
  login(dir, Date.now() - 60_000);
  assert.match(accountSetupLines(cfg, 'BEAST', HOST_TOKEN, [])[1], /^WARNING: set to the BEAST login \(the orchestrator\), which cannot run agents: the stored claude\.ai login expired/);
});

test('accounts: claudeAccounts.dispatcher (w464): checked, set by set_app_config, follows the orchestrator while unset, named only when set', (t) => {
  checkAccountConfig({ claudeAccounts: { dispatcher: 'token', orchestrator: 'login' } });
  assert.throws(() => checkAccountConfig({ claudeAccounts: { dispatcher: 'apikey' } } as never), /claudeAccounts\.dispatcher is "login" or "token"/);
  // Unset, the dispatcher follows the orchestrator's account; set, its own.
  assert.equal(hostAccount(split(), 'dispatcher'), 'login');
  assert.equal(hostAccount(split({ claudeAccounts: { orchestrator: 'login', dispatcher: 'token' } }), 'dispatcher'), 'token');
  assert.equal(hostAccount({}, 'dispatcher'), 'token');
  // system_status names the dispatcher apart only when it has an account of its own.
  const { dir, file } = configFile(t, { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN } });
  login(dir, Date.now() + 3_600_000);
  const cfg = split({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, CLAUDE_CONFIG_DIR: dir } });
  assert.doesNotMatch(accountSetupLines(cfg, 'BEAST', HOST_TOKEN, [])[0], /dispatcher/);
  assert.deepEqual(setAppConfig(file, cfg, 'claudeAccounts.dispatcher', 'token'), { before: undefined, after: 'token' });
  assert.deepEqual(cfg.claudeAccounts, { orchestrator: 'login', dispatcher: 'token' });
  assert.match(accountSetupLines(cfg, 'BEAST', HOST_TOKEN, [{ id: 'beast', local: true }])[0], /the orchestrator here: BEAST login; the dispatcher here: host token …9AAA; workers here/);
  assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.dispatcher', 'keychain'), /"login" .* or "token"/);
  setAppConfig(file, cfg, 'claudeAccounts.dispatcher', null);
  assert.deepEqual(cfg.claudeAccounts, { orchestrator: 'login' });
});

test('accounts: a stopped dispatcher with an account of its own is counted there, not on the system payer\'s token (w464)', () => {
  const dispatcher = { kind: 'orchestrator', orchestratorRole: 'dispatcher', requestedBy: LOTH } as SessionInfo;
  const cfg = split({ claudeAccounts: { orchestrator: 'login', dispatcher: 'token' } });
  assert.equal(hostRoleOf(cfg, dispatcher), 'dispatcher');
  assert.equal(hostRoleOf(split(), dispatcher), 'orchestrator', 'unset: an orchestrator like any other');
  assert.equal(hostRoleOf(cfg, { kind: 'orchestrator', orchestratorRole: 'personal' }), 'orchestrator');
});

// ---------------------------------------------------------------- the token file (w464, change 18)

const FILE_TOKEN = 'sk-ant-oat01-lothsahns-file-token-for-the-portal-FFFF';
const FILE_TOKEN_2 = 'sk-ant-oat01-lothsahns-new-file-token-for-the-portal-2222';
function tokenFile(t: { after: (fn: () => void) => void }, content = `${FILE_TOKEN}\n`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-tokenfile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claude-oauth-token');
  fs.writeFileSync(file, content);
  return file;
}

test('token file: only the orchestrator and the dispatcher may run on it, and only with a file named', () => {
  checkAccountConfig({ claudeAccounts: { orchestrator: 'tokenfile', dispatcher: 'tokenfile' }, claudeTokenFile: '/srv/fff/secrets/claude-oauth-token' } as never);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { workers: 'tokenfile' }, claudeTokenFile: '/x' } as never), /claudeAccounts\.workers cannot be "tokenfile": only orchestrator, dispatcher/);
  assert.throws(() => checkAccountConfig({ claudeAccounts: { orchestrator: 'tokenfile' } } as never), /is "tokenfile" but config claudeTokenFile names no file/);
  // A hand-edited "tokenfile" on workers never reaches them.
  assert.equal(hostAccount({ claudeAccounts: { workers: 'tokenfile' } } as never, 'workers'), 'token');
});

test('token file: read at each session start into that process alone, every other Claude credential removed', (t) => {
  const file = tokenFile(t);
  const cfg = split({ claudeAccounts: { orchestrator: 'tokenfile' }, claudeTokenFile: file });
  const env = hostProcessEnv(cfg, 'orchestrator', SERVER_ENV);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, FILE_TOKEN);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "the server's API key is removed");
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg', 'the rest of claudeEnv stays');
  assert.equal(env.PATH, '/bin');
  // The dispatcher follows the orchestrator while it has no account of its own; workers keep the host token.
  assert.equal(hostProcessEnv(cfg, 'dispatcher', SERVER_ENV).CLAUDE_CODE_OAUTH_TOKEN, FILE_TOKEN);
  assert.equal(hostProcessEnv(cfg, 'workers', SERVER_ENV).CLAUDE_CODE_OAUTH_TOKEN, HOST_TOKEN);
  // A new token applies to the next session, with no restart.
  fs.writeFileSync(file, FILE_TOKEN_2);
  assert.equal(hostProcessEnv(cfg, 'orchestrator', SERVER_ENV).CLAUDE_CODE_OAUTH_TOKEN, FILE_TOKEN_2);
  // Never in config claudeEnv, so never sent to a machine.
  assert.equal(cfg.claudeEnv?.CLAUDE_CODE_OAUTH_TOKEN, HOST_TOKEN);
  for (const m of ['m3', { id: 'beast', local: true }] as const) assert.notEqual(hostClaudeEnvFor(cfg, m as never).CLAUDE_CODE_OAUTH_TOKEN, FILE_TOKEN_2);
});

test('token file: an unreadable or malformed file stops the session start, and the error never shows what is in it', (t) => {
  const bad = tokenFile(t, 'sk-ant-api03-not-an-oauth-token-SECRETSECRETSECRET');
  assert.throws(
    () => hostProcessEnv(split({ claudeAccounts: { orchestrator: 'tokenfile' }, claudeTokenFile: bad }), 'orchestrator', SERVER_ENV),
    (e: Error) => /does not hold one Claude OAuth token .* its content is not shown/.test(e.message) && !e.message.includes('SECRET'),
  );
  assert.throws(() => readTokenFile({ claudeTokenFile: path.join(path.dirname(bad), 'missing') }), /cannot read config claudeTokenFile .*missing: ENOENT/);
  assert.equal(tokenFileToken(split({ claudeAccounts: { orchestrator: 'tokenfile' }, claudeTokenFile: bad })), undefined, 'the meters: unknown, not a throw');
});

test('token file: system_status names the file for the roles on it, and says when it cannot be read', (t) => {
  const file = tokenFile(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-accounts-'));
  let store: Store | undefined;
  t.after(() => {
    store?.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const cfg = {
    ...split({ claudeAccounts: { dispatcher: 'tokenfile' }, claudeTokenFile: file }),
    dataDir: path.join(tmp, 'data'),
    sandboxRoot: path.join(tmp, 'sb'),
    standingRoot: path.join(tmp, 'sb', '_agents'),
    protectedPaths: [],
    repo: { url: 'x', basePath: path.join(tmp, 'sb', '_base') },
    models: ['opus'],
    defaultModel: 'opus',
    worker: { permissionMode: 'bypassPermissions', effort: 'high' },
  } as unknown as Config;
  store = new Store(cfg.dataDir);
  assert.match(accountSetupLines(cfg, 'FFVM', HOST_TOKEN, [])[0], /the dispatcher here: token file …FFFF/);
  assert.match(accountSetupLines({ ...cfg, claudeTokenFile: path.join(tmp, 'gone') }, 'FFVM', HOST_TOKEN, [])[0], /the dispatcher here: token file \(UNREADABLE: its sessions will not start\)/);
});

test('token file: set_app_config takes "tokenfile" and claudeTokenFile, checks the file, refuses it for workers, never echoes the token', (t) => {
  const file = tokenFile(t);
  const { file: cfgFile } = configFile(t, {});
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN } } as unknown as Config;
  assert.throws(() => setAppConfig(cfgFile, cfg, 'claudeAccounts.orchestrator', 'tokenfile'), /claudeTokenFile names no file/);
  assert.throws(() => setAppConfig(cfgFile, cfg, 'claudeTokenFile', 'relative/path'), /absolute path/);
  const bad = tokenFile(t, 'not a token at all SECRETSECRET');
  assert.throws(() => setAppConfig(cfgFile, cfg, 'claudeTokenFile', bad), (e: Error) => /does not hold one Claude OAuth token/.test(e.message) && !e.message.includes('SECRET'));
  const r = setAppConfig(cfgFile, cfg, 'claudeTokenFile', file);
  assert.equal(r.after, file);
  assert.ok(!JSON.stringify(r).includes(FILE_TOKEN), 'the answer carries the path, not the token');
  assert.deepEqual(setAppConfig(cfgFile, cfg, 'claudeAccounts.dispatcher', 'tokenfile'), { before: undefined, after: 'tokenfile' });
  assert.throws(() => setAppConfig(cfgFile, cfg, 'claudeAccounts.workers', 'tokenfile'), /claudeAccounts\.workers cannot be "tokenfile"/);
  assert.throws(() => setAppConfig(cfgFile, cfg, 'claudeTokenFile', null), /cannot be cleared while claudeAccounts\.dispatcher is "tokenfile"/);
  assert.ok(!fs.readFileSync(cfgFile, 'utf8').includes(FILE_TOKEN), 'config.json holds the path only');
});

test('token file: the meters show it as its own account, named by the roles on it; redaction masks its token', () => {
  const key = tokenKey(FILE_TOKEN);
  const accounts = buildAccounts(new Map(), {
    hostName: 'FFVM',
    token: { key: tokenKey(HOST_TOKEN), label: tokenLabel(HOST_TOKEN) },
    machines: [{ id: 'lothdesktop', usesToken: true }],
    roles: ['orchestrator', 'dispatcher', 'workers'],
    tokenFile: { key, label: 'token file …FFFF', roles: ['orchestrator', 'dispatcher'] },
    sessions: [{ id: 'o1', source: key, live: true }],
  });
  const file = accounts.find((a) => a.sources.includes(key))!;
  assert.deepEqual([file.label, file.where, file.sessionIds], ['token file …FFFF', ["FFVM's token file (the orchestrator, the dispatcher)"], ['o1']]);
  const host = accounts.find((a) => a.sources.includes(tokenKey(HOST_TOKEN)))!;
  assert.match(host.where[0], /the agents' token on FFVM \(workers\), lothdesktop/);
  const text = `env: CLAUDE_CODE_OAUTH_TOKEN=${FILE_TOKEN}`;
  assert.equal(redactSecrets(text), 'env: CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-[redacted …FFFF]');
});

test("accounts (w748): the workers role is named, and warned about, only while a worker daemon runs on the portal's own host", (t) => {
  const { dir } = configFile(t, {});
  login(dir, Date.now() - 60_000); // an expired stored login: it cannot run agents
  const cfg = split({ claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: HOST_TOKEN, CLAUDE_CONFIG_DIR: dir }, claudeAccounts: { orchestrator: 'token', workers: 'login' } });
  // No daemon on the portal's host (the case since w510): no "workers here", and no warning for a login nothing uses.
  const none = accountSetupLines(cfg, 'fff-portal', HOST_TOKEN, ['m3', 'm5']);
  assert.doesNotMatch(none[0], /workers here/);
  assert.equal(none.length, 1, 'no WARNING about the fff-portal login (workers)');
  assert.doesNotMatch(none.join(' | '), /fff-portal login/);
  assert.deepEqual(shownRoles(cfg, false), ['orchestrator']);
  assert.equal(workersHere(['m3', { id: 'm5' }]), false);
  // A daemon added on the portal's host (add_machine local): both come back.
  const local = [{ id: 'fff-portal', local: true }, 'm3'];
  assert.equal(workersHere(local), true);
  const back = accountSetupLines(cfg, 'fff-portal', HOST_TOKEN, local);
  assert.match(back[0], /workers here: fff-portal login/);
  assert.match(back[1], /^WARNING: set to the fff-portal login \(workers\), which cannot run agents: the stored claude\.ai login expired/);
  assert.deepEqual(shownRoles(cfg, true), ['orchestrator', 'workers']);
  // The accounts list: the "fff-portal login (workers)" row follows the same rule.
  assert.deepEqual(hostAccountsInUse(cfg, false), { login: false, token: true, vault: false });
  assert.deepEqual(hostAccountsInUse(cfg, true), { login: true, token: true, vault: false });
});
