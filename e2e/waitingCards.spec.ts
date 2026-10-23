import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { appState, expect, isMobile, settle, signIn, test, uniq, useTool } from './fixtures.ts';
import type { AppState, ServerEvent, SessionInfo, WorkItem } from '../shared/types.ts';
import { waitingCases } from '../server/fixtures/waitingCards.ts';

/**
 * The Waiting on input tab's cards (w1868, lothsahn, 2026-10-23: "The existing cards are impossible to know what I need to
 * answer"; "I meant the 'waiting for input' tab on the portal"; w1871, Ben: "You don't put the clip in this little intake
 * waiting for input box, so I can't see it"). Each card of today's real cases says what it is, who acts and since when, the
 * question, its answers or the one step, its stills and clips (a clip plays in the card), and what follows. Set
 * WAITING_SHOTS to a folder to keep the screenshots.
 */

const TESTER = { userId: 'tester', displayName: 'tester' };

/** The review folder the e2e server seeds (e2e/server.ts): a still and a clip the cards show. */
function reviewFiles() {
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review').replace(/\\/g, '/');
  return { clip: `${review}/w000-clips/clip.webm`, still: `${review}/w000-clips/option-a-1280.png` };
}

/** Today's cases as the tester's own: their people are the tester, their media the seeded review files, their workers sessions. */
function fixtureState(s: AppState, now: number, media: { clip: string; still: string }): AppState {
  const cases = waitingCases(now);
  const swap = (t: string) => t.replace(/\/srv\/fff\/review\/w1797-braking\/brake-1\.5s\.mp4/g, media.clip).replace(/\/srv\/fff\/review\/w1821-frames\/[\w.-]+\.png/g, media.still);
  const work: WorkItem[] = cases.map(({ w }) => {
    const r = w.needsYou;
    return {
      ...w,
      requestedBy: TESTER,
      requesters: [TESTER],
      ...(r ? { needsYou: { ...r, who: ['tester'], to: ['tester'], question: swap(r.question), previews: r.previews.map(swap), ...(r.asks ? { asks: r.asks.map((a) => ({ question: swap(a.question), options: a.options })) } : {}) } } : {}),
    } as WorkItem;
  });
  // Each waiting worker as the ledger had it: declared on the tester, its block on the record.
  const workers = cases.flatMap(({ w, session }) => {
    const r = w.needsYou;
    if (!session || !r) return [];
    const info = {
      id: session.id,
      kind: 'worker',
      title: `${w.id}: worker`,
      status: 'idle',
      createdAt: w.createdAt,
      lastActivityAt: r.at,
      requestedBy: TESTER,
      pendingPermissions: [],
      waitingOn: { who: 'tester', what: swap(r.question), at: r.at, ...(r.asks ? { asks: r.asks } : {}) },
    } as unknown as SessionInfo;
    return [info];
  });
  return { ...s, work, sessions: [...s.sessions, ...workers] };
}

async function shot(page: Page, name: string) {
  const dir = process.env.WAITING_SHOTS;
  if (!dir) return;
  await settle(page);
  await page.screenshot({ path: path.join(dir, `${name}-${isMobile(page) ? 'narrow' : 'desktop'}.png`), fullPage: true });
}

