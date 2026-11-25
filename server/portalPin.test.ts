// w5576/w5715 (machine/portalPin.ts, docs/portal-pin.md): the portal hosts a daemon follows. Stage 1 warned only; stage 2
// (w5715) enforces: a relocate, or a review or attachment fetch's redirect, to an unpinned host is refused (an update
// bundle's redirect is only reported), and a dial of the daemon's own
// portalUrl or previousPortalUrl never is (logged, kept, reported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PINNED_PORTAL_HOSTS, PORTAL_PIN_MODE, PortalPin, describePortalPin, hostOf, isPinned, onPortalRedirect, pinnedHosts, portalFetch } from '../machine/portalPin.ts';
import { downloadBundle } from '../machine/selfUpdate.ts';
import { sendChunks } from '../machine/review.ts';

const tmpDir = (t: { after: (fn: () => unknown) => void }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-pin-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('w5715: stage 2 ships in enforce mode, and every portal host in use today is pinned', () => {
  // Enforcement is its own change, after every machine reported clean in warn mode (lothsahn, w5576).
  assert.equal(PORTAL_PIN_MODE, 'enforce');
  // The VM (every machine dials it now) and BEAST, the rollback (docs/portal-on-ffbox-host.md).
  for (const url of ['https://fff.tailedfcad.ts.net', 'https://beast.tailedfcad.ts.net', 'https://FFF.tailedfcad.ts.net:443']) assert.ok(isPinned(url, pinnedHosts()), url);
  // The machine itself: the portal's own host dials loopback, and so do the tests.
  for (const url of ['http://127.0.0.1:8790', 'http://localhost:1', 'http://[::1]:2']) assert.ok(isPinned(url, pinnedHosts()), url);
});

test('w5715 (w5726 nits): a pinnedPortalHosts entry as a URL or host:port, and a trailing-dot host, all match', () => {
  const hosts = pinnedHosts(['https://New.Example:8443/x', 'other.example:8790', ' plain.example ', '', 7, 'http://']);
  for (const h of ['new.example', 'other.example', 'plain.example']) assert.ok(hosts.includes(h), h);
  assert.ok(!hosts.includes(''), 'nothing empty');
  for (const url of ['https://new.example', 'http://other.example:1', 'https://plain.example.', 'https://fff.tailedfcad.ts.net.']) assert.ok(isPinned(url, hosts), url);
  assert.equal(hostOf('https://fff.tailedfcad.ts.net./x'), 'fff.tailedfcad.ts.net');
});

test('w5576: what is not pinned, and daemon.json adding hosts', () => {
  const hosts = pinnedHosts();
  for (const url of ['https://evil.example', 'https://fff.tailedfcad.ts.net.evil.example', 'https://tailedfcad.ts.net', 'http://127.0.0.2', 'not a url', '']) assert.equal(isPinned(url, hosts), false, url);
  const more = pinnedHosts([' New.Portal.ts.net ', 7, '', null]);
  assert.ok(isPinned('https://new.portal.ts.net', more));
  assert.deepEqual(more.slice(0, PINNED_PORTAL_HOSTS.length), [...PINNED_PORTAL_HOSTS]);
  assert.equal(pinnedHosts('fff.tailedfcad.ts.net').length, PINNED_PORTAL_HOSTS.length, 'a string, not a list: ignored');
  assert.equal(hostOf('https://A.B:9/x'), 'a.b');
});

test('w5576: warn mode lets an unpinned host through, logs it and keeps it across a restart; enforce refuses it', (t) => {
  const dir = tmpDir(t);
  const file = PortalPin.fileFor(path.join(dir, 'daemon.json'))!;
  const lines: string[] = [];
  const pin = new PortalPin(pinnedHosts(), file, (l) => lines.push(l), 'warn');
  assert.equal(pin.check('relocate', 'https://fff.tailedfcad.ts.net', 'a relocate'), true);
  assert.equal(lines.length, 0, 'a pinned host says nothing');
  assert.equal(pin.check('relocate', 'https://evil.example', 'a relocate'), true, 'warn mode: it goes ahead');
  assert.match(lines[0], /w5576, warn.*would refuse.*evil\.example is not a pinned portal host/);
  const again = new PortalPin(pinnedHosts(), file, () => undefined, 'warn');
  const st = again.status('https://fff.tailedfcad.ts.net');
  assert.equal(st.pinned, true);
  assert.equal(st.warnings.length, 1, 'kept in portal-pin.json across a restart');
  assert.equal(st.warnings[0].kind, 'relocate');
  const enforce = new PortalPin(pinnedHosts(), undefined, (l) => lines.push(l), 'enforce');
  assert.equal(enforce.check('relocate', 'https://evil.example', 'x'), false);
  assert.match(lines.at(-1)!, /w5576, enforce\): REFUSED: x: evil\.example is not a pinned portal host/);
  assert.equal(enforce.check('redirect', 'https://evil.example/u', 'x'), false);
  assert.match(lines.at(-1)!, /REFUSED/);
  assert.equal(enforce.check('relocate', 'https://beast.tailedfcad.ts.net', 'x'), true);
});

