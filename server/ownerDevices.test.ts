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

/** New-device approval for owner logins (w5524, docs/identity.md "Owner device approval"): off and advisory. Nothing in it
 * may refuse or hold an owner's login (lothsahn and Ben, w5524: advisory only while they travel; enforcement is a later change). */

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

test('advisory: a new browser through Funnel is let in, its request waits for the owners, and the log says it would need approval', async (t) => {
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

test('advisory: a denied browser is still let in, logged as one that would be refused', async (t) => {
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

test('a brand-new device with no approvals and no device store signs in, and is logged as needing approval', async (t) => {
  const { a, dir, told } = await setup(t, 'advisory');
  assert.ok(!fs.existsSync(path.join(dir, 'devices.json')), 'no approval store yet');
  assert.ok(!fs.existsSync(path.join(dir, 'device-log.json')));
  const r = await a.login(req(viaFunnel()), 'ben', 'the owners password');
  assert.ok(r.ok, 'a brand-new device is let in');
  assert.equal(a.user(req({ cookie: both(r.cookie, r.deviceCookie) })), 'ben');
  assert.deepEqual(a.deviceLogList().map((e) => e.outcome), ['would-need-approval']);
  assert.equal(told.length, 0, 'no notification is sent for an owner, so none can fail the login');
  // A second owner on a second new browser, at once: let in too.
  assert.ok((await a.login(req(viaFunnel()), 'loth', 'the other owners pw')).ok);
});

test('an owner is let in when the device check itself fails: the store, the log, the setting or a notification', async (t) => {
  const boom = () => { throw new Error('injected'); };
  const warn = console.warn;
  t.after(() => { console.warn = warn; });
  const warned: string[] = [];
  console.warn = (m: string) => { warned.push(String(m)); };
  for (const [what, breakIt] of [
    ['find', (a: Auth) => { a.devices.find = boom; }],
    ['upsert', (a: Auth) => { a.devices.upsert = boom; }],
    ['the log', (a: Auth) => { a.deviceLog.add = boom; }],
    ['a notification', (a: Auth) => { a.onDevicePending = boom; }],
  ] as const) {
    const { a } = await setup(t, 'advisory');
    breakIt(a);
    const r = await a.login(req(viaFunnel()), 'ben', 'the owners password');
    assert.ok(r.ok, `let in with ${what} failing`);
    assert.equal(a.user(req({ cookie: cookieOf(r.cookie) })), 'ben', what);
  }
  // The store's file cannot be written (a directory where devices.json should be).
  const { a, dir } = await setup(t, 'advisory');
  fs.mkdirSync(path.join(dir, 'devices.json'));
  assert.ok((await a.login(req(viaFunnel()), 'ben', 'the owners password')).ok, 'let in with the store unwritable');
  // The store's file is garbage.
  const g = await setup(t, 'advisory');
  fs.writeFileSync(path.join(g.dir, 'devices.json'), '{not json');
  fs.writeFileSync(path.join(g.dir, 'device-log.json'), '][');
  assert.ok((await g.a.login(req(viaFunnel()), 'ben', 'the owners password')).ok, 'let in with a corrupt store');
  // The setting's getter throws.
  const s = new Auth(dataDir(t), { trustProxy: true, ownerDeviceApproval: boom, onTailnet: boom });
  await s.setUser('ben', 'the owners password', { role: 'owner' });
  assert.ok((await s.login(req(viaFunnel()), 'ben', 'the owners password')).ok, 'let in with the setting failing');
  assert.ok(warned.some((m) => /owner device check for "ben" .* failed; let in/.test(m)), 'the failure is logged');
});

test('a value the portal does not know (an "enforce" written into config.json by hand) is read as advisory and holds nobody', async (t) => {
  const { a } = await setup(t, 'enforce' as OwnerDeviceApproval);
  const r = await a.login(req(viaFunnel()), 'ben', 'the owners password');
  assert.ok(r.ok);
  assert.deepEqual(a.deviceLogList().map((e) => e.outcome), ['would-need-approval']);
});

test('tailnet bypass: over the tailnet the browser is approved by the login and nothing is logged', async (t) => {
  const { a, told } = await setup(t, 'advisory');
  const r = await a.login(req(viaTailnet()), 'ben', 'the owners password');
  assert.ok(r.ok);
  const [d] = a.deviceList();
  assert.equal(d.status, 'approved');
  assert.equal(d.decidedBy, 'tailnet login');
  assert.equal(told.length, 0);
  assert.deepEqual(a.deviceLogList(), []);
  // That browser later comes through Funnel: it is known, so it is not logged.
  assert.ok((await a.login(req(viaFunnel(cookieOf(r.deviceCookie!))), 'ben', 'the owners password')).ok);
  assert.deepEqual(a.deviceLogList(), []);
  // A direct connection from a tailnet address, and one on this machine, are the tailnet too.
  assert.ok((await a.login(req({ ip: '100.90.1.2' }), 'loth', 'the other owners pw')).ok);
  assert.ok((await a.login(req({ ip: '127.0.0.1' }), 'loth', 'the other owners pw')).ok);
  assert.deepEqual(a.deviceLogList(), []);
  // A tailnet-looking forwarded address with Funnel's header is not the tailnet: let in, but logged.
  const spoof = await a.login(req({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '100.101.102.103', 'tailscale-funnel-request': '?1' } }), 'loth', 'the other owners pw');
  assert.ok(spoof.ok);
  assert.deepEqual(a.deviceLogList().map((e) => e.outcome), ['would-need-approval']);
  // A denied browser signs in over the tailnet and is approved by it.
  const [s] = a.deviceList().filter((x) => x.status === 'pending');
  a.decideDevice(s.id, 'deny', 'ben');
  const sc = cookieOf(spoof.deviceCookie!);
  assert.ok((await a.login(req(viaTailnet(sc)), 'loth', 'the other owners pw')).ok);
  assert.equal(a.deviceList().find((x) => x.id === s.id)?.status, 'approved');
});

test('revoke: an approved browser is forgotten and its sessions end; its next login is let in and logged again', async (t) => {
  const { a } = await setup(t, 'advisory');
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
  const next = await a.login(req(viaFunnel(cookieOf(dc))), 'ben', 'the owners password');
  assert.ok(next.ok, 'a revoked browser is still let in');
  assert.deepEqual(a.deviceLogList().map((e) => e.outcome), ['would-need-approval']);
});

test('the setting is read live: advisory to off without a restart', async (t) => {
  const { a, cfg } = await setup(t, 'advisory');
  assert.ok((await a.login(req(viaFunnel()), 'ben', 'the owners password')).ok);
  assert.equal(a.deviceLogList().length, 1);
  cfg.mode = 'off';
  assert.ok((await a.login(req(viaFunnel()), 'loth', 'the other owners pw')).ok);
  assert.equal(a.deviceLogList().length, 1, 'off records nothing');
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
  for (const v of ['off', 'advisory']) assert.equal(normalizeSetting('ownerDeviceApproval', v), v);
  assert.equal(normalizeSetting('ownerDeviceApproval', null), undefined);
  assert.throws(() => normalizeSetting('ownerDeviceApproval', 'on'), /ownerDeviceApproval is "advisory"/);
  assert.throws(() => normalizeSetting('ownerDeviceApproval', 'enforce'), /does not exist yet/, 'enforcement is a later change');
  const file = path.join(dataDir(t), 'config.json');
  fs.writeFileSync(file, '{}\n');
  const cfg = {} as Config;
  setAppConfig(file, cfg, 'ownerDeviceApproval', 'off');
  assert.equal(cfg.ownerDeviceApproval, 'off');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ownerDeviceApproval, 'off');
  setAppConfig(file, cfg, 'ownerDeviceApproval', null);
  assert.equal(cfg.ownerDeviceApproval, undefined, 'null puts back the default (advisory)');
});
