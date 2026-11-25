import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
import { PAGE_MAX_PAYLOAD } from './pageSockets.ts';

// w5527: the page's socket takes messages up to PAGE_MAX_PAYLOAD (1 MiB); a bigger one closes it with 1009.
test('w5527: a page message over 1 MiB closes the socket, a normal one passes', async () => {
  assert.equal(PAGE_MAX_PAYLOAD, 1024 * 1024);
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: PAGE_MAX_PAYLOAD });
  const got: number[] = [];
  wss.on('connection', (s) => {
    s.on('message', (d) => got.push((d as Buffer).length));
    s.on('error', () => {});
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const port = (wss.address() as { port: number }).port;
  const open = () => new Promise<WebSocket>((res, rej) => { const c = new WebSocket(`ws://127.0.0.1:${port}`); c.once('open', () => res(c)); c.once('error', rej); });
  const a = await open();
  a.send(Buffer.alloc(1000, 1));
  a.send(Buffer.alloc(PAGE_MAX_PAYLOAD, 1));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(got, [1000, PAGE_MAX_PAYLOAD]);
  assert.equal(a.readyState, WebSocket.OPEN);
  const code = new Promise<number>((r) => a.once('close', (c) => r(c)));
  a.send(Buffer.alloc(PAGE_MAX_PAYLOAD + 1, 1));
  assert.equal(await code, 1009);
  assert.deepEqual(got, [1000, PAGE_MAX_PAYLOAD], 'the oversized message was never delivered');
  const b = await open(); // a reconnect works at once
  b.close();
  wss.close();
});

test('w5527: the page server in index.ts sets the cap', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(src, /const wss = new WebSocketServer\(\{ noServer: true, maxPayload: PAGE_MAX_PAYLOAD,/);
});