test('w5715: enforce mode never refuses a dial: an unpinned portalUrl is dialled, logged and kept (no lockout)', () => {
  const lines: string[] = [];
  const pin = new PortalPin(pinnedHosts(), undefined, (l) => lines.push(l), 'enforce');
  assert.equal(pin.check('dial', 'https://hand-set-portal.example', 'the portal URL in daemon.json'), true);
  assert.match(lines.at(-1)!, /w5576, enforce\): dialled anyway, a dial is never refused: the portal URL in daemon\.json: hand-set-portal\.example/);
  assert.doesNotMatch(lines.at(-1)!, /REFUSED/);
  assert.equal(pin.status('https://hand-set-portal.example').warnings[0].kind, 'dial');
  assert.equal(pin.status('https://hand-set-portal.example').pinned, false);
});

test('w5576: a warning file that cannot be read or written never stops a daemon; at most 20 warnings are kept', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'portal-pin.json');
  fs.writeFileSync(file, '{ not json');
  const pin = new PortalPin(pinnedHosts(), file, () => undefined, 'warn');
  for (let i = 0; i < 25; i++) pin.check('dial', `https://h${i}.example`, 'x');
  assert.equal(pin.status('https://h0.example').warnings.length, 20);
  assert.match(pin.status('https://h0.example').warnings.at(-1)!.what, /h24\.example/);
  const lines: string[] = [];
  const blocked = new PortalPin(pinnedHosts(), path.join(dir, 'no-such-dir', 'portal-pin.json'), (l) => lines.push(l), 'warn');
  assert.equal(blocked.check('dial', 'https://evil.example', 'x'), true);
  assert.match(lines.at(-1)!, /could not keep the warning/);
});

// A fake portal for portalFetch: each URL answers a redirect (to its Location) or a body; every request is recorded.
const fakeFetch = (routes: Record<string, { status: number; location?: string; body?: string | Buffer }>, seen: { url: string; method: string; auth: string | null; body: boolean }[]) =>
  (async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    seen.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: init?.body != null });
    assert.equal(init?.redirect, 'manual', 'portalFetch follows redirects itself');
    const r = routes[url.replace(/\?.*$/, '')];
    if (!r) return new Response('no route', { status: 404 });
    return new Response((r.body ?? null) as BodyInit | null, { status: r.status, headers: r.location ? { location: r.location } : {} });
  }) as unknown as typeof fetch;

