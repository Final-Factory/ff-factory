import { devices, type Page } from '@playwright/test';
import { expect, moveViewport, ON_SCREEN_KEYBOARD, signIn, standInViewport, test, uniq } from './fixtures.ts';

// Safari on an iPad (with or without a hardware keyboard). Focusing a composer must not move the page:
// Safari floats its AutoFill bar (passwords, cards, contacts) over fields it may fill, shrinks the
// visual viewport by the bar's (or the keyboard's) height and pans it to reveal the field. The app
// follows the visual viewport (web/src/viewport.ts), so on screen the header stays put and only the
// composer lifts. A browser here has no such bar or keyboard: window.visualViewport is replaced by
// one the test moves the way Safari does (stand-in below). What Safari itself draws cannot be seen.

const IPAD = devices['iPad Pro 11'];
test.use({ viewport: IPAD.viewport, userAgent: IPAD.userAgent, deviceScaleFactor: IPAD.deviceScaleFactor, isMobile: IPAD.isMobile, hasTouch: IPAD.hasTouch });
test.skip(({ browserName }) => browserName !== 'webkit', "Safari's engine only (the mobile-safari project)");

const move = (page: Page, inset: number, pan: number) => moveViewport(page, inset, pan);

/** Where things are on screen: the page's own layout, less how far the visual viewport is panned. */
async function onScreen(page: Page) {
  return page.evaluate(() => {
    const vv = window.visualViewport!;
    const box = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { top: Math.round(r.top - vv.offsetTop), bottom: Math.round(r.bottom - vv.offsetTop) };
    };
    return { header: box('.orch-head'), composer: box('.orch .composer-box'), visible: Math.round(vv.height), scrollY: window.scrollY, scrollX: window.scrollX };
  });
}

async function home(page: Page) {
  await page.addInitScript(standInViewport);
  await signIn(page);
  await page.goto('/');
  await expect(page.locator('.orch .composer-box')).toBeVisible();
}

test('iPad: the composer is a message box, not a form field for AutoFill', async ({ page }) => {
  await home(page);
  const box = page.locator('.orch .composer textarea');
  await expect(box).toHaveAttribute('autocomplete', 'off');
  await expect(box).toHaveAttribute('data-1p-ignore', 'true');
  await expect(box).toHaveAttribute('data-lpignore', 'true');
  await expect(box).toHaveAttribute('autocapitalize', 'sentences');
  await expect(box).not.toHaveAttribute('name', /./);
  await expect(box).not.toHaveAttribute('id', /./);
  expect(await box.evaluate((el) => !!el.closest('form'))).toBe(false);
  // Nothing on the page looks like a login once signed in.
  expect(await page.locator('input[type="password"], [autocomplete="username"], [autocomplete="current-password"]').count()).toBe(0);
});

test('iPad: focusing the composer moves nothing, and no script scrolls the page', async ({ page }) => {
  await home(page);
  const before = await onScreen(page);
  await page.locator('.orch .composer textarea').focus();
  // viewport.ts follows the viewport for a second after a focus change.
  await page.waitForTimeout(1200);
  const after = await onScreen(page);
  expect(after.header.top).toBe(before.header.top);
  expect(after.composer.bottom).toBe(before.composer.bottom);
  expect([after.scrollX, after.scrollY]).toEqual([0, 0]);
});

test("iPad: Safari's shortcut bar (a hardware keyboard) lifts only the composer; the header stays put", async ({ page }) => {
  await home(page);
  const before = await onScreen(page);
  await page.locator('.orch .composer textarea').focus();

  // The bar takes 60 px at the bottom, and Safari pans the view by as much to reveal the field.
  await move(page, 60, 60);
  await expect.poll(async () => (await onScreen(page)).composer.bottom).toBeLessThanOrEqual(before.visible - 60);
  let now = await onScreen(page);
  expect(now.header.top).toBe(before.header.top);
  expect(now.composer.bottom).toBe(before.composer.bottom - 60);
  expect(now.scrollY).toBe(0);

  // The same bar without a pan (Safari did not need one): the same picture.
  await move(page, 60, 0);
  await expect.poll(async () => (await onScreen(page)).composer.bottom).toBe(before.composer.bottom - 60);
  now = await onScreen(page);
  expect(now.header.top).toBe(before.header.top);

  // The on-screen keyboard (no hardware keyboard): a lot taller, same rule.
  await move(page, 380, 120);
  await expect.poll(async () => (await onScreen(page)).composer.bottom).toBe(before.composer.bottom - 380);
  now = await onScreen(page);
  expect(now.header.top).toBe(before.header.top);
  expect(now.scrollY).toBe(0);

  // Gone again: everything back where it was.
  await move(page, 0, 0);
  await expect.poll(async () => (await onScreen(page)).composer.bottom).toBe(before.composer.bottom);
  expect((await onScreen(page)).header.top).toBe(before.header.top);
});

test('iPad: a viewport change that comes without an event is followed all the same', async ({ page }) => {
  await home(page);
  const before = await onScreen(page);
  await page.locator('.orch .composer textarea').focus();
  await page.waitForTimeout(150);
  // The bar lands and Safari pans, with no resize or scroll event after the focus.
  await moveViewport(page, 60, 60, true);
  await expect.poll(async () => (await onScreen(page)).header.top).toBe(before.header.top);
  expect((await onScreen(page)).composer.bottom).toBe(before.composer.bottom - 60);
});

// Enter follows the keyboard in use: with a hardware keyboard only Safari's shortcut bar (or nothing)
// covers the screen, and Enter sends as on a desktop; with the iPad's own keyboard Enter is a new line.

test('iPad with a hardware keyboard: Enter sends, Shift+Enter makes a new line', async ({ page }) => {
  await home(page);
  const tag = uniq('hwkb');
  const box = page.locator('.orch .composer textarea');
  await box.focus();
  await move(page, 60, 0);
  await box.pressSequentially(`first line ${tag}`);
  await box.press('Shift+Enter');
  await box.pressSequentially('second line');
  await expect(box).toHaveValue(`first line ${tag}\nsecond line`);
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);

  await box.press('Enter');
  const bubble = page.locator('.orch .msg-user', { hasText: tag });
  await expect(bubble.locator('.bubble-text')).toHaveText(`first line ${tag}\nsecond line`);
  await expect(box).toHaveValue('');
});

test("iPad with its own on-screen keyboard: Enter makes a new line, the Send button sends", async ({ page }) => {
  await home(page);
  const tag = uniq('oskb');
  const box = page.locator('.orch .composer textarea');
  await box.focus();
  await move(page, ON_SCREEN_KEYBOARD + 60, 0);
  await box.pressSequentially(`first line ${tag}`);
  await box.press('Enter');
  await box.pressSequentially('second line');
  await expect(box).toHaveValue(`first line ${tag}\nsecond line`);
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);

  await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.orch .msg-user', { hasText: tag }).locator('.bubble-text')).toHaveText(`first line ${tag}\nsecond line`);
});
