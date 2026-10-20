// Join codes (server/machineJoin.ts, w1592): one-use, bound to a machine and a tailnet device, lapsing, hashes only on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JoinCodes, defaultLimits, joinRefusal, newJoinCode, normalizeJoinCode, parseFacts, parseWhois, tailnetShortName } from './machineJoin.ts';

const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoin-')), 'machine-joins.json');

test('join codes: 20 characters of Crockford base32 in four groups; typing slips are forgiven, anything else refused', () => {
  const c = newJoinCode();
  assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  const canonical = c.replace(/-/g, '');
  assert.equal(normalizeJoinCode(c), canonical);
  assert.equal(normalizeJoinCode(` ${c.toLowerCase()} `), canonical);
  assert.equal(normalizeJoinCode('0000011111ABCDEFGHJK'), '0000011111ABCDEFGHJK');
  assert.equal(normalizeJoinCode('OOOOOIIIIL-ABCDEFGHJK'), '0000011111ABCDEFGHJK', 'O read as 0, I and L as 1');
  assert.equal(normalizeJoinCode('0000011111ABCDEFGHJ'), undefined, 'too short');
  assert.equal(normalizeJoinCode('0000011111ABCDEFGHJU'), undefined, 'U is not in the alphabet');
  assert.equal(normalizeJoinCode(42), undefined);
  assert.notEqual(newJoinCode(), newJoinCode());
});

test('join codes: only the hash is on disk (0600); a code works once, from the file, until it lapses', () => {
  let now = Date.parse('2026-10-20T10:00:00Z');
  const file = scratch();
  const codes = new JoinCodes(file, () => now);
  const { code, expiresAt, last4 } = codes.create({ machineId: 'desktop-coosego', tailnetName: 'Desktop-Coosego.tail1234.ts.net.', limits: { maxUnity: 2 }, by: 'Lothsahn' });
  assert.equal(expiresAt, '2026-10-20T11:00:00.000Z', 'an hour');
  assert.equal(last4, code.replace(/-/g, '').slice(-4));
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes(code) && !disk.includes(code.replace(/-/g, '')), 'the code itself is never written');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const j = codes.find(code.toLowerCase());
  assert.equal(j?.machineId, 'desktop-coosego');
  assert.equal(j?.tailnetName, 'desktop-coosego', 'the device name, short and lower-case');
  assert.deepEqual(j?.limits, { maxUnity: 2 });
  assert.equal(new JoinCodes(file, () => now).find(code)?.machineId, 'desktop-coosego', 'kept across a restart');
  assert.deepEqual(codes.pending().map((p) => [p.machineId, p.by, 'hash' in p]), [['desktop-coosego', 'Lothsahn', false]]);

  assert.equal(codes.take(j!), true);
  assert.equal(codes.find(code), undefined, 'used up');
  assert.equal(codes.take(j!), false);

  const again = codes.create({ machineId: 'desktop-coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn' });
  now += 61 * 60_000;
  assert.equal(codes.find(again.code), undefined, 'lapsed after its hour');
  assert.deepEqual(codes.pending(), []);
});

test('join codes: a new code for a machine replaces its old one; remove_machine drops it; bad input is refused', () => {
  const codes = new JoinCodes(scratch());
  const a = codes.create({ machineId: 'm9', tailnetName: 'm9', limits: {}, by: 'Ben' });
  const b = codes.create({ machineId: 'm9', tailnetName: 'm9', limits: {}, by: 'Ben' });
  const other = codes.create({ machineId: 'm10', tailnetName: 'm10', limits: {}, by: 'Ben' });
  assert.equal(codes.find(a.code), undefined);
  assert.equal(codes.find(b.code)?.machineId, 'm9');
  assert.equal(codes.revoke('m9'), true);
  assert.equal(codes.find(b.code), undefined);
  assert.equal(codes.find(other.code)?.machineId, 'm10', 'the other machine keeps its code');
  assert.throws(() => codes.create({ machineId: 'Bad Id', tailnetName: 'x', limits: {}, by: 'Ben' }), /machine id/);
  assert.throws(() => codes.create({ machineId: 'm11', tailnetName: 'not a name!', limits: {}, by: 'Ben' }), /tailnet name/);
  assert.throws(() => codes.create({ machineId: 'm11', tailnetName: 'm11', limits: { maxSandboxes: 9 }, by: 'Ben' }), /maxSandboxes must be a whole number from 1 to 8/);
});

