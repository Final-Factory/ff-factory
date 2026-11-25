// w5576 (machine/portalPin.ts, docs/portal-pin.md): the portal hosts a daemon follows. Stage 1 warns only: what pinning
// would refuse is logged, kept beside daemon.json, reported in the hello and shown by list_machines, and still happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PINNED_PORTAL_HOSTS, PORTAL_PIN_MODE, PortalPin, describePortalPin, hostOf, isPinned, notePortalRedirect, onPortalRedirect, pinnedHosts } from '../machine/portalPin.ts';

const tmpDir = (t: { after: (fn: () => unknown) => void }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-pin-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('w5576: stage 1 ships in warn mode, and every portal host in use today is pinned', () => {
  // Enforcement is its own change, after every machine has reported clean in warn mode (lothsahn, w5576).
  assert.equal(PORTAL_PIN_MODE, 'warn');
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
  assert.equal(enforce.check('dial', 'https://evil.example', 'x'), false);
  assert.match(lines.at(-1)!, /REFUSED/);
  assert.equal(enforce.check('dial', 'https://beast.tailedfcad.ts.net', 'x'), true);
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
  onPortalRedirect((from, to) => seen.push(`${from} -> ${to}`));
  t.after(() => onPortalRedirect(undefined));
  notePortalRedirect('https://fff.tailedfcad.ts.net/machine/update/x', { redirected: false, url: 'https://fff.tailedfcad.ts.net/machine/update/x' });
  notePortalRedirect('https://fff.tailedfcad.ts.net/machine/update/x', { redirected: true, url: 'https://evil.example/x' });
  assert.deepEqual(seen, ['https://fff.tailedfcad.ts.net/machine/update/x -> https://evil.example/x']);
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
