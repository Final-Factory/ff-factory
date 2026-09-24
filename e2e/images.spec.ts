import { RED_PNG } from './fakeAgent.ts';
import type { Locator, Page } from '@playwright/test';
import { BOX, expect, openSandbox, pastePng, startWorker, test, uniq } from './fixtures.ts';

/** The images are on screen and actually decoded (a broken link has no natural size). */
async function expectLoaded(images: Locator) {
  await expect(images.first()).toBeVisible();
  await expect.poll(() => images.evaluateAll((els) => els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0))).toBe(true);
}

async function workerPage(page: Page, prompt: string) {
  const tag = uniq('img');
  const s = await startWorker(page.request, `${prompt} ${tag}`, { title: `Images ${tag}` });
  const panel = await openSandbox(page, 'alpha', s.id);
  // The first turn is done before the test goes on (its reply is on screen, marked finished).
  await expect(panel.locator('.msg-assistant[data-turn-end]')).toHaveCount(1);
  return { panel, tag };
}

test('image paste: a thumbnail in the composer, then inline in the transcript, and the agent got it', async ({ authed: page }) => {
  const { panel, tag } = await workerPage(page, 'setup');
  const box = panel.locator(BOX);

  await pastePng(page, `.sb-panel ${BOX}`, RED_PNG);
  const preview = panel.locator('.composer-image img');
  await expectLoaded(preview);
  // A pasted image alone is enough to send: the primary slot turns into Send.
  const send = panel.locator('.composer').getByRole('button', { name: 'Send' });
  await expect(send).toBeVisible();

  // Removing it and pasting again (the x on the thumbnail).
  await panel.getByRole('button', { name: 'Remove image' }).click();
  await expect(preview).toHaveCount(0);
  await pastePng(page, `.sb-panel ${BOX}`, RED_PNG);
  await expect(preview).toHaveCount(1);

  await box.fill(`look at this ${tag}`);
  await send.click();
  await expect(preview).toHaveCount(0);

  const bubble = panel.locator('.msg-user', { hasText: `look at this ${tag}` });
  await expect(bubble).toBeVisible();
  await expectLoaded(bubble.locator('.img-strip img'));
  await expect(panel.locator('.msg-assistant', { hasText: `Echo: look at this ${tag} (1 image)` })).toBeVisible();

  // A click opens the lightbox.
  await bubble.locator('.img-thumb').click();
  await expectLoaded(page.locator('.lightbox img'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.lightbox')).toHaveCount(0);
});

test('a tool result with a screenshot shows the image inline', async ({ authed: page }) => {
  const { panel } = await workerPage(page, '#screenshot');
  // The tool call is folded into one line ("Used 1 tool · Read: …"); its image shows without opening it.
  const tool = panel.locator('.activity', { hasText: 'Screenshots/proof.png' });
  await expect(tool).toBeVisible();
  await expect(tool).not.toHaveClass(/\bopen\b/);
  await expectLoaded(tool.locator('.img-strip img'));
  await expect(panel.locator('.msg-assistant', { hasText: 'Here is the screenshot.' })).toBeVisible();
});