test('join defaults: an editor per 16 GB over 8 and per 4 CPUs, a sandbox more, one per 60 GB free; else the installer\'s 3/2/2', () => {
  const pick = (f: Parameters<typeof defaultLimits>[0]) => {
    const { why: _why, ...l } = defaultLimits(f);
    return l;
  };
  assert.deepEqual(pick({}), { maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2 });
  assert.deepEqual(pick({ ramGB: 16, cpus: 8 }), { maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 1 });
  assert.deepEqual(pick({ ramGB: 32, cpus: 16 }), { maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 1 });
  assert.deepEqual(pick({ ramGB: 63.8, cpus: 24, freeGB: 2000 }), { maxSandboxes: 4, maxAgentsPerSandbox: 2, maxUnity: 3 }, 'LothDesktop-sized');
  assert.deepEqual(pick({ ramGB: 128, cpus: 32 }), { maxSandboxes: 5, maxAgentsPerSandbox: 2, maxUnity: 4 }, 'at most 4 editors');
  assert.deepEqual(pick({ ramGB: 128, cpus: 8 }), { maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2 }, 'CPUs cap the editors');
  assert.deepEqual(pick({ ramGB: 128, cpus: 32, freeGB: 150 }), { maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 4 }, 'disk caps the sandboxes');
  assert.deepEqual(pick({ ramGB: 8, cpus: 2, freeGB: 10 }), { maxSandboxes: 1, maxAgentsPerSandbox: 2, maxUnity: 1 }, 'never below one');
  assert.match(defaultLimits({ ramGB: 64, cpus: 24, freeGB: 900 }).why, /64 GB RAM, 24 CPUs, 900 GB free/);
});

test('join facts: only sane numbers and a known os get through', () => {
  assert.deepEqual(parseFacts({ os: 'windows', ramGB: 63.8, cpus: 24.0, freeGB: 0 }), { os: 'windows', ramGB: 63.8, cpus: 24, freeGB: 0 });
  assert.deepEqual(parseFacts({ os: 'beos', ramGB: -1, cpus: 'many', freeGB: Infinity }), {});
  assert.deepEqual(parseFacts('nope'), {});
});

test('tailscale whois: the device\'s short name, its tags and its login', () => {
  const tagged = JSON.stringify({ Node: { Name: 'desktop-coosego.tail1234.ts.net.', ComputedName: 'desktop-coosego', Tags: ['tag:fff-worker'] }, UserProfile: { LoginName: 'tagged-devices' } });
  assert.deepEqual(parseWhois(tagged), { name: 'desktop-coosego', tags: ['tag:fff-worker'], login: 'tagged-devices' });
  assert.deepEqual(parseWhois(JSON.stringify({ Node: { Name: 'Biscuit.tail1234.ts.net.' }, UserProfile: { LoginName: 'ben@example.com' } })), { name: 'biscuit', tags: [], login: 'ben@example.com' });
  assert.equal(parseWhois('not json'), undefined);
  assert.equal(parseWhois(JSON.stringify({ UserProfile: {} })), undefined);
  assert.equal(parseWhois(JSON.stringify({ Node: { Name: '' } })), undefined);
  assert.equal(tailnetShortName('M3.tail1234.ts.net.'), 'm3');
});

test('join refusal: a new id or a record waiting for its installer may join; an installed or ssh-deployed machine may not', () => {
  const records = { get: (id: string) => ({ new1: undefined, waiting: { awaitingInstall: '2026-10-20T00:00:00Z' }, installed: { root: 'D:\\ffw' }, ssh: {} })[id] };
  assert.equal(joinRefusal(records, 'new1'), undefined);
  assert.equal(joinRefusal(records, 'waiting'), undefined);
  assert.match(joinRefusal(records, 'installed')!, /already installed \(worker root D:\\ffw\): run the bootstrap on it again/);
  assert.match(joinRefusal(records, 'ssh')!, /deployed over ssh/);
});
