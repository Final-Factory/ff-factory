import type { APIRequestContext } from '@playwright/test';
import { ALPHA, appState, expect, go, isMobile, sandboxHash, startWorker, test, uniq } from './fixtures.ts';

/**
 * An agent's state on the page (w475, asked by Lothsahn): Working mid-turn, Working between turns (a wake_me, a
 * background task, with what it is on; w643: never "Waiting", which is a person), Idle (available), and the Overview
 * lists a sandbox's agents in that order ("running at the top, waiting below them, and idle below them").
 */

async function hook(request: APIRequestContext, door: 'wake' | 'patch-session', data: Record<string, unknown>) {
  const port = Number(new URL(test.info().project.use.baseURL!).port) + 200;
  const r = await request.post(`http://127.0.0.1:${port}/${door}`, { data });
  expect(r.ok(), await r.text()).toBeTruthy();
}

test('the Overview shows agents mid-turn, between turns (Working, with what they are on) and Idle in that order', async ({ authed: page }) => {
  const tag = uniq('state');
  const idle = await startWorker(page.request, `idle one ${tag}`, { title: `Idle ${tag}` });
  const waits = await startWorker(page.request, `checks in later ${tag}`, { title: `Check-in ${tag}` });
  const task = await startWorker(page.request, `background build ${tag}`, { title: `Build ${tag}` });
  const status = async (id: string) => (await appState(page.request)).sessions.find((s) => s.id === id)?.status;
  for (const s of [idle, waits, task]) await expect.poll(() => status(s.id), { timeout: 15_000 }).toBe('idle');
  await hook(page.request, 'wake', { id: waits.id, minutes: 30 });
  await hook(page.request, 'patch-session', { id: task.id, patch: { backgroundTasks: 1, backgroundJobs: [{ type: 'local_bash', description: `CI on PR #1098 ${tag}` }] } });
  await expect.poll(async () => (await appState(page.request)).sessions.find((s) => s.id === waits.id)?.wakeAt).toBeTruthy();

  await go(page, '#/overview');
  const board = page.getByTestId('overview');
  const lines = board.getByTestId('fl-agent');
  const line = (title: string) => lines.filter({ hasText: title });
  await expect(line(`Check-in ${tag}`)).toContainText('working');
  await expect(line(`Check-in ${tag}`)).not.toContainText('waiting');
  await expect(line(`Check-in ${tag}`).locator('.fl-agent-state')).toHaveClass(/tone-blue/);
  await expect(line(`Check-in ${tag}`)).toHaveAttribute('title', /working \(check-in \d\d:\d\d.*: “e2e check-in”\)/);
  // What it waits on, on the board itself (w509): the running job's description, or the check-in and its note.
  await expect(line(`Build ${tag}`).getByTestId('fl-agent-why')).toHaveText(`CI on PR #1098 ${tag}`);
  await expect(line(`Check-in ${tag}`).getByTestId('fl-agent-why')).toContainText('“e2e check-in”');
  await expect(line(`Build ${tag}`)).toHaveAttribute('title', new RegExp(`working \\(CI on PR #1098 ${tag}\\)`));
  await expect(line(`Idle ${tag}`)).toContainText('idle');

  // A working one goes to the top while its turn runs (#slow streams for a few seconds).
  const work = await startWorker(page.request, `#slow working one ${tag}`, { title: `Working ${tag}` });
  await expect(line(`Working ${tag}`)).toContainText('busy');
  const order = async () =>
    (await lines.allTextContents())
      .map((t) => [`Working ${tag}`, `Check-in ${tag}`, `Build ${tag}`, `Idle ${tag}`].find((x) => t.includes(x)))
      .filter((x): x is string => !!x);
  const seen = await order();
  expect(seen.indexOf(`Working ${tag}`)).toBeLessThan(seen.indexOf(`Check-in ${tag}`));
  expect(seen.indexOf(`Check-in ${tag}`)).toBeLessThan(seen.indexOf(`Idle ${tag}`));
  expect(seen.indexOf(`Build ${tag}`)).toBeLessThan(seen.indexOf(`Idle ${tag}`));
  await page.screenshot({ path: test.info().outputPath('agent-states.png') });
  await expect.poll(() => status(work.id), { timeout: 20_000 }).toBe('idle');
});

test("an agent's page says Working between turns, and on what (w643: not Waiting)", async ({ authed: page }) => {
  const tag = uniq('wait');
  const s = await startWorker(page.request, `checks in later ${tag}`, { title: `Waits ${tag}` });
  await expect.poll(async () => (await appState(page.request)).sessions.find((x) => x.id === s.id)?.status, { timeout: 15_000 }).toBe('idle');
  await hook(page.request, 'wake', { id: s.id, minutes: 30 });
  await go(page, sandboxHash(ALPHA, s.id));
  // Tabs on a wide screen, a picker on a phone: each names the state and what it waits on.
  if (isMobile(page)) await expect(page.locator('option', { hasText: `Waits ${tag}` })).toHaveText(/Waits \S+ · Working: check-in \d\d:\d\d/);
  else await expect(page.getByRole('tab', { name: new RegExp(`Waits ${tag}`) })).toHaveAttribute('title', /^Waits \S+: Working: check-in \d\d:\d\d/);
});
