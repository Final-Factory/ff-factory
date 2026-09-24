import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { Auth, COOKIE } from './auth.ts';

/** The web login and API keys: the page drives agents with a shell, so this is the front door. */

function dataDir(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const req = (o: { ip?: string; cookie?: string; headers?: Record<string, string> } = {}) =>
  ({ socket: { remoteAddress: o.ip ?? '203.0.113.7' }, headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers } }) as unknown as http.IncomingMessage;

/** "ffsb_session=<id>" from a Set-Cookie value. */
const cookieOf = (setCookie: string) => setCookie.split(';')[0];

test('login: right password gets a hardened cookie; wrong ones and unknown users do not', async (t) => {
  const a = new Auth(dataDir(t), { trustProxy: false });
  await a.setUser('ben', 'correct horse battery');
  assert.equal(a.hasUsers(), true);

  const bad = await a.login(req(), 'ben', 'wrong password!!');
  assert.deepEqual(bad, { ok: false, status: 401, error: 'Wrong username or password.' });
  // An unknown name gets the same answer (and, via the dummy hash, the same timing).
  assert.deepEqual(await a.login(req(), 'nobody', 'whatever it is'), { ok: false, status: 401, error: 'Wrong username or password.' });

  const ok = await a.login(req(), 'ben', 'correct horse battery');
  assert.ok(ok.ok);
  assert.match(ok.cookie, new RegExp(`^${COOKIE}=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000$`));
  assert.equal(a.user(req({ cookie: cookieOf(ok.cookie) })), 'ben');
  assert.equal(a.user(req({ cookie: `${COOKIE}=${'0'.repeat(64)}` })), undefined);
  assert.equal(a.user(req()), undefined);
});

test('login: an unknown user right after startup is refused, not an error', async (t) => {
  // The dummy hash is computed in the background; a login may arrive before it is ready.
  const a = new Auth(dataDir(t), { trustProxy: false });
  assert.deepEqual(await a.login(req(), 'nobody', 'whatever it is'), { ok: false, status: 401, error: 'Wrong username or password.' });
});

