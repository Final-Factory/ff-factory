import type { Page } from '@playwright/test';
import { BOX, boxText, expect, moveViewport, ON_SCREEN_KEYBOARD, signIn, standInViewport, test, uniq } from './fixtures.ts';

// An iPad, in Safari (the ipad-safari project) and in Chrome (ipad-chrome: Chrome for iOS is WebKit
// with its own user agent, CriOS). With a hardware keyboard iPadOS floats a bar over the bottom of the
// screen (its shortcut bar, and Chrome's AutoFill bar on a form field, which the composer is not) and
// counts that part as covered: the visual viewport shrinks by up to 164 px although most of it still
// shows the page. The on-screen keyboard takes 300 px or more. The app (web/src/viewport.ts) keeps its
// full height under a bar and fits above a keyboard; either way it follows the pan Safari makes to
// reveal the box, so the header stays put. A browser here has neither bar nor keyboard: the tests
// move a stand-in window.visualViewport the way iPadOS does (fixtures.ts). What iPadOS draws, and
// whether Chrome's AutoFill bar really leaves a contenteditable box alone, cannot be seen here.

/** iPadOS's shortcut bar with a hardware keyboard. */
const BAR = 60;
/** The same bar with Chrome's AutoFill bar over a form field, measured on a 12.9" iPad on its side. */
const CHROME_BARS = 164;
/** The iPad's own keyboard, with its row of suggestions. */
const KEYBOARD = ON_SCREEN_KEYBOARD + 60;

const move = (page: Page, inset: number, pan: number) => moveViewport(page, inset, pan);

/** Where things are on screen: the page's own layout, less how far the visual viewport is panned. */
async function onScreen(page: Page) {
  return page.evaluate(() => {
    const vv = window.visualViewport!;
    const box = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { top: Math.round(r.top - vv.offsetTop), bottom: Math.round(r.bottom - vv.offsetTop) };
    };
    return {
      header: box('.orch-head'),
      composer: box('.orch .composer-box'),
      shell: Math.round(document.querySelector('.shell')!.getBoundingClientRect().height),
      layout: window.innerHeight,
      visible: Math.round(vv.height),
      scrollY: window.scrollY,
      scrollX: window.scrollX,
    };
  });
}

async function home(page: Page) {
  await page.addInitScript(standInViewport);
  await signIn(page);
  await page.goto('/');
  await expect(page.locator('.orch .composer-box')).toBeVisible();
  if (test.info().project.name === 'ipad-chrome') expect(await page.evaluate(() => navigator.userAgent)).toContain('CriOS/');
  return page.locator(`.orch ${BOX}`);
}

test('iPad: the composer is a contenteditable box, not a form field for AutoFill', async ({ page }) => {
  const box = await home(page);
  expect(await box.evaluate((el) => el.tagName)).toBe('DIV');
  await expect(box).toHaveAttribute('contenteditable', 'plaintext-only');
  await expect(box).toHaveAttribute('aria-multiline', 'true');
  await expect(box).toHaveAttribute('autocapitalize', 'sentences');
  // Nothing that asks for AutoFill, or for a password manager to stay away (which marks a form field).
  for (const attr of ['autocomplete', 'name', 'id', 'data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type']) {
    await expect(box, attr).not.toHaveAttribute(attr);
  }
  expect(await box.evaluate((el) => !!el.closest('form'))).toBe(false);
  // No form field anywhere in the composer (the image picker is a hidden file input).
  await expect(page.locator('.orch .composer :is(textarea, input:not([type="file"]), select)')).toHaveCount(0);
  // Nothing on the page looks like a login once signed in.
  expect(await page.locator('input[type="password"], [autocomplete="username"], [autocomplete="current-password"]').count()).toBe(0);
});

test('iPad: focusing the composer moves nothing, and no script scrolls the page', async ({ page }) => {
  const box = await home(page);
  const before = await onScreen(page);
  await box.focus();
  // viewport.ts follows the viewport for a second after a focus change.
  await page.waitForTimeout(1200);
  const after = await onScreen(page);
  expect(after.header.top).toBe(before.header.top);
  expect(after.composer.bottom).toBe(before.composer.bottom);
  expect(after.shell).toBe(after.layout);
  expect([after.scrollX, after.scrollY]).toEqual([0, 0]);
});

test('iPad with a hardware keyboard: its bar floats over the app, which keeps its full height', async ({ page }) => {
  const box = await home(page);
  const before = await onScreen(page);
  await box.focus();
  // The bar alone, then with Chrome's; each without a pan, then with the pan Safari makes to reveal the box.
  for (const [inset, pan] of [[BAR, 0], [BAR, BAR], [CHROME_BARS, 0], [CHROME_BARS, CHROME_BARS]]) {
    await move(page, inset, pan);
    await expect.poll(async () => (await onScreen(page)).header.top, `header, ${inset} px bar, ${pan} px pan`).toBe(before.header.top);
    const now = await onScreen(page);
    expect(now.visible).toBe(now.layout - inset);
    // No shorter app, so no dead band under it: the composer stays at the bottom, under the bar.
    expect(now.shell, `app height, ${inset} px bar`).toBe(now.layout);
    expect(now.composer.bottom).toBe(before.composer.bottom);
    expect([now.scrollX, now.scrollY]).toEqual([0, 0]);
  }
});

