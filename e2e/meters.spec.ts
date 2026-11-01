import type { Locator, Page } from '@playwright/test';
import type { AccountUsage, AppState, CleanupSummary, Machine, MachineStats, ServerEvent, SystemStats } from '../shared/types.ts';
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
async function fixedWorld(page: Page, shape: Shape, extra: AccountUsage[] = [], m5Cleanup?: CleanupSummary) {
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
          standingAgents: [],
          delegations: [],
          providers: [],
          system: SYSTEM,
          host: { elevated: false },
          machines: shape === 'machines' ? [{ ...machine('m5', true), lastCleanup: m5Cleanup }, machine('m3', false)] : [],
          machineStats: shape === 'machines' ? { m5: M5 } : {},
          usage: ACCOUNTS([]).at(1)!.usage,
          accounts: shape === 'machines' ? [...ACCOUNTS([orchId, 'w-busy']), ...extra] : ACCOUNTS([orchId, 'w-busy']).slice(0, 1),
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
  // The plan cell (w1389): in words, the plan agents run on now with its two windows, and how many are spent.
  await expect(foot.getByTestId('plan-glance')).toHaveText(footerLine('host token', '98%', '12%', 'none spent'), { useInnerText: true });
  await expect(foot.getByTestId('plan-glance')).toHaveAttribute('title', 'host token: in use, 5h 12%, weekly 98%\nowner: free, weekly 23%');
  // The computers fit one text line, as the host alone had with its editor and agent counts before w510 (52 px measured
  // at this size with two lines). The plan line in words (w1389) takes up to three more at the sidebar's 280 px: 68 px
  // measured on Windows, 84 px on CI's Linux fonts; a phone's wider sheet holds it in two.
  expect((await foot.locator('.sys-toggle').boundingBox())!.height, 'no taller than four lines').toBeLessThanOrEqual(Math.max(hostOnly, 52) + 40);
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
  // No editor or agent limits of the portal's own (w510): each machine's are on its row.
  await expect(foot.locator('.limits')).toHaveCount(0);

  // Plans first (w1389, Ben: "just list them in squence with name - weekly %, session% thats it"): one line each, red when spent, yellow from 80%, blue otherwise; the details are the hover.
  const plans = foot.getByTestId('plans-table');
  await expect(plans.locator('.plan-item')).toHaveCount(2);
  const token = foot.getByTestId('account-…9AAA');
  await expect(token).toHaveText(planLine('host token', '98%', '12%'), { useInnerText: true });
  await expect(token).toHaveClass(/pl-yellow/);
  await expect(token).toHaveAttribute('data-tip', /host token …9AAA\n5-hour session: 12%\. Resets Thu 15:00 UTC \(in 3 h\)\nWeekly: 98%\. Resets Sun 00:00 UTC \(in 2 d 12 h\)\nWeekly Fable: 22%\. Resets Sun 00:00 UTC \(in 2 d 12 h\)\nIn use now: \d agents?\nthe agents' token on BEAST, m5/);
  const login = foot.getByTestId('account-owner');
  await expect(login).toHaveText(planLine('owner', '23%'), { useInnerText: true });
  await expect(login).toHaveClass(/pl-blue/);
  await expect(login).toHaveAttribute('data-tip', /Not in use\nBEAST login\nm5 login/);
  // The plans come before the computers.
  expect((await plans.boundingBox())!.y).toBeLessThan((await foot.getByRole('table', { name: 'Load of every computer' }).boundingBox())!.y);
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
  // The live test server: its one machine (pc) connected, and its one poll may already be running.
  expect(await r.json()).toMatchObject({ started: expect.any(Boolean), machines: 1 });
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

test('meters: the server lists its accounts: the vault tokens, never a login or a host token (w1078)', async ({ page }) => {
  await signIn(page);
  const s = await appState(page.request);
  expect(Object.keys(s.machineStats ?? {})).toEqual(['pc']);
  // Every Claude process runs on a vault token (w1078): the test server's vault holds one fake token per login (e2e/server.ts),
  // and neither this host's login nor the machine's own is an account any more.
  expect(s.accounts?.length).toBe(7);
  for (const a of s.accounts!) {
    expect(a.kind).toBe('token');
    expect(a.label).toMatch(/^vault-[a-z0-9._-]+-1 …/);
  }
  expect(s.accounts!.flatMap((a) => a.sources).filter((k) => k.startsWith('login:') || k === 'host:login')).toEqual([]);
  expect(JSON.stringify(s.accounts)).not.toMatch(/sk-ant/);
});

/** A vault Claude token as the accounts list carries it (server/usage.ts buildAccounts, w777/w785): its vault name, no description. */
const VAULT = (name: string, last4: string, weekly: number, where: string[], agentIds: string[] = [], vaultEmail?: string): AccountUsage => ({
  id: `token:e2e-${name}`,
  ...(vaultEmail ? { vaultEmail } : {}),
  kind: 'token',
  label: `${name} …${last4}`,
  sources: [`token:e2e-${name}`],
  where,
  sessionIds: agentIds,
  usage: { available: true, asOf: NOW.toISOString(), plan: 'max', source: 'rate limits', weekly: { label: 'Weekly', percent: weekly, resetsAt: at(70) }, session: { label: 'Session (5 h)', percent: 9, resetsAt: at(2) }, models: [] },
});

/** A plan's line: "name - weekly 62%, session 38%"; in a narrow list (the desktop sidebar) the numbers are a second line and the dash is dropped. With no session, a plan with no 5-hour limit: weekly only (w2709). */
const planLine = (name: string, weekly: string, session?: string) => {
  const esc = (t: string) => t.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&');
  return new RegExp(`^${esc(name)}\\s+(-\\s+)?weekly ${esc(weekly)}${session === undefined ? '' : `, session ${esc(session)}`}$`);
};

/** The footer's plan line: "Plan in use: name  weekly 98%, session 12%  1 of 3 plans spent", its pieces on one line or several. */
const footerLine = (name: string, weekly: string, session: string, spent: string) =>
  new RegExp(`^Plan in use:\\s+${name}\\s+weekly ${weekly}, session ${session}\\s+${spent}$`);

const plans = (foot: Locator) => foot.getByTestId('plans-table');

test('meters (w785): a vault token is one row under its vault name, the Claude account email on its subtext; none recorded shows no subtext', async ({ page }) => {
  const foot = await fixedWorld(page, 'machines', [
    VAULT('vault-ben-2', 'dAAA', 71, ['ben@example.com', "fff-portal's token file (the orchestrator)"], ['w-busy'], 'ben@example.com'),
    VAULT('vault-lothsahn-1', 'EAAA', 95, ['lothsahn@example.com'], [], 'a.very.long.address.for.loth@finalfactory-example.test'),
    VAULT('vault-ben-1', 'cBBB', 12, []),
  ]);
  await foot.locator('.sys-toggle').click();
  await settle(page);
  const both = foot.getByTestId('account-…dAAA');
  // Named by the email a person recorded (w1389), not by the vault name; the vault name is on its hover; with none recorded the vault name stands (ben-1 below).
  await expect(both).toHaveText(planLine('ben@example.com', '71%', '9%'), { useInnerText: true });
  await expect(both).not.toContainText('ben-2');
  await expect(both).toHaveAttribute('data-tip', /^ben@example\.com\nvault-ben-2 …dAAA\n[\s\S]*fff-portal's token file \(the orchestrator\)/);
  await expect(both).not.toContainText('vault:');
  // A long address is cut with an ellipsis, never wrapped or clipped by the row, and whole on its hover.
  // Every plan's first element is its name, so no line starts with the dash.
  for (const item of await plans(foot).locator('.plan-item').all()) {
    // One text line where the list is wide (a phone's sheet), the name over the numbers where it is narrow (the desktop sidebar).
    const wide = (await plans(foot).evaluate((e) => e.clientWidth - 2 * parseFloat(getComputedStyle(e).paddingLeft))) > 261;
    expect((await item.boundingBox())!.height, wide ? 'a plan is one line' : 'a plan is two lines at most').toBeLessThan(wide ? 26 : 50);
    expect(await item.evaluate((e) => e.firstElementChild?.className)).toBe('plan-item-name');
  }
  const loth = foot.getByTestId('account-…EAAA');
  await expect(loth).toContainText('a.very.long.address.for.loth@finalfactory-example.test');
  // The cut-off name has no title of its own (w1528): its hover is the row's card, which opens with the whole address.
  await expect(loth.locator('.plan-item-name')).not.toHaveAttribute('title', /.+/);
  await loth.locator('.plan-item-name').hover();
  await expect(page.getByTestId('plan-tip').locator('.acct-label')).toHaveText('a.very.long.address.for.loth@finalfactory-example.test');
  await expect(loth).toHaveAttribute('data-tip', /^a\.very\.long\.address\.for\.loth@finalfactory-example\.test\nvault-lothsahn-1 …EAAA/);
  await expect(loth.locator('.plan-item-name')).toHaveCSS('text-overflow', 'ellipsis');
  // The vault's own name without "vault-"; one row each, never the token file's name for a vault token, and the usage line says "rate limits" on hover.
  await expect(foot.getByTestId('account-…cBBB')).toHaveText(planLine('ben-1', '12%', '9%'), { useInnerText: true });
  await expect(plans(foot).locator('.plan-item')).toHaveCount(5);
  await expect(foot.locator('.plan-asof').first()).toHaveAttribute('title', /from rate limits/);
  if (process.env.E2E_SHOT) {
    await page.setViewportSize({ width: 1440, height: 2200 });
    await settle(page);
    await foot.locator('.sys-detail').screenshot({ path: process.env.E2E_SHOT });
  }
});

test('meters (w1389): the footer says which plan is in use and how many are spent; the sheet shows each plan at a glance', async ({ page }) => {
  const spent: AccountUsage = {
    ...VAULT('vault-ben-1', 'cBBB', 100, ['ben@example.com']),
    usage: { available: true, asOf: NOW.toISOString(), plan: 'max', weekly: { label: 'Weekly', percent: 100, resetsAt: at(70) }, session: { label: 'Session (5 h)', percent: 40, resetsAt: at(2) }, models: [{ label: 'Weekly Fable', percent: 61, resetsAt: at(70) }] },
  };
  const foot = await fixedWorld(page, 'machines', [spent]);
  // Three plans, one in use (the host token has agents on it), one spent (weekly full).
  await expect(foot.getByTestId('plan-glance')).toHaveText(footerLine('host token', '98%', '12%', '1 of 3 plans spent'), { useInnerText: true });
  await expect(foot.getByTestId('plan-glance')).toHaveAttribute('title', /ben-1: spent until .*, 5h 40%, weekly 100%/);
  // One text line for the plans, not a cell per account: the footer stays at its two lines.
  await expect(foot.locator('.plan-chip, .plan-chips')).toHaveCount(0);
  await foot.locator('.sys-toggle').click();
  await settle(page);
  const rows = foot.getByTestId('plans-table').locator('.plan-item');
  await expect(rows).toHaveCount(3);
  // name - weekly %, session %, nothing else on the line; the colour says how worn it is: red used up, yellow from 80%, blue otherwise.
  const row = foot.getByTestId('account-…cBBB');
  await expect(row).toHaveText(planLine('ben-1', '100%', '40%'), { useInnerText: true });
  await expect(row).toHaveClass(/pl-red/);
  await expect(foot.getByTestId('account-…9AAA')).toHaveClass(/pl-yellow/);
  await expect(foot.getByTestId('account-owner')).toHaveClass(/pl-blue/);
  const red = await row.evaluate((e) => getComputedStyle(e).color);
  const yellow = await foot.getByTestId('account-…9AAA').evaluate((e) => getComputedStyle(e).color);
  const blue = await foot.getByTestId('account-owner').evaluate((e) => getComputedStyle(e).color);
  expect(new Set([red, yellow, blue]).size, 'three different colours').toBe(3);
  // The hover has the windows with their resets, the per-model window and the state.
  await expect(row).toHaveAttribute('data-tip', /Weekly Fable: 61%\. Resets Sun 10:00 UTC \(in 2 d 22 h\)\nSpent until Sun 10:00 UTC \(in 2 d 22 h\)/);
  // w1528: each limit has its own reset, day and time with the zone, and the time left.
  await expect(row).toHaveAttribute('data-tip', /5-hour session: 40%\. Resets Thu 14:00 UTC \(in 2 h\)\nWeekly: 100%\. Resets Sun 10:00 UTC \(in 2 d 22 h\)/);
  // Nothing needs a scroll to read the plans: the whole list is inside the sheet's visible area.
  const detail = (await foot.locator('.sys-detail').boundingBox())!;
  const list = (await foot.getByTestId('plans-table').boundingBox())!;
  expect(list.y + list.height, 'the plans end inside the sheet').toBeLessThanOrEqual(detail.y + detail.height + 1);
});

test('meters (w1389): the panel lists no clean-up lines; a disk still under its soft threshold is flagged on its own bar', async ({ page }) => {
  const pass: CleanupSummary = { at: NOW.toISOString(), trigger: 'low-space', removed: 3, freedBytes: 4 * GB, softFreeGB: 80, freeBytes: 70 * GB, belowSoft: true, listed: [{ path: '/Users/dev/x', bytes: GB, why: 'unattributed' }] };
  const foot = await fixedWorld(page, 'machines', [], pass);
  await foot.locator('.sys-toggle').click();
  await settle(page);
  await expect(foot.getByTestId('cleanup-lines')).toHaveCount(0);
  await expect(foot.locator('.sys-detail')).not.toContainText('Clean-up');
  // m5's disk (900 GB free of 2 TB: 55% used) would be an ordinary blue bar; below its soft threshold it is amber, and its hover says why.
  const disk = foot.getByTestId('mrow-m5').locator('.mt-cell').nth(3);
  await expect(disk).toHaveClass(/meter-warn/);
  await expect(disk).toHaveAttribute('title', /below the clean-up's soft threshold of 80 GB/);
  // The data is still there: the row's hover has the last pass.
  await expect(foot.getByTestId('mrow-m5')).toHaveAttribute('title', /Last clean-up .*: 4\.0 GB freed \(3 item\(s\)\)/);
  // Another machine's disk, not below its threshold, stays as it was.
  await expect(foot.getByTestId('mrow-BEAST').locator('.mt-cell').nth(3)).not.toHaveClass(/meter-warn|meter-crit/);
});

test.describe('plan reset hover (w1528)', () => {
  test.use({ timezoneId: 'America/Denver', deviceScaleFactor: 2 });
  const spent = (): AccountUsage => ({
    ...VAULT('vault-ben-1', 'cBBB', 100, ['ben@example.com']),
    usage: { available: true, asOf: NOW.toISOString(), plan: 'max', weekly: { label: 'Weekly', percent: 100, resetsAt: at(70) }, session: { label: 'Session (5 h)', percent: 40, resetsAt: at(2) }, models: [{ label: 'Weekly Fable', percent: 61 }] },
  });
  const inside = async (page: Page, tip: Locator, foot: Locator) => {
    const t = (await tip.boundingBox())!;
    const sheet = (await foot.boundingBox())!;
    const win = page.viewportSize()!;
    expect(t.x, 'card inside the sheet, left').toBeGreaterThanOrEqual(sheet.x - 0.5);
    expect(t.x + t.width, 'card inside the sheet, right').toBeLessThanOrEqual(sheet.x + sheet.width + 0.5);
    expect(t.y, 'card inside the sheet and window, top').toBeGreaterThanOrEqual(Math.max(sheet.y, 0) - 0.5);
    expect(t.y + t.height, 'card inside the sheet and window, bottom').toBeLessThanOrEqual(Math.min(sheet.y + sheet.height, win.height) + 0.5);
  };

  test('hovering a plan name or its usage line opens the account card: a bar per limit with its reset day, time and zone', async ({ page }) => {
    const foot = await fixedWorld(page, 'machines', [spent()]);
    await foot.locator('.sys-toggle').click();
    await settle(page);
    const tip = page.getByTestId('plan-tip');
    await expect(tip).toHaveCount(0);
    if (process.env.E2E_SHOT_BEFORE) {
      // The click left the pointer on the footer's toggle, which shades it; the stills compare the sheet with the pointer elsewhere.
      await page.mouse.move(900, 300);
      const sheet = (await foot.boundingBox())!;
      await page.screenshot({ path: process.env.E2E_SHOT_BEFORE, clip: sheet });
    }
    const row = foot.getByTestId('account-…cBBB');
    // Hovering the name (lothsahn: "hovering the email of the plan should also give the popup with the usage summary") and
    // hovering the usage line open the same card. The viewer's zone (Denver, MDT in September), not UTC: 14:00 UTC is 08:00 MDT.
    for (const [part, shot] of [['.plan-item-name', process.env.E2E_SHOT_TIP], ['.plan-item-tail', process.env.E2E_SHOT_TIP2]] as const) {
      await row.locator(part).hover();
      await expect(tip).toBeVisible();
      await expect(tip.locator('.acct-label')).toHaveText('vault-ben-1 …cBBB');
      await expect(tip.locator('.acct-agents')).toHaveText('Spent until Sun 04:00 MDT');
      await expect(tip.locator('.acct-where')).toHaveText('ben@example.com');
      // One bar per limit, the weekly first as the main tab drew them; each says when it resets, or that it is unknown.
      const meters = tip.locator('.meter');
      await expect(meters).toHaveCount(3);
      const want = [
        ['Weekly', '100%', 'Resets Sun 04:00 MDT (in 2 d 22 h)', '100%'],
        ['Session (5 h)', '40%', 'Resets Thu 08:00 MDT (in 2 h)', '40%'],
        ['Weekly Fable', '61%', 'Reset time unknown', '61%'],
      ];
      for (const [i, [label, value, note, width]] of want.entries()) {
        const m = meters.nth(i);
        await expect(m.locator('.meter-label')).toHaveText(label);
        await expect(m.locator('.meter-value')).toHaveText(value);
        await expect(m.locator('.meter-note')).toHaveText(note);
        // One line at the desktop sidebar's width too: a countdown is never cut across two lines (the orchestrator, for lothsahn: a lone "h)" on its own line).
        expect(await m.locator('.meter-note').evaluate((e) => e.getClientRects()[0].height <= parseFloat(getComputedStyle(e).fontSize) * 1.6), `${label} reset note on one line`).toBe(true);
        expect(await m.locator('.meter-bar i').evaluate((e) => (e as HTMLElement).style.width)).toBe(width);
      }
      await inside(page, tip, foot);
      if (shot) {
        // The whole sheet, the frame the before has; the part under the pointer is underlined (a screenshot has no pointer).
        await row.locator(part).evaluate((e) => ((e as HTMLElement).style.textDecoration = 'underline dashed #dbe3ec'));
        await page.screenshot({ path: shot, clip: (await foot.boundingBox())! });
        await row.locator(part).evaluate((e) => ((e as HTMLElement).style.textDecoration = ''));
      }
      await page.mouse.move(900, 300);
      await expect(tip).toHaveCount(0);
    }
  });

  test('the card stays inside the open sheet and the window: on the last plan row and on a short window', async ({ page }) => {
    const foot = await fixedWorld(page, 'machines', [spent()]);
    await foot.locator('.sys-toggle').click();
    await settle(page);
    const tip = page.getByTestId('plan-tip');
    const rows = foot.getByTestId('plans-table').locator('.plan-item');
    const last = rows.nth((await rows.count()) - 1);
    for (const height of [900, 520, 420]) {
      await page.setViewportSize({ width: 1440, height });
      await settle(page);
      for (const r of [rows.first(), last]) {
        await r.scrollIntoViewIfNeeded();
        await r.hover();
        await expect(tip).toBeVisible();
        await inside(page, tip, foot);
        await page.mouse.move(900, 300);
        await expect(tip).toHaveCount(0);
      }
    }
  });
});
