// The live view (w1398, docs/live-view.md): a worker's live_view streams its sandbox's game (here the e2e machine's
// stand-in game, server/testLiveGame.ts) beside its conversation; a knob dragged on the page reaches the game, shows in
// the next frames, appears in the conversation and opens the agent's next message; only the person and owners watch.
import { expect, test } from '@playwright/test';
import type { AppState, TranscriptEvent } from '../shared/types.ts';
import { appState, isMobile, sendMessage, signIn, startWorker, uniq, useTool } from './fixtures.ts';

// One stand-in game serves the e2e machine: its knobs are shared, so these run one at a time.
test.describe.configure({ mode: 'serial' });

const events = async (request: import('@playwright/test').APIRequestContext, id: string) =>
  (await (await request.get(`/api/sessions/${id}/events?limit=500`)).json()) as TranscriptEvent[];

test('a worker\'s live view: frames beside its chat, a knob that reaches the game and the conversation', async ({ page, request }) => {
  await signIn(page);
  const ctx = page.request;
  const worker = await startWorker(ctx, 'Hello', { title: uniq('live') });
  const started = await useTool(ctx, worker.id, 'live_view', { action: 'start', materials: ['VfxComet'], fps: 10, width: 320 });
  expect(started).toMatch(/^Live view started \(10 fps, 320 px, knobs on VfxComet\)/);
  await expect.poll(async () => (await appState(ctx)).live?.find((v) => v.sessionId === worker.id)?.state, { timeout: 20_000 }).toBe('live');

  // The conversation offers the view; the view shows frames, LIVE, and the knobs the game reports.
  await page.goto(`/#/session/${worker.id}`);
  // The conversation's own button: the sidebar's slot offers "Live view: go" too (w1430), in a drawer on a phone.
  await page.getByTestId('live-open').first().click();
  await expect(page).toHaveURL(new RegExp(`#/live/${worker.id}$`));
  const stage = page.getByTestId('live-stage');
  await expect(stage).toHaveAttribute('data-state', 'live');
  await expect(page.getByTestId('live-chip')).toHaveText(/live/i);
  await expect(page.getByTestId('live-readout')).toContainText(/fps/);
  // A frame was drawn: the canvas took the frame's size (the stand-in's 64x36), not its 16x9 placeholder.
  await expect.poll(() => stage.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBe(64);

  if (isMobile(page)) await page.getByRole('button', { name: /knobs/i }).first().click();
  const intensity = page.locator('[data-testid="live-knob"][data-knob="_Intensity"]');
  await expect(intensity).toBeVisible();
  await expect(page.locator('[data-testid="live-knob"][data-knob="_ComaColor"]')).toBeVisible();
  // A knob the game says it cannot move (w1509) has no control among them: it sits folded apart, with the game's reason.
  await expect(page.locator('[data-testid="live-knob"][data-knob="_Age"]')).toHaveCount(0);
  const driven = page.getByTestId('live-driven');
  await expect(driven).toContainText('1 more the game sets itself');
  await driven.locator('summary').click();
  const age = driven.locator('[data-testid="live-knob-driven"][data-knob="_Age"]');
  await expect(age).toContainText('MaterialPropertyBlock');
  await expect(age.locator('input')).toHaveCount(0);

  // Move the knob: the game takes it, the picture follows, and the conversation says who set what.
  const before = await stage.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const posted = page.waitForResponse((r) => r.url().endsWith(`/api/live/${worker.id}/knob`) && r.request().method() === 'POST');
  await intensity.locator('input[type="range"]').fill('2');
  expect((await posted).ok()).toBeTruthy();
  const second = page.waitForResponse((r) => r.url().endsWith(`/api/live/${worker.id}/knob`) && r.request().method() === 'POST');
  await intensity.locator('input[type="range"]').fill('4');
  expect((await second).ok()).toBeTruthy();
  await expect.poll(() => stage.locator('canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL()), { timeout: 15_000 }).not.toBe(before);
  await expect
    .poll(async () => (await events(ctx, worker.id)).some((e) => e.kind === 'system' && /^\[live view\] tester set VfxComet\._Intensity to 4 in the live view$/i.test(e.text)), { timeout: 15_000 })
    .toBe(true);
  // One drag is one line: the knob's later moves amended it rather than adding a line each.
  expect((await events(ctx, worker.id)).filter((e) => e.kind === 'system' && e.text.startsWith('[live view]')).length).toBe(1);
  const knobs = await (await ctx.get(`/api/live/${worker.id}/knobs`)).json();
  expect(knobs[0].knobs.find((k: { name: string }) => k.name === '_Intensity').value).toBe(4);

  // The agent's next message from its person opens with what was set since.
  await sendMessage(ctx, worker.id, 'What do you think?');
  await expect
    .poll(async () => (await events(ctx, worker.id)).some((e) => e.kind === 'user' && e.text.startsWith('[live view] Since your last message, in the live view:') && /tester set VfxComet\._Intensity to 4/i.test(e.text) && e.text.endsWith('What do you think?')), { timeout: 15_000 })
    .toBe(true);

  // Only this view's materials and real property names reach the game.
  const bad = await ctx.post(`/api/live/${worker.id}/knob`, { data: { material: 'Other', name: '_Intensity', value: 1 } });
  expect(bad.status()).toBe(400);

  // Stop: the page says so and the app lists it no more.
  expect(await useTool(ctx, worker.id, 'live_view', { action: 'stop' })).toBe('Live view stopped.');
  await expect.poll(async () => ((await appState(ctx)) as AppState).live?.some((v) => v.sessionId === worker.id), { timeout: 15_000 }).toBe(false);
});

test('a live view is for its person and the owners: a member who did not ask cannot watch it or move its knobs', async ({ page, browser }) => {
  await signIn(page);
  const worker = await startWorker(page.request, 'Hello', { title: uniq('live-perm') });
  await useTool(page.request, worker.id, 'live_view', { action: 'start', materials: ['VfxComet'] });
  await expect.poll(async () => (await appState(page.request)).live?.some((v) => v.sessionId === worker.id), { timeout: 20_000 }).toBe(true);

  const mate = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    await expect(async () => {
      const r = await mate.request.post('/api/login', { data: { username: 'teammate', password: 'e2e-teammate-456' } });
      expect(r.ok(), await r.text()).toBeTruthy();
    }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
    expect((await appState(mate.request)).live?.some((v) => v.sessionId === worker.id)).toBeFalsy();
    expect((await mate.request.get(`/api/live/${worker.id}/knobs`)).status()).toBe(403);
    expect((await mate.request.post(`/api/live/${worker.id}/knob`, { data: { material: 'VfxComet', name: '_Intensity', value: 2 } })).status()).toBe(403);
  } finally {
    await mate.close();
    await useTool(page.request, worker.id, 'live_view', { action: 'stop' });
  }
});