test('iPad with its own keyboard: only the composer lifts, just above the keyboard', async ({ page }) => {
  const box = await home(page);
  const before = await onScreen(page);
  await box.focus();

  await move(page, KEYBOARD, 120);
  await expect.poll(async () => (await onScreen(page)).composer.bottom).toBe(before.composer.bottom - KEYBOARD);
  let now = await onScreen(page);
  expect(now.shell).toBe(now.visible);
  expect(now.header.top).toBe(before.header.top);
  expect(now.scrollY).toBe(0);

  // Gone again (a hardware keyboard was connected): everything back where it was.
  await move(page, 0, 0);
  await expect.poll(async () => (await onScreen(page)).composer.bottom).toBe(before.composer.bottom);
  now = await onScreen(page);
  expect(now.header.top).toBe(before.header.top);
  expect(now.shell).toBe(now.layout);
});

test('iPad: a viewport change that comes without an event is followed all the same', async ({ page }) => {
  const box = await home(page);
  const before = await onScreen(page);
  await box.focus();
  await page.waitForTimeout(150);
  // The keyboard lands and Safari pans, with no resize or scroll event after the focus.
  await moveViewport(page, KEYBOARD, 120, true);
  await expect.poll(async () => (await onScreen(page)).composer.bottom).toBe(before.composer.bottom - KEYBOARD);
  expect((await onScreen(page)).header.top).toBe(before.header.top);
});

test('iPad: the caret stays in the box, where it was, while the page moves under it', async ({ page }) => {
  const box = await home(page);
  await box.focus();
  await box.pressSequentially('where is the caret');
  // In the middle of the text, so that a caret put back at the start or the end would show.
  for (let i = 0; i < 5; i++) await box.press('ArrowLeft');

  const caret = () =>
    page.evaluate(() => {
      const el = document.querySelector('.orch .composer [role="textbox"]')!;
      const sel = getSelection()!;
      const range = sel.getRangeAt(0);
      // A collapsed range has no box of its own in some engines: measure the character after it.
      const probe = range.cloneRange();
      probe.setEnd(range.startContainer, Math.min(range.startOffset + 1, (range.startContainer as Text).length ?? 0));
      const c = probe.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const vv = window.visualViewport!;
      return {
        focused: document.activeElement === el,
        inBox: el.contains(range.startContainer),
        text: (() => {
          const before = document.createRange();
          before.selectNodeContents(el);
          before.setEnd(range.startContainer, range.startOffset);
          return before.toString();
        })(),
        caret: { top: c.top, bottom: c.bottom, left: c.left },
        box: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
        visibleBottom: vv.offsetTop + vv.height,
      };
    });

  for (const [inset, pan] of [[BAR, 0], [CHROME_BARS, CHROME_BARS], [KEYBOARD, 120], [KEYBOARD, 0], [0, 0]]) {
    await move(page, inset, pan);
    // The caret is put back on the next frame.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const c = await caret();
    const at = `${inset} px covered, ${pan} px pan`;
    expect(c.focused, at).toBe(true);
    expect(c.inBox, at).toBe(true);
    expect(c.text, at).toBe('where is the ');
    expect(c.caret.top, at).toBeGreaterThanOrEqual(c.box.top - 1);
    expect(c.caret.bottom, at).toBeLessThanOrEqual(c.box.bottom + 1);
    expect(c.caret.left, at).toBeGreaterThanOrEqual(c.box.left - 1);
    expect(c.caret.left, at).toBeLessThanOrEqual(c.box.right + 1);
    // Above the keyboard, where it can be seen.
    if (inset === KEYBOARD) expect(c.caret.bottom, at).toBeLessThanOrEqual(c.visibleBottom);
  }
  // Typing goes on where the caret was.
  await box.pressSequentially('now ');
  await expect.poll(() => boxText(box)).toBe('where is the now caret');

  // Keys typed while the page moves stay where they were typed: on the next frame the caret is set
  // again where it is then, not where it was when the page moved (which would put it before them).
  await page.evaluate((inset) => {
    (window as unknown as { __vv: { set(inset: number, pan: number): void } }).__vv.set(inset, 0);
    document.execCommand('insertText', false, 'x');
    document.execCommand('insertText', false, 'y');
  }, KEYBOARD);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await box.pressSequentially('z');
  await expect.poll(() => boxText(box)).toBe('where is the now xyzcaret');
});

// Enter follows the keyboard in use: with a hardware keyboard only a bar (or nothing) covers the
// screen, and Enter sends as on a desktop; with the iPad's own keyboard Enter is a new line.

for (const inset of [BAR, CHROME_BARS]) {
  test(`iPad with a hardware keyboard (${inset} px bar): Enter sends, Shift+Enter makes a new line`, async ({ page }) => {
    const box = await home(page);
    const tag = uniq('hwkb');
    await box.focus();
    await move(page, inset, 0);
    await box.pressSequentially(`first line ${tag}`);
    await box.press('Shift+Enter');
    await box.pressSequentially('second line');
    await expect.poll(() => boxText(box)).toBe(`first line ${tag}\nsecond line`);
    await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);

    await box.press('Enter');
    const bubble = page.locator('.orch .msg-user', { hasText: tag });
    await expect(bubble.locator('.bubble-text')).toHaveText(`first line ${tag}\nsecond line`);
    await expect.poll(() => boxText(box)).toBe('');
  });
}

test('iPad with its own on-screen keyboard: Enter makes a new line, the Send button sends', async ({ page }) => {
  const box = await home(page);
  const tag = uniq('oskb');
  await box.focus();
  await move(page, KEYBOARD, 0);
  await box.pressSequentially(`first line ${tag}`);
  await box.press('Enter');
  await box.pressSequentially('second line');
  await expect.poll(() => boxText(box)).toBe(`first line ${tag}\nsecond line`);
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);

  await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.orch .msg-user', { hasText: tag }).locator('.bubble-text')).toHaveText(`first line ${tag}\nsecond line`);
});
