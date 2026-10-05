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

test('the Requests tab shows what each request is doing now, with counts per state and a filter (w418)', async ({ authed: page }) => {
  const tag = uniq('states');
  const me = await appState(page.request);
  const file = async (title: string) => (await useTool(page.request, me.orchestratorId, 'request_work', { title: `${title} ${tag}`, brief: `For the live states ${tag}.` })).match(/Filed (w\d+)/)![1];
  const queued = await file('Queued one');
  const stalled = await file('Stalled one');
  const waiting = await file('Waiting one');
  const followup = await file('Follow-up one');
  await patchWork(page.request, stalled, { status: 'active' });
  await patchWork(page.request, waiting, { status: 'question', question: { text: `Which save? ${tag}`, at: new Date().toISOString() } });
  await patchWork(page.request, followup, {
    status: 'active',
    prs: [{ repo: 'Final-Factory/FinalFactory', number: 1024, state: 'merged', at: new Date().toISOString() }],
    log: ['01:50 PR #1024 merged; still open: its brief asks for a step after the merge (a check, an audit, a verification)'],
  });

  await go(page, '#/dispatcher');
  const panel = page.locator('.dispatcher-panel');
  const states = panel.getByTestId('ledger-states');
  for (const s of ['queued', 'waiting', 'followup', 'stalled']) await expect(states.getByTestId(`ledger-state-${s}`)).toBeVisible();
  await expect(panel.getByTestId(`live-${queued}`)).toContainText('Queued');
  await expect(panel.getByTestId(`live-${stalled}`)).toContainText('Stalled');
  await expect(panel.getByTestId(`live-${waiting}`)).toContainText('Waiting on input on');
  await expect(panel.getByTestId(`live-${followup}`)).toContainText('Merged, follow-up pending');
  await panel.getByTestId(`work-${stalled}`).getByRole('button', { name: new RegExp(`Stalled one ${tag}`) }).click();
  await expect(panel.getByTestId(`live-why-${stalled}`)).toContainText('Stalled: no worker was ever started for it');
  await panel.screenshot({ path: test.info().outputPath('ledger-states.png') });

  // Several states at once (Lothsahn: "select multiple types"), kept across a reload.
  await states.getByTestId('ledger-state-stalled').click();
  await states.getByTestId('ledger-state-followup').click();
  await expect(states.getByTestId('ledger-state-stalled')).toHaveAttribute('aria-pressed', 'true');
  await expect(states.getByTestId('ledger-state-followup')).toHaveAttribute('aria-pressed', 'true');
  const picked = panel.getByTestId('ledger-picked');
  await expect(picked.getByTestId(`work-${stalled}`)).toBeVisible();
  await expect(picked.getByTestId(`work-${followup}`)).toBeVisible();
  await expect(picked.getByTestId(`work-${queued}`)).toHaveCount(0);
  await expect(picked.getByTestId(`work-${waiting}`)).toHaveCount(0);
  await panel.screenshot({ path: test.info().outputPath('ledger-states-multi.png') });
  await page.reload();
  await go(page, '#/dispatcher');
  const again = page.locator('.dispatcher-panel');
  await expect(again.getByTestId('ledger-state-stalled')).toHaveAttribute('aria-pressed', 'true');
  await expect(again.getByTestId('ledger-state-followup')).toHaveAttribute('aria-pressed', 'true');
  await expect(again.getByTestId('ledger-picked').getByTestId(`work-${queued}`)).toHaveCount(0);
  // One off leaves the other; Clear (or All) shows everything again.
  await again.getByTestId('ledger-state-stalled').click();
  await expect(again.getByTestId('ledger-picked').getByTestId(`work-${stalled}`)).toHaveCount(0);
  await expect(again.getByTestId('ledger-picked').getByTestId(`work-${followup}`)).toBeVisible();
  await again.getByTestId('ledger-state-clear').click();
  await expect(again.getByTestId('ledger-state-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(again.getByTestId(`work-${queued}`)).toBeVisible();
  await page.reload();
  await go(page, '#/dispatcher');
  await expect(page.locator('.dispatcher-panel').getByTestId('ledger-state-all')).toHaveAttribute('aria-pressed', 'true');
});
