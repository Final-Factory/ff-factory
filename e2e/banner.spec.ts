import type { Page } from '@playwright/test';
import { reserveLines } from '../server/secrets.ts';
import type { PlanUsage, TokenWarning } from '../shared/types.ts';
import { ALPHA, appState, expect, go, isMobile, sandboxHash, test, uniq } from './fixtures.ts';

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
    await go(page, sandboxHash(ALPHA));
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

test('a dry run (FFSB_DRY_RUN=1) says so above every page, and cannot be dismissed', async ({ authed: page }) => {
  const why = 'Nothing here acts outside: no wakes, timers, heartbeats or standing runs. Only a person writing to an orchestrator starts one.';
  const patch = (h: object) => ({ ...h, dryRun: why });
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch();
    const state = await res.json();
    state.host = patch(state.host);
    await route.fulfill({ response: res, json: state });
  });
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      try {
        const ev = JSON.parse(String(m));
        if (ev.type === 'state') ev.state.host = patch(ev.state.host);
        else if (ev.type === 'host') ev.host = patch(ev.host);
        ws.send(JSON.stringify(ev));
      } catch {
        ws.send(m);
      }
    });
  });
  await page.reload();
  const bar = page.locator('.gbar', { hasText: 'DRY RUN' });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/\bgbar-error\b/);
  await expect(bar.locator('.gbar-text')).toHaveAttribute('title', `DRY RUN: this is a copy, not the real portal. ${why}`);
  await expect(bar.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  await expectBelowBar(page);
});

/** The FFBox host's watchdog reported a failure on the path from the internet to the portal (server/pathHealth.ts), injected into the host status. */
async function withPathHealth(page: Page, pathHealth: object | undefined) {
  const patch = (h: object) => ({ ...h, pathHealth });
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch();
    const state = await res.json();
    state.host = patch(state.host);
    await route.fulfill({ response: res, json: state });
  });
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      try {
        const ev = JSON.parse(String(m));
        if (ev.type === 'state') ev.state.host = patch(ev.state.host);
        else if (ev.type === 'host') ev.host = patch(ev.host);
        ws.send(JSON.stringify(ev));
      } catch {
        ws.send(m);
      }
    });
  });
  await page.reload();
}

test('a failure on the path from the internet to the portal is on the banner: the layer, since when, the log line, who must act; it cannot be dismissed', async ({ authed: page }) => {
  const line = 'the tailnet policy drops Funnel traffic: a tailnet admin must grant tag:ingress (or *) → tag:fff-portal. 3 line(s) in 15 min, last: Oct 07 18:04:05 fff tailscaled[612]: Drop: TCP{100.100.3.13:50112 > 100.64.0.5:59917} 60 no rules matched';
  const layer = {
    id: '7',
    name: 'tailnet policy',
    verdict: 'fail',
    since: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    checkedAt: new Date().toISOString(),
    line,
    who: 'tailnet admin: grant tag:ingress → tag:fff-portal in the tailnet policy',
    repair: '',
  };
  await withPathHealth(page, { updatedAt: new Date().toISOString(), host: 'ffbox', dns: 'fff.example-tailnet.ts.net', ok: false, problems: [layer], warnings: [] });
  const bar = page.locator('.gbar', { hasText: 'Portal path problem: tailnet policy (layer 7)' });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/\bgbar-error\b/);
  const title = await bar.locator('.gbar-text').getAttribute('title');
  expect(title).toContain(line);
  expect(title).toContain('Who must act: tailnet admin: grant tag:ingress → tag:fff-portal in the tailnet policy.');
  expect(title).toMatch(/since [\d: A-Za-z]+\./);
  await expect(bar.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
  await expectBelowBar(page);
});

test('a silent path watchdog says so, and a healthy path shows nothing', async ({ authed: page }) => {
  await withPathHealth(page, { updatedAt: new Date(Date.now() - 40 * 60_000).toISOString(), host: 'ffbox', dns: 'x', ok: false, problems: [], warnings: [], silentMinutes: 40 });
  const bar = page.locator('.gbar', { hasText: 'path watchdog has been silent for 40 minutes' });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/\bgbar-warn\b/);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await withPathHealth(page, undefined);
  await expect(page.locator('.gbar')).toHaveCount(0);
});

/** The VM's unit watchdog reported restarts (server/unitWatchdog.ts), injected into the host status; `current.events` can change between reloads. It also reads as silent, so a fixed bar shows once the status is in. */
async function withUnitRestarts(page: Page, current: { events: object[] }) {
  const patch = (h: object) => ({ ...h, unitWatchdog: { updatedAt: new Date().toISOString(), host: 'fff', units: [], events: current.events, silentMinutes: 40 } });
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch();
    const state = await res.json();
    state.host = patch(state.host);
    await route.fulfill({ response: res, json: state });
  });
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      try {
        const ev = JSON.parse(String(m));
        if (ev.type === 'state') ev.state.host = patch(ev.state.host);
        else if (ev.type === 'host') ev.host = patch(ev.host);
        ws.send(JSON.stringify(ev));
      } catch {
        ws.send(m);
      }
    });
  });
  await page.reload();
}

