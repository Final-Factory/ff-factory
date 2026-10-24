import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { ALPHA, expect, openSidebar, startWorker, test } from './fixtures.ts';

/** The teammate's /mcp key, which e2e/server.ts wrote beside this server's data folder. */
function mateKey() {
  const port = new URL(test.info().project.use.baseURL!).port;
  return fs.readFileSync(path.join(os.tmpdir(), `ffsb-e2e-${port}`, 'teammate-key.txt'), 'utf8').trim();
}

/** list_sandboxes over the stateless /mcp endpoint, as an agent reads it. */
async function listSandboxes(request: APIRequestContext): Promise<string> {
  const r = await request.post('/mcp', {
    headers: { authorization: `Bearer ${mateKey()}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sandboxes', arguments: {} } },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const body = (await r.json()) as { result: { content: { text: string }[] } };
  return body.result.content.map((c) => c.text).join('\n');
}

test('w2067: a machine with empty sandboxes reads in use of its limit on the page, as list_sandboxes counts it at the same moment', async ({ authed: page }) => {
  // A live worker in pc/alpha, the other made sandbox empty: the biscuit case (2026-10-24), some made sandboxes empty.
  await startWorker(page.request, 'hold the sandbox', { sandbox: ALPHA, title: 'w2067: in use' });
  const sidebar = await openSidebar(page);
  // Machine "pc", the in-process daemon (e2e/server.ts): made sandboxes, some with no agent.
  const cap = sidebar.locator('[data-testid^="fl-group-"]').filter({ has: page.getByTestId('fl-sandbox-pc/alpha') }).getByTestId('fl-capacity');
  await expect(cap).toHaveText(/^\d+\/\d+ sandboxes · /);
  // Other tests start workers on pc too: the page and list_sandboxes are compared until one reading holds for both.
  let text = '';
  await expect(async () => {
    text = await listSandboxes(page.request);
    const header = text.split('\n').find((l) => l.startsWith('## pc '))!;
    const [, inUse, limit] = /(\d+)\/(\d+) sandboxes in use/.exec(header)!;
    // The FREE marks under that header are what the in-use count leaves out.
    const lines = text.split('\n').filter((l) => l.startsWith('- pc/'));
    expect(lines.filter((l) => !/^- pc\/\S+ FREE/.test(l)).length).toBe(Number(inUse));
    expect(Number(inUse)).toBeGreaterThan(0);
    expect(lines.filter((l) => /^- pc\/\S+ FREE/.test(l)).length).toBeGreaterThan(0);
    expect(await cap.textContent()).toMatch(new RegExp(`^${inUse}/${limit} sandboxes · `));
    expect(await cap.getAttribute('title')).toMatch(new RegExp(`^Sandboxes: ${inUse} in use, ${lines.length - Number(inUse)} free`));
  }).toPass({ timeout: 30_000 });
  const out = process.env.W2067_OUT;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    await sidebar.screenshot({ path: path.join(out, 'sidebar-pc.png') });
    fs.writeFileSync(path.join(out, 'list_sandboxes.txt'), `${new Date().toISOString()}\n${text}\n`);
    fs.writeFileSync(path.join(out, 'fl-capacity.txt'), `${await cap.textContent()}\n${await cap.getAttribute('title')}\n`);
    await page.goto('/#/overview');
    await expect(page.getByTestId('board-pc').getByTestId('fl-capacity')).toHaveText(/^\d+\/\d+ sandboxes · /);
    await page.getByTestId('overview').screenshot({ path: path.join(out, 'overview.png') });
  }
});
