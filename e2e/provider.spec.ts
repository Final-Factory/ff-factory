// FFBox's card and page (docs/ffbox-integration.md, phase 1). Runs only on the provider projects
// (playwright.config.ts), whose servers have providers.ffbox switched on with E2E_PROVIDER_TOKEN.
import { expect, expectNoHorizontalOverflow, openSidebar, test } from './fixtures.ts';
import { E2E_PROVIDER_TOKEN, MockConnector, SAMPLE_CONVERSATIONS } from './mockConnector.ts';

test('FFBox: the card follows the connector, and its page lists capacity, conversations and intake reports', async ({ authed: page, request }) => {
  const base = test.info().project.use.baseURL!;

  // Switched on, nothing connected yet (or, on a reused local server, gone again).
  let sidebar = await openSidebar(page);
  const card = sidebar.locator('.row.place', { hasText: 'FFBox' });
  await expect(sidebar.locator('.section-head', { hasText: 'Providers' })).toBeVisible();
  await expect(card).toContainText(/Waiting for the connector|Connector offline/);

  // The lists are behind the login like everything else.
  expect((await request.get('/api/providers/ffbox/intake')).status()).toBe(401);

  const c = new MockConnector(base, E2E_PROVIDER_TOKEN);
  try {
    const welcome = await c.hello({ version: 'e2e-1', web: 'https://ffbox.example:8787' });
    expect(welcome.protocol).toBe(1);
    c.sendSamples();
    // A player's title with markup in it: shown as text, never as HTML.
    c.conversation({ ...SAMPLE_CONVERSATIONS[1], id: '850', title: 'Crash <img src=x onerror="document.title=1"> on load', updatedAt: '2026-09-27T09:10:00Z' });

    await expect(card).toContainText('1 running');
    await expect(card).toContainText('7 free');
    await card.click();

    const panel = page.locator('[data-testid="provider-panel"]');
    await expect(panel.locator('h2')).toHaveText('FFBox');
    await expect(page).toHaveURL(/#\/provider\/ffbox$/);
    await expect(panel.getByTestId('provider-state')).toContainText('1 running');
    await expect(panel.locator('.sb-facts')).toContainText('connector e2e-1');
    await expect(panel.getByRole('link', { name: 'Open FFBox' })).toHaveAttribute('href', 'https://ffbox.example:8787');

    const classes = panel.getByTestId('provider-classes');
    const ffdev = classes.locator('.pv-class', { hasText: 'ffdev' });
    await expect(ffdev).toContainText('glm-5.3-flash');
    await expect(ffdev).toContainText('simple work');
    await expect(ffdev).toContainText('open internet');
    await expect(ffdev).toContainText('1/3 free');
    await expect(classes.locator('.pv-class', { hasText: 'ffdiagnose' })).toContainText('fenced');

    const conversations = panel.getByTestId('provider-conversations');
    await expect(conversations.locator('.run-row')).toHaveCount(4);
    await expect(conversations.locator('.run-row').first()).toContainText('Desync minerBots+census at heartbeat 7240');
    await expect(conversations).toContainText('PR #640 merged');
    await expect(conversations).toContainText('NEEDS-INFO');
    await expect(conversations).toContainText('Crash <img src=x onerror="document.title=1"> on load');
    await expect(conversations.locator('img')).toHaveCount(0);

    await panel.getByRole('tab', { name: /Intake reports/ }).click();
    await expect(page).toHaveURL(/#\/provider\/ffbox\/intake$/);
    const intake = panel.getByTestId('provider-intake');
    await expect(intake.locator('.run-row')).toHaveCount(3);
    await expect(intake.locator('.run-row').first()).toContainText('0.50.0.35 · WindowsPlayer · minerBots+census · from host · hb 7240');
    await expect(intake).toContainText('crash');
    await expectNoHorizontalOverflow(page);

    const listed = await page.request.get('/api/providers/ffbox/intake');
    expect(listed.ok()).toBeTruthy();
    expect((await listed.json()).map((e: { reportId: string }) => e.reportId)).toEqual([
      '20260927T090000Z-desync-3a9f01c2d4',
      '20260927T085958Z-desync-9b1e22aa07',
      '20260927T080000Z-crash-5c0ffee123',
    ]);
  } finally {
    c.close();
  }

  // The connector goes away: the card and the page say so, and keep what was reported.
  await expect(page.locator('[data-testid="provider-state"]')).toContainText('Connector offline');
  await expect(page.getByTestId('provider-intake').locator('.run-row')).toHaveCount(3);
  sidebar = await openSidebar(page);
  await expect(sidebar.locator('.row.place', { hasText: 'FFBox' })).toContainText('Connector offline');
});

test('FFBox: a wrong token is refused and changes nothing', async ({ authed: page }) => {
  const base = test.info().project.use.baseURL!;
  const c = new MockConnector(base, ['ffpv1', 'ThisIsNotTheTokenTheServerKnowsAboutAtAll00'].join('_'));
  expect((await c.closed).status).toBe(401);
  const state = await (await page.request.get('/api/state')).json();
  expect(state.providers.map((p: { id: string; online: boolean }) => [p.id, p.online])).toEqual([['ffbox', false]]);
});
