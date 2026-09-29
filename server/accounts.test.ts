import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { checkAccountConfig, type Config } from './config.ts';
import { accountSetupLines, hostAccount, hostClaudeEnv, hostLoginProblem, hostProcessEnv, hostRole, machineUsesLogin } from './secrets.ts';
import { nextUseHostClaudeEnv, setAppConfig } from './appConfig.ts';
import { claudeEnvFor } from './identity.ts';
import { buildOptions, type LaunchSpec } from './launch.ts';
import { HOST_LOGIN, accountKeyOf, buildAccounts, sessionSource, tokenKey, tokenLabel } from './usage.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { StandingAgents, type SessionPort } from './standing.ts';
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
  assert.equal(hostAccount(cfg, 'standing'), 'token');
  assert.deepEqual([hostRole('orchestrator'), hostRole('worker'), hostRole('standing')], ['orchestrator', 'workers', 'standing']);

  // The orchestrator on "login": neither config claudeEnv's token nor one in the server's own environment.
  const orch = hostProcessEnv(cfg, 'orchestrator', SERVER_ENV);
  assert.equal(orch.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(orch.ANTHROPIC_API_KEY, undefined, 'no other credential either');
  assert.equal(orch.CLAUDE_CONFIG_DIR, '/cfg', "claudeEnv's other variables stay: the login is read from there");
  assert.equal(orch.PATH, '/bin');
  // Workers stay on the token, which wins over the server's environment.
  assert.equal(hostProcessEnv(cfg, 'workers', SERVER_ENV).CLAUDE_CODE_OAUTH_TOKEN, HOST_TOKEN);
  assert.deepEqual(hostClaudeEnv(cfg, 'standing'), cfg.claudeEnv);
  assert.deepEqual(hostClaudeEnv({ ...cfg, claudeAccounts: { standing: 'login' } }, 'standing'), { CLAUDE_CONFIG_DIR: '/cfg' });
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

/** A SessionPort that records nothing but the sessions it made. */
class Port implements SessionPort {
  readonly events = new EventEmitter();
  readonly all = new Map<string, { info: SessionInfo; live: boolean; stop(): void }>();
  create(opts: Parameters<SessionPort['create']>[0]) {
    const info = { id: `s${this.all.size + 1}`, kind: opts.kind, standingId: opts.standingId, title: opts.title, status: 'stopped', permissionMode: opts.permissionMode, createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [] } as unknown as SessionInfo;
    const s = { info, live: false, stop: () => undefined };
    this.all.set(info.id, s);
    return s;
  }
  get(id: string) {
    return this.all.get(id)!;
  }
  send() {
    return 'u';
  }
  liveAgents() {
    return 0;
  }
  remove(id: string) {
    this.all.delete(id);
  }
}

test('accounts: a standing agent on this host follows claudeAccounts.standing', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-accounts-'));
  let store: Store | undefined;
  t.after(() => {
    store?.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const cfg = {
    ...split(),
    dataDir: path.join(tmp, 'data'),
    sandboxRoot: path.join(tmp, 'sb'),
    standingRoot: path.join(tmp, 'sb', '_agents'),
    protectedPaths: [],
    repo: { url: 'x', basePath: path.join(tmp, 'sb', '_base') },
    limits: { maxSessions: 6 },
    models: ['opus'],
    defaultModel: 'opus',
    worker: { permissionMode: 'bypassPermissions', effort: 'high' },
  } as unknown as Config;
  store = new Store(cfg.dataDir);
  const st = new StandingAgents({ cfg, store, sessions: new Port(), systemPayer: () => BEN, notify: () => undefined, sandboxes: { list: () => [], setPurpose: () => ({}) as never }, startWorker: () => ({ info: {} as SessionInfo }), now: () => new Date('2026-09-28T10:00:00') });
  const a = st.create({ name: 'Triager', charter: 'Triage.', trigger: { kind: 'interval', minutes: 30 }, tools: ['delegate'] });
  const info = { id: 'x', kind: 'standing', standingId: a.id } as SessionInfo;
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = ENV_TOKEN;
  t.after(() => (saved === undefined ? delete process.env.CLAUDE_CODE_OAUTH_TOKEN : (process.env.CLAUDE_CODE_OAUTH_TOKEN = saved)));
  assert.equal(st.options(info).env?.CLAUDE_CODE_OAUTH_TOKEN, HOST_TOKEN, 'default: the host token');
  cfg.claudeAccounts = { standing: 'login' };
  const env = st.options(info).env!;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "login: not even the server environment's token");
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg');
  assert.equal(env.FF_STANDING_AGENT, a.id);
});

test('accounts: a session records the account its process started on', async (t) => {
  setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-accounts-s-'));
  const store = new Store(dir);
  const sessions = new SessionManager({ limits: { maxSessions: 6 } } as Config, store);
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
  const where = (roles?: ('orchestrator' | 'workers' | 'standing')[]) => Object.fromEntries(buildAccounts(new Map(), { ...ctx, hostLoginRoles: roles }).map((a) => [a.sources[0], a.where[0]]));
  assert.deepEqual(where(['orchestrator']), {
    [HOST_LOGIN]: 'BEAST login (the orchestrator)',
    [tokenKey(HOST_TOKEN)]: "the agents' token on BEAST (workers, standing agents)",
    'login:m3': 'm3 login',
  });
  assert.equal(where()[tokenKey(HOST_TOKEN)], "the agents' token on BEAST", 'not split: as before');
  assert.equal(where()[HOST_LOGIN], 'BEAST login');
  assert.equal(where(['orchestrator', 'workers', 'standing'])[tokenKey(HOST_TOKEN)], "the agents' token (no agent set to it)");
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
    assert.throws(() => setAppConfig(file, cfg, 'claudeAccounts.standing', 'login'), /no claude\.ai login is stored/);
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
  assert.throws(() => setAppConfig(file, cfg, 'limits.maxSandboxes', 5, { machine: 'm3' }), /only for machines\.useHostClaudeEnv/);
  // Every machine not named, keeping the named ones.
  setAppConfig(file, cfg, 'machines.useHostClaudeEnv', true);
  assert.deepEqual(cfg.machines?.useHostClaudeEnv, { m3: false, m5: false, '*': true });

  assert.equal(nextUseHostClaudeEnv(undefined, undefined, false), false);
  assert.deepEqual(nextUseHostClaudeEnv(false, 'm5', true), { '*': false, m5: true }, 'a plain value becomes the rest');
  assert.equal(nextUseHostClaudeEnv({ '*': false, m5: true }, 'm5', undefined), false, 'collapses back');
  assert.equal(nextUseHostClaudeEnv({ m3: false }, 'm3', undefined), undefined);
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
  const [line, ...rest] = accountSetupLines(cfg, 'BEAST', HOST_TOKEN, ['m3', 'm5', 'mini'], ['Lothsahn']);
  assert.equal(
    line,
    'Claude account per agent (config claudeAccounts, machines.useHostClaudeEnv): the orchestrator here: BEAST login; workers here: host token …9AAA; standing agents here: host token …9AAA; agents on m3: Mac login; agents on m5: Mac login; agents on mini: host token …9AAA; work asked for by Lothsahn: their own token',
  );
  assert.deepEqual(rest, [], 'the login is usable: no warning');
  login(dir, Date.now() - 60_000);
  assert.match(accountSetupLines(cfg, 'BEAST', HOST_TOKEN, [])[1], /^WARNING: set to the BEAST login \(the orchestrator\), which cannot run agents: the stored claude\.ai login expired/);
});
