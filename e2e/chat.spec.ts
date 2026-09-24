import { expect, isMobile, test, uniq } from './fixtures.ts';

// The orchestrator is one conversation shared by every test on a server: each test finds its own
// messages by a unique tag, never by position.

test('orchestrator: Enter sends, Shift+Enter makes a new line (desktop keyboards)', async ({ authed: page }) => {
  test.skip(isMobile(page), 'touch keyboards: see the next test');
  const tag = uniq('chat');
  const box = page.locator('.orch .composer textarea');

  await box.fill(`first line ${tag}`);
  await box.press('Shift+Enter');
  await box.pressSequentially('second line');
  await expect(box).toHaveValue(`first line ${tag}\nsecond line`);
  // Nothing was sent by the Shift+Enter.
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);

  await box.press('Enter');
  const bubble = page.locator('.orch .msg-user', { hasText: tag });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.bubble-text')).toHaveText(`first line ${tag}\nsecond line`);
  await expect(box).toHaveValue('');
  await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: first line ${tag}` })).toBeVisible();

  // An empty box: Enter does nothing (no empty message).
  await box.press('Enter');
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(1);
});

test('orchestrator: on a touch keyboard Enter is a new line and the Send button sends', async ({ authed: page }) => {
  test.skip(!isMobile(page), 'desktop keyboards: see the previous test');
  const tag = uniq('chat');
  const box = page.locator('.orch .composer textarea');

  // By design (Composer.tsx, shared/keys.ts): a phone has no Shift key, so Enter never sends there.
  await box.fill(`first line ${tag}`);
  await box.press('Enter');
  await box.pressSequentially('second line');
  await expect(box).toHaveValue(`first line ${tag}\nsecond line`);
  await expect(page.locator('.orch .msg-user', { hasText: tag })).toHaveCount(0);
  // The placeholder does not advertise Enter to send on a phone.
  await expect(box).toHaveAttribute('placeholder', 'Message the orchestrator');

  await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  const bubble = page.locator('.orch .msg-user', { hasText: tag });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.bubble-text')).toHaveText(`first line ${tag}\nsecond line`);
  await expect(box).toHaveValue('');
  await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: first line ${tag}` })).toBeVisible();
  // With the box empty again, the primary slot is voice mode, not Send.
  await expect(page.locator('.orch .composer').getByRole('button', { name: 'Voice mode' })).toBeVisible();
});
