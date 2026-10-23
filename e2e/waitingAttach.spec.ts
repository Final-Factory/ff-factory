import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { DeliveredAttachment, ServerEvent, TranscriptEvent } from '../shared/types.ts';
import { RED_PNG } from './fakeAgent.ts';
import { appState, expect, isMobile, signIn, test, uniq, useTool } from './fixtures.ts';
import { waitingCases } from '../server/fixtures/waitingCards.ts';

/**
 * Attachments on the Waiting on input tab's answer fields (w1912, Ben: "i need to be able to attach files or paste images
 * to the waiting on input fields"). The box takes a paperclip, a paste (a screenshot) and a drop, shows each file as a chip
 * (a picture as its own thumbnail) with a remove control, uploads through the chat box's uploader, and the answer reaches
 * the orchestrator with the files as [attachments]. Set WAITING_ATTACH_SHOTS to a folder to keep the screenshots.
 */

// The app's service worker (web/public/sw.js) takes the page's requests in WebKit, where page.route never sees them.
test.use({ serviceWorkers: 'block' });

const PNG = Buffer.from(RED_PNG, 'base64');

type Sent = Extract<TranscriptEvent, { kind: 'user' }> & { attachments?: DeliveredAttachment[] };

async function humanMessages(page: Page, chatId: string): Promise<Sent[]> {
  const r = await page.request.get(`/api/sessions/${chatId}/events?limit=500`);
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as TranscriptEvent[]).filter((e): e is Sent => e.kind === 'user' && e.from === 'human');
}

/** A paste or a drop of files on an element, as the browser fires it (WebKit's constructors ignore their DataTransfer). */
async function fire(page: Page, selector: string, type: 'paste' | 'drop', files: { name: string; type: string; base64: string }[]) {
  await page.locator(selector).first().evaluate(
    (el, { type, files }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
    },
    { type, files },
  );
}

const shot = async (page: Page, card: ReturnType<Page['getByTestId']>, name: string) => {
  const dir = process.env.WAITING_ATTACH_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: path.join(dir, `${name}-${isMobile(page) ? 'narrow' : 'desktop'}.png`) });
};

test('w1912: a question of your orchestrator takes a pasted screenshot, a picked file and a dropped log, shows each with a remove control, and the answer carries them', async ({ authed: page }) => {
  const tag = uniq('wa');
  const me = await appState(page.request);
  await useTool(page.request, me.orchestratorId, 'ask_person', {
    question: `Which of the two stills looks right for ${tag}?`,
    options: [{ label: `The left one (${tag})`, description: 'What it does.', recommended: true }, { label: `The right one (${tag})`, description: 'What it does.' }],
  });
  await page.goto('/#/dispatcher/waiting');
  const card = page.getByTestId('waiting-tab').locator('.qc').filter({ hasText: tag });
  await expect(card).toBeVisible();
  const box = card.locator('.qc-free-text');
  const chips = card.getByTestId('pending-file');

  // A screenshot pasted into the box: a thumbnail chip, uploaded, with a remove control.
  await box.click();
  await fire(page, `.qc:has-text("${tag}") .qc-free-text`, 'paste', [{ name: 'image.png', type: 'image/png', base64: RED_PNG }]);
  await expect(chips).toHaveCount(1);
  await expect(chips.first().locator('img.composer-file-thumb')).toBeVisible();
  await expect(card.locator('.composer-file.done')).toHaveCount(1, { timeout: 20_000 });

  // A file picked with the paperclip.
  const chooser = page.waitForEvent('filechooser');
  await card.getByRole('button', { name: 'Attach files' }).click();
  await (await chooser).setFiles([{ name: `Player-${tag}.log`, mimeType: 'text/plain', buffer: Buffer.from(`[Desync] heartbeat 1200 ${tag}\n`) }]);
  await expect(chips).toHaveCount(2);

  // A file dropped on the box, then removed again.
  await fire(page, `.qc:has-text("${tag}") .qc-free`, 'drop', [{ name: `drop-${tag}.txt`, type: 'text/plain', base64: btoa(`dropped ${tag}`) }]);
  await expect(chips).toHaveCount(3);
  await chips.filter({ hasText: `drop-${tag}.txt` }).getByRole('button', { name: `Remove drop-${tag}.txt` }).click();
  await expect(chips).toHaveCount(2);
  await expect(card.locator('.composer-file.done')).toHaveCount(2, { timeout: 20_000 });
  await box.fill(`The left one, and the log has the detail ${tag}`);
  await shot(page, card, 'w1912-card-with-pasted-image');

  await card.getByTestId('qc-send').click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  const mine = (await humanMessages(page, me.orchestratorId)).find((e) => e.text.includes(`The left one, and the log has the detail ${tag}`));
  expect(mine, 'the typed answer reached the orchestrator').toBeTruthy();
  expect(mine!.attachments?.map((a) => a.name).sort()).toEqual(['image.png', `Player-${tag}.log`].sort());
  const png = mine!.attachments!.find((a) => a.name === 'image.png')!;
  expect(png.mediaType).toBe('image/png');
  expect(png.size).toBe(PNG.length);
  expect(png.id).toMatch(/^att_[a-z0-9]{12}$/);
  expect(png.sha256).toMatch(/^[a-f0-9]{64}$/);
  // The orchestrator was handed them as untrusted files with ids, to pass on to the request's worker (the fake echoes its prompt).
  await expect(async () => {
    const r = await page.request.get(`/api/sessions/${me.orchestratorId}/events?limit=500`);
    const text = JSON.stringify(await r.json());
    expect(text).toContain('[attachments: 2 files a person uploaded');
    expect(text).toContain(png.id);
  }).toPass({ timeout: 15_000 });
});

