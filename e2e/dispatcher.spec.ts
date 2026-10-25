import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import type { AppState, ServerEvent, SessionInfo, WorkItem, WorkSource } from '../shared/types.ts';
import { appState, expect, go, settle, signIn, test } from './fixtures.ts';

/**
 * Nobody chats with the dispatcher (docs/orchestrators.md): its page keeps the log, the requests and the Intake tab, has
 * no input, and points to your own orchestrator; the API refuses a direct message to it, the owner's included.
 */

const REFUSED = /nobody chats with the dispatcher/;

async function mateContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext(test.info().project.use as BrowserContextOptions);
  await expect(async () => {
    const r = await ctx.request.post('/api/login', { data: { username: 'teammate', password: 'e2e-teammate-456' } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }).toPass({ intervals: [100, 200, 400, 800], timeout: 15_000 });
  return ctx;
}

test('the Dispatcher page has no input, only a pointer to your own orchestrator; its log and tabs stay', async ({ authed: page }) => {
  await go(page, '#/dispatcher/conversation');
  const panel = page.locator('.dispatcher-panel');
  await expect(panel.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('tab', { name: /Requests/ })).toBeVisible();
  await expect(panel.locator('.transcript')).toBeVisible();

  await expect(panel.locator('.composer')).toHaveCount(0);
  await expect(panel.locator('textarea')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /send/i })).toHaveCount(0);

  const note = panel.getByTestId('read-only-note');
  await expect(note).toContainText('Nobody writes to the dispatcher');
  const link = panel.getByTestId('talk-to-orchestrator');
  await expect(link).toHaveText('Talk to your orchestrator');
  await link.click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator('.composer')).toBeVisible();
});

test('a direct POST to the dispatcher is refused for the owner and for a member; their own orchestrators still take messages', async ({ authed: page, browser }) => {
  const me = await appState(page.request);
  const dispatcher = me.dispatcherId!;
  const owner = await page.request.post(`/api/sessions/${dispatcher}/message`, { data: { text: 'do it now' } });
  expect(owner.status()).toBe(403);
  expect(((await owner.json()) as { error: string }).error).toMatch(REFUSED);

  const mateCtx = await mateContext(browser);
  try {
    const mate = await mateCtx.request.post(`/api/sessions/${dispatcher}/message`, { data: { text: 'let me in' } });
    expect(mate.status()).toBe(403);
    expect(((await mate.json()) as { error: string }).error).toMatch(REFUSED);
  } finally {
    await mateCtx.close();
  }

  const mine = await page.request.post(`/api/sessions/${me.orchestratorId}/message`, { data: { text: 'hello, my own orchestrator' } });
  expect(mine.ok(), await mine.text()).toBeTruthy();
});

// Rows of the Requests tab (w1104, w1105), after real ones: a Working request names the machine its worker runs on right after
// its id, and an FFBox dev request reads "<operator> (FFBox)". The page's WebSocket state is replaced with these requests.
const NOW = new Date('1970-01-01T00:00:00Z');
const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };
const BEN = { userId: 'ben', displayName: 'Ben' };
const ffboxDev = (reporter: string, untrusted = false): WorkSource => ({ kind: 'ffbox-dev', untrusted, channel: 'FFBox web', conversation: '812', reporter });

function rowsState(s: AppState): AppState {
  const at = (ago: number) => new Date(Date.now() - ago * 60_000).toISOString();
  const orch = s.sessions.find((x) => x.id === s.orchestratorId)!;
  const worker = (id: string, where: Partial<SessionInfo>): SessionInfo => ({
    ...orch,
    wakeAt: undefined,
    wakeNote: undefined,
    queuedSend: undefined,
    backgroundTasks: undefined,
    backgroundJobs: undefined,
    heldSince: undefined,
    id,
    kind: 'worker',
    title: `worker ${id}`,
    status: 'running',
    lastActivityAt: at(1),
    sandboxId: undefined,
    machineId: undefined,
    machineSandbox: undefined,
    ...where,
  });
  const item = (id: string, title: string, o: Partial<WorkItem>): WorkItem => ({
    id,
    title,
    brief: 'Do it.',
    priority: 'normal',
    keys: [],
    requestedBy: LOTH,
    requesters: [LOTH],
    humanAsked: true,
    status: 'active',
    createdAt: at(120),
    updatedAt: at(2),
    sessionIds: [],
    overlaps: [],
    asks: 0,
    log: [],
    ...o,
  });
  const sessions = [
    orch,
    worker('s1', { machineId: 'lothdesktop', machineSandbox: 'slot1' }),
    worker('s2', { machineId: 'beast', machineSandbox: 'agent-a' }),
    worker('s3', { machineId: 'lothdesktop', machineSandbox: 'slot2' }),
    worker('s4', { machineId: 'm3', machineSandbox: 'sb1' }),
    worker('s5', { machineId: 'beast', machineSandbox: 'agent-b', status: 'idle' }),
  ];
  const work = [
    item('w1104', 'Dispatcher pane: show the machine a working request runs on', { sessionIds: ['s1'] }),
    item('w1105', 'Dispatcher pane: shorten the operator label', { sessionIds: ['s1', 's3'], source: ffboxDev('lothsahn') }),
    item('w1100', 'Web UI scroll on beast', { sessionIds: ['s2', 's1', 's4'], requestedBy: BEN, requesters: [BEN, LOTH] }),
    item('w1099', 'A request whose worker is idle', { sessionIds: ['s5'], requestedBy: BEN, requesters: [BEN], source: ffboxDev('ben', true) }),
    item('w1098', 'Queued for a slot', { status: 'queued', queuedFor: { at: at(10), needs: ['nowhere'] } }),
    item('w1097', 'Someday: tidy the dashboard', { status: 'queued', priority: 'low', queuedFor: { at: at(11) } }),
  ];
  return { ...s, sessions, work };
}

