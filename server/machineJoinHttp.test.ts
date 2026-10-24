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
import { joinPage, machineJoinHttp, windowsInstaller, type MachineJoinDeps } from './machineJoinHttp.ts';

const FAKE_CRED = `ffm_coosego_${'FAKE'.repeat(11)}`;
const CMD = fs.readFileSync(new URL('../scripts/worker/join.cmd', import.meta.url), 'utf8');

async function serve(over: Partial<MachineJoinDeps> = {}, device: TailnetDevice | null = { name: 'desktop-coosego', tags: [] }) {
  const codes = new JoinCodes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ffjoinhttp-')), 'machine-joins.json'));
  const records = new Map<string, { root?: string; awaitingInstall?: string; playOnly?: string }>();
  const enrolled: { machineId: string; tailnetName: string; limits: Required<JoinLimits>; portalUrl: string; by: string; platform?: string }[] = [];
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
    script: (kind) => (kind === 'windows' ? "$PortalUrl = '__FF_PORTAL_URL__'\n" : kind === 'cmd' ? CMD : undefined),
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
  assert.equal(c.body.playOnly, false);
  assert.equal(c.body.credential, undefined);
  assert.deepEqual(s.enrolled, []);
  assert.ok(s.codes.find(code), 'a check uses nothing up');

  const r = await s.join({ code: code.toLowerCase(), facts });
  assert.equal(r.status, 200);
  assert.equal(r.body.credential, FAKE_CRED);
  assert.equal(r.body.last4, FAKE_CRED.slice(-4));
  assert.deepEqual(s.enrolled, [{ machineId: 'coosego', tailnetName: 'desktop-coosego', limits: { maxSandboxes: 4, maxAgentsPerSandbox: 2, maxUnity: 1 }, portalUrl: 'https://fff.tail1234.ts.net', by: 'Lothsahn', platform: 'win32' }], "w1603: the record says it is a Windows PC from the redeem on, not a Mac");
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

test('join http: /join is a page for the new PC with the download; the installer is the bootstrap in a double-click, CRLF, the code asked for', async (t) => {
  const s = await serve();
  t.after(s.close);
  const page = await fetch(`${s.base}/join`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const html = await page.text();
  assert.ok(html.includes('href="https://fff.tail1234.ts.net/join/windows.cmd"') && html.includes('irm https://fff.tail1234.ts.net/join/windows.ps1 | iex'), html);
  assert.equal((await fetch(`${s.base}/join`, { headers: { 'tailscale-funnel-request': '?1' } })).status, 403, 'tailnet-only, as the rest');

  const r = await fetch(`${s.base}/join/windows.cmd`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="ff-factory-join.cmd"');
  const cmd = await r.text();
  assert.ok(!/[^\r]\n/.test(cmd), 'CRLF line endings only (cmd.exe misreads LF-only batch files)');
  // w1603: downloaded to a file and run with -File, never `-Command "irm ... | iex"` (Defender's "Access is denied.").
  assert.ok(cmd.includes(`"%FF_CURL%" -fsS --connect-timeout 20 --retry 2 -o "%FF_JOIN_PS1%" "https://fff.tail1234.ts.net/join/windows.ps1"`), cmd);
  assert.ok(cmd.includes('set "FF_CURL=%SystemRoot%\\System32\\curl.exe"'), "Windows' own curl, never the first on PATH (w1758)");
  assert.ok(cmd.includes(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%FF_JOIN_PS1%"`), cmd);
  assert.doesNotMatch(cmd, /-Command/);
  assert.ok(cmd.includes('set "FF_JOIN_CODE="\r\n'), 'no code in the download anyone on the tailnet may take: the bootstrap asks');
  assert.ok(!cmd.includes('__FF_'), 'every mark filled');
});

test('join http: the dashboard\'s installer carries its code; a URL or code that could break out of the command line is refused', () => {
  const code = 'ABCDE-FGHJK-MNPQR-STVWX';
  const cmd = windowsInstaller(CMD, 'https://fff.tail1234.ts.net', code);
  assert.ok(cmd.includes(`set "FF_JOIN_CODE=${code}"\r\n`));
  assert.equal(cmd.split(code).length, 2, 'once, and only in the variable the bootstrap reads');
  assert.throws(() => windowsInstaller(CMD, "https://x' ; calc ; '"), /not a portal URL/);
  assert.throws(() => windowsInstaller(CMD, 'https://fff.tail1234.ts.net', 'A" & calc & "'), /digits, capital letters and dashes/);
  assert.ok(!joinPage('https://x"><script>alert(1)</script>').includes('<script>'), 'the page escapes what it writes in');
});

test('join http: a play-only record tells the bootstrap so, and its installer makes no Dev Drive (w1993)', async (t) => {
  const s = await serve();
  t.after(s.close);
  const { code } = s.codes.create({ machineId: 'desktop-coosego', tailnetName: 'desktop-coosego', limits: { maxSandboxes: 1, maxAgentsPerSandbox: 1, maxUnity: 1 }, by: 'lothsahn' });
  s.records.set('desktop-coosego', { awaitingInstall: 'now', playOnly: 'added play-only in the dashboard by lothsahn' });
  const c = await s.join({ code, check: true });
  assert.equal(c.status, 200);
  assert.equal(c.body.existing, 'waiting');
  assert.equal(c.body.playOnly, true);
  const join = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'worker', 'join.ps1'), 'utf8');
  assert.match(join, /if \(\$playOnly\) \{ \$a \+= @\('-NoDevDrive', '-PlayOnly'\) \}/, 'w2004: join.ps1 passes -NoDevDrive and -PlayOnly for a play-only machine');
  const install = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'worker', 'install.ps1'), 'utf8');
  assert.match(install, /if \(\$PlayOnly\) \{ \$argv \+= '--play-only' \}/, 'install.ps1 hands -PlayOnly to worker.ts');
});

test('join http: the redeem brings the person\'s vault GitHub token for the clone, never to a check or a play-only computer (w2004)', async (t) => {
  const asked: [string, string | undefined][] = [];
  const s = await serve({ githubToken: (id, person) => (asked.push([id, person]), 'ghp_FAKE_vault_token') });
  t.after(s.close);
  const { code } = s.codes.create({ machineId: 'desktop-coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn', byUser: 'lothsahn' });
  const c = await s.join({ code, check: true });
  assert.equal(c.body.githubToken, undefined, 'a check gets no token');
  const r = await s.join({ code });
  assert.equal(r.status, 200);
  assert.equal(r.body.githubToken, 'ghp_FAKE_vault_token');
  assert.deepEqual(asked, [['desktop-coosego', 'lothsahn']], "the code's person by user id");
  assert.ok(!s.reports.join(' ').includes('ghp_FAKE'), 'never in the report');

  const p = await serve({ githubToken: () => 'ghp_FAKE_vault_token' });
  t.after(p.close);
  const po = p.codes.create({ machineId: 'desktop-coosego', tailnetName: 'desktop-coosego', limits: {}, by: 'Lothsahn', byUser: 'lothsahn' });
  p.records.set('desktop-coosego', { awaitingInstall: 'now', playOnly: 'added play-only in the dashboard by lothsahn' });
  const pr = await p.join({ code: po.code });
  assert.equal(pr.status, 200);
  assert.equal(pr.body.playOnly, true);
  assert.equal(pr.body.githubToken, undefined, 'a play-only computer clones nothing');
});
