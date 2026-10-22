import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { ALPHA, appState, BOX, boxText, expect, openSandbox, openSidebar, sendMessage, signIn, startWorker, test, uniq, useTool } from './fixtures.ts';

// A tab left open across a deploy moves to the new UI by itself (web/src/freshness.ts, w285, w1489), and loses nothing
// on the way. A deploy is played here the way the page sees it: the server (health, the page, the state its socket sends)
// names another web build, and the socket drops and comes back.

// WebKit sends a page's requests through the service worker (web/public/sw.js, Web Push), where page.route cannot see them.
test.use({ serviceWorkers: 'block' });

const DEPLOYED = 'deployed0001';
const BAR = (page: Page) => page.locator('.gbar', { hasText: 'A new version of FF Factory is ready' });

interface Deploy {
  /** The server now serves the DEPLOYED build, and the socket reconnects to tell the page. */
  go: () => Promise<void>;
  /** While true, /api/health refuses (the portal is draining or starting). */
  unhealthy: boolean;
}

/** Make the page's server look like it deploys on demand. Call before page.goto. */
async function deployable(page: Page): Promise<Deploy> {
  const d: Deploy = { go: async () => {}, unhealthy: false };
  let deployed = false;
  // The tab's own spread over a few seconds is covered by the unit test; here it is zero, so each test is quick.
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.route('**/api/health', async (route) => {
    if (d.unhealthy) return route.fulfill({ status: 503, json: { ok: false } });
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: deployed ? { ...body, web: DEPLOYED } : body });
  });
  // The page (the document and the fetch of it the tab makes to see what is served) names the new build once deployed. Until then
  // it is left alone: a document answered through route.fetch gets a socket the server refuses (measured, 401 on /ws).
  await page.route((u) => u.pathname === '/', async (route) => {
    if (!deployed) return route.continue();
    const headers = { ...route.request().headers() };
    delete headers['if-none-match'];
    const res = await route.fetch({ headers });
    const html = (await res.text()).replace(/(<meta name="ff-build" content=")[^"]*/, `$1${DEPLOYED}`);
    await route.fulfill({ response: res, body: html });
  });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      try {
        const ev = JSON.parse(String(m));
        if (ev.type === 'state' && deployed) ev.state.app = { ...ev.state.app, web: DEPLOYED };
        ws.send(JSON.stringify(ev));
      } catch {
        ws.send(m);
      }
    });
  });
  d.go = async () => {
    deployed = true;
    await sockets[sockets.length - 1].close();
  };
  return d;
}

/** Whether this is still the page marked before the deploy (mid-reload counts as yes, so a poll asks again). */
const oldPage = (page: Page) => page.evaluate(() => (window as { oldPage?: boolean }).oldPage === true).catch(() => true);
const markPage = (page: Page) => page.evaluate(() => ((window as { oldPage?: boolean }).oldPage = true));
const builtAs = (page: Page) => page.locator('meta[name="ff-build"]').getAttribute('content');

/** Wait until the hand has been off the keys for longer than the page's idle rule. */
const handOff = (page: Page) => page.waitForTimeout(1_800);

async function loadWithDraft(page: Page, draft: string) {
  await page.goto('/');
  const box = page.locator(`.orch ${BOX}`);
  await box.fill(draft);
  await box.focus();
  await handOff(page);
  await markPage(page);
  return box;
}

test('the page names the build it was served, as /api/health does, and is fetched fresh every time', async ({ page }) => {
  await signIn(page);
  const res = await page.goto('/');
  expect(res?.headers()['cache-control']).toBe('no-cache');
  const health = await (await page.request.get('/api/health')).json();
  expect(health.web).toMatch(/^[0-9a-f]{12}$/);
  await expect(page.locator('meta[name="ff-build"]')).toHaveAttribute('content', health.web);
  expect(res?.headers().etag).toBe(`"${health.web}"`);
});

test('the version changes under an open tab with a draft in its box: the tab reloads by itself and the draft and caret are back', async ({ page }) => {
  await signIn(page);
  const deploy = await deployable(page);
  const draft = `half a thought ${uniq('fresh')}`;
  const box = await loadWithDraft(page, draft);
  expect(await builtAs(page)).not.toBe(DEPLOYED);

  await deploy.go();
  await expect.poll(() => oldPage(page), { timeout: 20_000 }).toBe(false);
  expect(await builtAs(page)).toBe(DEPLOYED);
  await expect.poll(() => boxText(box)).toBe(draft);
  await expect(box).toBeFocused();
  // No bar, no button to click, and no second reload.
  await expect(BAR(page)).toHaveCount(0);
  await markPage(page);
  await page.waitForTimeout(2_500);
  expect(await oldPage(page)).toBe(true);
});

test('a tab being typed in waits until the hand is off the keys, then reloads with everything typed', async ({ page }) => {
  await signIn(page);
  const deploy = await deployable(page);
  const box = await loadWithDraft(page, 'start ');
  await deploy.go();
  // Typing on, a key every 400 ms for four seconds: the page stays, and shows no bar (nothing is lost, it is only waiting).
  for (let i = 0; i < 10; i++) {
    await box.pressSequentially('abcd'[i % 4], { delay: 10 });
    await page.waitForTimeout(400);
    expect(await oldPage(page), `reloaded under the typing at key ${i}`).toBe(true);
  }
  await expect(BAR(page)).toHaveCount(0);
  await expect.poll(() => oldPage(page), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => boxText(box)).toBe('start abcdabcdab');
});

