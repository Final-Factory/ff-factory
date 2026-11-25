import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { Auth } from './auth.ts';
import { DEVICE_COOKIE, DeviceLog, OWNER_DEVICE_APPROVAL_DEFAULT, type DeviceView, type OwnerDeviceApproval } from './devices.ts';
import { OWNER_ONLY_KEYS, SETTABLE_KEYS, normalizeSetting, setAppConfig } from './appConfig.ts';
import { tailnetOnly } from './remoteChat.ts';
import type { Config } from './config.ts';

/** New-device approval for owner logins (w5524, docs/identity.md "Owner device approval"): off, advisory and enforce. */

function dataDir(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-owner-devices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
/** A request as Tailscale Serve hands it on: from this machine, with the client's address in X-Forwarded-For; Funnel adds its header. */
const viaFunnel = (cookie?: string) => ({ ip: '127.0.0.1', cookie, headers: { 'x-forwarded-for': '203.0.113.9', 'tailscale-funnel-request': '?1' } });
const viaTailnet = (cookie?: string) => ({ ip: '127.0.0.1', cookie, headers: { 'x-forwarded-for': '100.101.102.103' } });
const req = (o: { ip?: string; cookie?: string; headers?: Record<string, string> } = {}) =>
  ({ socket: { remoteAddress: o.ip ?? '203.0.113.7' }, headers: { 'user-agent': FIREFOX, ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers } }) as unknown as http.IncomingMessage;
const cookieOf = (setCookie: string) => setCookie.split(';')[0];
const both = (session: string, device?: string) => [cookieOf(session), device && cookieOf(device)].filter(Boolean).join('; ');

async function setup(t: { after: (fn: () => void) => void }, mode: OwnerDeviceApproval) {
  const dir = dataDir(t);
  const cfg = { mode };
  // The real tailnet test index.ts uses: Funnel's header, or an address outside 100.64.0.0/10, is not the tailnet.
  const a = new Auth(dir, { trustProxy: true, ownerDeviceApproval: () => cfg.mode, onTailnet: (r) => tailnetOnly(r) === undefined });
  await a.setUser('ben', 'the owners password', { role: 'owner' });
  await a.setUser('loth', 'the other owners pw', { role: 'owner' });
  await a.setUser('cassidy', 'cassidys own password', { role: 'member' });
  const told: DeviceView[] = [];
  a.onDevicePending = (d) => told.push(d);
  return { a, dir, cfg, told };
}

test('the default is advisory, and the CLIs’ Auth (no option) is off', async (t) => {
  assert.equal(OWNER_DEVICE_APPROVAL_DEFAULT, 'advisory');
  const plain = new Auth(dataDir(t), { trustProxy: false });
  await plain.setUser('ben', 'the owners password');
  const r = await plain.login(req(viaFunnel()), 'ben', 'the owners password');
  assert.ok(r.ok);
  assert.deepEqual(plain.deviceList(), []);
});

test('off: an owner signs in from anywhere with the password alone; nothing is recorded', async (t) => {
  const { a, told } = await setup(t, 'off');
  const r = await a.login(req(viaFunnel()), 'ben', 'the owners password');
  assert.ok(r.ok);
  assert.equal(r.deviceCookie, undefined, 'no device cookie while it is off');
  assert.equal(a.user(req({ cookie: cookieOf(r.cookie) })), 'ben');
  assert.deepEqual(a.deviceList(), []);
  assert.deepEqual(a.deviceLogList(), []);
  assert.equal(told.length, 0);
});

test('advisory: a new browser through Funnel is let in, its request waits for the owners, and the log says enforce would have held it', async (t) => {
  const { a, dir, told } = await setup(t, 'advisory');
  // A wrong password is just that: no request, no log line.
  const wrong = await a.login(req(viaFunnel()), 'ben', 'not the password!!');
  assert.equal(wrong.ok, false);
  assert.deepEqual(a.deviceList(), []);
  const r = await a.login(req(viaFunnel()), 'ben', 'the owners password');
  assert.ok(r.ok, 'advisory never holds a login');
  assert.ok(r.deviceCookie?.startsWith(`${DEVICE_COOKIE}=`), 'the browser gets its device cookie');
  assert.match(r.deviceCookie!, /HttpOnly/);
  assert.equal(a.user(req({ cookie: cookieOf(r.cookie) })), 'ben');
  const [d] = a.deviceList();
  assert.equal(d.status, 'pending');
  assert.equal(d.advisory, true);
  assert.equal(d.username, 'ben');
  assert.equal(d.ip, '203.0.113.9', 'the client address through the proxy');
  assert.equal(d.label, 'Firefox on Windows');
  assert.equal(told.length, 0, 'no push in advisory: the bar and the log show it');
  const [line] = a.deviceLogList();
  assert.equal(line.outcome, 'would-need-approval');
  assert.equal(line.mode, 'advisory');
  assert.equal(line.device, d.id);
  assert.equal(line.userAgent, FIREFOX);
  // Neither file holds the cookie's value.
  const id = cookieOf(r.deviceCookie!).split('=')[1];
  for (const f of ['devices.json', 'device-log.json']) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(id), f);
  // The same browser again within 30 minutes: let in, one log line still.
  const again = await a.login(req(viaFunnel(cookieOf(r.deviceCookie!))), 'ben', 'the owners password');
  assert.ok(again.ok);
  assert.equal(again.deviceCookie, undefined, 'it already has one');
  assert.equal(a.deviceLogList().length, 1);
  assert.equal(a.deviceList().length, 1);
  // Another owner approves it: from then on it is not logged.
  a.decideDevice(d.id, 'approve', 'loth');
  assert.equal(a.deviceList()[0].advisory, undefined);
  assert.ok((await a.login(req(viaFunnel(cookieOf(r.deviceCookie!))), 'ben', 'the owners password')).ok);
  assert.equal(a.deviceLogList().length, 1);
  // A member is not touched by the owners' setting (deviceApproval stays off here).
  const m = await a.login(req(viaFunnel()), 'cassidy', 'cassidys own password');
  assert.ok(m.ok);
  assert.equal(a.deviceList().length, 1);
});

