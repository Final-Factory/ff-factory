import type { APIRequestContext, BrowserContextOptions, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOX, appState, expect, expectNoHorizontalOverflow, expectTapTargets, isMobile, sendToChat, test, uniq, useTool } from './fixtures.ts';
import type { TranscriptEvent } from '../shared/types.ts';
import { REPLY_MARK } from '../shared/replies.ts';
import { HELD_MARK } from '../shared/conditional.ts';

/**
 * Questions the orchestrator asks with buttons (w1397, docs/orchestrators.md "Questions with buttons"). The fake agent
 * calls the real `ask_person` tool ("#tool ask_person {...}"), so the question is a real tool_use in the chat. A click is
 * your own reply to it; "Chat more about this" sends nothing. Set ASK_SHOTS to a folder to keep screenshots of the card.
 */

async function transcript(request: APIRequestContext, id: string): Promise<TranscriptEvent[]> {
  const r = await request.get(`/api/sessions/${id}/events?limit=500`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

const questionFor = (tag: string) => ({
  question: `Merge the belt fix for ${tag} now, or wait for the nightly?`,
  options: [
    { label: `Wait for the nightly (${tag})`, description: 'The fix stays on its branch until tomorrow morning.' },
    { label: `Merge ${tag} on green CI`, description: 'It reaches the development branch within the hour.', recommended: true },
    { label: `Hold ${tag} until Ben has watched the clip`, description: 'Nothing merges; the worker waits.' },
  ],
});

async function ask(page: Page, tag: string) {
  const q = questionFor(tag);
  const me = await appState(page.request);
  await useTool(page.request, me.orchestratorId, 'ask_person', q);
  const card = page.getByTestId('ask').filter({ hasText: q.question });
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  return { q, card, orchestratorId: me.orchestratorId };
}

async function shot(page: Page, name: string, locator?: ReturnType<Page['getByTestId']>) {
  const dir = process.env.ASK_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${isMobile(page) ? 'phone' : 'desktop'}.png`);
  await (locator ?? page).screenshot({ path: file });
}

test('ask: the card shows the question, the recommended option first and marked, and "Chat more about this" last', async ({ authed: page }) => {
  const { q, card } = await ask(page, uniq('look'));
  const options = card.getByTestId('ask-option');
  await expect(options).toHaveCount(3);
  // The orchestrator listed its pick second; the card shows it first.
  await expect(options.nth(0)).toContainText(q.options[1].label);
  await expect(options.nth(0)).toContainText('Recommended');
  await expect(options.nth(1)).toContainText(q.options[0].label);
  await expect(options.nth(1)).not.toContainText('Recommended');
  await expect(options.nth(0)).toContainText(q.options[1].description);
  await expect(options.nth(1)).toContainText(q.options[0].description);
  await expect(options.nth(2)).toContainText(q.options[2].description);
  const more = card.getByTestId('ask-more');
  await expect(more).toContainText('Chat more about this');
  expect(await card.locator('button').last().getAttribute('data-testid')).toBe('ask-more');
  await expect(card.getByRole('button')).toHaveCount(4);
  await expectNoHorizontalOverflow(page);
  if (isMobile(page)) await expectTapTargets(page, `[data-testid="ask"] button`);
  await shot(page, 'ask-open', card);
});

test('ask: a click is sent as your own reply to the question, the buttons lock on it, and it stays locked over a reload', async ({ authed: page }) => {
  const { q, card, orchestratorId } = await ask(page, uniq('click'));
  const pick = q.options[1].label;
  await card.getByTestId('ask-option').filter({ hasText: pick }).click();

  // The chat shows your answer as a message of yours with the question above it, and only the label in the bubble.
  const mine = page.locator('.orch .msg-user').filter({ has: page.getByTestId('reply-quote') }).filter({ hasText: pick });
  await expect(mine).toBeVisible();
  await expect(mine.locator('.bubble-text')).toHaveText(pick);
  await expect(mine.getByTestId('reply-quote')).toContainText(q.question);
  await expect(mine.getByTestId('reply-quote')).not.toContainText('Recommended');
  await expect(mine).not.toContainText(REPLY_MARK);

  // Locked: every button is shut, the pick is marked, and "Chat more" is gone.
  await expect(card).toHaveClass(/ask-locked/);
  for (const o of await card.getByTestId('ask-option').all()) await expect(o).toBeDisabled();
  await expect(card.getByTestId('ask-option').filter({ hasText: pick })).toContainText('Your answer');
  await expect(card.getByTestId('ask-option').filter({ hasText: pick })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByTestId('ask-more')).toHaveCount(0);

  // The server holds it as the person's own message, attributed to them; the orchestrator was handed the label and the question quoted.
  const events = await transcript(page.request, orchestratorId);
  const sent = events.find((e) => e.kind === 'user' && e.text.startsWith(`${pick}\n\n${REPLY_MARK}`));
  expect(sent && sent.kind === 'user' ? [sent.from, sent.requestedBy?.userId] : []).toEqual(['human', 'tester']);
  const echoed = page.locator('.orch .msg-assistant', { hasText: `Echo: ${pick}` });
  await expect(echoed).toBeVisible();
  await expect(echoed).toContainText(q.question);

  // Over a reload, from the transcript alone.
  await page.reload();
  const again = page.getByTestId('ask').filter({ hasText: q.question });
  await again.scrollIntoViewIfNeeded();
  await expect(again).toHaveClass(/ask-locked/);
  await expect(again.getByTestId('ask-option').filter({ hasText: pick })).toContainText('Your answer');
  await expectNoHorizontalOverflow(page);
  await shot(page, 'ask-answered', again);
});

test('ask: "Chat more about this" sends nothing: it opens the reply box on the question, and the buttons stay for later', async ({ authed: page }) => {
  const tag = uniq('more');
  const { q, card, orchestratorId } = await ask(page, tag);
  // Other tests share this chat: only messages that carry this question's own tag count, in the person's own words. Another
  // test's message typed while this card is open carries FF Factory's note after HELD_MARK, which quotes this question (w1955).
  const mentions = async () => (await transcript(page.request, orchestratorId)).filter((e) => e.kind === 'user' && e.from === 'human' && e.text.split(HELD_MARK)[0].includes(tag)).length;
  const before = await mentions();
  expect(before, 'only the message that asked it, through the fake agent').toBe(1);
  await card.getByTestId('ask-more').click();
  const bar = page.getByTestId('composer-reply');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Replying to Orchestrator');
  await expect(bar).toContainText(q.question);
  // Nothing was sent, and the question is still open.
  await page.waitForTimeout(300);
  expect(await mentions()).toBe(before);
  await expect(card).not.toHaveClass(/ask-locked/);
  for (const o of await card.getByTestId('ask-option').all()) await expect(o).toBeEnabled();

  // Typing is the other way to answer, and it leaves the buttons as they are.
  const box = page.locator(`.orch ${BOX}`);
  await box.fill(`what does it touch ${tag}`);
  if (isMobile(page)) await page.locator('.orch .composer').getByRole('button', { name: 'Send' }).click();
  else await box.press('Enter');
  const mine = page.locator('.orch .msg-user', { hasText: `what does it touch ${tag}` });
  await expect(mine.getByTestId('reply-quote')).toContainText(q.question);
  await expect(card).not.toHaveClass(/ask-locked/);
  await expect(card.getByTestId('ask-option').first()).toBeEnabled();
});

test('ask over the API: a click needs a real option of a real question, and a second one is refused', async ({ authed: page }) => {
  test.skip(isMobile(page), 'server behaviour; the desktop project is enough');
  const { q, card, orchestratorId } = await ask(page, uniq('api'));
  const events = await transcript(page.request, orchestratorId);
  const call = events.find((e) => e.kind === 'tool_use' && e.name.endsWith('__ask_person') && JSON.stringify(e.input) === JSON.stringify(q))!;
  const post = (data: unknown, id = orchestratorId) => page.request.post(`/api/sessions/${id}/answer`, { data });
  expect((await post({ seq: call.seq, choice: 3 })).status(), '"Chat more" is not an option').toBe(400);
  expect((await post({ seq: call.seq, choice: -1 })).status()).toBe(400);
  expect((await post({ seq: 99999, choice: 0 })).status()).toBe(400);
  const assistant = events.find((e) => e.kind === 'assistant')!;
  expect((await post({ seq: assistant.seq, choice: 0 })).status(), 'a plain message is no question').toBe(400);
  expect((await post({ seq: call.seq, choice: 0 })).ok()).toBeTruthy();
  const second = await post({ seq: call.seq, choice: 2 });
  expect(second.status()).toBe(409);
  expect(await second.text()).toContain('already answered');
  await expect(card).toHaveClass(/ask-locked/);
  const dispatcher = (await appState(page.request)).dispatcherId!;
  expect((await post({ seq: call.seq, choice: 0 }, dispatcher)).status()).toBeGreaterThanOrEqual(400);
});

// w1632 (lothsahn, 2026-10-20: "you didn't answer my question in our chat ... And instead you posted a question for me"):
// a turn that answers in text and then asks with buttons. The chat followed its end, and on a phone the card filled the
// screen with the answer above the top edge. Now the answer starts on screen at the turn's end, the card right after it,
// on a phone as on a desktop; the test does not scroll before it looks.
// Its own login's chat (e2e/server.ts, "asker"): where the view ends depends on the chat's last message, which another
// test's message, sent at the same time, would move.
const asAsker = test.extend<{ solo: Page }>({
  solo: async ({ browser }, use) => {
    const ctx = await browser.newContext(test.info().project.use as BrowserContextOptions);
    await expect(async () => {
      const r = await ctx.request.post('/api/login', { data: { username: 'asker', password: 'e2e-password-246' } });
      expect(r.ok(), await r.text()).toBeTruthy();
    }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('.sidebar')).toBeAttached();
    await use(page);
    await ctx.close();
  },
});

// An answer as long as the orchestrator's were (a few paragraphs), and a short one.
for (const [len, repeat, name] of [['long', 4, 'ask'], ['short', 0, 'ask-short']] as const)
asAsker(`ask: a turn that answers and then asks shows the answer on screen, the card after it (${len} answer)`, async ({ solo: page }) => {
  const tag = uniq('answer');
  const q = questionFor(tag);
  const answer = `Shell bots for ${tag} render as one instanced ring per platform; a hit on the platform takes them out with it.`;
  const more = `A bot still flying to its platform for ${tag} is an ordinary entity until it docks, so turrets can shoot it. ` + 'It keeps its own health and armour while it flies, takes splash from rockets like any drone, and only becomes a count on the platform when it lands. '.repeat(repeat);
  const me = await appState(page.request);
  await sendToChat(page.request, me.orchestratorId, `#say ${answer}⏎⏎${more}\n#tool ask_person ${JSON.stringify(q)}`);
  const card = page.getByTestId('ask').filter({ hasText: q.question });
  await expect(card).toBeAttached();
  const reply = page.locator('.orch .msg-assistant').filter({ hasText: answer });
  await expect(reply).toContainText(more);
  await page.waitForTimeout(600);
  // A chat opened on an earlier card's answer is scrolled up: this turn shows the pill, and one tap lands on this answer,
  // not past it on the card. A second tap on the same spot right after does not answer the question with whatever
  // button slid under it.
  const sbox = (await page.locator('.orch .transcript-scroll').boundingBox())!;
  const rbox = (await reply.boundingBox())!;
  if (rbox.y > sbox.y + sbox.height || rbox.y + rbox.height < sbox.y) {
    await expect(page.locator('.orch .jump-pill.has-new')).toHaveText('Question below');
    await page.locator('.orch .jump-pill').click();
    await page.waitForTimeout(250);
    // A tap on a button that slid under the finger (dispatched, so Playwright does not scroll to it).
    await card.locator('.ask-opt:not(.ask-more)').last().dispatchEvent('click');
    await page.waitForTimeout(600);
    await expect(card).not.toHaveClass(/ask-locked/);
  }
  await shot(page, `${name}-turn-end`);
  // The start of the answer is on screen, under the chat's top edge.
  const scroll = page.locator('.orch .transcript-scroll');
  await expect.poll(async () => {
    const [r, box] = [await reply.boundingBox(), await scroll.boundingBox()];
    return !!r && !!box && r.y >= box.y - 1 && r.y < box.y + box.height - 40;
  }, { message: 'the start of the answer is on screen' }).toBe(true);
  await expect(reply.getByText(answer)).toBeInViewport();
  // The card comes after the answer and does not sit over it.
  const [a, c] = [await reply.boundingBox(), await card.boundingBox()];
  expect(a!.y + a!.height).toBeLessThanOrEqual(c!.y + 1);
  await shot(page, `${name}-after-answer`);
  // When they do not fit together (and the chat is not within 80 px of its end, where it counts as at the end), the pill
  // says the question is below; going down there stays there.
  if (c!.y + c!.height > (await scroll.boundingBox())!.y + (await scroll.boundingBox())!.height + 80) {
    await expect(page.locator('.orch .jump-pill.has-new')).toHaveText('Question below');
    // The pill does not sit on the question: it shows clear above the pill, or the card starts below the screen.
    const [qb, pill, sb] = [await card.locator('.ask-q').boundingBox(), await page.locator('.orch .jump-pill').boundingBox(), await scroll.boundingBox()];
    expect(qb!.y >= sb!.y + sb!.height - 1 || qb!.y + qb!.height <= pill!.y + 1, `question ${JSON.stringify(qb)} under the pill ${JSON.stringify(pill)}`).toBe(true);
    await page.locator('.orch .jump-pill').click();
    await expect(card.getByTestId('ask-more')).toBeInViewport();
    await page.waitForTimeout(500);
    await expect(card.getByTestId('ask-more')).toBeInViewport();
  } else await expect(card.locator('.ask-q')).toBeInViewport({ ratio: 1 });
});

// w2664 (Ben, 2026-10-31, w2580's card seq 61907: "you didnt show me previews for C and D and you didnt give me the multiple
// choice options"): a design pick with 2 stills in the question and 2 in each of 4 options draws every still and every
// button, in the chat and on the Waiting tab.
test('w2664: a 4-option design pick with 2 stills each shows all 10 stills and all 4 buttons, in the chat and on the Waiting tab', async ({ authed: page }) => {
  test.setTimeout(120_000);
  const review = path.join(os.tmpdir(), `ffsb-e2e-${new URL(test.info().project.use.baseURL!).port}`, 'review');
  const dir = path.join(review, 'w9580-station-info-redesign');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(review, 'w000-options', '1-option-A-left-of-item-rows-1920.png');
  const names = ['q-desk', 'q-dock', ...['strip', 'card', 'tiles', 'banner'].flatMap((n) => [`${n}-desk`, `${n}-dock`])];
  for (const n of names) fs.copyFileSync(src, path.join(dir, `${n}.png`));
  const p = (n: string) => `![${n}](<${dir.split(path.sep).join('/')}/${n}.png>)`;
  const tag = uniq('w2664');
  const opt = (l: string, n: string) => ({ label: `${l} ${tag}`, description: `What ${l} does. ${p(`${n}-desk`)} ${p(`${n}-dock`)}` });
  const me = await appState(page.request);
  await useTool(page.request, me.orchestratorId, 'ask_person', {
    question: `Which Station Info design should I build? ${tag} ${p('q-desk')} ${p('q-dock')}`,
    options: [{ ...opt('A Strip', 'strip'), recommended: true }, opt('B Card', 'card'), opt('C Tiles', 'tiles'), opt('D Banner', 'banner')],
    request: 'w9580',
  });
  for (const where of ['chat', 'waiting'] as const) {
    if (where === 'waiting') await page.goto('/#/dispatcher/waiting');
    const card = where === 'chat' ? page.getByTestId('ask').filter({ hasText: tag }).last() : page.getByTestId('waiting-tab').locator('.qc').filter({ hasText: tag });
    await expect(card).toBeVisible();
    for (const l of ['A Strip', 'B Card', 'C Tiles', 'D Banner']) await expect(card.getByRole('button', { name: new RegExp(`^${l}`) })).toBeVisible();
    const imgs = card.locator('img');
    await expect(imgs).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await imgs.nth(i).scrollIntoViewIfNeeded();
      await expect.poll(() => imgs.nth(i).evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0), { message: `${where}: still ${i + 1} of 10 drawn`, timeout: 10_000 }).toBe(true);
    }
  }
});
