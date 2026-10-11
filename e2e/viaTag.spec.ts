import { expect, test, uniq } from './fixtures.ts';

/**
 * A message from Claude Code or Desktop (w1021, docs/talk-to-your-orchestrator.md) starts with its client's label line; the
 * chat shows it as a small tag under the message, not as a line of text. Tests share one server and its owner's chat: find
 * the line by a unique tag.
 */

test('a message from Claude Code shows its client as a tag, and the label line is not part of the words', async ({ authed: page }) => {
  const tag = uniq('via');
  const id = ((await (await page.request.get('/api/state')).json()) as { orchestratorId: string }).orchestratorId;
  const sent = await page.request.post(`/api/sessions/${id}/message`, { data: { text: `[via Claude Code or Desktop (ben-m5)]\nhello from the terminal ${tag}` } });
  expect(sent.ok()).toBeTruthy();
  const bubble = page.locator('.orch .msg-user', { hasText: tag });
  await expect(bubble).toHaveCount(1);
  await expect(bubble.getByTestId('msg-via')).toHaveText('via Claude Code or Desktop (ben-m5)');
  await expect(bubble.locator('.bubble-text')).toHaveText(`hello from the terminal ${tag}`);
});
