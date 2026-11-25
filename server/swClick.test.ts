import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Notifier } from './notify.ts';

// The service worker's notification click (web/public/sw.js, w5537): only an in-app # link is followed, on the
// dashboard's own origin; anything else opens the dashboard root.
const ORIGIN = 'https://portal.example';

async function click(url: unknown) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const opened: string[] = [];
  const messages: unknown[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (n: string, h: (e: unknown) => void) => (handlers[n] = h),
    clients: { matchAll: async () => (self.open ? [{ url: `${ORIGIN}/`, focus: async () => {}, postMessage: (m: unknown) => messages.push(m) }] : []), openWindow: async (u: string) => opened.push(u) },
    open: false,
    registration: {},
    skipWaiting: () => {},
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8'), { self, URL, console, fetch: async () => ({}) });
  const run = async () => {
    let p: Promise<unknown> = Promise.resolve();
    handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  const closed = await (async () => {
    await run();
    const a = { opened: [...opened] };
    opened.length = 0;
    self.open = true;
    await run();
    return { ...a, messages: JSON.parse(JSON.stringify(messages)) };
  })();
  return closed;
}

test('sw click (w5537): a # link opens that page, anything else the root', async () => {
  assert.deepEqual((await click('#/agent/rev/conversation')).opened, [`${ORIGIN}/#/agent/rev/conversation`]);
  assert.deepEqual((await click('#/agent/rev/conversation')).messages, [{ type: 'navigate', hash: '#/agent/rev/conversation' }]);
  for (const bad of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', '/#/x', 'evil.example', undefined, 5]) {
    const r = await click(bad);
    assert.deepEqual(r.opened, [`${ORIGIN}/#/`], String(bad));
    assert.deepEqual(r.messages, [{ type: 'navigate', hash: '#/' }], String(bad));
  }
});

test('sw click (w5537): every URL the server puts into a push is a # link', () => {
  const src = fs.readFileSync(new URL('./notify.ts', import.meta.url), 'utf8');
  const urls = [...src.matchAll(/\burl: (`[^`]*`|'[^']*'|this\.route\([^)]*\))/g)].map((m) => m[1]);
  assert.ok(urls.length >= 10);
  for (const u of urls) assert.ok(u.startsWith('this.route') || /^[`']#/.test(u), u);
  assert.ok(typeof Notifier === 'function');
});
