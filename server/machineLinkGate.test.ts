import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { checkMachineLink, isMachineLinkPath, machineLinkMode, resetMachineLinkWarnings } from './machineLinkGate.ts';

/** w5575 (finding 3 of the w5450 audit): the daemon link (/machine) from the tailnet only, warn first, then enforce. */

const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote }, headers }) as never;

function verdict(r: never, mode: 'off' | 'warn' | 'enforce' = 'enforce') {
  const lines: string[] = [];
  resetMachineLinkWarnings();
  return { ...checkMachineLink(r, mode, 'link /machine', (l) => lines.push(l)), lines };
}

test('w5575: a tailnet source is accepted, IPv4 and IPv6, direct or through Tailscale Serve on this machine', () => {
  for (const r of [
    req('100.101.102.103'),
    req('::ffff:100.64.0.1'),
    req('100.127.255.254'),
    req('fd7a:115c:a1e0::1234:5678'),
    req('127.0.0.1', { 'x-forwarded-for': '100.88.7.6' }),
    req('::1', { 'x-forwarded-for': 'fd7a:115c:a1e0:ab12::42' }),
    req('127.0.0.1'), // the portal host's own daemon (http://127.0.0.1:<port>, docs/beast-machine.md)
  ]) {
    const v = verdict(r);
    assert.equal(v.refuse, false, `${JSON.stringify(v)} is let in`);
    assert.deepEqual(v.lines, [], 'a tailnet source logs no refusal');
  }
});

test('w5575: a source outside the tailnet is refused under enforce', () => {
  for (const r of [
    req('198.51.100.4'),
    req('100.128.0.1'), // just past 100.64.0.0/10
    req('100.63.255.255'), // just before it
    req('2001:db8::1'),
    req('fd7a:115c:a1e1::1'), // a neighbour of fd7a:115c:a1e0::/48
    req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), // Funnel or Serve forwarding a public client
  ]) {
    const v = verdict(r);
    assert.equal(v.refuse, true, `${JSON.stringify(v)} is refused`);
    assert.match(v.lines[0], /^machine link: refused link \/machine from /);
  }
});

test('w5575: a spoofed X-Forwarded-For from outside does not get in', () => {
  // A public peer writing a tailnet address: the header from a peer that is not this machine is ignored.
  const outside = verdict(req('198.51.100.4', { 'x-forwarded-for': '100.100.100.100' }));
  assert.equal(outside.refuse, true);
  assert.equal(outside.address, '198.51.100.4');
  // Through the proxy, the client's own leftmost entry is ignored and the proxy's last one judged (w5535).
  const viaProxy = verdict(req('127.0.0.1', { 'x-forwarded-for': '100.100.100.100, 198.51.100.4' }));
  assert.equal(viaProxy.refuse, true);
  assert.equal(viaProxy.address, '198.51.100.4');
  // Tailscale Funnel's header is refused whatever address it carries.
  assert.equal(verdict(req('127.0.0.1', { 'x-forwarded-for': '100.100.100.100', 'tailscale-funnel-request': '?1' })).refuse, true);
});

test('w5575: warn lets every connection in and logs a would-be refusal once an hour; off neither checks nor logs', () => {
  const lines: string[] = [];
  resetMachineLinkWarnings();
  const outside = req('198.51.100.4');
  const t0 = Date.parse('2026-11-25T00:00:00Z');
  assert.equal(checkMachineLink(outside, 'warn', 'link /machine', (l) => lines.push(l), t0).refuse, false);
  assert.equal(checkMachineLink(outside, 'warn', 'link /machine', (l) => lines.push(l), t0 + 60_000).refuse, false);
  assert.equal(lines.length, 1, 'once per address, route and reason within the hour');
  assert.match(lines[0], /^machine link: WOULD REFUSE link \/machine from 198\.51\.100\.4 \(machineLinkTailnet is warn, let in\)/);
  checkMachineLink(outside, 'warn', 'link /machine', (l) => lines.push(l), t0 + 61 * 60_000);
  assert.equal(lines.length, 2, 'again after an hour');
  const off: string[] = [];
  assert.equal(checkMachineLink(outside, 'off', 'link /machine', (l) => off.push(l)).refuse, false);
  assert.deepEqual(off, []);
});

test('w5575: the mode and the paths', () => {
  assert.equal(machineLinkMode(undefined), 'enforce', 'unset is enforce (the warn-only rollout showed every daemon on a tailnet address)');
  assert.equal(machineLinkMode(null), 'enforce');
  assert.equal(machineLinkMode('warn'), 'warn');
  assert.equal(machineLinkMode('enforce'), 'enforce');
  assert.equal(machineLinkMode('off'), 'off');
  assert.equal(machineLinkMode('bogus'), 'warn', 'a hand-edited typo lets in, never a refusal nobody asked for');
  assert.equal(machineLinkMode('Off'), 'warn');
  for (const p of ['/machine', '/machine/live/abc', '/machine/whoami', '/machine/attachments/att_0123456789ab', '/machine/join']) assert.equal(isMachineLinkPath(p), true, p);
  for (const p of ['/machines', '/api/machines/join', '/provider', '/mcp', '/']) assert.equal(isMachineLinkPath(p), false, p);
});

test('w5575: over a real socket, the upgrade from outside is answered 403 and a tailnet one goes on', async () => {
  // The same gate index.ts puts in front of /machine, on a server on loopback (as the portal sits behind Tailscale Serve).
  const server = http.createServer((_q, s) => s.end('ok'));
  server.on('upgrade', (q, socket) => {
    if (checkMachineLink(q, 'enforce', 'link /machine', () => {}).refuse) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 418 Passed The Gate\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const ask = (xff: string) =>
    new Promise<string>((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1', () => c.write(`GET /machine HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Forwarded-For: ${xff}\r\n\r\n`));
      let got = '';
      c.on('data', (d) => (got += d));
      c.on('close', () => resolve(got.split('\r\n')[0]));
      c.on('error', reject);
    });
  try {
    assert.equal(await ask('203.0.113.9'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await ask('100.100.100.100, 203.0.113.9'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await ask('100.70.1.2'), 'HTTP/1.1 418 Passed The Gate');
    assert.equal(await ask('fd7a:115c:a1e0::9'), 'HTTP/1.1 418 Passed The Gate');
  } finally {
    server.close();
  }
});
