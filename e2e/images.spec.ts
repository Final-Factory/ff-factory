import fs from 'node:fs';
import path from 'node:path';
import { RED_PNG } from './fakeAgent.ts';
import type { Locator, Page } from '@playwright/test';
import { ALPHA, BOX, GALLERY, appState, expect, machineSandbox, openSandbox, pastePng, sendMessage, startWorker, test, uniq } from './fixtures.ts';

/** The images are on screen and actually decoded (a broken link has no natural size). */
async function expectLoaded(images: Locator) {
  await expect(images.first()).toBeVisible();
  await expect.poll(() => images.evaluateAll((els) => els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0))).toBe(true);
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

test("the orchestrator's messages show images from any sandbox, markdown or bare path, with the lightbox", async ({ authed: page }) => {
  const tag = uniq('orchimg');
  const app = await appState(page.request);
  const gallery = machineSandbox(app, GALLERY);
  const shot = `${gallery.path}${gallery.path.includes('\\') ? '\\' : '/'}Screenshots${gallery.path.includes('\\') ? '\\' : '/'}orch-proof.png`;
  // The fake orchestrator echoes the message: its reply carries a markdown image of a sandbox file, then the same file by bare path.
  await sendMessage(page.request, app.orchestratorId!, `before and after ![after](${shot}) ${tag}`);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  await expect(reply).toBeVisible();
  // The markdown image shows where it is in the text, not again in the strip.
  await expectLoaded(reply.locator('.md .md-img img'));
  await expect(reply.locator('.img-strip img')).toHaveCount(0);
  await reply.locator('.md-img').first().click();
  await expectLoaded(page.locator('.lightbox img'));
  await page.keyboard.press('Escape');
  await expect(page.locator('.lightbox')).toHaveCount(0);

  await sendMessage(page.request, app.orchestratorId!, `bare ${shot} ${tag}-bare`);
  const bare = page.locator('.orch .msg-assistant', { hasText: `${tag}-bare` });
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
  await images.nth(1).click();
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
  await block.getByRole('button', { name: 'Open diagram large' }).click();
  await expectLoaded(page.locator('.lightbox img'));
  await page.keyboard.press('Escape');

  // One that does not parse shows its source and why.
  const bad = uniq('mermaidbad');
  await sendMessage(page.request, app.orchestratorId!, `Broken:\n\n\`\`\`mermaid\nflowchart LR\n  A --> \n  ((((\n\`\`\`\n\n${bad}`);
  const broken = page.locator('.orch .msg-assistant', { hasText: bad }).locator('.md-mermaid');
  await expect(broken.locator('.md-mermaid-error')).toBeVisible({ timeout: 15_000 });
  await expect(broken.locator('pre code')).toContainText('flowchart LR');
});
