import type { Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';
import { appState, expect, go, test } from './fixtures.ts';

/**
 * Nobody chats with the dispatcher (docs/orchestrators.md): its page keeps the log, the requests and the Intake tab, has
 * no input, and points to your own orchestrator; the API refuses a direct message to it, the owner's included.
 */

const REFUSED = /nobody chats with the dispatcher/;

async function mateContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext(test.info().project.use as BrowserContextOptions);
  await expect(async () => {
    const r = await ctx.request.post('/api/login', { data: { username: 'teammate', password: 'e2e-teammate-456' } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
  return ctx;
}

test('the Dispatcher page has no input, only a pointer to your own orchestrator; its log and tabs stay', async ({ authed: page }) => {
  await go(page, '#/dispatcher/conversation');
  const panel = page.locator('.dispatcher-panel');
  await expect(panel.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('tab', { name: /Requests/ })).toBeVisible();
  await expect(panel.locator('.transcript')).toBeVisible();

  await expect(panel.locator('.composer')).toHaveCount(0);
  await expect(panel.locator('textarea')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /send/i })).toHaveCount(0);

  const note = panel.getByTestId('read-only-note');
  await expect(note).toContainText('Nobody writes to the dispatcher');
  const link = panel.getByTestId('talk-to-orchestrator');
  await expect(link).toHaveText('Talk to your orchestrator');
  await link.click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('.composer')).toBeVisible();
});

test('a direct POST to the dispatcher is refused for the owner and for a member; their own orchestrators still take messages', async ({ authed: page, browser }) => {
  const me = await appState(page.request);
  const dispatcher = me.dispatcherId!;
  const owner = await page.request.post(`/api/sessions/${dispatcher}/message`, { data: { text: 'do it now' } });
  expect(owner.status()).toBe(403);
  expect(((await owner.json()) as { error: string }).error).toMatch(REFUSED);

  const mateCtx = await mateContext(browser);
  try {
    const mate = await mateCtx.request.post(`/api/sessions/${dispatcher}/message`, { data: { text: 'let me in' } });
    expect(mate.status()).toBe(403);
    expect(((await mate.json()) as { error: string }).error).toMatch(REFUSED);
  } finally {
    await mateCtx.close();
  }

  const mine = await page.request.post(`/api/sessions/${me.orchestratorId}/message`, { data: { text: 'hello, my own orchestrator' } });
  expect(mine.ok(), await mine.text()).toBeTruthy();
});
