import { appState, asLogin, expect, sendMessage, test, uniq } from './fixtures.ts';

// The app page's Content-Security-Policy (w5518, server/webStatic.ts appCsp). Every `authed` test already fails on a CSP
// refusal (e2e/fixtures.ts); these check the headers themselves, and the one refusal that is meant: a remote image.

test('the app page and /login carry the CSP, nosniff and no framing', async ({ request }) => {
  for (const p of ['/', '/login']) {
    const r = await request.get(p);
    expect(r.ok(), p).toBeTruthy();
    const csp = r.headers()['content-security-policy'] ?? '';
    expect(csp, p).toContain("script-src 'self';");
    expect(csp, p).toContain("frame-ancestors 'none'");
    expect(csp, p).toContain("object-src 'none'");
    expect(csp, p).not.toMatch(/script-src[^;]*unsafe/);
    expect(r.headers()['x-content-type-options'], p).toBe('nosniff');
  }
  // An API answer too.
  expect((await request.get('/api/health')).headers()['x-content-type-options']).toBe('nosniff');
});

// Its own login (e2e/server.ts, cspcheck): the owner's chat is on every other test's page, which fails on this refusal.
const asCspCheck = asLogin('cspcheck', 'e2e-password-357');

asCspCheck('a remote image in agent text no longer loads; the page and its socket go on working', async ({ solo: page }) => {
  const refused: string[] = [];
  page.on('console', (m) => {
    if (/Content[ -]Security[ -]Policy/i.test(m.text())) refused.push(m.text());
  });
  const tag = uniq('remoteimg');
  const app = await appState(page.request);
  await sendMessage(page.request, app.orchestratorId!, `remote ![far](https://example.com/far.png) ${tag}`);
  // The reply arrives over the page's socket: the socket works under connect-src.
  await expect(page.locator('.orch .msg-assistant', { hasText: tag })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => refused.some((t) => t.includes('example.com')), { message: 'the browser refused the remote image', timeout: 10_000 }).toBe(true);
  // That refusal is the expected one; nothing else may be.
  expect(refused.filter((t) => !t.includes('example.com'))).toEqual([]);
});