test('a tab waits for the new build to answer healthy, and does not reload while the portal is down', async ({ page }) => {
  await signIn(page);
  const deploy = await deployable(page);
  const draft = `waiting ${uniq('fresh')}`;
  const box = await loadWithDraft(page, draft);
  deploy.unhealthy = true;
  await deploy.go();
  await page.waitForTimeout(3_000);
  expect(await oldPage(page)).toBe(true);
  await expect(BAR(page)).toHaveCount(0);
  deploy.unhealthy = false;
  await expect.poll(() => oldPage(page), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => boxText(box)).toBe(draft);
});

test('a reload that did not bring the new build is not repeated: the bar is offered once instead', async ({ page }) => {
  await signIn(page);
  const deploy = await deployable(page);
  await loadWithDraft(page, '');
  await page.evaluate((b) => sessionStorage.setItem('ffsb.reloadedFor', b), DEPLOYED);
  await deploy.go();
  await expect(BAR(page)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_500);
  expect(await oldPage(page)).toBe(true);
});

test('a tab with a form open (it cannot be put back) shows the bar, and reloads once the form is closed', async ({ page }) => {
  await signIn(page);
  const deploy = await deployable(page);
  await page.goto('/');
  const sidebar = await openSidebar(page);
  await sidebar.locator('.section-head', { hasText: 'Standing agents' }).getByRole('button', { name: 'New' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByPlaceholder('Discord triage').fill('half a form');
  await handOff(page);
  await markPage(page);

  await deploy.go();
  await expect(BAR(page)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_500);
  expect(await oldPage(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect.poll(() => oldPage(page), { timeout: 20_000 }).toBe(false);
});

// Its own login's chat (e2e/server.ts, "reloader"): on the owner's, other files' messages scrolled the chat as it followed
// them, and the tap on an answer button missed (w1758, 7 CI runs in WebKit).
test('an open ask_person question is still open, with its buttons, after the reload', async ({ page }) => {
  await signIn(page, 'reloader', 'e2e-password-680');
  const deploy = await deployable(page);
  await page.goto('/');
  const me = await appState(page.request);
  const question = `Merge the belt fix ${uniq('q')} now?`;
  await useTool(page.request, me.orchestratorId, 'ask_person', { question, options: [{ label: 'Merge it', description: 'Ship it.' }, { label: 'Wait', description: 'Hold it.' }] });
  const card = page.getByTestId('ask').filter({ hasText: question });
  await expect(card).toBeVisible();
  await handOff(page);
  await markPage(page);

  await deploy.go();
  await expect.poll(() => oldPage(page), { timeout: 20_000 }).toBe(false);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('ask-option').first()).toBeEnabled();
  await expect(card).not.toHaveClass(/ask-locked/);
  // Answer, so the question does not stay open in the chat for the next test.
  await card.getByTestId('ask-option').filter({ hasText: 'Wait' }).click();
  await expect(card.getByTestId('ask-option').filter({ hasText: 'Wait' })).toContainText('Your answer');
});

test('an approval being declined keeps its note over the reload', async ({ page }) => {
  await signIn(page);
  const deploy = await deployable(page);
  const tag = uniq('perm');
  const s = await startWorker(page.request, `#perm ${tag}`, { title: `Perm ${tag}`, permissionMode: 'default' });
  await page.goto('/');
  const panel = await openSandbox(page, ALPHA, s.id);
  const card = panel.locator('.perm-pending');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Deny and say why…' }).click();
  const note = card.getByPlaceholder('Tell the agent what to do instead');
  await note.fill('use the trash folder instead');
  await handOff(page);
  await markPage(page);

  await deploy.go();
  await expect.poll(() => oldPage(page), { timeout: 20_000 }).toBe(false);
  const again = page.locator('.sb-panel .perm-pending').getByPlaceholder('Tell the agent what to do instead');
  await expect(again).toHaveValue('use the trash folder instead');
  // The sandbox is shared by the other specs: decide, so no approval stays waiting in it.
  await page.locator('.sb-panel .perm-pending').getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(page.locator('.sb-panel .perm-pending')).toHaveCount(0);
});

// The reloader's chat too: pictures in other files' messages above the rows loaded after the scroll and moved them.
test('a chat scrolled up is at the same message after the reload', async ({ page }) => {
  await signIn(page, 'reloader', 'e2e-password-680');
  const deploy = await deployable(page);
  await page.goto('/');
  const me = await appState(page.request);
  const tag = uniq('scroll');
  for (let i = 0; i < 14; i++) await sendMessage(page.request, me.orchestratorId, `row ${i} ${tag} ${'filler '.repeat(60)}`);
  const row = (n: number): Locator => page.locator('.orch .msg-assistant', { hasText: `row ${n} ${tag}` });
  await expect(row(13)).toHaveCount(1);
  const topOf = (r: Locator) => r.evaluate((el) => Math.round(el.getBoundingClientRect().top - el.closest('.transcript-scroll')!.getBoundingClientRect().top));
  await row(5).evaluate((el) => {
    const sc = el.closest('.transcript-scroll')!;
    sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 60;
  });
  await handOff(page);
  // Where the row is as the page goes, not just after the scroll: pictures above it that load after the scroll move it
  // down on WebKit (no scroll anchoring), 136 px on CI (w1758), and the page keeps the place the reader then sees.
  const where = await topOf(row(5));
  await markPage(page);

  await deploy.go();
  await expect.poll(() => oldPage(page), { timeout: 20_000 }).toBe(false);
  await expect(row(5)).toHaveCount(1);
  await expect.poll(async () => Math.abs((await topOf(row(5))) - where), { timeout: 10_000 }).toBeLessThanOrEqual(3);
});
