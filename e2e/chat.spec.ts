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