test('w1912: a file alone is an answer, and a click on an option carries the files with it', async ({ authed: page }) => {
  const tag = uniq('wb');
  const me = await appState(page.request);
  await useTool(page.request, me.orchestratorId, 'ask_person', {
    question: `Ship ${tag} now?`,
    options: [{ label: `Ship ${tag}`, description: 'What it does.', recommended: true }, { label: `Hold ${tag}`, description: 'What it does.' }],
  });
  await page.goto('/#/dispatcher/waiting');
  const card = page.getByTestId('waiting-tab').locator('.qc').filter({ hasText: tag });
  await expect(card).toBeVisible();
  const chips = card.getByTestId('pending-file');
  // Nothing to send yet.
  await expect(card.getByTestId('qc-send')).toBeDisabled();
  await fire(page, `.qc:has-text("${tag}") .qc-free-text`, 'paste', [{ name: 'image.png', type: 'image/png', base64: RED_PNG }]);
  await expect(card.locator('.composer-file.done')).toHaveCount(1, { timeout: 20_000 });
  await expect(card.getByTestId('qc-send')).toBeEnabled();
  // A click on an answer sends the picture with it (POST /answer carries the attachment ids).
  await card.getByRole('button', { name: new RegExp(`^Hold ${tag}`) }).click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  const mine = (await humanMessages(page, me.orchestratorId)).find((e) => e.text.startsWith(`Hold ${tag}`));
  expect(mine?.attachments?.map((a) => a.name)).toEqual(['image.png']);
  await expect(chips).toHaveCount(0);

  // A second question answered by a file alone: the words say so.
  await useTool(page.request, me.orchestratorId, 'ask_person', {
    question: `Another look at ${tag}?`,
    options: [{ label: `Yes (${tag})`, description: 'What it does.' }, { label: `No (${tag})`, description: 'What it does.' }],
  });
  const card2 = page.getByTestId('waiting-tab').locator('.qc').filter({ hasText: `Another look at ${tag}` });
  await expect(card2).toBeVisible();
  await fire(page, `.qc:has-text("Another look at ${tag}") .qc-free-text`, 'paste', [{ name: 'image.png', type: 'image/png', base64: RED_PNG }]);
  await expect(card2.locator('.composer-file.done')).toHaveCount(1, { timeout: 20_000 });
  await card2.getByTestId('qc-send').click();
  await expect(card2).toHaveCount(0, { timeout: 15_000 });
  const alone = (await humanMessages(page, me.orchestratorId)).find((e) => e.text.includes('See the attached file.'));
  expect(alone?.attachments?.map((a) => a.name)).toEqual(['image.png']);
});

