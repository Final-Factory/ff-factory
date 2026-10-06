// Max's page and the sidebar's External strip (docs/max.md), against the E2E server's mock Discord and the five
// events it seeded as if the gallery worker's ffdiscord calls had written them (e2e/mockDiscord.ts). The FFBox
// setup page (FFBox is off on these servers) is here too. Visual baselines are CI's Linux renders.
import type { Page } from '@playwright/test';
import { appState, expect, expectNoHorizontalOverflow, openSidebar, signIn, test } from './fixtures.ts';
import { CH, E2E_DISCORD_TOKEN, GUILD } from './mockDiscord.ts';

const NOW = new Date('2026-09-24T12:00:00Z');

/** Signed in, clock frozen, and Max's token checked and channels read (the server does it a few seconds after start). */
async function ready(page: Page) {
  await page.clock.setFixedTime(NOW);
  await signIn(page);
  await page.request.post('/api/max/refresh', { data: {} });
  await expect
    .poll(async () => {
      const m = (await appState(page.request)).max;
      return [m?.health.state, !!m?.inbound.polledAt, m?.lastPost?.channel];
    }, { timeout: 20_000 })
    .toEqual(['ok', true, '#dev-chat']);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeAttached();
}

test('Max: the External strip, then the page: health, the last error, and what agents did as Max', async ({ page }) => {
  await ready(page);
  const sidebar = await openSidebar(page);
  const strip = sidebar.getByTestId('external');
  await expect(strip.getByTestId('external-max')).toContainText('Maxok20m');
  await expect(strip.getByTestId('external-ffbox')).toContainText('FFBoxoff');
  await expect(strip).toHaveScreenshot('external.png');

  await strip.getByTestId('external-max').click();
  const panel = page.getByTestId('max-panel');
  await expect(page).toHaveURL(/#\/max$/);
  await expect(panel.locator('h2')).toHaveText('Max');
  await expect(panel.getByTestId('max-state')).toHaveText('OK · posted 20m ago');
  await expect(panel.getByTestId('max-health')).toContainText('token works · Max');
  const err = panel.getByTestId('max-last-error');
  await expect(err).toContainText('HTTP 403: Missing Permissions');
  await expect(err).toContainText('#dev-patch-notes');
  await expect(err).toContainText('Seeded worker');

  const rows = panel.getByTestId('max-activity').locator('.run-row');
  await expect(rows).toHaveCount(5);
  const post = rows.nth(0);
  await expect(post).toContainText('post');
  await expect(post).toContainText('Belt splitter fix is on develop (PR #690)');
  await expect(post.getByRole('link', { name: '#dev-chat' })).toHaveAttribute('href', new RegExp(`^https://discord\\.com/channels/${GUILD}/${CH.devChat}/\\d+$`));
  await expect(post.getByRole('button', { name: 'Seeded worker' })).toBeVisible();
  await expect(post).toContainText('worker in pc/gallery');
  await expect(rows.nth(1)).toContainText('post failed');
  // A reply in a forum thread names the thread and its forum, and shows only its first line.
  const reply = rows.nth(3);
  await expect(reply).toContainText('#bug-reports › Belts stop after loading a save');
  await expect(reply).toContainText("Thanks! Fixed in 0.50.0.46; it will be in tonight's beta.");
  await expect(reply).not.toContainText('Details below');
  await expect(rows.nth(2)).toContainText('thread closed');
  await expect(rows.nth(4)).toContainText('thread opened');
  await expect(rows.nth(4).getByRole('link', { name: '#ask-claude › How do mass drivers aim?' })).toBeVisible();
  await expect(rows.nth(4).locator('.pv-title')).toHaveCount(0);
  await expect(panel).toHaveScreenshot('max-activity.png');

  // The session link opens the agent that posted.
  await post.getByRole('button', { name: 'Seeded worker' }).click();
  await expect(page).toHaveURL(/#\/session\/gallery1$/);
});

test("Max: Discord inbound is read-only, players' text stays text, and Mark read clears the count", async ({ page }) => {
  await ready(page);
  await page.goto('/#/max/inbound');
  const panel = page.getByTestId('max-panel');
  await expect(panel.getByRole('tab', { name: /Discord inbound/ })).toHaveAttribute('aria-selected', 'true');
  const dev = panel.getByTestId('max-inbound-dev_chat');
  const bugs = panel.getByTestId('max-inbound-bug_reports');
  await expect(dev.locator('.run-row')).toHaveCount(3);
  await expect(dev.locator('.mx-unread')).toHaveCount(1);
  await expect(dev.locator('.mx-unread')).toContainText('Merged the splitter fix, thanks Max');
  await expect(dev).toContainText('ffbox [bot]');
  await expect(dev).toContainText('Build 0.50.0.46 passed');
  // Only this forum's threads, newest activity first; a title with markup is shown as text.
  await expect(bugs).toContainText('forum');
  await expect(bugs.locator('.run-row')).toHaveCount(2);
  await expect(bugs.locator('.run-row').first()).toContainText('Crash <img src=x onerror="document.title=1"> when docking');
  await expect(bugs.locator('img')).toHaveCount(0);
  await expect(bugs.locator('.run-row').nth(1)).toContainText('5 messages');
  await expect(panel).toHaveScreenshot('max-inbound.png');
  await expectNoHorizontalOverflow(page);

  await dev.getByRole('button', { name: 'Mark read' }).click();
  await expect(dev.locator('.mx-unread')).toHaveCount(0);
  await expect(dev).toContainText('no unread');
  await expect.poll(async () => (await appState(page.request)).max?.inbound.channels.find((c) => c.alias === 'dev_chat')?.unread).toBe(0);
});

test('Max: the bot token never reaches the page, and the lists need a login', async ({ page, request }) => {
  expect((await request.get('/api/max/activity')).status()).toBe(401);
  expect((await request.get('/api/max/inbound')).status()).toBe(401);
  await signIn(page);
  for (const url of ['/api/state', '/api/max/activity', '/api/max/inbound']) {
    const body = await (await page.request.get(url)).text();
    expect(body, url).not.toContain(E2E_DISCORD_TOKEN);
    expect(body, url).not.toContain(E2E_DISCORD_TOKEN.split('.')[2]);
  }
  const s = (await appState(page.request)).max!;
  expect(s.token).toMatchObject({ found: true, source: expect.stringMatching(/^DISCORD_TOKEN in .*secrets\.env$/) });
});

test('FFBox while off: the strip says so, and its page lists what it needs', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await signIn(page);
  await page.goto('/');
  const sidebar = await openSidebar(page);
  await expect(sidebar.locator('.section-head', { hasText: 'Providers' })).toHaveCount(0);
  await sidebar.getByTestId('external-ffbox').click();
  await expect(page).toHaveURL(/#\/provider\/ffbox$/);
  const panel = page.getByTestId('provider-panel');
  await expect(panel.getByTestId('provider-state')).toHaveText('Switched off');
  const setup = panel.getByTestId('provider-setup');
  await expect(setup.locator('li')).toHaveCount(3);
  await expect(setup.locator('li.done')).toHaveCount(0);
  await expect(setup).toContainText('node server/providerToken.ts');
  await expect(setup).toContainText('providers.ffbox.enabled: true');
  await expect(setup.getByRole('link', { name: 'connector contract' })).toHaveAttribute('href', /docs\/ffbox-connector-contract\.md$/);
  await expect(panel.getByRole('tab')).toHaveCount(0);
  await expect(panel).toHaveScreenshot('ffbox-setup.png');
  await expectNoHorizontalOverflow(page);
});
