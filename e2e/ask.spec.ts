import type { APIRequestContext, BrowserContextOptions, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { BOX, appState, expect, expectNoHorizontalOverflow, expectTapTargets, isMobile, sendToChat, test, uniq, useTool } from './fixtures.ts';
import type { TranscriptEvent } from '../shared/types.ts';
import { REPLY_MARK } from '../shared/replies.ts';

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
  // Other tests share this chat: only messages that carry this question's own tag count.
  const mentions = async () => (await transcript(page.request, orchestratorId)).filter((e) => e.kind === 'user' && e.from === 'human' && e.text.includes(tag)).length;
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

asAsker('ask: a turn that answers and then asks shows the answer on screen, the card after it', async ({ solo: page }) => {
  const tag = uniq('answer');
  const q = questionFor(tag);
  // An answer as long as the orchestrator's were (a few paragraphs).
  const answer = `Shell bots for ${tag} render as one instanced ring per platform; a hit on the platform takes them out with it.`;
  const more = `A bot still flying to its platform for ${tag} is an ordinary entity until it docks, so turrets can shoot it. ` + 'It keeps its own health and armour while it flies, takes splash from rockets like any drone, and only becomes a count on the platform when it lands. '.repeat(4);
  const me = await appState(page.request);
  await sendToChat(page.request, me.orchestratorId, `#say ${answer}⏎⏎${more}\n#tool ask_person ${JSON.stringify(q)}`);
  const card = page.getByTestId('ask').filter({ hasText: q.question });
  await expect(card).toBeAttached();
  const reply = page.locator('.orch .msg-assistant').filter({ hasText: answer });
  await expect(reply).toContainText(more);
  await page.waitForTimeout(600);
  await shot(page, 'ask-turn-end');
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
  await shot(page, 'ask-after-answer');
  // When they do not fit together, the pill points down to the card; going down there stays there.
  if (c!.y + c!.height > (await scroll.boundingBox())!.y + (await scroll.boundingBox())!.height + 1) {
    await expect(page.locator('.orch .jump-pill.has-new')).toBeVisible();
    await page.locator('.orch .jump-pill').click();
    await expect(card.getByTestId('ask-more')).toBeInViewport();
    await page.waitForTimeout(500);
    await expect(card.getByTestId('ask-more')).toBeInViewport();
  } else await expect(card).toBeInViewport();
});
