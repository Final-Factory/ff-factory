import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { GALLERY, appState, expect, isMobile, machineSandbox, settle, signIn, test, uniq, useTool } from './fixtures.ts';
import type { AppState, OpenAsk, ServerEvent, SessionInfo, WorkItem } from '../shared/types.ts';
import { openQuestions2856, waitingCases } from '../server/fixtures/waitingCards.ts';

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
function fixtureState(s: AppState, now: number, media: { clip: string; still: string }, asks: OpenAsk[] = []): AppState {
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
  // The tester's orchestrator's open ask_person questions (w2856), in a chat of their own.
  const orch = asks.length ? [{ id: 'orch-w2856', kind: 'orchestrator', orchestratorRole: 'personal', title: 'Orchestrator', status: 'idle', createdAt: new Date(now - 86_400_000).toISOString(), requestedBy: TESTER, pendingPermissions: [], openAsks: asks } as unknown as SessionInfo] : [];
  return { ...s, work, sessions: [...s.sessions, ...workers, ...orch] };
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
  const ids = ['w1797', 'w1839', 'w1829', 'w1853', 'w1842', 'w3596', 'w1820', 'w1821'];
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
  await expect(tab.getByTestId('wait-w1842').getByTestId('qc-option').first()).toContainText('A worker reviews FFBox’s fix “circular placement log once” against the code');
  // w3602: with no summary from FFBox, its card still leads with the heading and says where the write-up is.
  await expect(tab.getByTestId('wait-w1842').getByTestId('qc-digest-missing')).toHaveText('Its full write-up is under Details, at the foot of this card.');
  // w3596 (w3602, lothsahn: "What am I approving?"): FFBox's summary leads the card, labelled as FFBox's, and Approve says what it sets in motion.
  const w3596 = tab.getByTestId('wait-w3596');
  await expect(w3596.getByTestId('qc-digest')).toContainText('What FFBox found and changed');
  await expect(w3596.getByTestId('qc-digest')).toContainText('FFBox’s summary, a model’s words: check them against the code.');
  await expect(w3596.getByTestId('qc-digest-row')).toHaveText([/^The player hit: a freeze \(hang\) on LinuxPlayer, game 1\.0\.0\.16$/, /^Cause: the game set the same screen size a second time at launch/, /^The fix: the game no longer re-applies the screen size/, /^Tests: compiled; 16349 of 16361 tests passed, 2 failed, 10 skipped$/, /^Not checked: I could not make the freeze happen here, because this machine has no Steam overlay\./, /^Risk: Low for other players: .*fail on master too\./]);
  await expect(w3596.getByTestId('qc-question')).toHaveText('Should a worker review FFBox’s fix for a freeze (hang) on LinuxPlayer and merge it?');
  await expect(w3596.getByTestId('qc-option').first()).toContainText('checks the 2 failing tests and fixes any the fix broke, opens a pull request and merges it on green');
  await expect(w3596.getByTestId('qc-option').nth(1)).toContainText('FFBox marks the player’s report obsolete and posts nothing');
  // The summary comes before the question.
  const [digestBox, questionBox] = await Promise.all([w3596.getByTestId('qc-digest').boundingBox(), w3596.getByTestId('qc-question').boundingBox()]);
  expect(digestBox!.y).toBeLessThan(questionBox!.y);
  if (process.env.WAITING_SHOTS) {
    // The whole card at once: a viewport as tall as the card, so nothing runs under the phone's sticky header.
    const box = (await w3596.boundingBox())!;
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, Math.ceil(box.height) + 600) });
    await settle(page);
    await w3596.screenshot({ path: path.join(process.env.WAITING_SHOTS, `w3596-card-${isMobile(page) ? 'narrow' : 'desktop'}.png`) });
    await page.setViewportSize(vp);
  }
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

