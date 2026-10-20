import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { RED_PNG } from './fakeAgent.ts';
import type { Locator, Page } from '@playwright/test';
import { ALPHA, BOX, GALLERY, appState, expect, machineSandbox, openSandbox, pastePng, sendMessage, startWorker, test, uniq, useTool } from './fixtures.ts';

/** The images are on screen and actually decoded (a broken link has no natural size). */
async function expectLoaded(images: Locator) {
  await expect(images.first()).toBeVisible();
  await expect.poll(() => images.evaluateAll((els) => els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0))).toBe(true);
}

/**
 * Scroll an orchestrator's reply into view, as its reader would: its images load lazily, once on screen. Other tests write
 * to this orchestrator too, so a reply can be pushed out of view, and a click on an image scrolls the chat off the bottom,
 * after which it no longer follows new messages. The streamed reply is replaced by the stored one: until it holds.
 */
async function onScreen(reply: Locator) {
  await expect(async () => reply.scrollIntoViewIfNeeded({ timeout: 1_000 })).toPass();
}

/**
 * Open the lightbox from `trigger`. A chat moves while a reply streams into it (its own, or in an orchestrator's chat
 * another test's), so a click can land where the image was a moment before: click again until it opens.
 */
async function openLightbox(page: Page, trigger: Locator) {
  await expect(async () => {
    if (!(await page.locator('.lightbox').count())) await trigger.click({ timeout: 2_000 });
    await expect(page.locator('.lightbox img').first()).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

async function workerPage(page: Page, prompt: string) {
  const tag = uniq('img');
  const s = await startWorker(page.request, `${prompt} ${tag}`, { title: `Images ${tag}` });
  const panel = await openSandbox(page, ALPHA, s.id);
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
  await openLightbox(page, bubble.locator('.img-thumb'));
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

test("the orchestrator's messages show images from any sandbox, markdown or bare path, with the lightbox", async ({ authed: page }) => {
  const tag = uniq('orchimg');
  const app = await appState(page.request);
  const gallery = machineSandbox(app, GALLERY);
  const shot = `${gallery.path}${gallery.path.includes('\\') ? '\\' : '/'}Screenshots${gallery.path.includes('\\') ? '\\' : '/'}orch-proof.png`;
  // The fake orchestrator echoes the message: its reply carries a markdown image of a sandbox file, then the same file by bare path.
  await sendMessage(page.request, app.orchestratorId!, `before and after ![after](${shot}) ${tag}`);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  await expect(reply).toBeVisible();
  await onScreen(reply);
  // The markdown image shows where it is in the text, not again in the strip.
  await expectLoaded(reply.locator('.md .md-img img'));
  await expect(reply.locator('.img-strip img')).toHaveCount(0);
  await openLightbox(page, reply.locator('.md-img').first());
  await expectLoaded(page.locator('.lightbox img'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.lightbox')).toHaveCount(0);

  await sendMessage(page.request, app.orchestratorId!, `bare ${shot} ${tag}-bare`);
  const bare = page.locator('.orch .msg-assistant', { hasText: `${tag}-bare` });
  await onScreen(bare);
  await expectLoaded(bare.locator('.img-strip img'));
  await expect(bare.locator('.md img')).toHaveCount(0);
  // Outside every root the orchestrator oversees: refused by the server.
  const denied = await page.request.get(`/api/image?${new URLSearchParams({ session: app.orchestratorId!, path: shot.replace(/[\\/]ffsb[\\/]gallery[\\/].*$/, '/elsewhere.png') })}`);
  expect(denied.status()).toBe(404);
});

const b64 = (s: string) => Buffer.from(s).toString('base64');
const HOSTILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30" onload="alert(1)"><script>alert(2)</script>' +
  '<foreignObject width="60" height="30"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
  '<image href="https://example.invalid/pixel.png" width="1" height="1"/><rect width="60" height="30" fill="#2a2"/></svg>';

test('inline images: a PNG and an SVG file, PNG and SVG data URIs, sanitised, kept after the files are gone', async ({ authed: page }) => {
  const tag = uniq('inline');
  const app = await appState(page.request);
  const alpha = machineSandbox(app, ALPHA);
  const dir = path.join(alpha.path, 'Screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const png = path.join(dir, `${tag}.png`);
  const svg = path.join(dir, `${tag}.svg`);
  fs.writeFileSync(png, Buffer.from(RED_PNG, 'base64'));
  fs.writeFileSync(svg, HOSTILE_SVG);
  const dialogs: string[] = [];
  page.on('dialog', (d) => (dialogs.push(d.message()), void d.dismiss()));

  await sendMessage(
    page.request,
    app.orchestratorId!,
    `Proofs ${tag}: ![the png](${png}) ![the svg](${svg}) ![data png](data:image/png;base64,${RED_PNG}) ![data svg](data:image/svg+xml;base64,${b64(HOSTILE_SVG)})`,
  );
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  const images = reply.locator('.md .md-img img');
  await expect(images).toHaveCount(4);
  await onScreen(reply);
  await expectLoaded(images);
  await expect(reply.locator('.img-strip img')).toHaveCount(0);

  // The data SVG is shown rebuilt by the sanitiser, the file SVG as the server sanitised it.
  const dataSvg = decodeURIComponent((await images.nth(3).getAttribute('src'))!.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
  expect(dataSvg).toContain('<rect width="60" height="30" fill="#2a2"/>');
  expect(dataSvg).not.toMatch(/script|onload|foreignObject|example\.invalid/i);
  const served = await page.request.get(`/api/image?${new URLSearchParams({ session: app.orchestratorId!, path: svg })}`);
  expect(served.headers()['content-type']).toBe('image/svg+xml');
  expect(served.headers()['content-security-policy']).toContain('sandbox');
  expect(await served.text()).not.toMatch(/script|onload|foreignObject|example\.invalid/i);

  // A click opens it full size.
  await openLightbox(page, images.nth(1));
  await expectLoaded(page.locator('.lightbox img'));
  await page.keyboard.press('Escape');

  // The server copies the files into the transcript's store as the reply arrives; the page then shows the copies.
  await expect.poll(() => images.nth(0).getAttribute('src')).toContain('/api/uploads/');
  await expect.poll(() => images.nth(1).getAttribute('src')).toContain('/api/uploads/');
  fs.rmSync(png);
  fs.rmSync(svg);
  await page.reload();
  const again = page.locator('.orch .msg-assistant', { hasText: tag }).locator('.md .md-img img');
  await expect(again).toHaveCount(4);
  await onScreen(page.locator('.orch .msg-assistant', { hasText: tag }));
  await expectLoaded(again);
  expect(dialogs).toEqual([]);
});

test('a data URI that is not a safe image is not shown', async ({ authed: page }) => {
  const tag = uniq('baddata');
  const app = await appState(page.request);
  await sendMessage(page.request, app.orchestratorId!, `Nope ${tag}: ![html](data:image/svg+xml;base64,${b64('<html><script>alert(1)</script></html>')}) ![text](data:text/html;base64,${b64('<b>x</b>')})`);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  await expect(reply).toBeVisible();
  await expect(reply.locator('.md img')).toHaveCount(0);
  await expect(reply.locator('.md code', { hasText: 'html (not shown)' })).toBeVisible();
});

const FLOW = ['Diagram:', '', '```mermaid', 'flowchart LR', '  OB[Orchestrator] -- request_work --> LED[(Work ledger)]', '  LED --> DSP{Dispatcher}', '  DSP --> WK[Workers]', '```'].join('\n');

test('a mermaid block renders as a diagram, with its source a click away', async ({ authed: page }) => {
  const tag = uniq('mermaid');
  const app = await appState(page.request);
  await sendMessage(page.request, app.orchestratorId!, `${FLOW}\n\n${tag}`);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  const block = reply.locator('.md-mermaid');
  const diagram = block.locator('.md-mermaid-diagram svg');
  await expect(diagram).toBeVisible({ timeout: 15_000 });
  await expect(diagram).toContainText('Dispatcher');
  await expect(diagram.locator('script')).toHaveCount(0);
  expect((await diagram.boundingBox())!.width).toBeLessThanOrEqual((await reply.boundingBox())!.width + 1);

  await block.getByRole('button', { name: 'Source' }).click();
  await expect(block.locator('pre code')).toContainText('flowchart LR');
  await expect(diagram).toHaveCount(0);
  await block.getByRole('button', { name: 'Diagram' }).click();
  await expect(diagram).toBeVisible();

  // Full size in the lightbox.
  await openLightbox(page, block.getByRole('button', { name: 'Open diagram large' }));
  await expectLoaded(page.locator('.lightbox img'));
  await page.keyboard.press('Escape');

  // One that does not parse shows its source and why.
  const bad = uniq('mermaidbad');
  await sendMessage(page.request, app.orchestratorId!, `Broken:\n\n\`\`\`mermaid\nflowchart LR\n  A --> \n  ((((\n\`\`\`\n\n${bad}`);
  const broken = page.locator('.orch .msg-assistant', { hasText: bad }).locator('.md-mermaid');
  await expect(broken.locator('.md-mermaid-error')).toBeVisible({ timeout: 15_000 });
  await expect(broken.locator('pre code')).toContainText('flowchart LR');
});

test("w1419: an orchestrator's message shows review stills and clips written ![x](</srv/…>), on load and after a reload", async ({ authed: page, browserName }) => {
  // Ben, 2026-10-16: "I need to see screenshots of what you're talking about", then "i dont see any previews". The review
  // folder the e2e server seeds (e2e/server.ts, review.root outside the sandboxes, as on the portal): a still, a clip, and the clip as .mp4.
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w000-clips').replace(/\\/g, '/');
  const still = `${review}/option-a-1280.png`;
  const webm = `${review}/clip.webm`;
  const mp4 = `${review}/clip.mp4`;
  const tag = uniq('w1419');
  const app = await appState(page.request);
  // The fake orchestrator echoes the message: its reply carries the three, as Ben's orchestrator wrote them.
  await sendMessage(page.request, app.orchestratorId!, `Option A ![Option A at 1280](<${still}>)\n\nThe clip ![clip](<${webm}>)\n\nAnd as mp4 ![clip mp4](<${mp4}>) ${tag}`);
  const check = async () => {
    const reply = page.locator('.orch .msg-assistant', { hasText: tag });
    await onScreen(reply);
    await expectLoaded(reply.locator('.md .md-img img'));
    // The still did not fall back to its alt text as code (what a failed load shows).
    await expect(reply.locator('.md code', { hasText: /^Option A at 1280$/ })).toHaveCount(0);
    // Both clips are served to this chat, with ranges, in every browser.
    for (const clip of [webm, mp4]) {
      const r = await page.request.get(`/api/image?${new URLSearchParams({ session: app.orchestratorId!, path: clip })}`, { headers: { Range: 'bytes=0-99' } });
      expect(r.status(), clip).toBe(206);
    }
    // Playwright's Chromium decodes the WebM fixture (its WebKit cannot, and shows the alt instead): both play, metadata first.
    if (browserName === 'chromium') {
      await expect(reply.locator('.md .md-video video')).toHaveCount(2);
      await expect(reply.locator('.md code', { hasText: /^clip( mp4)?$/ })).toHaveCount(0);
      const v = reply.locator('.md .md-video video').first();
      await expect.poll(() => v.evaluate((e: HTMLVideoElement) => (e.readyState >= 1 ? Math.round(e.duration) : -1))).toBe(2);
    }
  };
  await check();
  // After a reload: the stored reply, with what the server kept of it (server/inlineImages.ts), shows them the same.
  await page.reload();
  await check();
});

test('w1419: a question with buttons (ask_person) shows the stills and clips its question and options name', async ({ authed: page, browserName }) => {
  // Since w1397 every question to the person goes through ask_person ("Ask every question to Ben with ask_person"), and a
  // [needs you] look-to-OK is asked with it: its media must show in the card, not as "![Option A at 1280](</srv/…>)" text.
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w000-clips').replace(/\\/g, '/');
  const tag = uniq('w1419ask');
  const me = await appState(page.request);
  const q = {
    question: `Where should Save New Blueprint go (${tag})? ![Today](<${review}/option-a-1280.png>)`,
    options: [
      { label: `Option A, left of the item rows (${tag})`, description: `Left of the hotbar. ![Option A at 1280](<${review}/option-a-1280.png>)`, recommended: true },
      { label: `Option B, above the hint (${tag})`, description: `Above the held-blueprint hint. ![Option B clip](<${review}/clip.webm>)` },
    ],
  };
  expect(await useTool(page.request, me.orchestratorId, 'ask_person', q)).not.toMatch(/^ERROR/);
  const card = page.getByTestId('ask').filter({ hasText: `Where should Save New Blueprint go (${tag})?` });
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  // The question's still, and each option's, shown and decoded; no image syntax left as text.
  await expectLoaded(card.locator('.md-img img'));
  await expect(card.locator('.md-img img')).toHaveCount(2);
  // The clip is a player in Chromium; WebKit cannot decode the WebM fixture and shows its alt, as it would any clip it cannot play.
  await expect(card.locator(browserName === 'chromium' ? '.md-video video' : '.md-video video, .ask-media code')).toHaveCount(1);
  await expect(card).not.toContainText('![');
  await expect(card).not.toContainText('](<');
  // The words stay: the option's text in its button, its media under it, outside the button (a click on a still opens it, not the answer).
  const optionA = card.getByTestId('ask-option').filter({ hasText: `Option A, left of the item rows (${tag})` });
  await expect(optionA).toContainText('Left of the hotbar.');
  await expect(optionA.locator('img, video')).toHaveCount(0);
  if (browserName === 'chromium') {
    const v = card.locator('.md-video video').first();
    await expect.poll(() => v.evaluate((e: HTMLVideoElement) => (e.readyState >= 1 ? Math.round(e.duration) : -1))).toBe(2);
  }
  // The answer is still one click, and its words are the label alone.
  await optionA.click();
  await expect(optionA).toContainText('Your answer');
});

test("w1602: the Warden question's shape: a message with its clips, then a card that carries its own previews; a card without them is refused", async ({ authed: page, browserName }) => {
  // Ben, 2026-10-19: the clips were in the message above the ask_person card, not in it: "when you ask me about visual things
  // you have to include the previews". The message shows its clips; the call is refused until the card carries them too.
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w000-clips').replace(/\\/g, '/');
  const tag = uniq('w1602');
  const me = await appState(page.request);
  await sendMessage(page.request, me.orchestratorId!, `The Warden (w000) halo, as recorded ${tag}:\n\n![Halo clip](<${review}/clip.webm>)`);
  const message = page.locator('.orch .msg-assistant', { hasText: tag });
  await onScreen(message);
  if (browserName === 'chromium') await expect(message.locator('.md-video video')).toHaveCount(1);
  const bare = {
    question: `Is the Warden halo of w000 right as it is (${tag})?`,
    options: [
      { label: `OK as is (${tag})`, description: 'Ship it.', recommended: true },
      { label: `Add beads to the halo (${tag})`, description: 'Re-record w000.' },
    ],
  };
  const refused = await useTool(page.request, me.orchestratorId!, 'ask_person', bare);
  expect(refused).toMatch(/Not shown yet: your question names w000/);
  expect(refused).toMatch(/!\[[^\]]+\]\(<[^>]*\/review\/w000-[^>]+\.(png|webm)>\)/);
  await expect(page.getByTestId('ask').filter({ hasText: tag })).toHaveCount(0);
  const withMedia = {
    ...bare,
    question: `${bare.question} ![Halo today](<${review}/option-a-1280.png>)`,
    options: [{ ...bare.options[0], description: `Ship it. ![Halo clip](<${review}/clip.webm>)` }, bare.options[1]],
  };
  expect(await useTool(page.request, me.orchestratorId!, 'ask_person', withMedia)).not.toMatch(/Not shown yet|^ERROR/);
  const card = page.getByTestId('ask').filter({ hasText: tag });
  await card.scrollIntoViewIfNeeded();
  await expectLoaded(card.locator('.md-img img'));
  await expect(card.locator(browserName === 'chromium' ? '.md-video video' : '.md-video video, .ask-media code')).toHaveCount(1);
});

test('w1419: a long orchestrator message with six review stills between its paragraphs shows them all', async ({ authed: page }) => {
  // The shape of Ben's orchestrator's message of 2026-10-16 23:23 UTC: a TL;DR, then each option's words and its stills
  // as ![Option A at 1280](</srv/fff/review/…png>) lines, then the question. He saw none of them (Firefox).
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w000-options').replace(/\\/g, '/');
  const tag = uniq('w1419long');
  const app = await appState(page.request);
  const names = ['1-option-A-left-of-item-rows-1920', '2-option-A-left-of-item-rows-1280', '3-option-B-above-hint-1920', '4-option-B-above-hint-1280', '5-tried-left-of-abilities-1920', '6-tried-left-of-abilities-1280'];
  const body = [
    `**TL;DR:** two places for Save New Blueprint; I recommend A. ${tag}`,
    `**Option A**, left of the hotbar's item rows:\n\n![Option A at 1920](<${review}/${names[0]}.png>)\n\n![Option A at 1280](<${review}/${names[1]}.png>)`,
    `**Option B**, above the held-blueprint hint:\n\n![Option B at 1920](<${review}/${names[2]}.png>)\n\n![Option B at 1280](<${review}/${names[3]}.png>)`,
    `What I tried first, left of the abilities, overlaps the station controls:\n\n![Tried at 1920](<${review}/${names[4]}.png>) ![Tried at 1280](<${review}/${names[5]}.png>)`,
    'Which one?',
  ].join('\n\n');
  await sendMessage(page.request, app.orchestratorId!, body);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  await onScreen(reply);
  const imgs = reply.locator('.md .md-img img');
  await expect(imgs).toHaveCount(6);
  // Each one decoded once it is on screen, as its reader scrolls down the message.
  for (let i = 0; i < 6; i++) {
    await imgs.nth(i).scrollIntoViewIfNeeded();
    await expect.poll(() => imgs.nth(i).evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0), { message: names[i] }).toBe(true);
  }
  await expect(reply.locator('.md code', { hasText: /^(Option [AB]|Tried) at \d+$/ })).toHaveCount(0);
});

test('w1419: an image of a review still written with a slightly wrong name still shows (the outgoing check points it at the file)', async ({ authed: page }) => {
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w000-options').replace(/\\/g, '/');
  const tag = uniq('w1419near');
  const app = await appState(page.request);
  // "_1280" for "-1280" and a capital O: what an orchestrator writes from memory. The file is 2-option-A-left-of-item-rows-1280.png.
  await sendMessage(page.request, app.orchestratorId!, `Option A ![Option A at 1280](<${review}/2-Option-A-left-of-item-rows_1280.png>) ${tag}`);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  await onScreen(reply);
  await expectLoaded(reply.locator('.md .md-img img'));
  await expect(reply.locator('.md code', { hasText: 'Option A at 1280' })).toHaveCount(0);
});

test("w1419: Ben's message of 19:53 UTC as it was written: stills on the line after a paragraph and inside list items", async ({ authed: page }) => {
  // seq 34406 of Ben's orchestrator (2026-10-16 19:53 UTC), its image lines verbatim, each on the line after its text with a
  // single newline; in the bullets the image is the line right after "- **…:** text". The files are the real names.
  const port = new URL(test.info().project.use.baseURL!).port;
  const dir = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w1386-save-blueprint-options');
  fs.mkdirSync(dir, { recursive: true });
  const names = ['2-option-A-left-of-item-rows-1280', '2-option-A-left-of-item-rows-1920', '2-option-A-left-of-item-rows-1920-nothing-selected', '3-option-B-above-the-hint-1280', '3-option-B-above-the-hint-1920', '4-tried-beside-quick-buttons-1920', '4-tried-on-the-hint-line-1280', '4-tried-left-of-abilities-1280'];
  for (const n of names) fs.writeFileSync(path.join(dir, `${n}.png`), Buffer.from(RED_PNG, 'base64'));
  const p = dir.replace(/\\/g, '/');
  const tag = uniq('w1419exact');
  const text = [
    `**Thread 1085: where Save New Blueprint goes.** ${tag}`,
    '',
    'Option A puts it left of the hotbar\'s item rows (recommended):',
    `![Option A, 1280x800](<${p}/${names[0]}.png>)`,
    `![Option A, 1920x1080](<${p}/${names[1]}.png>)`,
    `![Option A, 1920x1080, nothing selected](<${p}/${names[2]}.png>)`,
    '',
    'Option B puts it above the held-blueprint hint:',
    `![Option B, 1280x800](<${p}/${names[3]}.png>)`,
    `![Option B, 1920x1080](<${p}/${names[4]}.png>)`,
    '',
    'What it tried first:',
    `- **Beside the Blueprints quick button:** crowds the quick buttons.`,
    `![Beside the Blueprints quick button](<${p}/${names[5]}.png>)`,
    `- **On the hint's line:** covers the hint.`,
    `![On the hint's line](<${p}/${names[6]}.png>)`,
    `- **Left of the abilities:** overlaps the station controls.`,
    `![Left of the abilities](<${p}/${names[7]}.png>)`,
    '',
    'A or B?',
  ].join('\n');
  const app = await appState(page.request);
  await sendMessage(page.request, app.orchestratorId!, text);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  await onScreen(reply);
  const imgs = reply.locator('.md .md-img img');
  await expect(imgs).toHaveCount(8);
  for (let i = 0; i < 8; i++) {
    await imgs.nth(i).scrollIntoViewIfNeeded();
    await expect.poll(() => imgs.nth(i).evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0), { message: names[i] }).toBe(true);
  }
  await expect(reply.locator('.md code', { hasText: /^(Option [AB],|Beside|On the hint|Left of)/ })).toHaveCount(0);
});

/** A 1920x1080 PNG of noise (it does not compress): about 6 MB, the size of a real full-screen still. */
function noisePng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 3 + 1) === 0 ? 0 : (Math.random() * 256) | 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('w1419: a full-size review still (1920x1080, about 6 MB) in an orchestrator message loads', async ({ authed: page }) => {
  const port = new URL(test.info().project.use.baseURL!).port;
  const dir = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w000-big');
  fs.mkdirSync(dir, { recursive: true });
  const files = ['a-1920.png'].map((n) => path.join(dir, n));
  for (const f of files) if (!fs.existsSync(f)) fs.writeFileSync(f, noisePng(1920, 1080));
  const tag = uniq('w1419big');
  const app = await appState(page.request);
  await sendMessage(page.request, app.orchestratorId!, `A full-size still: ${tag}\n${files.map((f, i) => `![Still ${i + 1}](<${f.replace(/\\/g, '/')}>)`).join('\n')}`);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  await onScreen(reply);
  const imgs = reply.locator('.md .md-img img');
  await expect(imgs).toHaveCount(1);
  for (let i = 0; i < 1; i++) {
    await imgs.nth(i).scrollIntoViewIfNeeded();
    await expect.poll(() => imgs.nth(i).evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth === 1920), { timeout: 20_000 }).toBe(true);
  }
});
