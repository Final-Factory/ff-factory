import type { Page } from '@playwright/test';
import { expect, go, isMobile, test } from './fixtures.ts';

const REASON = 'update (request_app_update)';

/** The app as the server would show it with a restart waiting on busy agents (injected into /api/state). */
async function withRestartPending(page: Page) {
  const drain = (sessions: { id: string }[]) => ({ reason: REASON, update: true, startedAt: new Date().toISOString(), deadline: new Date(Date.now() + 10 * 60_000).toISOString(), waitingFor: sessions.slice(0, 3).map((s) => s.id) });
  let sessions: { id: string }[] = [];
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch();
    const state = await res.json();
    sessions = state.sessions;
    state.host = { ...state.host, drain: drain(sessions) };
    await route.fulfill({ response: res, json: state });
  });
  // The live socket sends the whole state on connect, and host updates later: the drain rides along.
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      try {
        const ev = JSON.parse(String(m));
        if (ev.type === 'state') {
          sessions = ev.state.sessions;
          ev.state.host = { ...ev.state.host, drain: drain(sessions) };
        } else if (ev.type === 'host') ev.host = { ...ev.host, drain: drain(sessions) };
        ws.send(JSON.stringify(ev));
      } catch {
        ws.send(m);
      }
    });
  });
  await page.reload();
}

/** The visible page headers: the orchestrator's, and (desktop) the side panel's, or a phone page's. */
const HEADERS = '.orch-head, .page-head, .ph, .sb-head';

async function expectBelowBar(page: Page) {
  const bar = await page.locator('.gbar').first().boundingBox();
  expect(bar).not.toBeNull();
  const heads = page.locator(HEADERS);
  let checked = 0;
  for (let i = 0; i < (await heads.count()); i++) {
    const h = heads.nth(i);
    if (!(await h.isVisible())) continue;
    const box = (await h.boundingBox())!;
    expect(box.y, `header ${i} starts below the bar`).toBeGreaterThanOrEqual(bar!.y + bar!.height - 0.5);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
}

test('global notices sit above the page, in the layout: opaque, one line, full text on hover or tap, dismissible', async ({ authed: page }) => {
  await withRestartPending(page);
  const bar = page.locator('.gbar', { hasText: 'Restart pending' });
  await expect(bar).toBeVisible();

  // Opaque, and in the flow: every visible header starts below it, nothing is drawn over it.
  const bg = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toMatch(/^rgb\(/); // rgba(..., a < 1) would let the page show through
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).not.toMatch(/fixed|absolute/);
  await expectBelowBar(page);
  if (!isMobile(page)) {
    // With a side panel open too (the case in the report): both headers are below it.
    await go(page, '#/sandbox/alpha');
    await expect(page.locator('.sb-panel')).toBeVisible();
    await expectBelowBar(page);
  }

  // One line, cut short, the whole text in the tooltip.
  const text = bar.locator('.gbar-text');
  const oneLine = (await bar.boundingBox())!.height;
  expect(oneLine).toBeLessThanOrEqual(44);
  await expect(text).toHaveAttribute('title', /^Restart pending \(update \(request_app_update\)\): waiting for .* Interrupted agents are resumed afterwards\.$/);
  // A tap unfolds it.
  await text.click();
  await expect(bar).toHaveClass(/\bopen\b/);
  if (await text.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > 30)) {
    expect((await bar.boundingBox())!.height).toBeGreaterThanOrEqual(oneLine);
  }
  await expectBelowBar(page);

  // Dismissed: gone, and the page moves back up.
  await bar.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.gbar')).toHaveCount(0);
  const top = (await page.locator(HEADERS).first().boundingBox())!.y;
  expect(top).toBeLessThan(40);
});
