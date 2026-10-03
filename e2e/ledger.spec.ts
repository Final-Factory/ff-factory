import type { APIRequestContext } from '@playwright/test';
import { appState, expect, go, patchWork, sendToChat, test, uniq } from './fixtures.ts';
import type { TranscriptEvent, WorkItem } from '../shared/types.ts';

/**
 * The ledger cleanup (docs/orchestrators.md, "Ledger cleanup") on the Requests tab: a request nothing has touched for a
 * day becomes stalled when the owner presses "Clean up now", shows under its own filter with the reason and its
 * pull requests, and a note from its person revives it. The test server links no repo's PRs (e2e/server.ts), so only the
 * quiet-request rule runs here; the PR rules are server/ledgerSweep.test.ts.
 */

async function useTool(request: APIRequestContext, chatId: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const events = async () => (await (await request.get(`/api/sessions/${chatId}/events?limit=500`)).json()) as TranscriptEvent[];
  const before = (await events()).at(-1)?.seq ?? 0;
  await sendToChat(request, chatId, `#tool ${tool} ${JSON.stringify(args)}`);
  let answer = '';
  await expect
    .poll(async () => {
      const r = (await events()).find((e) => e.seq > before && e.kind === 'assistant' && e.text.startsWith(`Called ${tool}:`));
      answer = r && r.kind === 'assistant' ? r.text : '';
      return answer;
    }, { timeout: 15_000 })
    .not.toBe('');
  return answer.slice(`Called ${tool}: `.length);
}

test('a quiet request stalls on "Clean up now", shows under Stalled with its reason and PRs, and a note revives it', async ({ authed: page }) => {
  const tag = uniq('ledger');
  const me = await appState(page.request);
  const filed = await useTool(page.request, me.orchestratorId, 'request_work', { title: `Tidy the splitter ${tag}`, brief: `Nothing has touched this ${tag}.` });
  const id = filed.match(/Filed (w\d+)/)![1];
  const find = async () => (await appState(page.request)).work?.find((w: WorkItem) => w.id === id);
  await expect.poll(async () => (await find())?.title).toContain(tag);
  const day = new Date(Date.now() - 30 * 3_600_000).toISOString();
  await patchWork(page.request, id, { updatedAt: day, status: 'new', prs: [{ repo: 'Final-Factory/FinalFactory', number: 77, url: 'https://github.com/Final-Factory/FinalFactory/pull/77', state: 'closed' }] });

  await go(page, '#/dispatcher');
  const panel = page.locator('.dispatcher-panel');
  await expect(panel.getByTestId('ledger-cleanup')).toContainText('Cleanup every 4 h');
  await panel.getByRole('button', { name: 'Clean up now' }).click();
  await expect.poll(async () => (await find())?.status).toBe('stalled');
  expect((await find())!.stalled?.kind).toBe('idle');

  const filter = panel.getByTestId('stalled-filter');
  await expect(filter).toContainText('stalled');
  await filter.click();
  const row = panel.getByTestId('stalled-list').getByTestId(`work-${id}`);
  await expect(row).toContainText('Stalled');
  await row.getByRole('button', { name: new RegExp(tag) }).click();
  await expect(row.getByTestId(`stalled-${id}`)).toContainText('no worker running and no activity for 30 hours');
  await expect(row.getByTestId(`prs-${id}`)).toContainText('#77 closed');
  await expect(panel.getByTestId('ledger-cleanup')).toContainText('last');

  const revived = await useTool(page.request, me.orchestratorId, 'update_work', { id, note: `Still wanted ${tag}` });
  expect(revived).toContain('revived from stalled');
  await expect.poll(async () => (await find())?.status).toBe('new');
  await expect(panel.getByTestId('stalled-list').getByTestId(`work-${id}`)).toHaveCount(0);
});