test('w1868: every card of today’s real cases says what it is, who acts, the question, its answers, its media and what follows', async ({ page, browserName }) => {
  const now = Date.now();
  const media = reviewFiles();
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      if (e.type === 'state') return ws.send(JSON.stringify({ type: 'state', state: fixtureState(e.state, now, media) } satisfies ServerEvent));
      if (e.type === 'session' || e.type === 'session_removed' || e.type === 'work') return;
      ws.send(raw);
    });
    ws.onMessage((m) => server.send(m));
  });
  if (!isMobile(page)) await page.setViewportSize({ width: 1440, height: 2400 });
  await signIn(page);
  await page.goto('/#/dispatcher/waiting');
  const tab = page.getByTestId('waiting-tab');
  const ids = ['w1797', 'w1839', 'w1829', 'w1853', 'w1842', 'w1820', 'w1821'];
  for (const id of ids) {
    const card = tab.getByTestId(`wait-${id}`);
    await expect(card, id).toBeVisible();
    // 1. What it is, 2. who acts and since when.
    await expect(card.getByTestId('qc-what'), id).not.toBeEmpty();
    await expect(card.getByTestId('qc-meta'), id).toContainText(/must act · waiting \d+ (min|h|days)/);
    // 3. The question, whole.
    await expect(card.getByTestId('qc-question'), id).not.toHaveText(/…$/);
    // 4. Its answers, or the one step.
    expect((await card.getByTestId('qc-option').count()) >= 2 || (await card.getByTestId('qc-step').count()) === 1, `${id}: answers or a step`).toBe(true);
    // 6. What follows.
    await expect(card.getByTestId('qc-after'), id).toContainText('After you answer:');
  }
  // The intake cards say what the item is and what each answer does.
  await expect(tab.getByTestId('wait-w1853').getByTestId('qc-what')).toHaveText(/^The nightly game tests of 2026-10-23: 6 scenarios failed on master/);
  await expect(tab.getByTestId('wait-w1842').getByTestId('qc-option').first()).toContainText('a worker starts at the next free sandbox');
  // w1829: the decision itself, flagged as overtaken.
  await expect(tab.getByTestId('wait-w1829').getByTestId('qc-stale')).toContainText('timed runs no longer go to m5');
  // w1821: the frame look answered, the Station strip question asked, with its still.
  const w1821 = tab.getByTestId('wait-w1821');
  await expect(w1821.getByTestId('qc-question')).toHaveText('When a window covers the Station strip, what should come up over it?');
  await expect(w1821.getByTestId('qc-still')).toHaveCount(1);
  // 5. w1797's clip plays in the card (Playwright's Chromium decodes WebM; its WebKit hides what it cannot play).
  const clip = tab.getByTestId('wait-w1797').getByTestId('qc-clip').locator('video');
  if (browserName === 'chromium') {
    await expect(clip).toBeVisible();
    expect(await clip.evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
    await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => (v.readyState >= 1 ? Math.round(v.duration) : -1))).toBe(2);
  }
  await shot(page, 'waiting-cards');
  await tab.getByTestId('wait-w1797').scrollIntoViewIfNeeded();
  if (process.env.WAITING_SHOTS) await tab.getByTestId('wait-w1797').screenshot({ path: path.join(process.env.WAITING_SHOTS, `w1797-card-${isMobile(page) ? 'narrow' : 'desktop'}.png`) });
  if (process.env.WAITING_SHOTS) await w1821.screenshot({ path: path.join(process.env.WAITING_SHOTS, `w1821-card-${isMobile(page) ? 'narrow' : 'desktop'}.png`) });
  // The clip at a phone's width, in the engine that plays WebM (the portal sends Safari the clip's H.264 web preview).
  if (process.env.WAITING_SHOTS && browserName === 'chromium' && !isMobile(page)) {
    await page.setViewportSize({ width: 390, height: 1400 });
    await settle(page);
    await tab.getByTestId('wait-w1797').scrollIntoViewIfNeeded();
    await tab.getByTestId('wait-w1797').screenshot({ path: path.join(process.env.WAITING_SHOTS, 'w1797-card-narrow-chromium.png') });
  }
});

test('w1868: every open question of your orchestrator is a card: three requests and two on one make five, and a click answers each', async ({ authed: page }) => {
  test.setTimeout(120_000);
  const tag = uniq('oq');
  const me = await appState(page.request);
  const q = (n: number, request: string) => ({
    question: `Question ${n} on ${request} ${tag}: go ahead now?`,
    options: [
      { label: `Go ahead (${n} ${tag})`, description: 'It starts at once.', recommended: true },
      { label: `Hold it (${n} ${tag})`, description: 'Nothing happens until you say.' },
    ],
    request,
    after: 'The orchestrator files your answer on the request.',
  });
  const asked = [q(1, 'w9811'), q(2, 'w9812'), q(3, 'w9813'), q(4, 'w9814'), q(5, 'w9814')];
  for (const a of asked) await useTool(page.request, me.orchestratorId, 'ask_person', a);
  await page.goto('/#/dispatcher/waiting');
  const tab = page.getByTestId('waiting-tab');
  const cards = tab.locator('.qc').filter({ hasText: tag });
  await expect(cards).toHaveCount(5);
  await expect(cards.first().getByTestId('qc-after')).toContainText('The orchestrator files your answer on the request.');
  await expect(cards.first().getByTestId('qc-meta')).toContainText('asked by your orchestrator about w9811');
  // Each click answers its own question, exactly as the click in the chat: the card goes, the chat has your answer.
  for (let n = 1; n <= 5; n++) {
    const card = cards.filter({ hasText: `Question ${n} on` });
    await card.getByRole('button', { name: new RegExp(`^Go ahead \\(${n} ${tag}\\)`) }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
  }
  const events = (await (await page.request.get(`/api/sessions/${me.orchestratorId}/events?limit=500`)).json()) as { kind: string; from?: string; text?: string }[];
  for (let n = 1; n <= 5; n++) expect(events.some((e) => e.kind === 'user' && e.from === 'human' && e.text?.startsWith(`Go ahead (${n} ${tag})`)), `answer ${n} in the chat`).toBe(true);
});
