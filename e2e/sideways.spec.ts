import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { appState, expect, isMobile, sendMessage, test, uniq, useTool } from './fixtures.ts';

/**
 * The chat scrolls only up and down (w1698; Ben, 2026-10-21, on his phone: "it's letting me scroll horizontally slightly in this
 * chat window ... It should only scroll vertically"). Wide content wraps instead of panning: a code block, a table, a long path
 * or id, a diagram, a picture, a clip and an ask_person card, at the two phone widths (375 is an iPhone SE or mini, 390 an iPhone 13).
 * Set SIDEWAYS_SHOTS to a folder to keep a screenshot of each width, the desktop's included.
 */

const LONG_PATH = 'C:/Users/Lothsahn/AppData/Local/Temp/ffa-7371c100/ffrepo/node_modules/@anthropic-ai/claude-agent-sdk/dist/some/very/long/path/to/a/file-with-a-really-long-name-that-never-breaks.ts';

async function wideChat(page: Page, tag: string) {
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w000-clips').replaceAll(path.sep, '/');
  const app = await appState(page.request);
  const md = [
    `Wide content ${tag}`,
    '',
    '```ts',
    'export async function reallyLongFunctionName(argumentNumberOne: string, argumentNumberTwo: number, argumentNumberThree: boolean) { return 1; }',
    '```',
    '',
    '| Column one | Column two | Column three | Column four | Column five | Column six |',
    '| --- | --- | --- | --- | --- | --- |',
    '| a long cell value here | another long cell value | yet another long cell value | more | words in cells | final column value |',
    '',
    `Path: ${LONG_PATH}`,
    '',
    'Id: 20261005T035612Z-crash-6102d405dc-6102d405dc-6102d405dc-6102d405dc and `inline-code-that-is-very-long-and-has-no-spaces-anywhere-at-all-in-it-so-it-overflows`',
    '',
    'https://github.com/Final-Factory/ff-factory/pull/1698/files?diff=split&w=0&very=long&query=string&that=never&breaks=anywhere&at=all',
    '',
    `![shot](<${review}/option-a-1280.png>)`,
    '',
    `![Halo clip](<${review}/clip.webm>)`,
    '',
    '```mermaid',
    'flowchart LR',
    '  OB[Orchestrator] -- request_work --> LED[(Work ledger)]',
    '  LED --> DSP{Dispatcher}',
    '  DSP --> WK[Workers]',
    '  WK --> A[Another long node label here] --> B[Yet another long node label] --> C[Final long node label]',
    '```',
  ].join('\n');
  await sendMessage(page.request, app.orchestratorId!, md);
  const reply = page.locator('.orch .msg-assistant', { hasText: tag });
  await expect(reply).toBeVisible();
  await expect(reply.locator('.md-mermaid-diagram svg')).toBeVisible({ timeout: 15_000 });
  await useTool(page.request, app.orchestratorId!, 'ask_person', {
    question: `Merge the belt fix ${tag} now, with a really-long-unbroken-identifier-${'x'.repeat(40)}?`,
    options: [
      { label: `Wait for the nightly (${tag})`, description: 'The fix stays on its branch until tomorrow morning.' },
      { label: `Merge ${tag} on green CI ${'y'.repeat(40)}`, description: `It reaches dev. ${LONG_PATH}`, recommended: true },
    ],
  });
  await expect(page.getByTestId('ask').filter({ hasText: tag }).last()).toBeVisible();
  // Pictures and the diagram settle (their sizes decide the layout).
  await page.waitForTimeout(1000);
  return reply;
}

async function shot(page: Page, name: string, reply: Locator) {
  const dir = process.env.SIDEWAYS_SHOTS;
  if (!dir) return;
  // The code block and the table at the top of the screen, the long path under them.
  await reply.locator('pre').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}-${test.info().project.name}.png`) });
}

for (const width of [375, 390]) {
  test(`the chat never scrolls sideways at ${width} px`, async ({ authed: page }) => {
    await page.setViewportSize({ width, height: 800 });
    const reply = await wideChat(page, uniq('side'));
    const m = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.orch .transcript-scroll')!;
      // Every box in the chat that a finger could pan sideways: it scrolls on that axis and has something to scroll to.
      const pannable = [scroller, ...scroller.querySelectorAll<HTMLElement>('*')]
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX))
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)} (${e.scrollWidth} px of ${e.clientWidth})`);
      return {
        vw: window.innerWidth,
        page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        chat: { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth },
        pannable,
      };
    });
    await shot(page, `phone-${width}`, reply);
    expect(m.page, `page is ${m.page} px wide in a ${m.vw} px viewport`).toBeLessThanOrEqual(m.vw);
    expect(m.chat.scrollWidth, 'the chat holds something wider than itself').toBeLessThanOrEqual(m.chat.clientWidth);
    expect(m.pannable, 'boxes in the chat that pan sideways').toEqual([]);
  });
}