test('login: Secure cookie behind an HTTPS proxy', async (t) => {
  const a = new Auth(dataDir(t), { trustProxy: true });
  await a.setUser('ben', 'correct horse battery');
  const ok = await a.login(req({ ip: '127.0.0.1', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.1' } }), 'ben', 'correct horse battery');
  assert.ok(ok.ok && ok.cookie.endsWith('; Secure'));
});

test('rate limit: five failures per client lock it out for a while; others are unaffected', async (t) => {
  const a = new Auth(dataDir(t), { trustProxy: false });
  await a.setUser('ben', 'correct horse battery');
  for (let i = 0; i < 5; i++) assert.equal((await a.login(req({ ip: '203.0.113.9' }), 'ben', `guess number ${i}`)).ok, false);
  // Now even the right password is refused from there, without hashing anything.
  const locked = await a.login(req({ ip: '203.0.113.9' }), 'ben', 'correct horse battery');
  assert.deepEqual(locked, { ok: false, status: 429, error: 'Too many failed attempts. Try again in 15 minutes.' });
  // Another address still gets in, and a success clears that address's record.
  const other = req({ ip: '203.0.113.10' });
  assert.equal((await a.login(other, 'ben', 'nope nope nope')).ok, false);
  assert.equal((await a.login(other, 'ben', 'correct horse battery')).ok, true);
});

test('client address: X-Forwarded-For is believed only from a local proxy, and only with trustProxy', () => {
  const trusting = new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-auth-')), { trustProxy: true });
  const fwd = { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' };
  assert.equal(trusting.clientIp(req({ ip: '127.0.0.1', headers: fwd })), '198.51.100.1');
  assert.equal(trusting.clientIp(req({ ip: '::1', headers: fwd })), '198.51.100.1');
  // A remote peer cannot pick its own address for the rate limiter.
  assert.equal(trusting.clientIp(req({ ip: '203.0.113.7', headers: fwd })), '203.0.113.7');
  const strict = new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-auth-')), { trustProxy: false });
  assert.equal(strict.clientIp(req({ ip: '127.0.0.1', headers: fwd })), '127.0.0.1');
  assert.equal(strict.isHttps(req()), false);
});

test('sessions: persisted as hashes, survive a restart, end on logout and on a password change', async (t) => {
  const dir = dataDir(t);
  const a = new Auth(dir, { trustProxy: false });
  await a.setUser('ben', 'correct horse battery');
  await a.setUser('kyle', 'another long password');
  const ben = await a.login(req(), 'ben', 'correct horse battery');
  const kyle = await a.login(req(), 'kyle', 'another long password');
  assert.ok(ben.ok && kyle.ok);
  const benCookie = cookieOf(ben.cookie);
  const kyleCookie = cookieOf(kyle.cookie);

  // The file holds SHA-256 digests, never the cookie value itself.
  const onDisk = fs.readFileSync(path.join(dir, 'auth-sessions.json'), 'utf8');
  assert.ok(!onDisk.includes(benCookie.split('=')[1]));
  assert.equal(Object.keys(JSON.parse(onDisk)).length, 2);

  // A new server process reads them back.
  const b = new Auth(dir, { trustProxy: false });
  assert.equal(b.user(req({ cookie: benCookie })), 'ben');

  // Logout ends that session only, and clears the cookie.
  assert.match(b.logout(req({ cookie: benCookie })), /Max-Age=0/);
  assert.equal(b.user(req({ cookie: benCookie })), undefined);
  assert.equal(b.user(req({ cookie: kyleCookie })), 'kyle');

  // Changing a password signs that user out everywhere.
  await b.setUser('kyle', 'a brand new password');
  assert.equal(b.user(req({ cookie: kyleCookie })), undefined);
});

test('sessions: an expired one is refused and forgotten', async (t) => {
  const dir = dataDir(t);
  const a = new Auth(dir, { trustProxy: false });
  await a.setUser('ben', 'correct horse battery');
  const ok = await a.login(req(), 'ben', 'correct horse battery');
  assert.ok(ok.ok);
  const file = path.join(dir, 'auth-sessions.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of Object.keys(raw)) raw[k].expires = Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(raw));
  // Loaded expired: dropped at startup.
  assert.equal(new Auth(dir, { trustProxy: false }).user(req({ cookie: cookieOf(ok.cookie) })), undefined);
});

test('users: names and passwords are validated', async (t) => {
  const a = new Auth(dataDir(t), { trustProxy: false });
  await assert.rejects(a.setUser('x', 'correct horse battery'), /username/);
  await assert.rejects(a.setUser('ben ryding', 'correct horse battery'), /username/);
  await assert.rejects(a.setUser('ben', 'short'), /at least 12/);
  assert.equal(a.hasUsers(), false);
});

test('API keys: shown once, stored hashed, revocable; bad keys are throttled per address', (t) => {
  const dir = dataDir(t);
  const a = new Auth(dir, { trustProxy: false });
  const key = a.createApiKey('laptop');
  assert.match(key, /^ffsb_[A-Za-z0-9_-]{43}$/);
  assert.ok(!fs.readFileSync(path.join(dir, 'api-keys.json'), 'utf8').includes(key));
  assert.throws(() => a.createApiKey('bad name!'), /key name/);

  const bearer = (k: string, ip?: string) => a.bearer(req({ ip, headers: { authorization: `Bearer ${k}` } }));
  assert.deepEqual(bearer(key), { ok: true, name: 'laptop' });
  // Re-minting a name replaces the old key.
  const key2 = a.createApiKey('laptop');
  assert.deepEqual(bearer(key), { ok: false, status: 401 });
  assert.deepEqual(bearer(key2), { ok: true, name: 'laptop' });
  assert.deepEqual(a.bearer(req()), { ok: false, status: 401 });

  for (let i = 0; i < 9; i++) assert.equal(bearer(`ffsb_${'x'.repeat(43)}`, '198.51.100.3').ok, false);
  // The tenth failure from that address... and then even a good key waits.
  assert.deepEqual(bearer(`ffsb_${'y'.repeat(43)}`, '198.51.100.3'), { ok: false, status: 401 });
  assert.deepEqual(bearer(key2, '198.51.100.3'), { ok: false, status: 429 });
  assert.deepEqual(bearer(key2, '198.51.100.4'), { ok: true, name: 'laptop' });

  assert.equal(a.revokeApiKey('laptop'), true);
  assert.equal(a.revokeApiKey('laptop'), false);
  assert.deepEqual(bearer(key2), { ok: false, status: 401 });
});
