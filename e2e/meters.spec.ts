import type { Page } from '@playwright/test';
import type { AccountUsage, AppState, Machine, MachineStats, ServerEvent, SystemStats } from '../shared/types.ts';
import { appState, expect, openSidebar, settle, signIn, test } from './fixtures.ts';

// The sidebar footer: every computer's load and every Claude account's usage. The page's WebSocket is
// intercepted and its state replaced with fixed numbers (the test server's own are this runner's real
// CPU and RAM, and parallel tests add sessions), so the footer and its snapshots are stable.

const NOW = new Date('2026-09-24T12:00:00Z');
const GB = 2 ** 30;
const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

const SYSTEM: SystemStats = {
  hostname: 'BEAST',
  platform: 'win32 10.0.26100',
  cpuModel: 'AMD Ryzen 9 7950X',
  cpuCount: 32,
  loadPct: 38,
  memTotalBytes: 128 * GB,
  memFreeBytes: 57 * GB,
  diskTotalBytes: 4000 * GB,
  diskFreeBytes: 1100 * GB,
  gpu: { name: 'NVIDIA GeForce RTX 5090', memTotalMiB: 32607, memUsedMiB: 14540, utilPct: 41 },
  limits: { maxUnity: 4, maxSessions: 8 },
};

const machine = (id: string, online: boolean): Machine => ({
  id,
  host: id,
  purpose: 'unused',
  status: 'ready',
  online,
  repoPath: '/Users/dev/FinalFactory',
  home: '/Users/dev',
  portalUrl: 'https://portal.example.ts.net',
  maxSessions: 3,
  sessionIds: [],
  createdAt: at(-100),
});

const M5: MachineStats = {
  hostname: 'mac.local',
  platform: 'darwin 25.1.0',
  cpuModel: 'Apple M5 Max',
  cpuCount: 18,
  loadPct: 64,
  memTotalBytes: 64 * GB,
  memFreeBytes: 30 * GB,
  memUsedBytes: 34 * GB,
  memPressure: 'normal',
  diskTotalBytes: 2000 * GB,
  diskFreeBytes: 900 * GB,
  gpu: { name: 'Apple M5 Max', memTotalMiB: 64 * 1024, memUsedMiB: 9 * 1024, utilPct: 71, unified: true },
  at: NOW.toISOString(),
};

const ACCOUNTS = (agentIds: string[]): AccountUsage[] => [
  {
    id: 'token:e2e-9aaa',
    kind: 'token',
    label: 'host token …9AAA',
    sources: ['token:e2e-9aaa'],
    where: ["the agents' token on BEAST, m5"],
    sessionIds: agentIds,
    usage: {
      available: true,
      asOf: NOW.toISOString(),
      plan: 'max',
      weekly: { label: 'Weekly', percent: 98, resetsAt: at(60), severity: 'critical' },
      session: { label: 'Session (5 h)', percent: 12, resetsAt: at(3) },
      models: [{ label: 'Weekly Fable', percent: 22, resetsAt: at(60) }],
    },
  },
  {
    id: 'email:owner@example.com',
    kind: 'login',
    label: 'owner@example.com',
    email: 'owner@example.com',
    sources: ['host:login', 'login:m5'],
    where: ['BEAST login', 'm5 login'],
    sessionIds: [],
    usage: { available: true, asOf: NOW.toISOString(), plan: 'max', weekly: { label: 'Weekly', percent: 23, resetsAt: at(90) }, models: [] },
  },
];

type Shape = 'machines' | 'host-only' | 'old-server';

/** Serve the page a fixed world: the orchestrator only, no sandboxes, and the machines and accounts of `shape`. */
async function fixedWorld(page: Page, shape: Shape) {
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    let orchId = '';
    server.onMessage((raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      if (e.type === 'state') {
        const s: AppState = e.state;
        orchId = s.orchestratorId;
        const orch = s.sessions.filter((x) => x.id === orchId);
        const fixed: AppState = {
          ...s,
          sessions: [...orch, { ...orch[0], id: 'w-busy', kind: 'worker', title: 'Busy worker', status: 'running' }],
          sandboxes: [],
          standingAgents: [],
          delegations: [],
          providers: [],
          system: SYSTEM,
          host: { elevated: false },
          machines: shape === 'machines' ? [machine('m5', true), machine('m3', false)] : [],
          machineStats: shape === 'machines' ? { m5: M5 } : {},
          usage: ACCOUNTS([]).at(1)!.usage,
          accounts: shape === 'machines' ? ACCOUNTS([orchId, 'w-busy']) : ACCOUNTS([orchId, 'w-busy']).slice(0, 1),
        };
        if (shape === 'old-server') {
          delete fixed.accounts;
          delete fixed.machineStats;
        }
        ws.send(JSON.stringify({ type: 'state', state: fixed } satisfies ServerEvent));
        return;
      }
      // Whatever else the live server says about the footer's inputs is someone else's test.
      if (['system', 'host', 'usage', 'accounts', 'machine_stats', 'machine', 'machine_removed', 'sandbox', 'sandbox_removed', 'standing', 'delegation', 'provider'].includes(e.type)) return;
      if ((e.type === 'session' && e.session.id !== orchId) || e.type === 'session_removed') return;
      ws.send(raw);
    });
    ws.onMessage((m) => server.send(m));
  });
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => localStorage.removeItem('ffsb.meters'));
  await signIn(page);
  await page.goto('/');
  const sidebar = await openSidebar(page);
  const foot = sidebar.locator('.sys-foot');
  await expect(foot).toBeVisible();
  return foot;
}

