import type { Page } from '@playwright/test';
import { expect, signIn, startWorker, test, uniq } from './fixtures.ts';
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
  const status = page.waitForResponse((r) => r.url().endsWith('/api/voice'));
  await page.goto(`/#/sandbox/alpha/${s.id}`);
  expect((await (await status).json()).state).toBe('unavailable');
  const panel = page.locator('.sb-panel');
  await expect(panel.locator('.turn-footer')).toHaveCount(1);
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
  await expect(panel.locator('.msg-user', { hasText: /^stop$/ })).toHaveCount(0);

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
  const box = panel.locator('.composer textarea');
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
  await expect(box).toHaveValue(`note for ${tag}`);
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
  // Long enough to be a clip (under 0.3 s is refused as too short).
  await expect(bar.locator('.dictation-time')).toHaveText('0:01', { timeout: 5_000 });

  await bar.getByRole('button', { name: 'Done' }).click();
  const err = panel.getByRole('alert');
  await expect(err).toContainText('Transcription failed: local Whisper is unavailable: turned off in config.json (voice.enabled)');
  await expect(err.getByRole('button', { name: 'Retry' })).toBeVisible();
  await err.getByRole('button', { name: 'Dismiss' }).click();
  await expect(err).toBeHidden();
});
