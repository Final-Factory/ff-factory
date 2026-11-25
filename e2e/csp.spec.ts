import { expect, test } from './fixtures.ts';

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

// A remote image in agent text is an <img> with a remote src (Markdown.tsx): the page's CSP refuses it. Checked on /login, the
// same page and policy, with the plain `page` fixture: on a signed-in page this refusal would fail the fixture, and a chat
// message carrying it would reach every other test's page through the shared orchestrator. No new login either: a login of
// its own needs a vault token, which changes the account list meters.spec and provider.spec's screenshot count on.
test('a remote image no longer loads on the app page; its own stills and data: images do', async ({ page }) => {
  await page.goto('/login');
  const got = await page.evaluate(async () => {
    const refused: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => refused.push(`${e.violatedDirective} ${e.blockedURI}`));
    const load = (src: string) => new Promise<string>((done) => {
      const img = new Image();
      img.onload = () => done('loaded');
      img.onerror = () => done('refused');
      img.src = src;
      document.body.append(img);
    });
    const remote = await load('https://example.com/far.png');
    const data = await load('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    await new Promise((r) => setTimeout(r, 200));
    return { remote, data, refused };
  });
  expect(got.remote).toBe('refused');
  expect(got.data).toBe('loaded');
  expect(got.refused.some((r) => r.startsWith('img-src') && r.includes('example.com')), got.refused.join(' | ')).toBe(true);
});
