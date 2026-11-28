import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { CpuSampler, PAGE_DEFLATE, probePool, timeNextDeflate } from './connectTiming.ts';
import { PageSockets, clocksOf, handoffOf, pageAtOf, readyOf } from './pageSockets.ts';

test('w6762: the first deflate on a socket is timed, split into queue and run, and ws is put back as it was', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: { threshold: 16 * 1024, serverNoContextTakeover: true, clientNoContextTakeover: true } });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const port = (wss.address() as { port: number }).port;
  const body = JSON.stringify({ type: 'state', rows: Array.from({ length: 20_000 }, (_, i) => ({ id: `w${i}`, title: `request ${i} of many`, n: i % 97 })) });
  const got = new Promise<{ t: ReturnType<typeof timeNextDeflate>; own: boolean }>((resolve) => {
    wss.once('connection', (ws) => {
      const t = timeNextDeflate(ws);
      ws.send(body, () => {
        const ext = (ws as unknown as { _extensions: Record<string, object> })._extensions['permessage-deflate'];
        resolve({ t, own: Object.hasOwn(ext, 'compress') || Object.hasOwn(ext, '_compress') });
      });
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
  const received = new Promise<string>((r) => client.once('message', (d) => r(d.toString())));
  const { t, own } = await got;
  assert.equal(await received, body, 'the page still gets the message whole');
  assert.equal(own, false, 'the wrappers are gone after one message');
  assert.equal(t.inBytes, Buffer.byteLength(body));
  assert.ok(t.outBytes! > 0 && t.outBytes! < t.inBytes!, `deflated ${t.inBytes} to ${t.outBytes}`);
  assert.ok(t.ranMs! >= 0 && t.queuedMs! >= 0 && t.doneAt! > 0);
  assert.ok(t.chunks! >= 1, `chunks ${t.chunks}`);
  client.close();
  await new Promise<void>((r) => wss.close(() => r()));
});

test('w6762: a socket without deflate is left alone', () => {
  assert.deepEqual(timeNextDeflate({}), {});
  assert.deepEqual(timeNextDeflate({ _extensions: {} }), {});
});

test('w6762: the pool probe answers with the pool and the loop', async () => {
  const lag = await new Promise<{ poolMs: number; loopMs: number }>((r) => probePool(r));
  assert.ok(lag.poolMs >= 0 && lag.loopMs >= 0);
  const slow = await new Promise<{ poolMs: number; loopMs: number }>((r) => probePool(r, (cb) => setTimeout(cb, 30)));
  assert.ok(slow.poolMs >= 25, `poolMs ${slow.poolMs}`);
});

test('w6762: the CPU line reads the VM, steal and tailscaled from /proc', () => {
  const files: Record<string, string> = {
    '/p/stat': 'cpu  1000 0 500 8000 100 0 0 50 0 0\ncpu0 1 2 3',
    '/p/1/comm': 'systemd\n',
    '/p/77/comm': 'tailscaled\n',
    '/p/77/stat': '77 (tailscaled) S 1 77 77 0 -1 4194560 100 0 0 0 200 100 0 0 20 0 10 0',
  };
  const s = new CpuSampler({ proc: '/p', read: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(p);
      return v;
    }, list: () => ['1', '77', 'self'] });
  const a = s.sample();
  assert.equal(a.tailscaled, 300);
  files['/p/stat'] = 'cpu  1150 0 550 8040 110 0 0 60 0 0';
  files['/p/77/stat'] = '77 (tailscaled) S 1 77 77 0 -1 4194560 100 0 0 0 230 120 0 0 20 0 10 0';
  const b = { ...s.sample(), at: a.at + 1000 };
  const line = s.between(a, b);
  // 260 ticks in all, 50 idle+iowait: 81% busy; steal 10 of 260: 4%; tailscaled 50 ticks in 1 s: 50% of a core.
  assert.match(line, /^cpu\{vm 81% of \d+ cores, steal 4%, node \d+%, tailscaled 50%\}$/);
});

test('w6762: the page clock in the URL and the ready message, and the lines that set them beside the server', () => {
  assert.equal(pageAtOf('/ws?why=closed&at=1764300000000'), 1764300000000);
  for (const bad of ['/ws?at=12', '/ws?at=x', '/ws', undefined]) assert.equal(pageAtOf(bad), undefined);
  assert.deepEqual(readyOf('{"type":"ready","open":1,"state":2,"parse":3,"render":4,"openEpoch":1764300003140,"stateEpoch":1764300004300}'), { open: 1, state: 2, parse: 3, render: 4, openEpoch: 1764300003140, stateEpoch: 1764300004300 });
  assert.deepEqual(readyOf('{"type":"ready","open":1,"state":2,"parse":3,"render":4,"openEpoch":"x","stateEpoch":5}'), { open: 1, state: 2, parse: 3, render: 4 });
  const h = { pageAt: 1764300000000, arrivedAt: 1764300003100, sentAt: 1764300004100, sentMs: 1000, sentPerf: 5150, deflate: { queuedMs: 2, ranMs: 900, doneAt: 5000, inBytes: 1024 * 1024, outBytes: 160 * 1024, chunks: 11 }, pool: { poolMs: 420, loopMs: 30 }, cpu: 'cpu{node 99%}' };
  assert.equal(clocksOf(h, { open: 0, state: 0, parse: 0, render: 0, openEpoch: 1764300003140, stateEpoch: 1764300004300 }), '; clocks: upgrade in 3100ms after the page began, open seen 40ms after it, in+back 3140ms, state sent 1000ms after it, at the page 200ms after that');
  assert.equal(handoffOf(h), ' (deflate queued 2ms, ran 900ms in 11 chunks 1024KB to 160KB; kernel 150ms; pool lag 420ms, loop turn 30ms; cpu{node 99%})');
  assert.equal(handoffOf({ pool: { poolMs: 1, loopMs: 1 } }), ' (not deflated; pool lag 1ms, loop turn 1ms)');

  const lines: string[] = [];
  const p = new PageSockets<object>((l) => lines.push(l), () => 1764300003100);
  const ws = {};
  p.opened(ws, 'lothsahn', { headers: { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' }, url: '/ws?why=closed&at=1764300000000' } as never, { ms: 200, bytes: 1024 * 1024 }, { arrivedAt: 1764300003100, deflate: h.deflate });
  p.pool(ws, { poolMs: 420, loopMs: 30 });
  p.cpu(ws, 'cpu{node 99%}');
  p.sent(ws, 600, 5150);
  assert.equal(lines.length, 1, 'a fast hand-off has no sent line');
  p.ready(ws, JSON.stringify({ type: 'ready', open: 3140, state: 1160, parse: 20, render: 30, openEpoch: 1764300003140, stateEpoch: 1764300003300 }));
  assert.match(lines[1], /; clocks: upgrade in 3100ms after the page began, open seen 40ms after it, in\+back 3140ms, state sent 0ms after it, at the page 200ms after that \(deflate queued 2ms, ran 900ms in 11 chunks 1024KB to 160KB; kernel 150ms; pool lag 420ms, loop turn 30ms; cpu\{node 99%\}\)$/);
});

test('w6762: the page socket deflates a big first state in a few pool jobs, not one per 16 KB', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: { ...PAGE_DEFLATE, zlibDeflateOptions: { ...PAGE_DEFLATE.zlibDeflateOptions } } });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const port = (wss.address() as { port: number }).port;
  // Varied enough to deflate to ~1 MB from 4 MB: 60+ chunks at zlib's 16 KB default.
  const body = JSON.stringify({ type: 'state', rows: Array.from({ length: 40_000 }, (_, i) => ({ id: `w${i}`, h: (i * 2654435761).toString(36), title: `request ${i} of many ${(i * 40503) % 9973}`, n: i % 97 })) });
  const got = new Promise<ReturnType<typeof timeNextDeflate>>((resolve) => {
    wss.once('connection', (ws) => {
      const t = timeNextDeflate(ws);
      ws.send(body, () => resolve(t));
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
  const received = new Promise<string>((r) => client.once('message', (d) => r(d.toString())));
  const t = await got;
  assert.equal(await received, body, 'the page still gets the message whole');
  assert.ok(t.outBytes! > 256 * 1024, `deflated to ${t.outBytes}`);
  assert.ok(t.chunks! <= Math.ceil(t.outBytes! / (256 * 1024)) + 1, `${t.chunks} chunks for ${t.outBytes} bytes`);
  client.close();
  await new Promise<void>((r) => wss.close(() => r()));
});
