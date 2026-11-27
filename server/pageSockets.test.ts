import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageSockets, fromThisMachine, readyOf, reconnectOf, viaOf } from './pageSockets.ts';

const req = (addr: string, headers: Record<string, string> = {}, url = '/ws') => ({ socket: { remoteAddress: addr }, headers, url }) as never;

test('w4723: a page socket is told apart by its way in: Funnel, tailnet, this machine or other', () => {
  assert.deepEqual(viaOf(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9', 'tailscale-funnel-request': '?1' })), { addr: '203.0.113.9', via: 'funnel' });
  assert.deepEqual(viaOf(req('127.0.0.1', { 'x-forwarded-for': '100.101.2.3' })), { addr: '100.101.2.3', via: 'tailnet' });
  assert.deepEqual(viaOf(req('::ffff:127.0.0.1')), { addr: '127.0.0.1', via: 'local' });
  assert.deepEqual(viaOf(req('192.168.1.5')), { addr: '192.168.1.5', via: 'other' });
  assert.equal(fromThisMachine(req('127.0.0.1')), true);
  assert.equal(fromThisMachine(req('127.0.0.1', { 'x-forwarded-for': '100.101.2.3' })), false, 'Tailscale Serve proxied it in');
  assert.equal(fromThisMachine(req('100.101.2.3')), false);
});

test('w4723: the reconnect reason is read from the URL, and anything odd is not echoed into the log', () => {
  assert.equal(reconnectOf('/ws?why=closed&code=1006&gap=2300'), 'why=closed pageSawCode=1006 gap=2.3s');
  assert.equal(reconnectOf('/ws?why=stale&gap=46000'), 'why=stale gap=46s');
  assert.equal(reconnectOf('/ws'), 'why=?', 'a page from before w4723');
  assert.equal(reconnectOf('/ws?why=%0Afake%20line&code=x&gap=-1'), 'why=other');
  // w5318: an attempt that hung is abandoned and says so, with how many attempts failed before the one that opened.
  assert.equal(reconnectOf('/ws?why=timeout&code=1006&gap=622900&tries=31'), 'why=timeout pageSawCode=1006 gap=622.9s tries=31');
  assert.equal(reconnectOf('/ws?why=error&tries=0'), 'why=error');
  assert.equal(reconnectOf('/ws?why=error&tries=1.5'), 'why=error');
});

test('w4723: one line per open and close, naming who closed it, and drops counted per person', () => {
  let t = 1_000_000;
  const lines: string[] = [];
  const p = new PageSockets<object>((l) => lines.push(l), () => t);
  const a = {};
  const b = {};
  const c = {};
  p.opened(a, 'lothsahn', req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9', 'tailscale-funnel-request': '?1' }, '/ws?why=first'), { ms: 12.4, bytes: 2048 });
  assert.equal(lines[0], 'page socket open: lothsahn from 203.0.113.9 via funnel, why=first, state 12ms 2KB (1 open)');
  t += 90_000;
  p.closed(a, 1006, '');
  assert.equal(lines[1], "page socket closed: lothsahn from 203.0.113.9 via funnel, code 1006, by network, open 90s; lothsahn's drops: 1 in the last hour, 1 since start");

  p.opened(b, 'lothsahn', req('127.0.0.1', { 'x-forwarded-for': '100.101.2.3' }, '/ws?why=closed&code=1006&gap=1200'));
  t += 30_000;
  p.serverClosing(b, 'ping-timeout');
  p.closed(b, 1006, '');
  assert.match(lines[3], /code 1006, by ping-timeout, open 30s; lothsahn's drops: 2 in the last hour, 2 since start$/);

  p.opened(c, 'ben', req('127.0.0.1', {}, '/ws?why=stale&gap=46000'));
  p.closed(c, 1001, 'bye\nnext');
  assert.match(lines[5], /^page socket closed: ben from 127\.0\.0\.1 via local, code 1001 "bye\?next", by page, open 0s; ben's drops: 1 in the last hour/);
  assert.equal(lines.length, 6, 'one line per event');

  p.closed(c, 1000, ''); // a second close of one socket logs nothing
  assert.equal(lines.length, 6);

  assert.deepEqual(p.health(false), { open: 0, dropsLastHour: 3, dropsSinceStart: 3 }, 'no logins for a request from outside');
  t += 3_600_001;
  assert.deepEqual(p.health(true), { open: 0, dropsLastHour: 0, dropsSinceStart: 3, byUser: { lothsahn: { lastHour: 0, sinceStart: 2 }, ben: { lastHour: 0, sinceStart: 1 } } });
});

test('w6336: the page says when its first state is on screen, and one line gives every phase of that connect', () => {
  const lines: string[] = [];
  const p = new PageSockets<object>((l) => lines.push(l), () => 0);
  const a = {};
  p.opened(a, 'lothsahn', req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9', 'tailscale-funnel-request': '?1' }, '/ws?why=first'), { ms: 1130.2, bytes: 4 * 1024 * 1024, buildMs: 980.4, jsonMs: 149.8 });
  assert.equal(lines[0], 'page socket open: lothsahn from 203.0.113.9 via funnel, why=first, state 1130ms (build 980ms json 150ms) 4096KB (1 open)');
  p.ready(a, JSON.stringify({ type: 'ready', open: 120.4, state: 1400, parse: 90, render: 210.6, load: 2300 }));
  assert.equal(lines[1], 'page socket ready: lothsahn via funnel, 1821ms: open 120ms, first state 1400ms, parse 90ms, render 211ms, server build 1130ms 4096KB; 2300ms since the page began loading');
  // Once per socket, and nothing else a page sends is logged.
  p.ready(a, JSON.stringify({ type: 'ready', open: 1, state: 1, parse: 1, render: 1 }));
  p.ready({}, JSON.stringify({ type: 'ready', open: 1, state: 1, parse: 1, render: 1 }));
  assert.equal(lines.length, 2);
});

test('w6336: a ready message is only its numbers: anything odd is dropped, not logged', () => {
  assert.deepEqual(readyOf('{"type":"ready","open":1,"state":2,"parse":3,"render":4}'), { open: 1, state: 2, parse: 3, render: 4 });
  for (const bad of ['', 'nope', '{"type":"ping"}', '{"type":"ready","open":1,"state":2,"parse":3}', '{"type":"ready","open":-1,"state":2,"parse":3,"render":4}', '{"type":"ready","open":"1\nfake line","state":2,"parse":3,"render":4}', `{"type":"ready","open":1e12,"state":2,"parse":3,"render":4}`, 'x'.repeat(600), 42])
    assert.equal(readyOf(bad), undefined, String(bad).slice(0, 40));
  // A bad `load` is left out, the rest kept.
  assert.deepEqual(readyOf('{"type":"ready","open":1,"state":2,"parse":3,"render":4,"load":"x"}'), { open: 1, state: 2, parse: 3, render: 4 });
});
