import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { Auth } from './auth.ts';
import { DEVICE_COOKIE, deviceLabel, type DeviceApproval, type DeviceView } from './devices.ts';
import { OWNER_ONLY_KEYS, SETTABLE_KEYS, normalizeSetting } from './appConfig.ts';

/** Device approval (docs/identity.md): a member's login from a browser no owner approved for them waits for an owner. */

function dataDir(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-devices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const req = (o: { ip?: string; cookie?: string; ua?: string; headers?: Record<string, string> } = {}) =>
  ({ socket: { remoteAddress: o.ip ?? '203.0.113.7' }, headers: { 'user-agent': o.ua ?? IPHONE, ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers } }) as unknown as http.IncomingMessage;
const cookieOf = (setCookie: string) => setCookie.split(';')[0];

async function setup(t: { after: (fn: () => void) => void }, mode: DeviceApproval = 'members') {
  const dir = dataDir(t);
  const cfg = { mode };
  const a = new Auth(dir, { trustProxy: false, deviceApproval: () => cfg.mode });
  await a.setUser('ben', 'the owners password', { role: 'owner' });
  await a.setUser('cassidy', 'cassidys own password', { role: 'member' });
  const told: DeviceView[] = [];
  a.onDevicePending = (d) => told.push(d);
  return { a, dir, cfg, told };
}

test('off (the default): a member signs in with the password alone, as before', async (t) => {
  const { a, cfg, told } = await setup(t, 'off');
  const r = await a.login(req(), 'cassidy', 'cassidys own password');
  assert.ok(r.ok);
  assert.equal(r.deviceCookie, undefined, 'no device cookie while approval is off');
  assert.equal(a.user(req({ cookie: cookieOf(r.cookie) })), 'cassidy');
  assert.deepEqual(a.deviceList(), []);
  assert.equal(told.length, 0);
  // An Auth made without the option is off too (the CLIs' own).
  const plain = new Auth(dataDir(t), { trustProxy: false });
  await plain.setUser('ben', 'the owners password');
  await plain.setUser('cassidy', 'cassidys own password', { role: 'member' });
  assert.ok((await plain.login(req(), 'cassidy', 'cassidys own password')).ok);
  // Live: turning it on holds the next login from a new browser.
  cfg.mode = 'members';
  const held = await a.login(req({ ip: '198.51.100.1' }), 'cassidy', 'cassidys own password');
  assert.equal(held.ok, false);
  assert.equal(!held.ok && held.status, 202);
});

test('members: a new browser waits for an owner; once approved, that browser signs in and no other one does', async (t) => {
  const { a, dir, told } = await setup(t);
  // A wrong password is a wrong password: no request, no device cookie.
  const wrong = await a.login(req(), 'cassidy', 'not her password!');
  assert.deepEqual(wrong, { ok: false, status: 401, error: 'Wrong username or password.' });
  assert.deepEqual(a.deviceList(), []);

  const first = await a.login(req(), 'cassidy', 'cassidys own password');
  assert.ok(!first.ok && first.status === 202 && first.pending, 'right password, new browser: held, no session');
  assert.ok(!first.ok && first.deviceCookie);
  const dev = cookieOf((!first.ok && first.deviceCookie) || '');
  assert.match(dev, new RegExp(`^${DEVICE_COOKIE}=[a-f0-9]{64}$`));
  assert.match(!first.ok ? first.deviceCookie! : '', /HttpOnly; SameSite=Strict; Path=\/; Max-Age=34560000/);
  // The owners are told once, with what the browser is; only the cookie's hash is kept.
  assert.equal(told.length, 1);
  assert.equal(told[0].username, 'cassidy');
  assert.equal(told[0].label, 'Safari on iPhone');
  assert.equal(told[0].status, 'pending');
  assert.equal(fs.readFileSync(path.join(dir, 'devices.json'), 'utf8').includes(dev.split('=')[1]), false);
  assert.equal('sha256' in a.deviceList()[0], false, 'the list carries no hash');

  // Asking again from the same browser still waits, sends no second notice, and sets no new cookie.
  const again = await a.login(req({ cookie: dev }), 'cassidy', 'cassidys own password');
  assert.ok(!again.ok && again.status === 202 && again.deviceCookie === undefined);
  assert.equal(told.length, 1);
  assert.equal(a.deviceList().length, 1);

  // A held login is not a failed one: it does not run into the throttle.
  for (let i = 0; i < 6; i++) assert.equal((await a.login(req({ cookie: dev }), 'cassidy', 'cassidys own password')).ok, false);
  const id = a.deviceList()[0].id;
  assert.equal(a.decideDevice(id, 'approve', 'ben').status, 'approved');
  const ok = await a.login(req({ cookie: dev }), 'cassidy', 'cassidys own password');
  assert.ok(ok.ok, 'approved browser signs in');
  assert.equal(a.user(req({ cookie: cookieOf(ok.cookie) })), 'cassidy');

  // Another browser waits on its own; the owner never does.
  const other = await a.login(req({ ip: '198.51.100.2', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' }), 'cassidy', 'cassidys own password');
  assert.ok(!other.ok && other.status === 202);
  assert.equal(told.at(-1)!.label, 'Chrome on Windows');
  assert.ok((await a.login(req({ ip: '198.51.100.3' }), 'ben', 'the owners password')).ok, 'an owner is not held');
  // An approval is per login: the same browser is still new for another member.
  await a.setUser('guest', 'another long password', { role: 'member' });
  const shared = await a.login(req({ cookie: dev, ip: '198.51.100.4' }), 'guest', 'another long password');
  assert.ok(!shared.ok && shared.status === 202);
});

test('deny refuses the browser until an owner approves it; revoke ends its sessions and makes it ask again', async (t) => {
  const { a, told } = await setup(t);
  const first = await a.login(req(), 'cassidy', 'cassidys own password');
  const dev = cookieOf(!first.ok ? first.deviceCookie! : '');
  const id = a.deviceList()[0].id;
  a.decideDevice(id, 'deny', 'ben');
  const denied = await a.login(req({ cookie: dev }), 'cassidy', 'cassidys own password');
  assert.deepEqual(denied, { ok: false, status: 403, error: 'An owner refused this device. Ask them to approve it in FF Factory.' });
  assert.equal(told.length, 1, 'a refused browser asking again pings nobody');
  a.decideDevice(id, 'approve', 'ben');
  const ok = await a.login(req({ cookie: dev }), 'cassidy', 'cassidys own password');
  assert.ok(ok.ok);
  const session = cookieOf(ok.cookie);
  assert.equal(a.user(req({ cookie: `${session}; ${dev}` })), 'cassidy');

  const revoked = a.decideDevice(id, 'revoke', 'ben');
  assert.equal(revoked.id, id);
  assert.equal(a.user(req({ cookie: `${session}; ${dev}` })), undefined, 'revoking ends that browser’s sessions');
  assert.deepEqual(a.deviceList(), []);
  const back = await a.login(req({ cookie: dev }), 'cassidy', 'cassidys own password');
  assert.ok(!back.ok && back.status === 202, 'a revoked browser asks again');
  assert.equal(told.length, 2);
  assert.throws(() => a.decideDevice('dnothere1', 'approve', 'ben'), /no device "dnothere1"/);
});

test('a set-password link approves the browser that redeems it, and only that one', async (t) => {
  const { a, told } = await setup(t);
  const { token } = a.mintPasswordLink('cassidy', 72 * 3600 * 1000);
  const used = await a.usePasswordLink(req({ ip: '198.51.100.20' }), token, 'her very own password');
  assert.ok(used.ok);
  assert.equal(a.user(req({ cookie: cookieOf(used.cookie) })), 'cassidy', 'signed in at once');
  assert.ok(used.deviceCookie);
  const dev = cookieOf(used.deviceCookie!);
  const [d] = a.deviceList();
  assert.equal(d.status, 'approved');
  assert.equal(d.decidedBy, 'set-password link');
  assert.equal(told.length, 0, 'nothing to approve');
  // That browser signs in again later with the password alone; a new one waits.
  assert.ok((await a.login(req({ cookie: dev }), 'cassidy', 'her very own password')).ok);
  const phone = await a.login(req({ ip: '198.51.100.21' }), 'cassidy', 'her very own password');
  assert.ok(!phone.ok && phone.status === 202);
  // A browser that already had a device cookie keeps it (no new one is set) and is approved by the link.
  const second = a.mintPasswordLink('cassidy');
  const phoneDev = cookieOf(!phone.ok ? phone.deviceCookie! : '');
  const reused = await a.usePasswordLink(req({ cookie: phoneDev }), second.token, 'her newer password!');
  assert.ok(reused.ok && reused.deviceCookie === undefined);
  assert.equal(a.deviceList().find((x) => x.status === 'pending'), undefined);
});

test('deviceLabel names the browser and the system', () => {
  assert.equal(deviceLabel(IPHONE), 'Safari on iPhone');
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), 'Safari on Mac');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox on Windows');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'), 'Edge on Windows');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(deviceLabel(''), 'a browser on an unknown system');
});

test('deviceApproval and trustProxy are owner-only settings with checked values', () => {
  for (const k of ['deviceApproval', 'trustProxy'] as const) {
    assert.ok(SETTABLE_KEYS.includes(k));
    assert.ok(OWNER_ONLY_KEYS.has(k));
  }
  assert.equal(normalizeSetting('deviceApproval', 'members'), 'members');
  assert.equal(normalizeSetting('deviceApproval', 'off'), 'off');
  assert.equal(normalizeSetting('deviceApproval', undefined), undefined);
  assert.throws(() => normalizeSetting('deviceApproval', 'everyone'), /deviceApproval is "members"/);
  assert.equal(normalizeSetting('trustProxy', 'true'), true);
  assert.equal(normalizeSetting('trustProxy', false), false);
  assert.throws(() => normalizeSetting('trustProxy', 'yes'), /trustProxy is true/);
});