test('meters: every machine gets a cell with three bars, in the footprint of the host alone', async ({ page }) => {
  const alone = await fixedWorld(page, 'host-only');
  await expect(alone.locator('.mcell')).toHaveCount(0);
  await expect(alone.locator('.sys-cells')).toContainText('CPU 38%');
  const hostOnly = (await alone.locator('.sys-toggle').boundingBox())!.height;

  const foot = await fixedWorld(page, 'machines');
  await expect(foot.locator('.mcell')).toHaveCount(3);
  await expect(foot.getByTestId('mcell-BEAST').locator('.mbar')).toHaveCount(3);
  await expect(foot.getByTestId('mcell-m5').locator('.mbar')).toHaveCount(3);
  // m3 is offline: its name and "off", no bars.
  await expect(foot.getByTestId('mcell-m3')).toContainText('off');
  await expect(foot.getByTestId('mcell-m3').locator('.mbar')).toHaveCount(0);
  // The numbers are one hover away (and read out to screen readers).
  await expect(foot.getByTestId('mcell-m5')).toHaveAttribute('title', /CPU 64%\nRAM 53% \(34\.0 GB of 64\.0 GB\), pressure normal\nGPU 71% busy/);
  await expect(foot.getByTestId('mcell-BEAST')).toHaveAttribute('aria-label', /VRAM 45%/);
  // The plan cell: the account nearest its weekly limit, which one, and how many more.
  await expect(foot.getByTestId('plan-glance')).toHaveText('Plan 98% …9AAA +1');
  await expect(foot.getByTestId('plan-glance')).toHaveAttribute('title', 'host token …9AAA: weekly 98%\nowner@example.com: weekly 23%');
  expect((await foot.locator('.sys-toggle').boundingBox())!.height, 'no taller than the host alone').toBeLessThanOrEqual(hostOnly + 1);
  await expect(foot).toHaveScreenshot('meters-collapsed.png');
});

test('meters: open, every computer is a row and every account its limits and agents', async ({ page }) => {
  const foot = await fixedWorld(page, 'machines');
  await foot.locator('.sys-toggle').click();
  await settle(page);
  const table = foot.getByRole('table', { name: 'Load of every computer' });
  await expect(table.getByTestId('mrow-BEAST')).toContainText(/BEAST\s*38%\s*55%\s*45%\s*1\.1 TB/);
  await expect(table.getByTestId('mrow-m5')).toContainText(/m5\s*64%\s*53%\s*71%\s*900 GB/);
  await expect(table.locator('.mt-off')).toHaveText(/m3\s*offline/);
  await expect(foot.locator('.limits')).toContainText('Unity editors 0/4');
  await expect(foot.locator('.limits')).toContainText('Agents here 1/8');

  const token = foot.getByTestId('account-…9AAA');
  await expect(token).toContainText('host token …9AAA');
  await expect(token).toContainText('2 agents');
  await expect(token).toContainText("the agents' token on BEAST, m5");
  const login = foot.getByTestId('account-owner');
  await expect(login).toContainText('owner@example.com');
  await expect(login).toContainText('BEAST login · m5 login');
  await expect(foot.locator('.plan-meters')).toHaveCount(2);
  await expect(foot.locator('.plan-meters').first()).toContainText('Weekly Fable');
  await expect(foot.locator('.sys-detail')).toHaveScreenshot('meters-open.png');
});

test('meters: Refresh usage polls every account now; each account says as of when', async ({ page }) => {
  const foot = await fixedWorld(page, 'machines');
  await foot.locator('.sys-toggle').click();
  await expect(foot.locator('.plan-asof').first()).toContainText(/as of \d\d:\d\d/);
  const button = foot.getByTestId('usage-refresh');
  await expect(button).toHaveText('Refresh usage');
  const asked = page.waitForResponse((r) => r.url().endsWith('/api/usage/refresh') && r.request().method() === 'POST');
  await button.click();
  const r = await asked;
  expect(r.ok()).toBeTruthy();
  // The live test server: no machine connected, and its one poll may already be running.
  expect(await r.json()).toMatchObject({ started: expect.any(Boolean), machines: 0 });
  await expect(button).toBeDisabled();
  await expect(button).toHaveText('Refreshing…');
});

test('meters: with more than one account, a session says which one it runs on', async ({ page }) => {
  await fixedWorld(page, 'machines');
  await page.goto('/#/session/w-busy');
  await page.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByTestId('session-account').first()).toHaveText('…9AAA');
  await expect(page.getByTestId('session-account').first()).toHaveAttribute('title', 'Claude account: host token …9AAA');
});

test('meters: a server from before per-account usage still shows the host and its one plan', async ({ page }) => {
  const foot = await fixedWorld(page, 'old-server');
  await expect(foot.locator('.sys-cells')).toContainText('VRAM 45%');
  await expect(foot.getByTestId('plan-glance')).toHaveText('Plan 23%');
  await foot.locator('.sys-toggle').click();
  await expect(foot.locator('.plan-meters')).toHaveCount(1);
  await expect(foot.locator('.acct-head')).toHaveCount(0);
});

test('meters: the server lists its accounts, with each agent on the one it runs on', async ({ page }) => {
  await signIn(page);
  const s = await appState(page.request);
  expect(s.machineStats).toEqual({});
  // The test server has no token and no stored login: its own login, not fetched or unavailable, is the one account.
  expect(s.accounts?.map((a) => [a.kind, a.sources])).toEqual([['login', ['host:login']]]);
  expect(s.accounts![0].sessionIds).toEqual(expect.arrayContaining([s.orchestratorId, 'gallery1']));
  expect(JSON.stringify(s.accounts)).not.toMatch(/sk-ant/);
});
