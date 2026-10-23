import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type http from 'node:http';
import { Auth } from './auth.ts';
import { LOGIN_DELETE_DIR, LoginDeleteRefused, deleteLogin, describeLoginDeleted, serveLoginDeletes, type LoginDeleteDeps } from './loginDelete.ts';
import type { AppSettings } from '../shared/types.ts';

/** Deleting a login (w1864, fffctl user delete): what goes with it, what is refused, and that no key or password is printed. */

const req = (cookie: string) => ({ headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as http.IncomingMessage;

async function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-delete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const auth = new Auth(data, { trustProxy: false });
  await auth.setUser('ben', 'ben-password-1234'); // the first login is the owner
  await auth.setUser('lothsahn', 'loth-password-123', { role: 'owner' });
  await auth.setUser('carol', 'carol-password-12', { role: 'member' });
  await auth.setUser('w1021-test', 'throwaway-password-1', { role: 'member', displayName: 'w1021 test' });
  const memoryRoot = path.join(data, 'orchestrator-memory');
  let settings: AppSettings = { heartbeatMinutes: null, pool: { 'w1021-test': 'ben', lothsahn: 'ben' }, heartbeat: { 'w1021-test': 5, ben: 10 }, dismissedEvents: { 'w1021-test': ['x'], ben: ['y'] } };
  const sessions = new Map([
    ['o-test', { id: 'o-test', status: 'idle', user: 'w1021-test' }],
    ['o-ben', { id: 'o-ben', status: 'running', user: 'ben' }],
  ]);
  const subs = [
    { endpoint: 'https://push.test/1', user: 'w1021-test' },
    { endpoint: 'https://push.test/2', user: 'ben' },
  ];
  const removed: string[] = [];
  const deps: LoginDeleteDeps = {
    auth,
    settings: () => settings,
    putSettings: (p) => (settings = { ...settings, ...p }),
    personalOf: (u) => [...sessions.values()].find((s) => s.user.toLowerCase() === u.toLowerCase()),
    removeSession: (id) => {
      removed.push(id);
      sessions.delete(id);
    },
    pushEndpoints: (u) => subs.filter((s) => s.user === u).map((s) => s.endpoint),
    unsubscribe: (e) => subs.splice(subs.findIndex((s) => s.endpoint === e), 1),
    memoryRoot,
    memoryDir: (u) => path.join(memoryRoot, `person-${u.toLowerCase()}`),
    now: () => new Date('2026-10-23T15:30:00Z'),
  };
  const mem = deps.memoryDir('w1021-test');
  fs.mkdirSync(path.join(mem, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- a note\n');
  fs.writeFileSync(path.join(mem, 'notes', 'a.md'), 'a\n');
  fs.mkdirSync(deps.memoryDir('ben'));
  fs.writeFileSync(path.join(deps.memoryDir('ben'), 'MEMORY.md'), 'ben\n');
  return { dir, data, auth, deps, settings: () => settings, sessions, subs, removed, memoryRoot };
}

test('delete: the login, its keys, sessions, pool entry, settings, push subscriptions and orchestrator go in one step; no other login is touched', async (t) => {
  const { data, auth, deps, settings, sessions, subs, removed, memoryRoot } = await setup(t);
  const key = auth.createApiKey('w1021-m3', 'w1021-test');
  auth.createApiKey('carol-key', 'carol');
  auth.createApiKey('owner-mcp');
  const login = await auth.login(req(''), 'w1021-test', 'throwaway-password-1');
  assert.ok(login.ok);
  const cookie = login.cookie.split(';')[0];
  assert.equal(auth.user(req(cookie)), 'w1021-test');
  const benLogin = await auth.login(req(''), 'ben', 'ben-password-1234');
  assert.ok(benLogin.ok);

  const r = deleteLogin(deps, { user: 'w1021-test', by: 'lothsahn' });
  assert.deepEqual(r.keys, ['w1021-m3']);
  assert.equal(r.sessions, 1);
  assert.equal(r.pool, 'ben');
  assert.deepEqual(r.settings, ['heartbeat', 'dismissedEvents']);
  assert.equal(r.pushSubscriptions, 1);
  assert.deepEqual(r.orchestrator, { id: 'o-test', status: 'idle' });
  assert.equal(r.memoryFiles, 2);

  assert.deepEqual(auth.userInfos().map((u) => u.userId), ['ben', 'lothsahn', 'carol']);
  assert.deepEqual(auth.apiKeyInfos().map((k) => k.name).sort(), ['carol-key', 'owner-mcp']);
  assert.equal(auth.user(req(cookie)), undefined, 'its session is gone');
  assert.equal(new Auth(data, { trustProxy: false }).user(req(cookie)), undefined, 'and gone from disk');
  assert.equal(auth.user(req(benLogin.cookie.split(';')[0])), 'ben', "another login's session stays");
  assert.deepEqual(settings().pool, { lothsahn: 'ben' });
  assert.deepEqual(settings().heartbeat, { ben: 10 });
  assert.deepEqual(settings().dismissedEvents, { ben: ['y'] });
  assert.deepEqual(removed, ['o-test']);
  assert.ok(sessions.has('o-ben'));
  assert.deepEqual(subs.map((s) => s.user), ['ben']);
  assert.equal(fs.existsSync(deps.memoryDir('w1021-test')), false);
  assert.ok(fs.existsSync(path.join(deps.memoryDir('ben'), 'MEMORY.md')));
  const trash = path.join(`${memoryRoot}.backup`, 'trash', 'person-w1021-test');
  assert.deepEqual(fs.readdirSync(trash).sort(), ['20261023T153000Z-deleted-login-MEMORY.md', '20261023T153000Z-deleted-login-notes__a.md']);

  const lines = describeLoginDeleted(r).join('\n');
  assert.match(lines, /^deleted the login w1021-test \("w1021 test", member\)\nAPI keys: w1021-m3\nsessions ended: 1\npool entry: removed \(its work ran on ben's pool\)/);
  assert.match(lines, /orchestrator: session o-test removed, its process stopped \(was idle\)\norchestrator memory: 2 files moved to /);
  assert.ok(!lines.includes(key.slice(5, 30)) && !lines.includes('throwaway-password'), 'no key or password');
});

test('delete is refused, with nothing touched: a missing login, its own login, the last owner, an owner in the members-only form, a login another pool names', async (t) => {
  const { auth, deps, settings, removed, memoryRoot } = await setup(t);
  auth.createApiKey('w1021-m3', 'w1021-test');
  const before = { users: auth.userInfos(), keys: auth.apiKeyInfos(), settings: structuredClone(settings()) };
  const refused = (re: RegExp) => (e: unknown) => e instanceof LoginDeleteRefused && re.test(e.message);
  assert.throws(() => deleteLogin(deps, { user: 'nobody', by: 'ben' }), refused(/no login 'nobody'/));
  assert.throws(() => deleteLogin(deps, { user: 'W1021-test', by: 'ben' }), refused(/differs only in case from the login 'w1021-test'/));
  assert.throws(() => deleteLogin(deps, { user: 'carol', by: 'Carol' }), refused(/the login this is run as/));
  assert.throws(() => deleteLogin(deps, { user: 'carol', by: 'nobody' }), refused(/--by nobody: no such login/));
  assert.throws(() => deleteLogin(deps, { user: 'w1021-test;id', by: 'ben' }), refused(/not a login id/));
  assert.throws(() => deleteLogin(deps, { user: 'lothsahn', by: 'carol', membersOnly: true }), refused(/a person's own login/));
  // w1021-test's pool names ben: lothsahn's pool names ben too, so ben is refused for that before anything else
  assert.throws(() => deleteLogin(deps, { user: 'ben', by: 'lothsahn' }), refused(/lothsahn's pool setting names 'ben''s pool/));
  assert.deepEqual(auth.userInfos(), before.users);
  assert.deepEqual(auth.apiKeyInfos(), before.keys);
  assert.deepEqual(settings(), before.settings);
  assert.deepEqual(removed, []);
  assert.ok(fs.existsSync(path.join(memoryRoot, 'person-w1021-test', 'MEMORY.md')));

  // The last owner: with lothsahn a member, ben is the only owner left.
  await auth.setUser('lothsahn', 'loth-password-123', { role: 'member' });
  deps.putSettings({ pool: {} });
  assert.throws(() => deleteLogin(deps, { user: 'ben', by: 'lothsahn' }), refused(/the last owner login/));
  assert.throws(() => auth.deleteUser('ben'), /the last owner login/);
  // A second owner: the members-only form still refuses an owner; the person's own form deletes it.
  await auth.setUser('dana', 'dana-password-123', { role: 'owner' });
  assert.throws(() => deleteLogin(deps, { user: 'dana', by: 'ben', membersOnly: true }), refused(/an owner login: only member logins/));
  assert.equal(deleteLogin(deps, { user: 'dana', by: 'ben' }).role, 'owner');
  assert.deepEqual(auth.userInfos().map((u) => u.userId).sort(), ['ben', 'carol', 'lothsahn', 'w1021-test']);
});

test('fffctl user (server/userCli.ts): delete reaches the running portal through data/login-delete and prints its answer; list shows no hash', async (t) => {
  const { dir, data, auth, deps } = await setup(t);
  const key = auth.createApiKey('w1021-m3', 'w1021-test');
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: data, sandboxRoot: path.join(dir, 'sb'), repo: { url: 'https://example.test/g.git', basePath: path.join(dir, 'base') }, unity: { editorPath: 'x' } }));
  const cli = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, ['server/userCli.ts', ...args], { env: { ...process.env, FFSB_CONFIG: cfgFile, ...env } });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (b) => (stdout += b));
      p.stderr.on('data', (b) => (stderr += b));
      p.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  // No portal answering: nothing is deleted, and the request is taken back.
  const none = await cli(['delete', 'w1021-test', '--by', 'lothsahn'], { FFF_USER_DELETE_WAIT_SEC: '1' });
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stderr, /the portal did not answer in 1 s: it must be running .*nothing was deleted/);
  assert.deepEqual(fs.readdirSync(path.join(data, LOGIN_DELETE_DIR)), []);
  assert.ok(auth.userInfo('w1021-test'));

  // The portal's 1 s poll, here every 50 ms.
  const poll = setInterval(() => serveLoginDeletes(data, (r) => deleteLogin(deps, r)), 50);
  t.after(() => clearInterval(poll));
  const list = await cli(['list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^w1021-test +member +w1021 test$/m);
  assert.ok(!list.stdout.includes('scrypt'));
  const self = await cli(['delete', 'carol', '--by', 'carol']);
  assert.equal(self.status, 2);
  assert.match(self.stderr, /^user: 'carol' is the login this is run as/);
  const owner = await cli(['delete', 'lothsahn', '--by', 'ben', '--members-only']);
  assert.equal(owner.status, 2);
  assert.match(owner.stderr, /a person's own login/);
  for (const [args, why] of [
    [['delete', 'w1021-test'], /--by LOGIN/],
    [['delete', 'w1021-test', '--by', 'ben', '--force'], /Unknown option '--force'/],
    [['list', 'extra'], /list takes nothing more/],
    [['remove', 'w1021-test'], /user list \| delete/],
  ] as const) {
    const x = await cli([...args]);
    assert.equal(x.status, 2, `${args.join(' ')}: ${x.stdout}${x.stderr}`);
    assert.match(x.stderr, why, args.join(' '));
  }
  const ok = await cli(['delete', 'w1021-test', '--by', 'lothsahn', '--members-only']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^deleted the login w1021-test \("w1021 test", member\)\nAPI keys: w1021-m3\n/);
  assert.ok(!(ok.stdout + ok.stderr).includes(key.slice(5, 30)), 'no key printed');
  assert.equal(auth.userInfo('w1021-test'), undefined);
  assert.deepEqual(fs.readdirSync(path.join(data, LOGIN_DELETE_DIR)), [], 'request and answer both gone');
  const again = await cli(['delete', 'w1021-test', '--by', 'lothsahn']);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /no login 'w1021-test'/);
});