test('w2576: a still in the Details text at a path of the worker that waits shows the picture, not its alt text', async ({ page }) => {
  // Ben, 2026-10-30: "a lot of previews in the waiting on input are not showing their preview images". The Details text read
  // every still without the worker's session, so a still outside the review folder was refused (400) and showed its alt.
  await signIn(page);
  const app0 = await appState(page.request);
  const gallery = machineSandbox(app0, GALLERY);
  const sep = gallery.path.includes('\\') ? '\\' : '/';
  const shot = `${gallery.path}${sep}Screenshots${sep}orch-proof.png`;
  const base = waitingCases(Date.now()).find((c) => c.w.id === 'w1797')!.w;
  const w = {
    ...base,
    id: 'w9576',
    requestedBy: TESTER,
    requesters: [TESTER],
    sessionIds: ['gallery1'],
    needsYou: { ...base.needsYou!, key: 'declared:gallery1:x', kind: 'declared', worker: 'gallery1', who: ['tester'], to: ['tester'], answeredAsks: [], question: `OK the spire? ![Beacon Spire next to a portal](<${shot}>)` },
  } as WorkItem;
  delete (w.needsYou as { asks?: unknown }).asks;
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      // The waiting worker as the ledger has it: gallery1, declared on the tester.
      const waiting = (s: SessionInfo) => (s.id === 'gallery1' ? ({ ...s, title: 'w9576: worker', requestedBy: TESTER, waitingOn: { who: 'tester', what: w.needsYou!.question, at: w.needsYou!.at } } as SessionInfo) : s);
      if (e.type === 'state') return ws.send(JSON.stringify({ type: 'state', state: { ...e.state, work: [...(e.state.work ?? []), w], sessions: e.state.sessions.map(waiting) } as AppState } satisfies ServerEvent));
      if (e.type === 'work' || (e.type === 'session' && e.session.id === 'gallery1')) return;
      ws.send(raw);
    });
    ws.onMessage((m) => server.send(m));
  });
  await page.goto('/#/dispatcher/waiting');
  await page.reload();
  const card = page.getByTestId('waiting-tab').getByTestId('wait-w9576');
  await expect(card).toBeVisible();
  await card.getByTestId('qc-details').locator('summary').click();
  const words = card.getByTestId('wait-question-w9576');
  await expect(words.locator('code', { hasText: 'Beacon Spire next to a portal' })).toHaveCount(0);
  const img = words.locator('img[alt="Beacon Spire next to a portal"]');
  await img.scrollIntoViewIfNeeded();
  await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test('w2856: every card leads with its question, its answers right under it; what holds up a worker comes first', async ({ page, browserName }) => {
  const now = Date.now();
  const media = reviewFiles();
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      if (e.type === 'state') return ws.send(JSON.stringify({ type: 'state', state: fixtureState(e.state, now, media, openQuestions2856(now, media.still)) } satisfies ServerEvent));
      if (e.type === 'session' || e.type === 'session_removed' || e.type === 'work') return;
      ws.send(raw);
    });
    ws.onMessage((m) => server.send(m));
  });
  if (!isMobile(page)) await page.setViewportSize({ width: 1440, height: 2400 });
  await signIn(page);
  await page.goto('/#/dispatcher/waiting');
  const tab = page.getByTestId('waiting-tab');
  const cards = tab.getByTestId('waiting-mine').locator(':scope > .qc');
  // Seven requests and the two open questions of the orchestrator (70477, 70556); a parallel test may add its own.
  for (const id of ['wait-w1797', 'wait-w1839', 'wait-w1829', 'wait-w1853', 'wait-w1842', 'wait-w1820', 'wait-w1821', 'ask-70477', 'ask-70556']) await expect(cards.and(tab.getByTestId(id)), id).toHaveCount(1);
  await expect(tab.getByTestId('ask-70556').getByTestId('qc-question')).toHaveText('What should far space past 20,000 units contain?');
  await expect(tab.getByTestId('ask-70477').getByTestId('qc-still')).toHaveCount(1);
  const n = await cards.count();
  const holds: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const id = (await card.getAttribute('data-testid')) ?? String(i);
    // The question is the card's first line (a multi-question card's progress may sit above it), whole and readable; an
    // intake card's plain summary of what is being approved sits above it (w3602, lothsahn: "What am I approving?").
    const lead = await card.evaluate((el) => [...el.children].map((c) => c.getAttribute('data-testid')).filter((t) => t !== 'qc-progress').slice(0, 2));
    expect(lead[0] === 'qc-digest' ? lead[1] : lead[0], `${id}: the question first`).toBe('qc-question');
    const q = card.getByTestId('qc-question');
    await expect(q, id).not.toBeEmpty();
    await expect(q, id).not.toHaveText(/…$/);
    // Its answers (or its answer box) right under the question, and what it is, who acts and since when under those.
    const answer = (await card.getByTestId('qc-option').count()) ? card.getByTestId('qc-option').first() : card.locator('.qc-free-text');
    const qBox = (await q.boundingBox())!;
    const aBox = (await answer.boundingBox())!;
    const cBox = (await card.getByTestId('qc-context').boundingBox())!;
    expect(aBox.y, `${id}: answers under the question`).toBeGreaterThan(qBox.y);
    expect(cBox.y, `${id}: the context under the answers`).toBeGreaterThan(aBox.y);
    await expect(card.getByTestId('qc-meta'), id).toContainText(/must act · waiting/);
    // The recommended answer first.
    if ((await card.getByTestId('qc-recommended').count()) > 0) await expect(card.getByTestId('qc-option').first().getByTestId('qc-recommended'), id).toBeVisible();
    holds.push((await card.getByTestId('qc-holds').count()) > 0);
    // Nothing runs off the card at a phone's width.
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${id}: fits its width`).toBe(true);
  }
  // The questions that hold up a worker first, then the rest (the orchestrator's two hold none here).
  expect(holds.some(Boolean), 'some hold a worker').toBe(true);
  expect(holds.indexOf(false) === -1 || !holds.slice(holds.indexOf(false)).some(Boolean), `holding cards first: ${holds.join(',')}`).toBe(true);
  await expect(tab.getByTestId('waiting-summary')).toContainText('up a worker, then the rest; oldest first.');
  // An intake approval's question names what "this" is right under it.
  await expect(tab.getByTestId('wait-w1853').getByTestId('qc-what')).toHaveText(/^The nightly game tests of 2026-10-23/);
  // The stills (WAITING_SHOTS): the first screen, and the whole tab in a window tall enough to hold it (it scrolls inside the
  // page, so a full-page capture alone stops at the window). A phone's width in Chromium too: Playwright's WebKit plays no WebM.
  const dir = process.env.WAITING_SHOTS;
  if (dir) {
    const narrow = isMobile(page);
    await page.screenshot({ path: path.join(dir, `w2856-top-${narrow ? 'narrow' : 'desktop'}.png`) });
    const sizes: [string, number][] = narrow ? [] : [['desktop', 1440], ...(browserName === 'chromium' ? ([['narrow-chromium', 390]] as [string, number][]) : [])];
    for (const [name, width] of sizes) {
      await page.setViewportSize({ width, height: 9000 });
      await settle(page);
      const h = await tab.evaluate((el) => (el.lastElementChild?.getBoundingClientRect().bottom ?? el.scrollHeight) + 40);
      await page.setViewportSize({ width, height: Math.ceil(Math.min(h, 16000)) });
      await settle(page);
      await page.screenshot({ path: path.join(dir, `w2856-all-${name}.png`) });
      if (width === 390) await page.setViewportSize({ width, height: 844 }), await settle(page), await page.screenshot({ path: path.join(dir, 'w2856-top-narrow-chromium.png') });
    }
  }
});
