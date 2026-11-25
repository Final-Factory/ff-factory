// w5576/w5715 (machine/portalPin.ts, docs/portal-pin.md): the portal hosts a daemon follows. Stage 1 warned only; stage 2
// (w5715) enforces: a relocate or a fetch redirect to an unpinned host is refused, and a dial of the daemon's own
// portalUrl or previousPortalUrl never is (logged, kept, reported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PINNED_PORTAL_HOSTS, PORTAL_PIN_MODE, PortalPin, describePortalPin, hostOf, isPinned, notePortalRedirect, onPortalRedirect, pinnedHosts, refusedRedirect } from '../machine/portalPin.ts';
import { downloadBundle } from '../machine/selfUpdate.ts';

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

test('w5576: a fetch that came through a redirect is reported; a direct one is not', (t) => {
  const seen: string[] = [];
  onPortalRedirect((from, to) => void seen.push(`${from} -> ${to}`));
  t.after(() => onPortalRedirect(undefined));
  assert.equal(notePortalRedirect('https://fff.tailedfcad.ts.net/machine/update/x', { redirected: false, url: 'https://fff.tailedfcad.ts.net/machine/update/x' }), true);
  assert.equal(notePortalRedirect('https://fff.tailedfcad.ts.net/machine/update/x', { redirected: true, url: 'https://evil.example/x' }), true, 'a sink that answers nothing refuses nothing');
  assert.deepEqual(seen, ['https://fff.tailedfcad.ts.net/machine/update/x -> https://evil.example/x']);
});

test('w5715: enforce mode refuses a fetch a redirect took to an unpinned host, and uses one to a pinned host', (t) => {
  const lines: string[] = [];
  const pin = new PortalPin(pinnedHosts(), undefined, (l) => lines.push(l), 'enforce');
  // As the daemon wires it (machine/daemon.ts constructor).
  onPortalRedirect((from, to) => pin.check('redirect', to, `the portal redirected ${hostOf(from) ?? from} to ${to}`));
  t.after(() => onPortalRedirect(undefined));
  const u = 'https://fff.tailedfcad.ts.net/machine/update/x';
  assert.equal(notePortalRedirect(u, { redirected: true, url: 'https://evil.example/x' }), false);
  assert.match(lines.at(-1)!, /REFUSED: the portal redirected fff\.tailedfcad\.ts\.net to https:\/\/evil\.example\/x/);
  assert.equal(notePortalRedirect(u, { redirected: true, url: 'https://beast.tailedfcad.ts.net/machine/update/x' }), true, 'within the pinned hosts');
  assert.equal(notePortalRedirect(u, { redirected: false, url: u }), true);
  assert.match(refusedRedirect(u, { url: 'https://evil.example/x' }).message, /redirect to evil\.example, not a pinned portal host \(w5715/);
});

test('w5715: an unpinned redirect fails that one update bundle download at once, keeping nothing; a pinned one downloads', async (t) => {
  const dir = tmpDir(t);
  const pin = new PortalPin(pinnedHosts(), undefined, () => undefined, 'enforce');
  onPortalRedirect((from, to) => pin.check('redirect', to, `the portal redirected ${from} to ${to}`));
  t.after(() => onPortalRedirect(undefined));
  const body = Buffer.from('bundle bytes');
  let calls = 0;
  const mk = (finalUrl: string): typeof fetch => (async (u: string | URL) => {
    calls++;
    const r = new Response(body, { status: 200 });
    Object.defineProperty(r, 'redirected', { value: finalUrl !== String(u) });
    Object.defineProperty(r, 'url', { value: finalUrl });
    return r;
  }) as unknown as typeof fetch;
  const b = { sha256: createHash('sha256').update(body).digest('hex'), size: body.length };
  const portal = 'https://fff.tailedfcad.ts.net';
  const url = `${portal}/machine/update/${b.sha256}`;
  await assert.rejects(downloadBundle(portal, 'tok', b, path.join(dir, 'a'), mk('https://evil.example/b')), /not a pinned portal host \(w5715/);
  assert.equal(calls, 1, 'refused at once, not retried within the attempt');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'a')), [], 'nothing of the unpinned answer kept');
  const got = await downloadBundle(portal, 'tok', b, path.join(dir, 'b'), mk(url.replace('fff.', 'beast.')));
  assert.equal(fs.readFileSync(got, 'utf8'), 'bundle bytes');
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