test('w1912: a file over the limit is refused in the box, before any upload', async ({ authed: page }) => {
  const tag = uniq('wc');
  const me = await appState(page.request);
  await useTool(page.request, me.orchestratorId, 'ask_person', { question: `Limits for ${tag}?`, options: [{ label: `A ${tag}`, description: 'What it does.' }, { label: `B ${tag}`, description: 'What it does.' }] });
  await page.goto('/#/dispatcher/waiting');
  const card = page.getByTestId('waiting-tab').locator('.qc').filter({ hasText: tag });
  await expect(card).toBeVisible();
  let uploads = 0;
  await page.route('**/api/attachments', (route) => {
    uploads++;
    return route.continue();
  });
  const chooser = page.waitForEvent('filechooser');
  await card.getByRole('button', { name: 'Attach files' }).click();
  // The e2e server caps a file at 20 MB (e2e/server.ts); the page learns the limit from the app's settings.
  await (await chooser).setFiles([{ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(21 * 1024 * 1024, 1) }]);
  await expect(page.getByText(/huge\.bin is 21(\.0)? MB; the limit is/)).toBeVisible();
  await expect(card.getByTestId('pending-file')).toHaveCount(0);
  expect(uploads).toBe(0);
});

/** A wait of the ledger (not a question of the orchestrator): its answer goes to the orchestrator as the message that records it on the request. */
test('w1912: a request card sends the answer to your orchestrator with the files as attachments', async ({ page }) => {
  const now = Date.now();
  const cases = waitingCases(now);
  const TESTER = { userId: 'tester', displayName: 'tester' };
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      if (e.type === 'state') {
        // Today's real cases as the tester's own (e2e/waitingCards.spec.ts): their people are the tester, each waiting worker a session.
        const work = cases.map(({ w }) => {
          const r = w.needsYou;
          return { ...w, requestedBy: TESTER, requesters: [TESTER], ...(r ? { needsYou: { ...r, who: ['tester'], to: ['tester'] } } : {}) } as never;
        });
        const workers = cases.flatMap(({ w, session }) => {
          const r = w.needsYou;
          if (!session || !r) return [];
          return [{ id: session.id, kind: 'worker', title: `${w.id}: worker`, status: 'idle', createdAt: w.createdAt, lastActivityAt: r.at, requestedBy: TESTER, pendingPermissions: [], waitingOn: { who: 'tester', what: r.question, at: r.at, ...(r.asks ? { asks: r.asks } : {}) } } as never];
        });
        return ws.send(JSON.stringify({ type: 'state', state: { ...e.state, work, sessions: [...e.state.sessions, ...workers] } } satisfies ServerEvent));
      }
      if (e.type === 'session' || e.type === 'session_removed' || e.type === 'work') return;
      ws.send(raw);
    });
    ws.onMessage((m) => server.send(m));
  });
  await signIn(page);
  const me = await appState(page.request);
  await page.goto('/#/dispatcher/waiting');
  // A request's card that takes files (an intake card's decline reason does not: a declined request goes nowhere), pinned by the
  // fixture's own id: the requests other tests filed show for a moment before the state override replaces them.
  const mineCase = cases.find(({ w, session }) => session && w.needsYou)!;
  const card = page.getByTestId(`wait-${mineCase.w.id}`);
  await expect(card.getByRole('button', { name: 'Attach files' })).toBeVisible();
  await card.locator('.qc-free-text').evaluate((el) => el.setAttribute('data-w1912', '1'));
  await fire(page, '[data-w1912]', 'paste', [{ name: 'image.png', type: 'image/png', base64: RED_PNG }]);
  await expect(card.locator('.composer-file.done')).toHaveCount(1, { timeout: 20_000 });
  const words = `see the picture ${uniq('wd')}`;
  // A card of several questions takes each in turn ("Next"); the files go with the last answer.
  const sent = page.locator('[data-testid^="wait-sent-"]');
  await expect(async () => {
    if (await sent.count()) return;
    await card.locator('.qc-free-text').fill(words);
    await card.getByTestId('qc-send').click();
    await expect(sent).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  const mine = (await humanMessages(page, me.orchestratorId)).find((e) => e.text.includes(words));
  expect(mine, 'the answer reached the orchestrator').toBeTruthy();
  expect(mine!.attachments?.map((a) => a.name)).toEqual(['image.png']);
});
