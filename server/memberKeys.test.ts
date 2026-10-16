import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type http from 'node:http';
import { Auth } from './auth.ts';
import { MemberKeyRefused, PROTECTED_LOGINS, issueMemberKey, memberKeys, revokeMemberKey } from './memberKeys.ts';
import { OPS_PEOPLE } from './opsWorker.ts';
import { redactSecrets } from './secrets.ts';

/** API keys for member logins (w1415, fffctl apikey): the refusals, and that the key reaches a file and no output. */

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  return { dir, data, auth: new Auth(data, { trustProxy: false }) };
}
const req = (key: string) => ({ headers: { authorization: `Bearer ${key}` }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as http.IncomingMessage;
const refused = (re: RegExp) => (e: unknown) => e instanceof MemberKeyRefused && re.test(e.message);

async function people(auth: Auth) {
  await auth.setUser('owner1', 'owner-password-123'); // the first login is the owner
  await auth.setUser('ben', 'ben-password-1234', { role: 'member' }); // even as a member, Ben's own login is refused
  await auth.setUser('lothsahn', 'loth-password-123', { role: 'member' });
  await auth.setUser('carol', 'carol-password-12', { role: 'member' });
}

test('the protected logins are the people the orchestration worker works for', () => {
  for (const p of OPS_PEOPLE) assert.ok(PROTECTED_LOGINS.includes(p), p);
});

test('issue: refused for an owner, for ben and lothsahn in any case, for a missing login without --create-member, and before anything is written', async (t) => {
  const { dir, auth } = setup(t);
  await people(auth);
  const out = path.join(dir, 'key');
  const before = fs.readFileSync(path.join(path.dirname(out), 'data', 'users.json'), 'utf8');
  for (const [user, why] of [
    ['owner1', /owner login/],
    ['ben', /Ben's own login/],
    ['Ben', /Ben's own login/],
    ['lothsahn', /Lothsahn's own login/],
    ['LOTHSAHN', /Lothsahn's own login/],
    ['nobody', /--create-member/],
    ['x', /not a login id/],
    ['a b', /not a login id/],
    ['Carol', /differs only in case/],
  ] as const) {
    await assert.rejects(issueMemberKey(auth, { name: 'k1', user, out }), refused(why), user);
  }
  // --create-member does not make an owner, Ben or Lothsahn into anything.
  for (const user of ['owner1', 'ben', 'Lothsahn']) await assert.rejects(issueMemberKey(auth, { name: 'k1', user, createMember: true, out }), MemberKeyRefused, user);
  await assert.rejects(issueMemberKey(auth, { name: 'k1', user: 'carol', displayName: 'Carol', out }), refused(/--display-name names a new login/));
  await assert.rejects(issueMemberKey(auth, { name: 'k1', user: 'carol', createMember: true, displayName: 'Carol', out }), refused(/exists/));
  await assert.rejects(issueMemberKey(auth, { name: 'bad name', user: 'carol', out }), refused(/not a key name/));
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(auth.apiKeyInfos(), []);
  assert.equal(fs.readFileSync(path.join(path.dirname(out), 'data', 'users.json'), 'utf8'), before, 'no login was made or changed');
});

test("issue: a key name the owner's key, a scoped key or another login's key holds is not taken over; an existing file is not overwritten", async (t) => {
  const { dir, auth } = setup(t);
  await people(auth);
  auth.createApiKey('owners', undefined);
  auth.createApiKey('nightly-run', undefined, 'nightly');
  auth.createApiKey('bens', 'ben');
  auth.createApiKey('carols', 'carol');
  await auth.setUser('dave', 'dave-password-123', { role: 'member' });
  const out = path.join(dir, 'key');
  for (const name of ['owners', 'nightly-run', 'bens', 'carols']) await assert.rejects(issueMemberKey(auth, { name, user: 'dave', out }), refused(/re-issuing it would replace that key/), name);
  fs.writeFileSync(out, 'something\n');
  await assert.rejects(issueMemberKey(auth, { name: 'daves', user: 'dave', out }), refused(/exists; pick a new file/));
  assert.equal(fs.readFileSync(out, 'utf8'), 'something\n');
  assert.deepEqual(auth.apiKeyInfos().map((k) => k.name).sort(), ['bens', 'carols', 'nightly-run', 'owners']);
});

test('issue --create-member: a member login with a password nobody has, a key bound to it in a 0600 file, and only its last four characters back', async (t) => {
  const { dir, data, auth } = setup(t);
  await people(auth);
  const out = path.join(dir, 'w1021-m3.key');
  const r = await issueMemberKey(auth, { name: 'w1021-m3', user: 'w1021-test', createMember: true, displayName: 'w1021 test', out });
  const key = fs.readFileSync(out, 'utf8').trim();
  assert.match(key, /^ffsb_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r, { last4: key.slice(-4), createdLogin: true, replaced: false });
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(auth.userInfo('w1021-test'), { userId: 'w1021-test', displayName: 'w1021 test', role: 'member' });
  const who = auth.bearer(req(key));
  assert.deepEqual(who, { ok: true, name: 'w1021-m3', user: 'w1021-test' });
  // Only hashes on disk: the key is in neither file, and the login has a scrypt hash, never a password in clear.
  for (const f of ['users.json', 'api-keys.json']) assert.ok(!fs.readFileSync(path.join(data, f), 'utf8').includes(key), f);
  assert.match(auth.users().find((u) => u.username === 'w1021-test')!.hash, /^scrypt\$/);
  // Again for the same login (a rerun after a failed write): a new key replaces the old, the login is kept.
  const out2 = path.join(dir, 'again.key');
  const r2 = await issueMemberKey(auth, { name: 'w1021-m3', user: 'w1021-test', out: out2 });
  assert.equal(r2.replaced, true);
  assert.equal(r2.createdLogin, false);
  assert.deepEqual(auth.bearer(req(key)), { ok: false, status: 401 });
  assert.deepEqual(memberKeys(auth).map((k) => [k.name, k.user]), [['w1021-m3', 'w1021-test']]);
});

test("revoke: a member login's key only; never the owner's, a scoped one, or ben's or lothsahn's", async (t) => {
  const { dir, auth } = setup(t);
  await people(auth);
  auth.createApiKey('owners', undefined);
  auth.createApiKey('nightly-run', undefined, 'nightly');
  auth.createApiKey('bens', 'ben');
  auth.createApiKey('loths', 'lothsahn');
  auth.createApiKey('owner1s', 'owner1');
  await issueMemberKey(auth, { name: 'w1021-m3', user: 'w1021-test', createMember: true, out: path.join(dir, 'k') });
  for (const [name, why] of [
    ['owners', /acts for the owner/],
    ['nightly-run', /has scope nightly/],
    ['bens', /Ben's own login/],
    ['loths', /Lothsahn's own login/],
    ['owner1s', /owner login/],
    ['nothere', /no key named/],
  ] as const) assert.throws(() => revokeMemberKey(auth, name), refused(why), name);
  assert.equal(auth.apiKeyInfos().length, 6);
  assert.deepEqual(memberKeys(auth).map((k) => k.name), ['w1021-m3'], 'list shows only member logins\' keys');
  assert.equal(revokeMemberKey(auth, 'w1021-m3'), 'w1021-test');
  assert.deepEqual(auth.apiKeyInfos().map((k) => k.name).sort(), ['bens', 'loths', 'nightly-run', 'owner1s', 'owners']);
});

test('the CLI: the key reaches the --out file and nothing it prints, on success or refusal; its shape is redacted wherever it shows up', async (t) => {
  const { dir, data, auth } = setup(t);
  await people(auth);
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: data, sandboxRoot: path.join(dir, 'sb'), repo: { url: 'https://example.test/g.git', basePath: path.join(dir, 'base') }, unity: { editorPath: 'x' } }));
  const env = { ...process.env, FFSB_CONFIG: cfgFile };
  const cli = (...a: string[]) => spawnSync(process.execPath, ['server/memberKeyCli.ts', ...a], { env, encoding: 'utf8' });
  const out = path.join(dir, 'key');
  const r = cli('issue', 'w1021-m3', '--user', 'w1021-test', '--create-member', '--out', out);
  assert.equal(r.status, 0, r.stderr);
  const key = fs.readFileSync(out, 'utf8').trim();
  const printed = r.stdout + r.stderr;
  assert.ok(!printed.includes(key) && !printed.includes(key.slice(5, 40)), 'the key was printed');
  assert.match(r.stdout, new RegExp(`made the member login w1021-test .*a key w1021-m3 for w1021-test, ending …${key.slice(-4).replace(/[-]/g, '\\-')}, in `));
  const list = cli('list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^w1021-m3 +w1021-test +20\d\d-/);
  assert.ok(!list.stdout.includes(key.slice(5, 40)));
  for (const [args, why] of [
    [['issue', 'k2', '--user', 'ben', '--out', path.join(dir, 'k2')], /Ben's own login/],
    [['issue', 'k2', '--user', 'owner1', '--out', path.join(dir, 'k2')], /owner login/],
    [['issue', 'w1021-m3', '--user', 'carol', '--out', path.join(dir, 'k2')], /re-issuing it would replace/],
    [['issue', 'k2', '--user', 'carol'], /--out FILE/],
    [['issue', 'k2', '--user', 'carol', '--out', path.join(dir, 'k2'), '--role', 'owner'], /Unknown option '--role'/],
    [['revoke', 'w1021-m3', '--user', 'x'], /revoke NAME/],
    [['list', 'extra'], /list takes nothing more/],
    [['export', 'w1021-m3'], /apikey list \| issue/],
  ] as const) {
    const x = cli(...args);
    assert.equal(x.status, 2, `${args.join(' ')}: ${x.stdout}${x.stderr}`);
    assert.match(x.stderr, why, args.join(' '));
    assert.ok(!(x.stdout + x.stderr).includes(key.slice(5, 40)));
  }
  assert.equal(fs.existsSync(path.join(dir, 'k2')), false);
  const rv = cli('revoke', 'w1021-m3');
  assert.equal(rv.status, 0, rv.stderr);
  assert.match(rv.stdout, /revoked w1021-m3 \(it acted for w1021-test\); the login stays/);
  assert.deepEqual(new Auth(data, { trustProxy: false }).apiKeyInfos(), []);
  // A transcript or log line that ever held one shows only its last four characters.
  assert.equal(redactSecrets(`cat says ${key} ok`), `cat says ffsb_[redacted …${key.slice(-4)}] ok`);
  assert.equal(redactSecrets('cookie ffsb_session=1'), 'cookie ffsb_session=1');
});
