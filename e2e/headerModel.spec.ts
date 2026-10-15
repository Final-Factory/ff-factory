import type { Locator, Page } from '@playwright/test';
import { appState, expect, expectNoHorizontalOverflow, go, isMobile, openSandbox, sendToChat, startWorker, test, uniq } from './fixtures.ts';

/**
 * w1358 (asked by Ben: "show what model is active in a given conversation, like up in the header"): every conversation
 * header shows the model its last reply came from, "Opus 5.5", the full id on hover, beside the context size. It follows
 * a switch at once, like the state and the context do, and nothing else in the header moves. The fake agent answers as
 * claude-opus-5-5 and switches with "#model <id>" (e2e/fakeAgent.ts). The id-to-name mapping is server/models.test.ts.
 */

const chip = (page: Page) => page.getByTestId('active-model');

/** Where the header's other items are. */
async function boxes(header: Locator) {
  return header.evaluate((h) => {
    const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
    const hid = h.querySelectorAll('[data-testid="active-model"]');
    hid.forEach((e) => ((e as HTMLElement).style.display = 'none'));
    const spots: Record<string, string> = { name: '.orch-name, .ph-name, h2', state: '.state', context: '[data-testid="context-size"]', last: 'button:last-of-type' };
    const read = (tag: string) => {
      for (const [k, sel] of Object.entries(spots)) {
        const el = h.querySelector(sel);
        const r = el?.getBoundingClientRect();
        out[`${tag}:${k}`] = r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
      }
      const r = h.getBoundingClientRect();
      out[`${tag}:header`] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    read('without');
    hid.forEach((e) => ((e as HTMLElement).style.display = ''));
    read('with');
    return out;
  });
}

/** The header with and without the chip: the name, the state, the context size and the last button are where they were (the title takes the chip's room). */
async function expectNothingMoved(header: Locator, pinned: string[]) {
  const b = await boxes(header);
  for (const k of ['header', ...pinned]) {
    expect(b[`with:${k}`], `${k} is in the header`).not.toBeNull();
    expect(b[`with:${k}`], k).toEqual(b[`without:${k}`]);
  }
}

test('the orchestrator header shows the model of its last reply, and follows a switch live', async ({ authed: page }) => {
  const me = await appState(page.request);
  const tag = uniq('mdl');
  await sendToChat(page.request, me.orchestratorId, `hello ${tag} #model claude-opus-5-5`);
  const header = page.locator('.orch .orch-head');
  await expect(page.locator('.orch .msg-assistant', { hasText: `Echo: hello ${tag}` })).toBeVisible({ timeout: 15_000 });
  const model = header.getByTestId('active-model');
  await expect(model).toHaveText('Opus 5.5');
  await expect(model).toHaveAttribute('title', /^claude-opus-5-5: /);
  await expect(model).toHaveAttribute('data-source', 'reply');
  // Beside the context size, before it.
  const m = (await model.boundingBox())!;
  const c = await header.getByTestId('context-size').boundingBox();
  if (c) expect(m.x + m.width).toBeLessThanOrEqual(c.x + 0.5);
  await expectNoHorizontalOverflow(page);
  // Nothing in the header moves for it (the title, flexible, gives it room).
  await expectNothingMoved(header, isMobile(page) ? ['state', 'name', 'last'] : ['state', 'name', 'context', 'last']);

  // The model changes under it: the header follows without a reload.
  await sendToChat(page.request, me.orchestratorId, `switch ${tag} #model claude-sonnet-5-5`);
  await expect(model).toHaveText('Sonnet 5.5', { timeout: 15_000 });
  await expect(model).toHaveAttribute('title', /^claude-sonnet-5-5: /);
  await expect.poll(async () => (await appState(page.request)).sessions.find((s) => s.id === me.orchestratorId)?.activeModel).toBe('claude-sonnet-5-5');
  await sendToChat(page.request, me.orchestratorId, `back ${tag} #model claude-opus-5-5`);
  await expect(model).toHaveText('Opus 5.5', { timeout: 15_000 });
});

test('a worker conversation, full width, shows its model in its header', async ({ authed: page }) => {
  const w = await startWorker(page.request, `which model ${uniq('w')} #model claude-haiku-4-5`);
  await expect.poll(async () => (await appState(page.request)).sessions.find((s) => s.id === w.id)?.activeModel, { timeout: 15_000 }).toBe('claude-haiku-4-5');
  await go(page, `#/session/${w.id}`);
  const header = page.locator('.session-view .ph');
  await expect(header.getByTestId('active-model')).toHaveText('Haiku 4.5');
  await expect(header.getByTestId('active-model')).toHaveAttribute('title', /^claude-haiku-4-5: /);
  await expectNoHorizontalOverflow(page);
  await expectNothingMoved(header, ['name', 'state', 'last']);
});

test('a sandbox page shows the model of the agent it has open (desktop), the seeded one answered as Opus 5.5', async ({ authed: page }) => {
  test.skip(isMobile(page), 'the phone header has the agent picker in that line; the full-width page above has the model');
  const panel = await openSandbox(page, 'pc/gallery');
  await expect(panel.locator('.ph').getByTestId('active-model')).toHaveText('Opus 5.5');
});

test('the dispatcher header shows its model', async ({ authed: page }) => {
  await go(page, '#/dispatcher/conversation');
  const panel = page.locator('.dispatcher-panel');
  await expect(panel.locator('.sb-head-top').getByTestId('active-model')).toHaveText(/^(Opus|Sonnet|Haiku|Fable)\b/);
  await expectNoHorizontalOverflow(page);
});