test('advisory: a denied browser is still let in, logged as one enforce would refuse', async (t) => {
  const { a } = await setup(t, 'advisory');
  const r = await a.login(req(viaFunnel()), 'ben', 'the owners password');
  assert.ok(r.ok);
  const [d] = a.deviceList();
  a.decideDevice(d.id, 'deny', 'loth');
  assert.equal(a.user(req({ cookie: both(r.cookie, r.deviceCookie) })), undefined, 'deny ends that browser’s session');
  const back = await a.login(req(viaFunnel(cookieOf(r.deviceCookie!))), 'ben', 'the owners password');
  assert.ok(back.ok);
  assert.deepEqual(
    a.deviceLogList().map((e) => e.outcome),
    ['would-be-refused', 'would-need-approval'],
  );
});

test('enforce: a new browser through Funnel waits for another owner; once approved it signs in, and no other browser does', async (t) => {
  const { a, told } = await setup(t, 'enforce');
  const r = await a.login(req(viaFunnel()), 'ben', 'the owners password');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 202);
  assert.equal(!r.ok && r.pending, true);
  const dc = r.deviceCookie!;
  assert.ok(dc, 'the waiting browser gets its device cookie, so the approval finds it');
  const [d] = a.deviceList();
  assert.equal(d.status, 'pending');
  assert.equal(d.advisory, undefined);
  assert.equal(told.length, 1, 'the owners are told once');
  // The login page asks again: still held, no second notice, one log line.
  const again = await a.login(req(viaFunnel(cookieOf(dc))), 'ben', 'the owners password');
  assert.equal(!again.ok && again.status, 202);
  assert.equal(told.length, 1);
  assert.deepEqual(a.deviceLogList().map((e) => e.outcome), ['held']);
  a.decideDevice(d.id, 'approve', 'loth');
  const ok = await a.login(req(viaFunnel(cookieOf(dc))), 'ben', 'the owners password');
  assert.ok(ok.ok);
  assert.equal(a.user(req({ cookie: both(ok.cookie, dc) })), 'ben');
  // Another browser (no cookie) is held again.
  const other = await a.login(req(viaFunnel()), 'ben', 'the owners password');
  assert.equal(!other.ok && other.status, 202);
  // Denied: refused, 403.
  const [o] = a.deviceList().filter((x) => x.status === 'pending');
  a.decideDevice(o.id, 'deny', 'loth');
  const no = await a.login(req(viaFunnel(cookieOf(other.ok ? '' : other.deviceCookie!))), 'ben', 'the owners password');
  assert.equal(!no.ok && no.status, 403);
  assert.equal(a.deviceLogList()[0].outcome, 'refused');
});

