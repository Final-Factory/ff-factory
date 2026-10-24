import type { Page } from '@playwright/test';
import { ALPHA, BOX, appState, boxText, expect, expectNoHorizontalOverflow, isMobile, patchWork, sandboxHash, signIn, startWorker, test, uniq, useTool } from './fixtures.ts';
import { fakeVoice } from './voice.ts';

// Voice is turned off on the E2E server (no local Whisper, no Kokoro), so voice mode and the mic use
// the browser's own engines, which e2e/voice.ts replaces with scripted ones: the test is the speaker.

type SpeechWindow = { __speech: { live: unknown[]; say(t: string, final?: boolean): void; end(): void }; __tts: { spoken: string[]; release(): void } };
const say = (page: Page, text: string, final = true) => page.evaluate(([t, f]) => (window as unknown as SpeechWindow).__speech.say(t as string, f as boolean), [text, final] as const);
const endUtterance = (page: Page) => page.evaluate(() => (window as unknown as SpeechWindow).__speech.end());
const listening = (page: Page) => page.evaluate(() => (window as unknown as SpeechWindow).__speech.live.length);

/** A worker's page with the fakes in place and the server's voice status known (it decides the engine). */
async function voicePage(page: Page, browserName: string, prefs?: object) {
  await page.addInitScript(fakeVoice, { fakeAudio: browserName === 'webkit' });
  if (prefs) await page.addInitScript((p) => localStorage.setItem('ffsb.voice.prefs', p), JSON.stringify(prefs));
  await signIn(page);
  const tag = uniq('voice');
  const s = await startWorker(page.request, `hi ${tag}`, { title: `Voice ${tag}` });
  await page.goto(`/${sandboxHash(ALPHA, s.id)}`);
  const panel = page.locator('.sb-panel');
  await expect(panel.locator('.msg-assistant[data-turn-end]')).toHaveCount(1);
  return { panel, tag };
}

test('voice mode: listening, hearing, thinking, speaking, listening again, stopped by voice or a tap', async ({ page, browserName }) => {
  const { panel, tag } = await voicePage(page, browserName);

  await panel.getByRole('button', { name: 'Voice mode' }).click();
  const vm = page.getByRole('dialog', { name: 'Voice mode' });
  const word = vm.getByTestId('vm-state');
  const sub = vm.locator('.vm-sub');
  await expect(word).toHaveText('Listening');
  await expect(sub).toHaveText('Go ahead');
  await expect(vm.locator('.vm-title')).toHaveText(`Voice ${tag}`);
  await expect(vm.locator('.vm-engines')).toContainText('Browser →');
  await expect.poll(() => listening(page)).toBe(1);

  // Speech starts: still "Listening", now hearing you.
  await say(page, 'tell me', false);
  await expect(sub).toHaveText('Hearing you');
  // The utterance ends; it is sent, and the reply streams for a few seconds (#slow).
  await say(page, `tell me a story #slow ${tag}`);
  await endUtterance(page);
  await expect(vm.locator('.vm-heard')).toHaveText(`“tell me a story #slow ${tag}”`);
  await expect(word).toHaveText('Thinking');
  await expect(sub).toHaveText('Waiting for the reply');

  // The reply is read aloud (held by the fake until released).
  await expect(word).toHaveText('Speaking', { timeout: 10_000 });
  await expect(sub).toHaveText('Talk to interrupt');
  // As spoken: markdown and symbols out, a full stop at the end.
  await expect(vm.locator('.vm-reply')).toHaveText(`Echo: tell me a story slow ${tag}.`);
  await expect(vm.locator('.vm-engines')).toHaveText('Browser → browser voice');
  expect((await page.evaluate(() => (window as unknown as SpeechWindow).__tts.spoken)).join(' ')).toContain(`tell me a story slow ${tag}`);
  await page.evaluate(() => (window as unknown as SpeechWindow).__tts.release());

  // And it listens again.
  await expect(word).toHaveText('Listening');
  await expect.poll(() => listening(page)).toBe(1);

  // "Stop" ends it.
  await say(page, 'stop');
  await endUtterance(page);
  await expect(vm).toBeHidden();
  await expect(page.locator('.toast', { hasText: 'Stopped by voice.' })).toBeVisible();
  // What was said went into the conversation like a typed message.
  await expect(panel.locator('.msg-user', { hasText: `tell me a story #slow ${tag}` })).toBeVisible();
  await expect(panel.locator('.msg-user .bubble-text', { hasText: /^stop$/ })).toHaveCount(0);

  // A tap anywhere ends it too.
  await panel.getByRole('button', { name: 'Voice mode' }).click();
  await expect(word).toHaveText('Listening');
  await vm.click();
  await expect(vm).toBeHidden();
  await expect(page.locator('.toast', { hasText: 'Voice mode off.' })).toBeVisible();
  await expect.poll(() => listening(page)).toBe(0);
});

