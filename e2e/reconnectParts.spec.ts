import { appState, expect, go, patchWork, test, uniq, useTool } from './fixtures.ts';
import type { AppState } from '../shared/types.ts';

// w6336: a reconnecting page sends a hash of each part of its state it holds (shared/pageParts.ts), and the server leaves
// out the parts and requests that are unchanged. A request changed while the page was offline (its live event lost
// with the socket) is sent again, an unchanged one is not, and the page then shows what a fresh load shows.

/** Before the page's scripts: every /ws socket and its first message are kept, and while `__hold` attempts fail at once. */
function watchSockets() {
  const Real = window.WebSocket;
  const w = window as unknown as { __socks: WebSocket[]; __urls: string[]; __first: string[]; __sent: string[]; __hold: boolean };
  w.__socks = [];
  w.__sent = [];
  w.__urls = [];
  w.__first = [];
  w.__hold = false;
  function Watched(this: unknown, url: string | URL, protocols?: string | string[]) {
    const u = String(url);
    if (new URL(u).pathname !== '/ws') return new Real(url, protocols);
    if (w.__hold) return new Real('ws://127.0.0.1:9/ws');
    const s = new Real(url, protocols);
    w.__socks.push(s);
    w.__urls.push(u);
    const send = s.send.bind(s);
    s.send = (d: string) => {
      w.__sent.push(String(d));
      send(d);
    };
    s.addEventListener('message', (m) => {
      const d = String(m.data);
      if (d.startsWith('{"type":"state"') && w.__first.length < w.__socks.length) w.__first.push(d);
    });
    return s;
  }
  Object.assign(Watched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  (window as unknown as { WebSocket: unknown }).WebSocket = Watched;
}

test('w6336: a reconnect resends only what changed while the page was away, and shows what a fresh load shows', async ({ authed: page }) => {
  test.setTimeout(90_000);
  const tag = uniq('parts');
  const me = await appState(page.request);
  const idOf = (s: string) => s.match(/Filed (w\d+)/)![1];
  const kept = idOf(await useTool(page.request, me.orchestratorId, 'request_work', { title: `Kept as it was ${tag}`, brief: `Unchanged ${tag}.` }));
  const edited = idOf(await useTool(page.request, me.orchestratorId, 'request_work', { title: `Edited offline ${tag}`, brief: `Changed ${tag}.` }));

  await page.addInitScript(watchSockets);
  await page.reload();
  await go(page, '#/dispatcher');
  const panel = page.locator('.dispatcher-panel');
  await expect(panel.getByTestId(`work-${edited}`)).toContainText(`Edited offline ${tag}`);
  await expect(panel.getByTestId(`work-${kept}`)).toContainText(`Kept as it was ${tag}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __first: string[] }).__first.length)).toBe(1);
  // Once its first state is drawn, the page tells the server each phase of the connect (server/pageSockets.ts ready).
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent.filter((d) => d.includes('"type":"ready"')).length)).toBe(1);
  const ready = JSON.parse(await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent[0])) as Record<string, number>;
  for (const k of ['open', 'state', 'parse', 'render', 'load']) expect(ready[k], k).toBeGreaterThanOrEqual(0);

  // Offline: the socket drops, attempts fail, and the request changes meanwhile (its event goes nowhere).
  await page.evaluate(() => {
    const w = window as unknown as { __socks: WebSocket[]; __hold: boolean };
    w.__hold = true;
    w.__socks.at(-1)!.close();
  });
  await patchWork(page.request, edited, { title: `Edited offline, now renamed ${tag}` });
  await page.evaluate(() => {
    (window as unknown as { __hold: boolean }).__hold = false;
  });

  await expect(panel.getByTestId(`work-${edited}`)).toContainText(`now renamed ${tag}`, { timeout: 20_000 });
  await expect(panel.getByTestId(`work-${kept}`)).toContainText(`Kept as it was ${tag}`);
  const { urls, first } = await page.evaluate(() => {
    const w = window as unknown as { __urls: string[]; __first: string[] };
    return { urls: w.__urls, first: w.__first };
  });
  expect(first.length).toBe(2);
  const parts = new URL(urls[1]).searchParams.get('parts') ?? '';
  expect(parts).toContain(`${kept}=`);
  expect(parts).toContain(`${edited}=`);
  const again = (JSON.parse(first[1]) as { state: AppState }).state;
  expect(again.workDelta?.ids).toEqual(expect.arrayContaining([kept, edited]));
  expect(again.work?.map((w) => w.id)).toContain(edited);
  expect(again.work?.map((w) => w.id)).not.toContain(kept);
  expect(again.partsKept?.length).toBeGreaterThan(0);
  expect(first[1].length).toBeLessThan(first[0].length);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent.filter((d) => d.includes('"type":"ready"')).length)).toBe(2);

  // The same as a fresh load: the page's requests, in order, match the server's whole state.
  const rows = async () => (await panel.locator('[data-testid^="work-w"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).filter((t, i, a) => a.indexOf(t) === i);
  const afterReconnect = await rows();
  await page.reload();
  await go(page, '#/dispatcher');
  await expect(panel.getByTestId(`work-${edited}`)).toContainText(`now renamed ${tag}`);
  await expect.poll(rows).toEqual(afterReconnect);
});