test('w5715 (w5726 finding 3): a redirect to an unpinned host is refused before it is followed; nothing is sent there', async (t) => {
  const lines: string[] = [];
  const pin = new PortalPin(pinnedHosts(), undefined, (l) => lines.push(l), 'enforce');
  // As the daemon wires it (machine/daemon.ts constructor).
  onPortalRedirect((from, to, refusable) => pin.redirect(from, to, refusable));
  t.after(() => onPortalRedirect(undefined));
  const seen: Parameters<typeof fakeFetch>[1] = [];
  const u = 'https://fff.tailedfcad.ts.net/machine/attachments/x';
  const f = fakeFetch({ [u]: { status: 307, location: 'https://evil.example/x' }, 'https://evil.example/x': { status: 200, body: 'stolen' } }, seen);
  const e = await portalFetch(u, { method: 'PUT', headers: { authorization: 'Bearer tok' }, body: 'data' }, { fetch: f }).then(() => undefined, (x: Error & { final?: boolean }) => x);
  assert.ok(e, 'refused');
  assert.equal(e.final, true, 'final: trying again would be refused again');
  assert.match(e.message, /redirect to evil\.example, not a pinned portal host \(w5715/);
  assert.deepEqual(seen.map((s) => s.url), [u], 'the unpinned host never got a request');
  assert.match(lines.at(-1)!, /REFUSED: the portal redirected fff\.tailedfcad\.ts\.net to https:\/\/evil\.example\/x/);
});

test('w5715: a redirect within the pinned hosts is followed, the token only to the same host; a 303 becomes a GET', async (t) => {
  const pin = new PortalPin(pinnedHosts(), undefined, () => undefined, 'enforce');
  onPortalRedirect((from, to, refusable) => pin.redirect(from, to, refusable));
  t.after(() => onPortalRedirect(undefined));
  const seen: Parameters<typeof fakeFetch>[1] = [];
  const u = 'https://fff.tailedfcad.ts.net/a';
  const f = fakeFetch({ [u]: { status: 302, location: '/b' }, 'https://fff.tailedfcad.ts.net/b': { status: 303, location: 'https://beast.tailedfcad.ts.net/c' }, 'https://beast.tailedfcad.ts.net/c': { status: 200, body: 'ok' } }, seen);
  const res = await portalFetch(u, { method: 'PUT', headers: { authorization: 'Bearer tok' }, body: 'data' }, { fetch: f });
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(seen.map((s) => [s.url, s.method, s.auth, s.body]), [
    [u, 'PUT', 'Bearer tok', true],
    ['https://fff.tailedfcad.ts.net/b', 'PUT', 'Bearer tok', true],
    ['https://beast.tailedfcad.ts.net/c', 'GET', null, false],
  ]);
});

test('w5715 (w5726 finding 2): a daemon whose portalUrl is not pinned (recovery route 2(b)) follows a redirect within that host', async (t) => {
  const lines: string[] = [];
  const pin = new PortalPin(pinnedHosts(), undefined, (l) => lines.push(l), 'enforce');
  onPortalRedirect((from, to, refusable) => pin.redirect(from, to, refusable));
  t.after(() => onPortalRedirect(undefined));
  const seen: Parameters<typeof fakeFetch>[1] = [];
  const u = 'http://10.1.0.100:8790/machine/review/r';
  const f = fakeFetch({ [u]: { status: 308, location: 'https://10.1.0.100/machine/review/r' }, 'https://10.1.0.100/machine/review/r': { status: 200, body: '{}' } }, seen);
  const res = await portalFetch(u, { headers: { authorization: 'Bearer tok' } }, { fetch: f });
  assert.equal(res.status, 200);
  assert.equal(seen[1].auth, 'Bearer tok', 'the same host keeps the token');
  assert.deepEqual(lines, [], 'nothing to warn about: the host it dials');
});

test('w5715 (w5726 finding 2): an update bundle follows even an unpinned redirect, reported only; its SHA-256 decides', async (t) => {
  const dir = tmpDir(t);
  const lines: string[] = [];
  const pin = new PortalPin(pinnedHosts(), undefined, (l) => lines.push(l), 'enforce');
  onPortalRedirect((from, to, refusable) => pin.redirect(from, to, refusable));
  t.after(() => onPortalRedirect(undefined));
  const body = Buffer.from('bundle bytes');
  const b = { sha256: createHash('sha256').update(body).digest('hex'), size: body.length };
  const portal = 'https://fff.tailedfcad.ts.net';
  const url = `${portal}/machine/update/${b.sha256}`;
  const seen: Parameters<typeof fakeFetch>[1] = [];
  const got = await downloadBundle(portal, 'tok', b, path.join(dir, 'a'), fakeFetch({ [url]: { status: 302, location: 'https://cdn.example/b' }, 'https://cdn.example/b': { status: 200, body } }, seen));
  assert.equal(fs.readFileSync(got, 'utf8'), 'bundle bytes');
  assert.equal(seen[1].auth, null, 'no token to another host');
  assert.match(lines.at(-1)!, /portal pin \(w5576, enforce\): followed, an update download is never refused: the portal redirected fff\.tailedfcad\.ts\.net to https:\/\/cdn\.example\/b/);
  // A redirected bundle that is not the one the link named installs nothing.
  await assert.rejects(downloadBundle(portal, 'tok', b, path.join(dir, 'b'), fakeFetch({ [url]: { status: 302, location: 'https://cdn.example/b' }, 'https://cdn.example/b': { status: 200, body: Buffer.from('bundle bytez') } }, [])));
});

test('w5715 (w5726 finding 3): a review upload redirected to an unpinned host is refused once, not retried, and its chunk never goes there', async (t) => {
  const dir = tmpDir(t);
  const pin = new PortalPin(pinnedHosts(), undefined, () => undefined, 'enforce');
  onPortalRedirect((from, to, refusable) => pin.redirect(from, to, refusable));
  t.after(() => onPortalRedirect(undefined));
  const file = path.join(dir, 'still.png');
  fs.writeFileSync(file, 'png bytes');
  const seen: Parameters<typeof fakeFetch>[1] = [];
  const u = 'https://fff.tailedfcad.ts.net/machine/review/r1';
  const f = fakeFetch({ [u]: { status: 307, location: 'https://evil.example/r1' } }, seen);
  await assert.rejects(sendChunks(u, 'tok', file, 9, undefined, { fetch: f, tries: 4, backoffMs: 1 }, () => true), /still\.png: .*not a pinned portal host \(w5715/);
  assert.deepEqual(seen.map((s) => s.url), [`${u}?offset=0`], 'one try, and nothing to evil.example');
});

test('w5576: list_machines says the mode, the host and the newest warnings; an older daemon says it reports none', () => {
  assert.match(describePortalPin(undefined), /not reported \(a daemon from before w5576\)/);
  assert.equal(describePortalPin({ mode: 'warn', host: 'fff.tailedfcad.ts.net', pinned: true, hosts: ['fff.tailedfcad.ts.net', 'beast.tailedfcad.ts.net'], warnings: [] }), 'portal pin (w5576): warn mode; dials fff.tailedfcad.ts.net (pinned); follows fff.tailedfcad.ts.net, beast.tailedfcad.ts.net; no warnings');
  const w = (i: number) => ({ at: `2026-11-25T00:0${i}:00Z`, kind: 'relocate' as const, what: `w${i}` });
  const line = describePortalPin({ mode: 'warn', host: 'x.example', pinned: false, hosts: [], warnings: [w(1), w(2), w(3), w(4)] });
  assert.match(line, /dials x\.example \(NOT pinned\); 4 warnings kept, newest first: 2026-11-25T00:04:00Z relocate: w4 \| .*w3 \| .*w2$/);
});

test('w5576 (w5620 review): a malformed hello from one daemon never throws in list_machines', () => {
  const odd = { mode: 'warn', host: 'fff.tailedfcad.ts.net', pinned: true, hosts: ['fff.tailedfcad.ts.net', 7, null], warnings: [null, 3, 'x', { at: 't', kind: 'dial', what: 'w' }] } as never;
  const line = describePortalPin(odd);
  assert.match(line, /follows fff\.tailedfcad\.ts\.net; 1 warning kept, newest first: t dial: w$/);
  assert.doesNotThrow(() => describePortalPin({ mode: 'warn', host: 'h', pinned: false, hosts: 'nope', warnings: 'nope' } as never));
});
