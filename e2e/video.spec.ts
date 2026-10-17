import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, openSandbox, startWorker, test, uniq } from './fixtures.ts';

test('video: a clip an agent mentions plays inline and seeks with HTTP ranges (a review-folder clip)', async ({ authed: page, browserName }) => {
  // The review folder the e2e server seeds (e2e/server.ts): the portal holds no sandboxes of its own (w510), and videos
  // from a machine are not shown yet (server/index.ts /api/image).
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review');
  const clip = path.join(review, 'w000-clips', 'clip.webm').replace(/\\/g, '/');
  const tag = uniq('vid');
  const s = await startWorker(page.request, `see ${clip} ${tag}`, { title: `Video ${tag}` });
  const panel = await openSandbox(page, 'pc/alpha', s.id);
  await expect(panel.locator('.msg-assistant', { hasText: `Echo: see ${clip}` })).toBeVisible();

  // Inline player: Playwright's Chromium decodes WebM (its WebKit builds do not, and hide what they cannot
  // play, as images that fail to load are hidden). The metadata, and so the duration, arrives without playing.
  if (browserName === 'chromium') {
    const video = panel.locator('.msg-assistant .video-item video').first();
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('preload', 'metadata');
    // The player asks for the web preview (w1248); with no ffmpeg here the server sends the original. The link opens it.
    expect(await video.getAttribute('src')).toContain('preview=1');
    const full = panel.locator('.msg-assistant .video-item a.video-full').first();
    await expect(full).toHaveText('Full quality');
    expect(await full.getAttribute('href')).not.toContain('preview=1');
    expect(await video.evaluate((v: HTMLVideoElement) => v.controls && v.muted && v.playsInline)).toBe(true);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => (v.readyState >= 1 ? Math.round(v.duration) : -1))).toBe(2);
  }

  // The same authenticated, folder-limited endpoint as images, with ranges.
  const src = `/api/image?${new URLSearchParams({ session: s.id, path: clip })}`;
  const part = await page.request.get(src, { headers: { Range: 'bytes=0-99' } });
  expect(part.status()).toBe(206);
  expect(part.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
  expect(part.headers()['accept-ranges']).toBe('bytes');
  expect((await part.body()).length).toBe(100);
  expect((await page.request.get(src, { headers: { Range: 'bytes=99999999-' } })).status()).toBe(416);
  // ?preview=1 (w1248): with no preview to send, the original, ranges and all.
  const viaPreview = await page.request.get(`${src}&preview=1`, { headers: { Range: 'bytes=0-99' } });
  expect(viaPreview.status()).toBe(206);
  expect(viaPreview.headers()['content-type']).toBe('video/webm');
  const whole = await page.request.get(src);
  expect(whole.status()).toBe(200);
  expect(whole.headers()['content-type']).toBe('video/webm');
  const outside = `/api/image?${new URLSearchParams({ session: s.id, path: clip.replace('/review/', '/elsewhere/') })}`;
  expect((await page.request.get(outside)).status()).toBeGreaterThanOrEqual(400);
});

test('video: a clip written as a markdown image, in the <angle> path form, is a player and not an image (w1030)', async ({ authed: page, browserName }) => {
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review');
  const dir = path.join(review, 'w000-clips').replace(/\\/g, '/');
  const tag = uniq('mdvid');
  const s = await startWorker(page.request, `see ![md clip](<${dir}/clip.webm>) and ![md mp4](<${dir}/clip.mp4>) ${tag}`, { title: `Markdown video ${tag}` });
  // A <video> asks for its file with a Range header; an <img> never does. That holds for the .mp4 whatever the browser can decode.
  const asked = page.waitForRequest((r) => r.url().includes('clip.mp4') && r.url().includes('/api/image') && !!r.headers().range);
  const panel = await openSandbox(page, 'pc/alpha', s.id);
  await asked;
  const message = panel.locator('.msg-assistant', { hasText: tag });
  await expect(message).toBeVisible();
  await expect(message.locator('img[src*="clip.mp4"], img[src*="clip.webm"]')).toHaveCount(0);
  if (browserName === 'chromium') {
    const video = message.locator('.md-video video').first();
    await expect(video).toBeVisible();
    expect(await video.evaluate((v: HTMLVideoElement) => v.controls && v.playsInline)).toBe(true);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => (v.readyState >= 1 ? Math.round(v.duration) : -1))).toBe(2);
    await expect(message.locator('.md-video-cap').first()).toContainText('md clip');
  }
});

test('video: ?preview=1 sends a review clip\'s web preview, with ranges; the original stays one link away (w1248)', async ({ authed: page }) => {
  const port = new URL(test.info().project.use.baseURL!).port;
  const review = path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'review');
  const clip = path.join(review, 'w000-clips', 'previewed.mp4').replace(/\\/g, '/');
  const s = await startWorker(page.request, `preview ${uniq('pv')}`, { title: 'Preview' });
  const src = `/api/image?${new URLSearchParams({ session: s.id, path: clip })}`;
  const preview = fs.statSync(path.join(path.dirname(clip), '.preview', 'previewed.mp4.mp4')).size;
  const part = await page.request.get(`${src}&preview=1`, { headers: { Range: 'bytes=0-99' } });
  expect(part.status()).toBe(206);
  expect(part.headers()['content-range']).toBe(`bytes 0-99/${preview}`);
  expect(part.headers()['content-type']).toBe('video/mp4');
  expect((await part.body()).length).toBe(100);
  const tail = await page.request.get(`${src}&preview=1`, { headers: { Range: `bytes=${preview - 10}-` } });
  expect(tail.status()).toBe(206);
  expect(tail.headers()['content-range']).toBe(`bytes ${preview - 10}-${preview - 1}/${preview}`);
  expect((await page.request.get(`${src}&preview=1`, { headers: { Range: `bytes=${preview}-` } })).status()).toBe(416);
  const whole = await page.request.get(`${src}&preview=1`);
  expect(whole.status()).toBe(200);
  expect(Number(whole.headers()['content-length'])).toBe(preview);
  // Without it, the original: 100 bytes.
  const original = await page.request.get(src);
  expect(original.status()).toBe(200);
  expect((await original.body()).length).toBe(100);
});
