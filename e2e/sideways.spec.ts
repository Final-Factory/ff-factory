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
