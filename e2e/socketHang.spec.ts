import { SOCKET_CONNECT_TIMEOUT_MS } from '../shared/socketPolicy.ts';
import { expect, test } from './fixtures.ts';

// w5318: on 2026-11-23 lothsahn's page went 14 min without its live socket (18:53:06 to 19:07:17Z) while the portal
// answered within seconds. Tailscale Funnel was failing, and an attempt through it can hang: it never opens and never
// closes. The page used to wait on such an attempt for as long as the browser did. Now it gives up after
// SOCKET_CONNECT_TIMEOUT_MS and tries again, and the server's log line says why (timeout) and how many tries failed.

/** Installed before the page's own scripts: the first /ws attempt hangs (a fake that never opens), the rest are real. */
function hangFirstSocket() {
  const Real = window.WebSocket;
  const w = window as unknown as { __wsUrls: string[] };
  w.__wsUrls = [];
  let hung = false;
  function Hanging(this: unknown, url: string | URL, protocols?: string | string[]) {
    const u = String(url);
    if (!/\/ws(\?|$)/.test(new URL(u).pathname + new URL(u).search)) return new Real(url, protocols);
    w.__wsUrls.push(u);
    if (hung) return new Real(url, protocols);
    hung = true;
    const fake = {
      url: u,
      readyState: 0,
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
      send() {},
      close() {
        fake.readyState = 3;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    return fake;
  }
  Object.assign(Hanging, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  (window as unknown as { WebSocket: unknown }).WebSocket = Hanging;
}

test('w5318: a socket attempt that hangs is abandoned and tried again, so the page does not stay "Connection lost"', async ({ authed: page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(hangFirstSocket);
  await page.reload();
  // The hung attempt holds the page: the banner says so after its 2.5 s grace.
  await expect(page.getByText('Connection lost.')).toBeVisible({ timeout: SOCKET_CONNECT_TIMEOUT_MS });
  // Then the page gives up on it and opens a real one: the banner goes.
  await expect(page.getByText('Connection lost.')).toBeHidden({ timeout: SOCKET_CONNECT_TIMEOUT_MS + 10_000 });
  const urls = await page.evaluate(() => (window as unknown as { __wsUrls: string[] }).__wsUrls);
  expect(urls.length).toBeGreaterThanOrEqual(2);
  const second = new URL(urls[1]).searchParams;
  expect(second.get('why')).toBe('timeout');
  expect(second.get('tries')).toBe('1');
});