test('dictation with the browser engine: the words land in the box for review', async ({ page, browserName }) => {
  const { panel, tag } = await voicePage(page, browserName);
  const box = panel.locator(BOX);
  const mic = panel.getByRole('button', { name: 'Dictate' });

  await mic.click();
  const bar = panel.locator('.dictation-bar');
  await expect(bar).toBeVisible();
  await expect(bar.locator('.dictation-interim')).toHaveText('Listening…');
  await expect(bar.locator('.engine-long')).toHaveText('Browser speech');
  await expect(panel.getByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true');

  await say(page, `note for ${tag}`, false);
  await expect(bar.locator('.dictation-interim')).toHaveText(`note for ${tag}`);
  await say(page, `note for ${tag}`);
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toBeHidden();
  // Not sent: it waits in the box (the "send automatically" setting is off by default).
  await expect.poll(() => boxText(box)).toBe(`note for ${tag}`);
  await expect(panel.locator('.msg-user', { hasText: `note for ${tag}` })).toHaveCount(0);
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
});

test('dictation with local Whisper chosen: records the mic, then says transcription is unavailable', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'needs real Web Audio for the recorder (the WebKit run fakes AudioContext)');
  const { panel } = await voicePage(page, browserName, { engine: 'whisper' });

  await panel.getByRole('button', { name: 'Dictate' }).click();
  const bar = panel.locator('.dictation-bar');
  await expect(bar.locator('.engine-short')).toHaveText('Whisper');
  await expect(bar.locator('.rec-dot.live')).toBeVisible();
  await expect(bar.locator('.level-meter')).toBeVisible();
  // Long enough to be a clip (under 0.3 s is refused as too short). Any second past 0:00: a loaded CI runner can stall the
  // page past 0:01 between polls (w2014: run 40081034328 read 0:06 and 0:07).
  await expect(bar.locator('.dictation-time')).not.toHaveText('0:00', { timeout: 5_000 });
  await expect(bar.locator('.dictation-time')).toHaveText(/^\d+:\d\d$/);

  await bar.getByRole('button', { name: 'Done' }).click();
  const err = panel.getByRole('alert');
  await expect(err).toContainText('Transcription failed: local Whisper is unavailable: turned off in config.json (voice.enabled)');
  await expect(err.getByRole('button', { name: 'Retry' })).toBeVisible();
  await err.getByRole('button', { name: 'Dismiss' }).click();
  await expect(err).toBeHidden();
});

// w1817: a question card's free-text box dictates like the chat box (the same MicButton, DictationBar and useTextareaDictation).
test('a question card has the chat mic: the words land in its answer box for review, then Send', async ({ page, browserName }) => {
  await page.addInitScript(fakeVoice, { fakeAudio: browserName === 'webkit' });
  await signIn(page);
  const tag = uniq('qcmic');
  const me = await appState(page.request);
  const id = (await useTool(page.request, me.orchestratorId, 'request_work', { title: `Voice answer ${tag}`, brief: `A question card with a mic ${tag}.` })).match(/Filed (w\d+)/)![1];
  const asks = [
    { question: `Which save comes first ${tag}?`, options: [{ label: `Newest first ${tag}`, description: 'Like the load menu.', recommended: true }, { label: `Keep the old order ${tag}`, description: '' }] },
    { question: `Should the list be sorted by name ${tag}?`, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] },
  ];
  await patchWork(page.request, id, { status: 'question', question: { text: 'Which save comes first?', at: new Date().toISOString(), asks } });
  await page.goto('/#/dispatcher/waiting');
  const card = page.getByTestId(`wait-${id}`);
  await expect(card.getByTestId('qc-progress')).toContainText('Question 1 of 2');

  const mic = card.getByRole('button', { name: 'Dictate' });
  const box = card.getByLabel('Or type your own answer');
  await expect(mic).toBeVisible();
  await expect(mic).toBeEnabled();
  if (process.env.QC_SHOTS) await card.screenshot({ path: `${process.env.QC_SHOTS}/card-mic-${isMobile(page) ? 'narrow' : 'desktop'}.png` });
  await expectNoHorizontalOverflow(page);

  await mic.click();
  const bar = card.locator('.dictation-bar');
  await expect(bar.locator('.dictation-interim')).toHaveText('Listening…');
  await expect(card.getByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true');
  await say(page, `keep it ${tag}`);
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toBeHidden();
  // Not sent: it waits in the box to be edited, and Send is ready.
  await expect(box).toHaveValue(`keep it ${tag}`);
  await expect(card.getByTestId('qc-question')).toContainText('Which save comes first');
  if (process.env.QC_SHOTS) await card.screenshot({ path: `${process.env.QC_SHOTS}/card-dictated-${isMobile(page) ? 'narrow' : 'desktop'}.png` });
  await card.getByTestId('qc-send').click();
  // Next question: the box is empty again and the mic is still there.
  await expect(card.getByTestId('qc-progress')).toContainText('Question 2 of 2');
  await expect(box).toHaveValue('');
  await expect(card.getByRole('button', { name: 'Dictate' })).toBeVisible();
  // The last question, as in Ben's screenshot: listening, then the transcript waiting under Send.
  const shot = (name: string) => (process.env.QC_SHOTS ? card.screenshot({ path: `${process.env.QC_SHOTS}/${name}-${isMobile(page) ? 'narrow' : 'desktop'}.png` }) : undefined);
  await card.getByRole('button', { name: 'Dictate' }).click();
  await expect(bar.locator('.dictation-interim')).toHaveText('Listening…');
  await shot('q2-listening');
  await say(page, `use the second one because it matches the load menu, and tell the player why ${tag}`);
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(box).toHaveValue(`use the second one because it matches the load menu, and tell the player why ${tag}`);
  await expect(card.getByTestId('qc-send')).toHaveText('Send');
  // What was dictated shows whole, for review: the box grew instead of cutting the second line off.
  expect(await box.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  await shot('q2-dictated');
});
