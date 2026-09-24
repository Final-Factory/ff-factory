import { expect, go, isMobile, openSidebar, test } from './fixtures.ts';

test('search: finds the seeded transcript, and a hit opens it at that message', async ({ authed: page }) => {
  const sidebar = await openSidebar(page);
  await sidebar.getByRole('button', { name: 'Search', exact: true }).click();
  if (isMobile(page)) await expect(page.locator('.shell.drawer-open')).toHaveCount(0);

  const input = page.getByPlaceholder(/Search every transcript/);
  await expect(input).toBeFocused();
  await input.fill('zebrafish');
  await input.press('Enter');

  await expect(page.locator('.search-results > p')).toContainText('1 match in');
  const hit = page.locator('.search-hit');
  await expect(hit).toHaveCount(1);
  await expect(hit.locator('.search-hit-title')).toHaveText('Seeded worker');
  // Where it happened, by the sandbox's name.
  await expect(hit.locator('.search-where')).toHaveText('Visual baseline');
  await expect(hit.locator('mark')).toHaveText('zebrafish');
  // The query is in the address, so a reload or a shared link repeats it.
  await expect(page).toHaveURL(/#\/search\/zebrafish$/);

  await hit.click();
  await expect(page).toHaveURL(/#\/sandbox\/gallery\/gallery1$/);
  const msg = page.locator('.sb-panel .msg-user', { hasText: 'zebrafish' });
  await expect(msg).toBeInViewport();

  // No hits: said plainly.
  await go(page, '#/search/nosuchwordanywhere');
  await expect(page.locator('.search-results > p')).toContainText('No matches');
});
