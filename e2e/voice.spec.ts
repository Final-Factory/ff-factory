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

// w3712: with Whisper, the words fill the box while the user talks. The E2E server has no Whisper, so these tests answer
// /api/voice/transcribe themselves: a live pass (`partial`) says one word per half second of the audio it got, so the box
// grows as the clip does; the final pass says a sentence of its own, which must replace the live text.
type LiveCall = { partial: boolean; seconds: number; at: number; live?: { passes: number; medianMs: number; firstTextMs?: number } };
async function fakeWhisper(page: Page, final: string) {
  const calls: LiveCall[] = [];
  await page.route(/\/api\/voice(\/warm)?$/, (r) => r.fulfill({ json: { state: 'ready', model: 'large-v3-turbo', device: 'cuda', tts: { state: 'idle', voice: 'af_heart' } } }));
  await page.route(/\/api\/voice\/transcribe$/, async (r) => {
    const body = r.request().postDataJSON() as { audio: string; partial?: boolean; live?: LiveCall['live'] };
    const seconds = (Buffer.from(body.audio, 'base64').length - 44) / 32_000;
    calls.push({ partial: !!body.partial, seconds, at: Date.now(), live: body.live });
    const words = Array.from({ length: Math.max(1, Math.floor(seconds * 2)) }, (_, i) => `w${i + 1}`).join(' ');
    await r.fulfill({ json: { text: body.partial ? words : final, model: 'large-v3-turbo', device: 'cuda', audioSeconds: seconds, seconds: 0.2, totalSeconds: 0.3, engine: 'remote', machine: 'beast' } });
  });
  return calls;
}

test('w3712: live Whisper dictation fills the chat box while talking, the final pass replaces it, and a cancel puts the box back', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'needs real Web Audio for the recorder (the WebKit run fakes AudioContext)');
  const { panel, tag } = await voicePage(page, browserName, { engine: 'whisper', dictationAutoStop: false });
  const calls = await fakeWhisper(page, `final words ${tag}`);
  const box = panel.locator(BOX);
  await box.click();
  await box.pressSequentially('Note:');

  await panel.getByRole('button', { name: 'Dictate' }).click();
  const bar = panel.locator('.dictation-bar');
  await expect(bar.locator('.rec-dot.live')).toBeVisible();
  const opened = Date.now();
  // The first words within two seconds of the mic opening (each live pass answers at once here: this is the page's own
  // cadence, a 0.6 s minimum of new audio and 0.3 s between passes).
  await expect.poll(() => boxText(box), { timeout: 2_000, intervals: [50] }).toMatch(/^Note: w1/);
  const firstWordsMs = Date.now() - opened;
  // And it keeps growing while the mic is open.
  await expect.poll(async () => (await boxText(box)).split(' ').length, { timeout: 5_000 }).toBeGreaterThan(5);
  expect(calls.every((c) => c.partial)).toBe(true);
  expect(calls.length).toBeGreaterThan(2);

  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toBeHidden();
  await expect.poll(() => boxText(box)).toBe(`Note: final words ${tag}`);
  const finalCall = calls.find((c) => !c.partial)!;
  expect(finalCall.seconds).toBeGreaterThan(2);
  expect(finalCall.live?.passes).toBeGreaterThan(2);
  expect(finalCall.live?.firstTextMs).toBeLessThan(2_000);
  console.log(`w3712 e2e (${browserName}): first live words ${firstWordsMs} ms after the mic opened; ${finalCall.live?.passes} live passes`);
  await expect(panel.locator('.msg-user', { hasText: `final words ${tag}` })).toHaveCount(0);

  // A second dictation, discarded with Esc: its live words leave and the box is as it was.
  await panel.getByRole('button', { name: 'Dictate' }).click();
  await expect.poll(() => boxText(box), { timeout: 3_000 }).toMatch(new RegExp(`final words ${tag} w1`));
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect.poll(() => boxText(box)).toBe(`Note: final words ${tag}`);
});

test('w3712: a question card answer box fills live while talking, then holds the final transcript', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'needs real Web Audio for the recorder (the WebKit run fakes AudioContext)');
  await page.addInitScript(fakeVoice, { fakeAudio: false });
  await page.addInitScript(() => localStorage.setItem('ffsb.voice.prefs', JSON.stringify({ engine: 'whisper', dictationAutoStop: false })));
  await signIn(page);
  const tag = uniq('qclive');
  const calls = await fakeWhisper(page, `the newest save first ${tag}`);
  const me = await appState(page.request);
  const id = (await useTool(page.request, me.orchestratorId, 'request_work', { title: `Live answer ${tag}`, brief: `A live dictation card ${tag}.` })).match(/Filed (w\d+)/)![1];
  const asks = [{ question: `Which save comes first ${tag}?`, options: [{ label: 'Newest', description: '', recommended: true }, { label: 'Oldest', description: '' }] }];
  await patchWork(page.request, id, { status: 'question', question: { text: 'Which save comes first?', at: new Date().toISOString(), asks } });
  await page.goto('/#/dispatcher/waiting');
  const card = page.getByTestId(`wait-${id}`);
  const box = card.getByLabel('Or type your own answer');
  await card.getByRole('button', { name: 'Dictate' }).click();
  const bar = card.locator('.dictation-bar');
  await expect(bar.locator('.rec-dot.live')).toBeVisible();
  await expect(box).toHaveValue(/^w1/, { timeout: 2_000 });
  await expect.poll(async () => (await box.inputValue()).split(' ').length, { timeout: 5_000 }).toBeGreaterThan(4);
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(box).toHaveValue(`the newest save first ${tag}`);
  expect(calls.filter((c) => !c.partial)).toHaveLength(1);
  await expect(card.getByTestId('qc-send')).toHaveText('Send');
});
