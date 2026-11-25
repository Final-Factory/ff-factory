import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress, configureClientAddress, isLoopback, plainAddress, untrustedProxied } from './clientAddress.ts';
import { tailnetOnly } from './remoteChat.ts';
import { viaOf } from './pageSockets.ts';
import { Auth } from './auth.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** w5535 (finding 27 of the w5452 audit): one rule for the client address, the last X-Forwarded-For entry from a trusted proxy only. */

const req = (remote: string, headers: Record<string, string | string[]> = {}) => ({ socket: { remoteAddress: remote }, headers }) as never;

function withConfig(trustProxy: boolean, proxies: string[], fn: () => void) {
  configureClientAddress({ trustProxy: () => trustProxy, proxies: () => proxies });
  try {
    fn();
  } finally {
    configureClientAddress({ trustProxy: () => true });
  }
}

test('w5535: a spoofed leftmost X-Forwarded-For entry is never the address; the proxy-added last one is', () => {
  // The client wrote a tailnet address in front; the proxy appended the address it really saw.
  const spoof = req('127.0.0.1', { 'x-forwarded-for': '100.90.1.2, 198.51.100.4' });
  assert.equal(clientAddress(spoof), '198.51.100.4');
  assert.match(tailnetOnly(spoof)!, /tailnet/, 'a spoofed tailnet address does not pass the tailnet-only check');
  assert.deepEqual(viaOf(spoof), { addr: '198.51.100.4', via: 'other' });
  const auth = new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-auth-')), { trustProxy: true });
  assert.equal(auth.clientIp(spoof as never), '198.51.100.4', 'the login throttle counts the real address, not the one the client picked');
  // Several headers are one list; the last entry of the last header wins.
  assert.equal(clientAddress(req('::1', { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2, 203.0.113.5'] })), '203.0.113.5');
  assert.equal(clientAddress(req('127.0.0.1', { 'x-forwarded-for': '100.90.1.2, ' })), '127.0.0.1', 'an empty last entry falls back to the connection');
});

test('w5535: a trusted proxy (this machine, or a configured one) is believed, with trustProxy on', () => {
  assert.equal(clientAddress(req('127.0.0.1', { 'x-forwarded-for': '100.90.1.2' })), '100.90.1.2');
  assert.equal(clientAddress(req('::ffff:127.0.0.1', { 'x-forwarded-for': '::ffff:100.90.1.2' })), '100.90.1.2');
  assert.equal(clientAddress(req('::1', { 'x-forwarded-for': '2001:db8::7' })), '2001:db8::7');
  assert.equal(tailnetOnly(req('127.0.0.1', { 'x-forwarded-for': '100.90.1.2' })), undefined, 'a tailnet browser through Tailscale Serve');
  withConfig(true, ['10.0.0.5'], () => {
    assert.equal(clientAddress(req('10.0.0.5', { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9', 'a configured proxy');
    assert.equal(clientAddress(req('10.0.0.6', { 'x-forwarded-for': '203.0.113.9' })), '10.0.0.6', 'its neighbour is not one');
  });
  assert.equal(clientAddress(req('127.0.0.1')), '127.0.0.1', 'this machine with no proxy header is itself');
});

test('w5535: an untrusted source is judged by its own address, and trustProxy off believes no header', () => {
  for (const remote of ['203.0.113.7', '100.90.1.2', '192.168.1.5', '::ffff:10.0.0.6']) {
    assert.equal(clientAddress(req(remote, { 'x-forwarded-for': '127.0.0.1' })), plainAddress(remote), remote);
  }
  assert.match(tailnetOnly(req('203.0.113.7', { 'x-forwarded-for': '100.90.1.2' }))!, /tailnet/);
  assert.equal(tailnetOnly(req('100.90.1.2', { 'x-forwarded-for': '8.8.8.8' })), undefined);
  withConfig(false, ['10.0.0.5'], () => {
    const proxied = req('127.0.0.1', { 'x-forwarded-for': '100.90.1.2' });
    assert.equal(clientAddress(proxied), '127.0.0.1');
    assert.equal(clientAddress(req('10.0.0.5', { 'x-forwarded-for': '203.0.113.9' })), '10.0.0.5');
    assert.equal(untrustedProxied(proxied), true);
    assert.match(tailnetOnly(proxied)!, /does not trust/, 'a proxied request is not let in as this machine when the proxy is not believed');
    assert.equal(tailnetOnly(req('127.0.0.1')), undefined, 'this machine itself still is');
  });
  const strict = new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-auth-')), { trustProxy: false });
  assert.equal(strict.clientIp(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.1' }) as never), '127.0.0.1', "an Auth's own trustProxy wins");
});

test('w5535: the Funnel header is checked first, whatever the address says', () => {
  const funnel = req('127.0.0.1', { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '100.90.1.2' });
  assert.match(tailnetOnly(funnel)!, /Funnel/);
  assert.equal(viaOf(funnel).via, 'funnel');
  withConfig(false, [], () => assert.match(tailnetOnly(funnel)!, /Funnel/, 'with trustProxy off too'));
});

test('w5535: loopback and plain addresses', () => {
  for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '[::1]']) assert.equal(isLoopback(a), true, a);
  for (const a of ['128.0.0.1', '::2', '100.90.1.2', '', '127.0.0.1.evil']) assert.equal(isLoopback(a), false, a);
  assert.equal(plainAddress(' ::FFFF:203.0.113.1 '), '203.0.113.1');
  assert.equal(plainAddress('::ffff:abcd'), '::ffff:abcd', 'only an IPv4-mapped tail loses its prefix');
});
