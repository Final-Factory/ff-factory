// The join routes over HTTP (server/machineJoinHttp.ts, w1592): tailnet-only, the code and the device decide, the
// credential is answered once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { JoinCodes, type JoinLimits, type TailnetDevice } from './machineJoin.ts';
import { machineJoinHttp, type MachineJoinDeps } from './machineJoinHttp.ts';

const FAKE_CRED = `ffm_coosego_${'FAKE'.repeat(11)}`;

async function serve(over: Partial<MachineJoinDeps> = {}, device: TailnetDevice | null = { name: 'desktop-coosego', tags: [] }) {
  const codes = new JoinCodes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoinhttp-')), 'machine-joins.json'));
  const records = new Map<string, { root?: string; awaitingInstall?: string }>();
  const enrolled: { machineId: string; tailnetName: string; limits: Required<JoinLimits>; portalUrl: string; by: string }[] = [];
  const reports: string[] = [];
  const d: MachineJoinDeps = {
    codes,
    records: { get: (id) => records.get(id) },
    whois: async () => device ?? undefined,
    enrol: (o) => {
      enrolled.push(o);
      records.set(o.machineId, { awaitingInstall: 'now' });
      return FAKE_CRED;
    },
    portalUrl: () => 'https://fff.tail1234.ts.net',
    script: (kind) => (kind === 'windows' ? "$PortalUrl = '__FF_PORTAL_URL__'\n" : undefined),
    report: (t) => reports.push(t),
    ...over,
  };
  const handle = machineJoinHttp(d);
  const server = http.createServer((req, res) => void handle(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const join = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/machine/join`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { base, join, codes, records, enrolled, reports, close: () => server.close() };
}

test('join http: Funnel and off-tailnet requests are refused before anything else', async (t) => {
  const s = await serve();
  t.after(s.close);
  const { code } = s.codes.create({ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn' });
  const funnel = await s.join({ code }, { 'tailscale-funnel-request': '?1' });
  assert.equal(funnel.status, 403);
  assert.match(String(funnel.body.error), /Funnel.*joining a machine is tailnet-only/);
  const outside = await s.join({ code }, { 'x-forwarded-for': '198.51.100.4' });
  assert.equal(outside.status, 403);
  assert.match(String(outside.body.error), /did not come from the tailnet/);
  assert.equal((await fetch(`${s.base}/join/windows.ps1`, { headers: { 'tailscale-funnel-request': '?1' } })).status, 403);
  assert.ok(s.codes.find(code), 'the code is untouched');
  assert.deepEqual(s.enrolled, []);
});

test('join http: the bootstrap is served with the portal\'s tailnet URL written in', async (t) => {
  const s = await serve();
  t.after(s.close);
  const r = await fetch(`${s.base}/join/windows.ps1`, { headers: { 'x-forwarded-for': '100.90.1.2' } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "$PortalUrl = 'https://fff.tail1234.ts.net'\n");
  assert.equal((await fetch(`${s.base}/join/unix.sh`)).status, 404, 'a portal checkout without it');
  assert.equal((await fetch(`${s.base}/join/windows.ps1`, { method: 'POST' })).status, 405);
});

test('join http: a check changes nothing; the redeem makes the record and answers the credential once', async (t) => {
  const s = await serve();
  t.after(s.close);
  const { code, last4 } = s.codes.create({ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: { maxUnity: 1 }, by: 'Lothsahn' });
  const facts = { os: 'windows', ramGB: 64, cpus: 24, freeGB: 900 };

  const c = await s.join({ code, check: true, facts });
  assert.equal(c.status, 200);
  assert.equal(c.body.machineId, 'coosego');
  assert.deepEqual(c.body.limits, { maxSandboxes: 4, maxAgentsPerSandbox: 2, maxUnity: 1 }, 'the code\'s editor limit, the rest from the PC');
  assert.equal(c.body.limitsFrom, 'code');
  assert.equal(c.body.tagged, false);
  assert.equal(c.body.existing, 'new');
  assert.equal(c.body.credential, undefined);
  assert.deepEqual(s.enrolled, []);
  assert.ok(s.codes.find(code), 'a check uses nothing up');

  const r = await s.join({ code: code.toLowerCase(), facts });
  assert.equal(r.status, 200);
  assert.equal(r.body.credential, FAKE_CRED);
  assert.equal(r.body.last4, FAKE_CRED.slice(-4));
  assert.deepEqual(s.enrolled, [{ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: { maxSandboxes: 4, maxAgentsPerSandbox: 2, maxUnity: 1 }, portalUrl: 'https://fff.tail1234.ts.net', by: 'Lothsahn' }]);
  assert.equal(s.reports.length, 1);
  assert.ok(s.reports[0].includes(`...${last4}`) && !s.reports[0].includes(FAKE_CRED), 'the report names the code by its last four, never the credential');

  const again = await s.join({ code, facts });
  assert.equal(again.status, 403, 'used up');
  assert.equal(s.enrolled.length, 1);
});

test('join http: the code works only from the device it was made for; wrong codes are throttled per address', async (t) => {
  const s = await serve({}, { name: 'someone-else', tags: [] });
  t.after(s.close);
  const { code } = s.codes.create({ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn' });
  const wrongDevice = await s.join({ code });
  assert.equal(wrongDevice.status, 403);
  assert.match(String(wrongDevice.body.error), /for the tailnet device "desktop-coosego", and this request came from "someone-else"/);
  assert.ok(s.codes.find(code), 'still there for the right PC');
  for (let i = 0; i < 9; i++) assert.equal((await s.join({ code: 'AAAAA-AAAAA-AAAAA-AAAAA' })).status, 403);
  assert.equal((await s.join({ code })).status, 429, 'ten failures in 15 minutes');
  assert.deepEqual(s.enrolled, []);
});

test('join http: no whois, an installed machine, a dry-run portal and a failed record each refuse, and keep the code', async (t) => {
  const noWhois = await serve({}, null);
  t.after(noWhois.close);
  const a = noWhois.codes.create({ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn' });
  assert.equal((await noWhois.join({ code: a.code })).status, 503);
  assert.ok(noWhois.codes.find(a.code));

  const s = await serve();
  t.after(s.close);
  const b = s.codes.create({ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn' });
  s.records.set('coosego', { root: 'D:\\ffw' });
  const installed = await s.join({ code: b.code });
  assert.equal(installed.status, 409);
  assert.match(String(installed.body.error), /already installed/);
  s.records.delete('coosego');

  const dry = await serve({ refused: () => 'this portal is a dry run' });
  t.after(dry.close);
  const c = dry.codes.create({ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn' });
  assert.equal((await dry.join({ code: c.code, check: true })).status, 200, 'a check still answers');
  assert.deepEqual(await dry.join({ code: c.code }), { status: 409, body: { error: 'this portal is a dry run' } });
  assert.ok(dry.codes.find(c.code));

  const broken = await serve({
    enrol: () => {
      throw new Error('disk full');
    },
  });
  t.after(broken.close);
  const e = broken.codes.create({ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn' });
  const r = await broken.join({ code: e.code });
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /disk full/);
  assert.ok(broken.codes.find(e.code), 'a second try may use it');
  assert.equal((await broken.join('not an object')).status, 403);
});