test('a closed watchdog-restart banner stays closed for that restart across reloads, and a new restart shows it again (w751)', async ({ authed: page }) => {
  const u1 = `${uniq('a')}.socket`;
  const u2 = `${uniq('b')}.service`;
  const restart = (unit: string, minutesAgo: number) => ({ at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), unit, action: 'restart', why: 'inactive (dead) while it should be active', attempt: 1, ok: true });
  const first = restart(u1, 30);
  const current = { events: [first] };
  await withUnitRestarts(page, current);
  const bar = page.locator('.gbar', { hasText: 'restarted a critical unit' });
  await expect(bar).toBeVisible();
  await expect(bar.locator('.gbar-text')).toHaveAttribute('title', new RegExp(u1));
  await bar.getByRole('button', { name: 'Dismiss' }).click();
  await expect(bar).toHaveCount(0);
  // The server remembers it for this person...
  await expect(async () => {
    const mine = (await appState(page.request)).settings.dismissedEvents?.tester ?? [];
    expect(mine).toContain(`${first.at}|${u1}|restart`);
  }).toPass();
  // ...so the same restart does not come back on a reload.
  await page.reload();
  // (the silent-watchdog bar rides in the same host status and cannot be closed: it shows the page has the status by now)
  await expect(page.locator('.gbar', { hasText: 'unit watchdog has been silent for 40 minutes' })).toBeVisible();
  await expect(bar).toHaveCount(0);
  // A new restart (another unit, another time) shows it again, listing only the new one.
  current.events = [first, restart(u2, 1)];
  await page.reload();
  await expect(bar).toBeVisible();
  const title = (await bar.locator('.gbar-text').getAttribute('title')) ?? '';
  expect(title).toContain(u2);
  expect(title).not.toContain(u1);
});

/**
 * The banner text the server would send for a dispatcher token with these meters: the real reserveLines, fixture usage
 * (a token ending …dAAA, as in w828's live reading), injected into /api/state and the live socket.
 */
function reserveBanner(usage: PlanUsage, others = 1): TokenWarning[] {
  const token = 'sk-ant-oat01-e2e-fixture-token-dAAA';
  const cfg = { claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: token }, claudeAccounts: { dispatcher: 'token' } } as never;
  return reserveLines(cfg, () => usage, () => others, Date.now()).flatMap((r) => (r.warning ? [{ id: `reserve:${r.cred.key}`, kind: 'reserve' as const, text: r.warning }] : []));
}

async function withTokenWarnings(page: Page, tokenWarnings: TokenWarning[]) {
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch();
    const state = await res.json();
    state.host = { ...state.host, tokenWarnings };
    await route.fulfill({ response: res, json: state });
  });
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      try {
        const ev = JSON.parse(String(m));
        if (ev.type === 'state') ev.state.host = { ...ev.state.host, tokenWarnings };
        else if (ev.type === 'host') ev.host = { ...ev.host, tokenWarnings };
        ws.send(JSON.stringify(ev));
      } catch {
        ws.send(m);
      }
    });
  });
  await page.reload();
}

test("the dispatcher's token buffer banner names the limit that tripped it: the 5-hour window, not the week (w828)", async ({ authed: page }, testInfo) => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  // The live reading: weekly 51% with a 26% buffer (5.2 days to the reset) is not inside it; the 5-hour window at 93% (buffer 20%) is.
  const sessionOnly: PlanUsage = { available: true, asOf: at(0), models: [], weekly: { label: 'weekly', percent: 51, resetsAt: at(5.2 * 86_400_000) }, session: { label: '5-hour', percent: 93, resetsAt: at(10 * 60_000 + 30_000) } };
  await withTokenWarnings(page, reserveBanner(sessionOnly));
  const bar = page.locator('.gbar', { hasText: "The dispatcher's Claude token buffer is in use." });
  await expect(bar).toBeVisible();
  const text = bar.locator('.gbar-text');
  await expect(text).toHaveAttribute('title', /is inside the buffer kept for the dispatcher: 5-hour 93% \(buffer 20%\), resets in 1[01] min$/);
  await expect(text).not.toHaveAttribute('title', /weekly/);
  await testInfo.attach('banner-5-hour-only', { body: await page.screenshot(), contentType: 'image/png' });

});

test("the dispatcher's token buffer banner names both limits when both are inside the buffer (w828)", async ({ authed: page }, testInfo) => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const both: PlanUsage = { available: true, asOf: at(0), models: [], weekly: { label: 'weekly', percent: 80, resetsAt: at(5.2 * 86_400_000) }, session: { label: '5-hour', percent: 93, resetsAt: at(10 * 60_000 + 30_000) } };
  await withTokenWarnings(page, reserveBanner(both));
  const text = page.locator('.gbar', { hasText: "The dispatcher's Claude token buffer is in use." }).locator('.gbar-text');
  await expect(text).toHaveAttribute('title', /: 5-hour 93% \(buffer 20%\), resets in 1[01] min; weekly 80% \(buffer 26%\), resets \w{3} \d\d:\d\dZ$/);
  await text.click(); // the bar cuts a long line short; a tap unfolds it
  await testInfo.attach('banner-both', { body: await page.screenshot(), contentType: 'image/png' });
});