test('tailnet bypass: over the tailnet an owner is never held, in enforce too, and the browser is approved by it', async (t) => {
  const { a, told } = await setup(t, 'enforce');
  const r = await a.login(req(viaTailnet()), 'ben', 'the owners password');
  assert.ok(r.ok, 'the tailnet is always a way in');
  const [d] = a.deviceList();
  assert.equal(d.status, 'approved');
  assert.equal(d.decidedBy, 'tailnet login');
  assert.equal(told.length, 0);
  assert.deepEqual(a.deviceLogList(), []);
  // That browser later comes through Funnel: it is known, so it signs in.
  const away = await a.login(req(viaFunnel(cookieOf(r.deviceCookie!))), 'ben', 'the owners password');
  assert.ok(away.ok);
  // A direct connection from a tailnet address, and one on this machine, are the tailnet too.
  assert.ok((await a.login(req({ ip: '100.90.1.2' }), 'loth', 'the other owners pw')).ok);
  assert.ok((await a.login(req({ ip: '127.0.0.1' }), 'loth', 'the other owners pw')).ok);
  // A tailnet-looking forwarded address with Funnel's header is not the tailnet.
  const spoof = await a.login(req({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '100.101.102.103', 'tailscale-funnel-request': '?1' } }), 'loth', 'the other owners pw');
  assert.equal(!spoof.ok && spoof.status, 202);
  // A denied browser is let back in over the tailnet, and approved by it.
  const [s] = a.deviceList().filter((x) => x.status === 'pending');
  a.decideDevice(s.id, 'deny', 'ben');
  const sc = cookieOf(spoof.ok ? '' : spoof.deviceCookie!);
  assert.equal(((await a.login(req(viaFunnel(sc)), 'loth', 'the other owners pw')) as { status: number }).status, 403);
  assert.ok((await a.login(req(viaTailnet(sc)), 'loth', 'the other owners pw')).ok);
  assert.ok((await a.login(req(viaFunnel(sc)), 'loth', 'the other owners pw')).ok, 'approved by the tailnet login');
});

test('revoke: an approved browser is forgotten and its sessions end; its next login outside the tailnet is held again', async (t) => {
  const { a } = await setup(t, 'enforce');
  const first = await a.login(req(viaTailnet()), 'ben', 'the owners password');
  assert.ok(first.ok);
  const dc = first.deviceCookie!;
  const away = await a.login(req(viaFunnel(cookieOf(dc))), 'ben', 'the owners password');
  assert.ok(away.ok);
  const browser = req({ cookie: both(away.cookie, dc) });
  assert.equal(a.user(browser), 'ben');
  const [d] = a.deviceList();
  assert.equal(a.currentDevice(browser), d.id, 'the Devices list can mark this browser');
  a.decideDevice(d.id, 'revoke', 'loth');
  assert.deepEqual(a.deviceList(), []);
  assert.equal(a.user(browser), undefined, 'its session ended');
  assert.equal(a.user(req({ cookie: both(first.cookie, dc) })), undefined, 'every session of that browser');
  const held = await a.login(req(viaFunnel(cookieOf(dc))), 'ben', 'the owners password');
  assert.equal(!held.ok && held.status, 202);
});

test('the setting is read live: advisory to enforce to off without a restart', async (t) => {
  const { a, cfg } = await setup(t, 'advisory');
  assert.ok((await a.login(req(viaFunnel()), 'ben', 'the owners password')).ok);
  cfg.mode = 'enforce';
  assert.equal(((await a.login(req(viaFunnel()), 'ben', 'the owners password')) as { status: number }).status, 202);
  cfg.mode = 'off';
  assert.ok((await a.login(req(viaFunnel()), 'ben', 'the owners password')).ok);
});

test('deleting a login forgets its log lines too', async (t) => {
  const { a } = await setup(t, 'advisory');
  await a.login(req(viaFunnel()), 'loth', 'the other owners pw');
  assert.equal(a.deviceLogList().length, 1);
  a.deleteUser('loth');
  assert.deepEqual(a.deviceLogList(), []);
});

test('the device log keeps 180 days and drops repeats within 30 minutes', (t) => {
  const log = new DeviceLog(dataDir(t));
  const line = { username: 'ben', device: 'dAAAAAAAA', label: 'x', ip: '203.0.113.9', userAgent: 'x', mode: 'advisory' as const, outcome: 'would-need-approval' as const };
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  log.add(line, t0);
  log.add(line, t0 + 10 * 60_000);
  assert.equal(log.list(t0 + 20 * 60_000).length, 1);
  log.add(line, t0 + 31 * 60_000);
  assert.equal(log.list(t0 + 40 * 60_000).length, 2);
  assert.equal(log.list(t0 + 181 * 24 * 3600_000).length, 0);
});

test('ownerDeviceApproval is an owner-only setting with checked values, applied live', (t) => {
  assert.ok(SETTABLE_KEYS.includes('ownerDeviceApproval'));
  assert.ok(OWNER_ONLY_KEYS.has('ownerDeviceApproval'));
  for (const v of ['off', 'advisory', 'enforce']) assert.equal(normalizeSetting('ownerDeviceApproval', v), v);
  assert.equal(normalizeSetting('ownerDeviceApproval', null), undefined);
  assert.throws(() => normalizeSetting('ownerDeviceApproval', 'on'), /ownerDeviceApproval is "advisory"/);
  const file = path.join(dataDir(t), 'config.json');
  fs.writeFileSync(file, '{}\n');
  const cfg = {} as Config;
  setAppConfig(file, cfg, 'ownerDeviceApproval', 'enforce');
  assert.equal(cfg.ownerDeviceApproval, 'enforce');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ownerDeviceApproval, 'enforce');
  setAppConfig(file, cfg, 'ownerDeviceApproval', null);
  assert.equal(cfg.ownerDeviceApproval, undefined, 'null puts back the default (advisory)');
});
