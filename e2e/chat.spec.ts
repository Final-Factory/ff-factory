import { BOX, boxText, expect, isMobile, moveViewport, ON_SCREEN_KEYBOARD, signIn, standInViewport, test, uniq } from './fixtures.ts';

// The orchestrator is one conversation shared by every test on a server: each test finds its own
// messages by a unique tag, never by position.

test('orchestrator: Enter sends, Shift+Enter makes a new line (desktop keyboards)', async ({ authed: page }) => {
  test.skip(isMobile(page), 'touch keyboards: see the next test');
  const tag = uniq('chat');
  const box = page.locator(`.orch ${BOX}`);

  await box.fill(`first line ${tag}`);
  await box.press('Shift+Enter');
  await box.pressSequentially('second line');
  await expect.poll(() => boxText(box)).toBe(`first line ${tag}\nsecond line`);
  // Nothing was sent by the Shift+Enter.
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);

  await box.press('Enter');
  const bubble = page.locator('.orch .msg-user', { hasText: tag });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.bubble-text')).toHaveText(`first line ${tag}\nsecond line`);
  await expect.poll(() => boxText(box)).toBe('');
  await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: first line ${tag}` })).toBeVisible();

  // An empty box: Enter does nothing (no empty message).
  await box.press('Enter');
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(1);
});

test('orchestrator: on a touch keyboard Enter is a new line and the Send button sends', async ({ page }) => {
  test.skip(!isMobile(page), 'desktop keyboards: see the previous test');
  // The phone's own keyboard comes up when the box is focused (a stand-in viewport: there is none here).
  await page.addInitScript(standInViewport);
  await signIn(page);
  await page.goto('/');
  const tag = uniq('chat');
  const box = page.locator(`.orch ${BOX}`);
  await box.focus();
  await moveViewport(page, ON_SCREEN_KEYBOARD);

  // By design (Composer.tsx, shared/keys.ts): an on-screen keyboard has no Shift key to hand, so Enter
  // never sends there. (A hardware keyboard on a tablet does: e2e/ipad.spec.ts.)
  await box.fill(`first line ${tag}`);
  await box.press('Enter');
  await box.pressSequentially('second line');
  await expect.poll(() => boxText(box)).toBe(`first line ${tag}\nsecond line`);
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);
  // The placeholder does not advertise Enter to send on a phone.
  await expect(box).toHaveAttribute('aria-placeholder', 'Message the orchestrator');

  await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  const bubble = page.locator('.orch .msg-user', { hasText: tag });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.bubble-text')).toHaveText(`first line ${tag}\nsecond line`);
  await expect.poll(() => boxText(box)).toBe('');
  await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: first line ${tag}` })).toBeVisible();
  // With the box empty again, the primary slot is voice mode, not Send.
  await expect(page.locator('.orch .composer').getByRole('button', { name: 'Voice mode' })).toBeVisible();
});

test('orchestrator: a message sent from another device shows up without a reload', async ({ authed: page, browser }) => {
  test.skip(isMobile(page), 'one project is enough: two desktop windows on one server');
  // The second device: a separate browser context (its own cookies, its own socket), same account.
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
  try {
    const phone = await other.newPage();
    await signIn(phone);
    await phone.goto('/');
    const tag = uniq('dev');
    // Both windows have the chat open before the message goes out.
    await expect(page.locator(`.orch ${BOX}`)).toBeVisible();
    await expect(phone.locator(`.orch ${BOX}`)).toBeVisible();

    const box = phone.locator(`.orch ${BOX}`);
    await box.fill(`from the phone ${tag}`);
    await box.press('Enter');
    await expect(phone.locator('.orch .msg-user', { hasText: tag })).toBeVisible();

    // The first window never sent it, and must still show it: the message, then the reply.
    await expect(page.locator('.orch .msg-user', { hasText: tag })).toBeVisible();
    await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: from the phone ${tag}` })).toBeVisible();
  } finally {
    await other.close();
  }
});

test('orchestrator: a window whose socket died silently catches up on messages sent meanwhile', async ({ page, browser }) => {
  test.skip(isMobile(page), 'one project is enough: two desktop windows on one server');
  // The desktop's first socket stays "open" but delivers nothing more, as after a laptop sleeps or a
  // phone suspends the tab: no close event ever comes. Later sockets are healthy.
  let socketsOpened = 0;
  let firstDead = false;
  await page.routeWebSocket('/ws', (ws) => {
    const n = ++socketsOpened;
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (!(n === 1 && firstDead)) ws.send(m);
    });
    ws.onMessage((m) => server.send(m));
  });
  await page.clock.install();
  await signIn(page);
  await page.goto('/');
  await expect(page.locator(`.orch ${BOX}`)).toBeVisible();
  await expect.poll(() => socketsOpened).toBe(1);

  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
  try {
    const phone = await other.newPage();
    await signIn(phone);
    await phone.goto('/');
    firstDead = true;
    const tag = uniq('zombie');
    const box = phone.locator(`.orch ${BOX}`);
    await box.fill(`while you slept ${tag}`);
    await box.press('Enter');
    await expect(phone.locator('.orch .msg-assistant', { hasText: `Echo: while you slept ${tag}` })).toBeVisible();

    // The desktop heard none of it.
    await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);
    // A minute of silence: the page gives up on that socket, opens a new one, and refetches.
    await page.clock.fastForward(60_000);
    await expect.poll(() => socketsOpened).toBe(2);
    await expect(page.locator('.orch .msg-user', { hasText: tag })).toBeVisible();
    await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: while you slept ${tag}` })).toBeVisible();
  } finally {
    await other.close();
  }
});