test('the chat on a desktop, for the before and after (SIDEWAYS_SHOTS)', async ({ authed: page }) => {
  test.skip(!process.env.SIDEWAYS_SHOTS || isMobile(page), 'desktop screenshots only');
  const reply = await wideChat(page, uniq('desk'));
  await shot(page, 'desktop', reply);
});

/**
 * w1781 (Ben, on his Android phone: "The preview video is clipping off the screen on my phone"): a 1920x1080 clip, in a message
 * and in an ask_person card, stays inside the column with its caption, as the stills do. Phone widths 360 (a small Android) and
 * 412 (a Pixel). Set SIDEWAYS_SHOTS to keep a screenshot of each.
 */
const CLIP_CAPTION = 'A 45-second clip of setting it up in a built game with a caption that is long enough to need wrapping';

for (const width of [360, 412]) {
  test(`a 1920x1080 clip and its caption stay inside the column at ${width} px, in a message and in a card`, async ({ authed: page, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit builds cannot decode the WebM fixture and hide the player');
    await page.setViewportSize({ width, height: 800 });
    const port = new URL(test.info().project.use.baseURL!).port;
    const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review', 'w000-clips').replaceAll(path.sep, '/');
    const app = await appState(page.request);
    const tag = uniq('clip');
    const still = `![Option A at 1280](<${review}/option-a-1280.png>)`;
    const clip = `![${CLIP_CAPTION}](<${review}/clip-1080.mp4>)`;
    await sendMessage(page.request, app.orchestratorId!, `Clip in a message ${tag}\n\n${still}\n\n${clip}\n\n${still}`);
    const reply = page.locator('.orch .msg-assistant', { hasText: tag });
    await expect(reply).toBeVisible();
    await useTool(page.request, app.orchestratorId!, 'ask_person', {
      question: `Ship the halo ${tag}? ${still} ${still} ${clip}`,
      options: [
        { label: `Ship it (${tag})`, description: `As recorded. ${clip}`, recommended: true },
        { label: `Wait (${tag})`, description: `Not yet. ${still}` },
      ],
    });
    const card = page.getByTestId('ask').filter({ hasText: tag }).last();
    await expect(card).toBeVisible();
    await expect(reply.locator('video')).toHaveCount(1);
    await expect(card.locator('video')).toHaveCount(2);
    // The players take their size from the file's header (1920 x 1080): wait for it, so a layout that follows it shows.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('video')].filter((v) => v.currentSrc.includes('clip-1080') && v.videoWidth === 1920).length)).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.orch .transcript-scroll')!;
      const col = scroller.getBoundingClientRect();
      const colRight = col.left + scroller.clientWidth;
      const what = (e: Element) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 24)}`;
      const media = [...scroller.querySelectorAll('video, .md-video, .md-video-cap, .md-video-cap .ellipsis, .md-img img, .ask-media')].map((e) => {
        const r = e.getBoundingClientRect();
        const h = e as HTMLElement;
        return { el: what(e), right: Math.round(r.right), width: Math.round(r.width), scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, whiteSpace: getComputedStyle(e).whiteSpace };
      });
      return {
        vw: window.innerWidth,
        colRight: Math.round(colRight),
        chat: { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth },
        page: { scrollWidth: document.scrollingElement!.scrollWidth, clientWidth: document.scrollingElement!.clientWidth },
        media,
      };
    });
    const dir = process.env.SIDEWAYS_SHOTS;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      await reply.locator('video').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: path.join(dir, `clip-message-${width}.png`) });
      await card.locator('video').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: path.join(dir, `clip-card-${width}.png`) });
      fs.writeFileSync(path.join(dir, `clip-${width}.json`), JSON.stringify(m, null, 1));
    }
    expect(m.page.scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(m.page.clientWidth);
    expect(m.chat.scrollWidth, 'the chat holds something wider than itself').toBeLessThanOrEqual(m.chat.clientWidth);
    for (const e of m.media) {
      expect(e.right, `${e.el} runs past the column (right edge ${e.right} px, column ${m.colRight} px)`).toBeLessThanOrEqual(m.colRight + 1);
      expect(e.scrollWidth, `${e.el} holds ${e.scrollWidth} px in ${e.clientWidth}`).toBeLessThanOrEqual(e.clientWidth + 1);
      expect(e.whiteSpace, `${e.el} does not wrap`).not.toBe('pre');
    }
  });
}