async function rowsPage(page: Page) {
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      if (e.type === 'state') return ws.send(JSON.stringify({ type: 'state', state: rowsState(e.state) } satisfies ServerEvent));
      if (e.type === 'session' || e.type === 'session_removed' || e.type === 'work') return;
      ws.send(raw);
    });
    ws.onMessage((m) => server.send(m));
  });
  await signIn(page);
  await page.goto('/#/dispatcher');
}

test('a Working request shows its machine after its status, its id in its own column, and an FFBox dev request reads "<operator> (FFBox)" (w1104, w1105)', async ({ page }) => {
  await rowsPage(page);
  const panel = page.locator('.dispatcher-panel');
  const sub = (id: string) => panel.getByTestId(`work-${id}`).locator('.work-sub');
  await expect(sub('w1104')).toContainText(/Working .* · lothdesktop · Lothsahn/);
  await expect(panel.getByTestId('work-id-w1104')).toHaveText('w1104');
  await expect(sub('w1105')).toContainText(' · lothdesktop · lothsahn (FFBox)');
  await expect(panel.getByTestId('work-machine-w1105')).toHaveText(/^ · lothdesktop$/);
  await expect(sub('w1100')).toContainText(/ · beast, lothdesktop, m3 · Ben, Lothsahn/);
  // Not Working: no machine, FFBox dev request still short.
  await expect(panel.getByTestId('work-machine-w1099')).toHaveCount(0);
  await expect(sub('w1099')).toContainText(' · ben (FFBox)');
  await expect(panel.getByTestId('work-machine-w1098')).toHaveCount(0);
  await expect(panel.getByText('FFBox dev request')).toHaveCount(0);

  // The detail says the operator once, with the short untrusted marking.
  await panel.getByTestId('work-w1099').getByRole('button', { name: /A request whose worker is idle/ }).click();
  const facts = panel.getByTestId('work-w1099').locator('.intake-facts');
  await expect(facts).toContainText('ben (FFBox) · untrusted');
  await expect(facts).not.toContainText('reported by');
  await expect(facts).not.toContainText('for Ben');

  await settle(page);
  const file = test.info().outputPath('dispatcher-rows.png');
  await panel.screenshot({ path: file });
  await test.info().attach('dispatcher-rows', { path: file, contentType: 'image/png' });
});

test('a low request says low beside its id, and its detail sets the priority (w2049)', async ({ page }) => {
  await rowsPage(page);
  const panel = page.locator('.dispatcher-panel');
  await expect(panel.getByTestId('work-low-w1097')).toHaveText(' · low');
  await expect(panel.getByTestId('work-low-w1098')).toHaveCount(0);
  await panel.getByTestId('work-w1097').getByRole('button', { name: /Someday: tidy the dashboard/ }).click();
  const select = panel.getByTestId('work-priority-w1097').getByRole('combobox', { name: 'Priority of w1097' });
  await expect(select).toHaveValue('low');
  await expect(select.locator('option')).toHaveText(['urgent', 'high', 'normal', 'low']);
  // The row here is the page's own (rowsState), not the server's: the server's answer proves the change reached its route.
  await select.selectOption('normal');
  await expect(page.getByText('no work request "w1097"; list_work shows them')).toBeVisible();

  await settle(page);
  const file = test.info().outputPath('dispatcher-priority.png');
  await panel.getByTestId('work-w1097').screenshot({ path: file });
  await test.info().attach('dispatcher-priority', { path: file, contentType: 'image/png' });
});
