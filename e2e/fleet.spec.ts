import type { Page } from '@playwright/test';
import type { AppState, LiveViewInfo, Machine, MachineSandbox, MachineStats, ServerEvent, SessionInfo, SystemStats, WorkItem } from '../shared/types.ts';
import { expect, isMobile, openSidebar, settle, signIn, test } from './fixtures.ts';

// The sidebar's computers and the Overview board (web/src/components/Fleet.tsx, shared/fleet.ts): BEAST, then
// each machine with its sandboxes and their live agents (w536: none in a main clone). The page's WebSocket is intercepted and
// its state replaced with a fixed fleet, as in e2e/meters.spec.ts. The seeded worker "gallery1" stands in for an
// agent in a machine sandbox, so its page has a real transcript.

const NOW = new Date('2026-09-29T12:00:00Z');
const GB = 2 ** 30;
const min = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const git = (branch: string) => ({ branch, dirty: 0, untracked: 0, ahead: 1, behind: 0, upstream: `origin/${branch}`, at: NOW.toISOString(), head: { sha: 'abc1234', subject: 'Nightly: Windows runner', date: min(30) } });

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

const stats = (loadPct: number, usedGB: number, totalGB: number, gpu: MachineStats['gpu']): MachineStats => ({
  hostname: 'x',
  platform: 'x',
  cpuModel: 'x',
  cpuCount: 16,
  loadPct,
  memTotalBytes: totalGB * GB,
  memFreeBytes: (totalGB - usedGB) * GB,
  memUsedBytes: usedGB * GB,
  diskTotalBytes: 2000 * GB,
  diskFreeBytes: 640 * GB,
  gpu,
  at: NOW.toISOString(),
});

const worker = (base: SessionInfo, id: string, title: string, status: SessionInfo['status'], ago: number, where: Partial<SessionInfo>): SessionInfo => ({
  ...base,
  // None of the live orchestrator's own pending facts: a wake_me another test set on it (e2e/compact.spec.ts) makes a
  // stopped copy one that resumes at its check-in, which holds its place and counts as live (shared/agentState.ts).
  wakeAt: undefined,
  wakeNote: undefined,
  queuedSend: undefined,
  backgroundTasks: undefined,
  backgroundJobs: undefined,
  heldSince: undefined,
  id,
  kind: 'worker',
  title,
  status,
  lastActivityAt: min(ago),
  pendingPermissions: [],
  sandboxId: undefined,
  ...where,
});

const machineSb = (id: string, purpose: string, sessionIds: string[], unity: MachineSandbox['unity']['state'], branch: string): MachineSandbox => ({
  id,
  branch,
  base: 'origin/develop',
  path: `D:/work/ffsb/${id}`,
  purpose,
  status: 'ready',
  createdAt: min(300),
  unity: { state: unity, logPath: `D:/work/ffsb/${id}/Logs/sandbox-editor.log` },
  sessionIds,
  git: git(branch),
});

const machine = (id: string, extra: Partial<Machine>): Machine => ({
  id,
  host: id,
  purpose: 'unused',
  status: 'ready',
  online: true,
  repoPath: 'D:/work/mainrepo',
  home: 'C:/Users/dev',
  portalUrl: 'https://portal.example.ts.net',
  sessionIds: [],
  createdAt: min(9000),
  ...extra,
});

/** A request in the ledger (w1430: a chat on an open one is listed; one on a closed one folds behind "+N older"). */
const request = (id: string, status: WorkItem['status'], sessionIds: string[], extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: id,
  brief: '',
  priority: 'normal',
  keys: [],
  requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' },
  requesters: [{ userId: 'lothsahn', displayName: 'Lothsahn' }],
  humanAsked: true,
  status,
  createdAt: min(600),
  updatedAt: min(10),
  sessionIds,
  overlaps: [],
  asks: 0,
  log: [],
  ...extra,
});

/**
 * The fleet as the machines report it, before BEAST's sandboxes are put on its own daemon (onBeastsDaemon): BEAST's two
 * workers name their sandbox only. LothDesktop with a sandbox pool, the M5 without one (so no workers, w536), an offline M3.
 */
function fleetBase(s: AppState): AppState {
  const orch = s.sessions.find((x) => x.id === s.orchestratorId)!;
  const gallery = s.sessions.find((x) => x.id === 'gallery1')!;
  const sessions = [
    orch,
    worker(orch, 'b-play', 'Honest co-op: BEAST client', 'running', 1, { sandboxId: 'agent-a' }),
    worker(orch, 'b-old', 'Old build check', 'stopped', 400, { sandboxId: 'agent-a' }),
    { ...gallery, title: 'Nightly e2e: Windows leg', status: 'running' as const, lastActivityAt: min(2), sandboxId: undefined, machineId: 'lothdesktop', machineSandbox: 'sb1' },
    worker(orch, 'l-review', 'Review the nightly report', 'idle', 25, { machineId: 'lothdesktop', machineSandbox: 'sb1', requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' } }),
  ];
  return {
    ...s,
    sessions,
    // The idle reviewer is on an open request, so it is listed (w1430).
    work: [...(s.work ?? []), request('w900', 'active', ['l-review'])],
    standingAgents: [],
    delegations: [],
    providers: [],
    system: SYSTEM,
    host: { elevated: false },
    machines: [
      machine('lothdesktop', {
        name: 'LothDesktop',
        platform: 'win32',
        purpose: 'Spec 075 nightly e2e',
        sandboxRoot: 'D:/work/ffsb',
        maxSandboxes: 3,
        maxUnity: 2,
        sessionIds: ['l-review', 'gallery1'],
        git: git('075-nightly-windows'),
        sandboxes: [machineSb('sb2', 'unused', [], 'stopped', 'sandbox/sb2'), machineSb('sb1', 'Nightly e2e run', ['l-review', 'gallery1'], 'running', 'feature/fleet-view')],
      }),
      machine('m5', { platform: 'darwin', purpose: 'Honest co-op host', git: git('develop') }),
      machine('m3', { platform: 'darwin', online: false, lastSeen: min(180) }),
    ],
    machineStats: {
      lothdesktop: stats(22, 41, 64, { name: 'NVIDIA GeForce RTX 4080', memTotalMiB: 16376, memUsedMiB: 6100, utilPct: 18 }),
      m5: stats(64, 34, 64, { name: 'Apple M5 Max', memTotalMiB: 65536, memUsedMiB: 9216, utilPct: 71, unified: true }),
    },
  };
}

/**
 * The fixed fleet: BEAST's own daemon, machine "beast", holds BEAST's two sandboxes (docs/beast-machine.md; the portal
 * holds none of its own, w510). `online` false: that daemon is down.
 */
function onBeastsDaemon(online = true) {
  return (s: AppState): AppState => {
    const f = fleetBase(s);
    const onBeast = (x: SessionInfo) => (x.sandboxId ? { ...x, sandboxId: undefined, machineId: 'beast', machineSandbox: x.sandboxId } : x);
    const beast = machine('beast', {
      name: 'BEAST',
      local: true,
      host: 'localhost',
      platform: 'win32',
      online,
      repoPath: 'C:/ffsb/_base',
      sandboxRoot: 'F:/ffsb',
      maxSandboxes: 5,
      maxUnity: 4,
      maxSandboxAgents: 6,
      sessionIds: ['b-play', 'b-old'],
      sandboxes: [
        { ...machineSb('agent-a', 'Honest co-op playthrough', ['b-play', 'b-old'], 'running', 'feature/honest-coop'), path: 'F:/ffsb/agent-a' },
        { ...machineSb('agent-b', 'unused', [], 'stopped', 'sandbox/agent-b'), path: 'F:/ffsb/agent-b' },
      ],
    });
    return { ...f, sessions: f.sessions.map(onBeast), machines: [beast, ...f.machines] };
  };
}
const fleet = onBeastsDaemon();

async function fixedFleet(page: Page, hash = '#/', shape: (s: AppState) => AppState = fleet) {
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    let orchId = '';
    server.onMessage((raw) => {
      const e = JSON.parse(String(raw)) as ServerEvent;
      if (e.type === 'state') {
        orchId = e.state.orchestratorId;
        ws.send(JSON.stringify({ type: 'state', state: shape(e.state) } satisfies ServerEvent));
        return;
      }
      // What the live server says about sandboxes, machines and other tests' agents is not this fleet.
      if (['system', 'host', 'usage', 'accounts', 'machine_stats', 'machine', 'machine_removed', 'sandbox', 'sandbox_removed', 'standing', 'delegation', 'provider', 'live'].includes(e.type)) return;
      if ((e.type === 'session' && e.session.id !== orchId) || e.type === 'session_removed') return;
      ws.send(raw);
    });
    ws.onMessage((m) => server.send(m));
  });
  // The log is read on the machine through its daemon; this fleet has none, so the page gets these lines.
  await page.context().route(/\/api\/machines\/lothdesktop\/sandboxes\/sb1\/unity-log/, (r) =>
    r.fulfill({ json: { lines: ['[Licensing::Module] Channel doesn\'t exist', 'Refreshing native plugins compatible for Editor', 'error CS0103: The name \'Foo\' does not exist'] } }),
  );
  await page.clock.setFixedTime(NOW);
  // Every group open at the start of a test; a reload inside it keeps what the test folded.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('fleet-test')) return;
    sessionStorage.setItem('fleet-test', '1');
    localStorage.removeItem('ffsb.fleet.collapsed');
  });
  await signIn(page);
  await page.goto(`/${hash}`);
  await expect(page.locator('.sidebar')).toBeAttached();
}

/** A proof image for the PR, kept with the run's results (test-results/…), and attached to the report. */
async function proof(page: Page, name: string) {
  await settle(page);
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}

test('fleet: the sidebar groups every computer, with its sandboxes and their agents (w536: no main clone)', async ({ page }) => {
  await fixedFleet(page);
  const sidebar = await openSidebar(page);
  const groups = sidebar.locator('.fl-group');
  await expect(groups).toHaveCount(4);
  expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['fl-group-host', 'fl-group-lothdesktop', 'fl-group-m5', 'fl-group-m3']);

  const beast = sidebar.getByTestId('fl-group-host');
  await expect(beast.locator('.fl-name')).toHaveText('BEAST');
  await expect(beast.getByTestId('fl-capacity')).toHaveText('2/5 sandboxes · 1/4 editors');
  await expect(beast.getByTestId('fl-agents-sum')).toHaveText('1 agent, 1 busy');
  await expect(beast.getByTestId('meter-CPU')).toHaveText('CPU 38%');
  await expect(beast.getByTestId('meter-GPU')).toHaveText('GPU 45%');
  await expect(beast.getByTestId('meter-Disk')).toHaveText('Disk 1.1T');
  // The four meters sit on one line in the sidebar's width, none of them cut.
  const cells = await beast.locator('.fl-meter').evaluateAll((els) => els.map((e) => ({ top: Math.round(e.getBoundingClientRect().top), cut: e.scrollWidth > e.clientWidth + 1, text: e.textContent })));
  expect(new Set(cells.map((c) => c.top)).size, 'meters on one line').toBe(1);
  expect(cells.filter((c) => c.cut).map((c) => c.text), 'meters cut short').toEqual([]);
  // Nor is the counts line.
  expect(await beast.getByTestId('fl-capacity').evaluate((e) => e.scrollWidth <= e.clientWidth + 1), 'counts line cut short').toBe(true);
  // A live agent: its title, busy or idle, and how long since it last did something; a stopped one is a count.
  const play = beast.getByTestId('fl-sandbox-beast/agent-a');
  await expect(play.getByTestId('fl-agent')).toHaveCount(1);
  await expect(play.getByTestId('fl-agent')).toContainText(/Honest co-op: BEAST client\s*busy\s*1m/);
  await expect(play.getByTestId('fl-older')).toHaveText('+1 older');
  await expect(beast.getByTestId('fl-sandbox-beast/agent-b').locator('.fl-free')).toHaveText('FREE');

  const loth = sidebar.getByTestId('fl-group-lothdesktop');
  await expect(loth.locator('.fl-title')).toContainText('LothDesktop');
  await expect(loth.locator('.fl-title')).toContainText('Windows');
  await expect(loth.getByTestId('fl-capacity')).toHaveText('2/3 sandboxes · 1/2 editors');
  await expect(loth.getByTestId('fl-agents-sum')).toHaveText('2 agents, 1 busy');
  const sb1 = loth.getByTestId('fl-sandbox-lothdesktop/sb1');
  // Its label is its name (w575); what it is doing is its live agents' titles, the Working one first.
  await expect(sb1.locator('.row-title')).toHaveText('sb1');
  await expect(sb1.locator('.row-sub')).toContainText('Working · Nightly e2e: Windows leg (+1) · feature/fleet-view');
  await expect(sb1.locator('.fl-unity')).toHaveAttribute('title', 'Unity running');
  // Working first, then Idle (w475).
  await expect(sb1.getByTestId('fl-agent')).toHaveText([/Nightly e2e: Windows leg\s*busy\s*2m/, /Review the nightly report\s*idle\s*25m/]);
  await expect(loth.getByTestId('fl-sandbox-lothdesktop/sb2').locator('.fl-free')).toBeVisible();
  // No main-clone row (w536): a machine's places are its sandboxes.
  await expect(sidebar.locator('[data-testid^="fl-main-"]')).toHaveCount(0);

  // The M5 has no sandbox pool, so no workers; the M3 is offline.
  await expect(sidebar.getByTestId('fl-group-m5').getByTestId('fl-capacity')).toHaveText('no sandboxes');
  await expect(sidebar.getByTestId('fl-group-m5').getByTestId('fl-agents-sum')).toHaveCount(0);
  await expect(sidebar.getByTestId('fl-group-m3').locator('.fl-meters')).toHaveText('offline · seen 3h ago');
  if (!isMobile(page)) await proof(page, 'sidebar');
});

test('fleet: a group folds away, and stays folded after a reload', async ({ page }) => {
  await fixedFleet(page);
  let sidebar = await openSidebar(page);
  const head = sidebar.getByTestId('fl-group-lothdesktop').locator('.fl-head');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByTestId('fl-group-lothdesktop').locator('.fl-places')).toHaveCount(0);
  // Folded, the header still says what is there: the counts and what waits on the user.
  await expect(head.getByTestId('fl-capacity')).toContainText('2/3 sandboxes');

  expect(await page.evaluate(() => localStorage.getItem('ffsb.fleet.collapsed'))).toBe('["lothdesktop"]');

  await page.reload();
  sidebar = await openSidebar(page);
  await expect(sidebar.getByTestId('fl-group-lothdesktop').locator('.fl-head')).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByTestId('fl-group-host').locator('.fl-head')).toHaveAttribute('aria-expanded', 'true');
  // And opens again.
  await sidebar.getByTestId('fl-group-lothdesktop').locator('.fl-head').click();
  await expect(sidebar.getByTestId('fl-sandbox-lothdesktop/sb1')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ffsb.fleet.collapsed'))).toBeNull();
});

test('fleet: the Overview board shows every computer as a card with its live agents', async ({ page }) => {
  await fixedFleet(page, '#/overview');
  const board = page.getByTestId('overview');
  await expect(board.locator('.page-title')).toHaveText('Overview');
  await expect(board.locator('.overview-sum')).toHaveText('3 agents live · 2 busy');
  await expect(board.locator('.board-card')).toHaveCount(4);
  const loth = board.getByTestId('board-lothdesktop');
  await expect(loth.getByTestId('fl-capacity')).toHaveText('2/3 sandboxes · 1/2 editors');
  await expect(loth.getByTestId('fl-agents-sum')).toHaveText('2 agents, 1 busy');
  // Free sandboxes are one line of chips on the board; the requester shows on each agent.
  await expect(loth.getByTestId('fl-free-line')).toHaveText(/FREE\s*sb2/);
  await expect(loth.getByTestId('fl-agent').filter({ hasText: 'Review the nightly report' })).toContainText('Lothsahn');
  await expect(board.getByTestId('board-host').getByTestId('fl-free-line')).toHaveText(/FREE\s*agent-b/);
  await proof(page, 'overview');

  // An agent opens its sandbox's page, on that agent.
  await loth.getByTestId('fl-agent').filter({ hasText: 'Nightly e2e: Windows leg' }).click();
  await expect(page).toHaveURL(/#\/machine\/lothdesktop\/sandbox\/sb1\/gallery1$/);
  await expect(page.getByTestId('machine-sandbox-panel')).toBeVisible();
});

test('fleet: a machine sandbox has its own page: agents as tabs, Unity with its log, and git', async ({ page, browserName }) => {
  await fixedFleet(page, '#/machine/lothdesktop/sandbox/sb1');
  const panel = page.getByTestId('machine-sandbox-panel');
  await expect(panel.locator('.ph-name')).toHaveText('Nightly e2e run');
  // The newest agent is selected, and its transcript loads.
  await expect(panel.locator('.msg-assistant').first()).toBeVisible();
  if (!isMobile(page)) {
    await expect(panel.locator('.ph-facts')).toContainText('lothdesktop/sb1');
    await expect(panel.locator('.ph-facts')).toContainText('feature/fleet-view');
    // Working first, then Idle (w475).
    await expect(panel.getByRole('tab')).toHaveText([/Nightly e2e: Windows leg/, /Review the nightly report\s*Lothsahn/]);
  }
  await panel.getByRole('button', { name: 'Details' }).click();
  const details = page.locator('.details-sheet');
  await expect(details).toContainText('lothdesktop/sb1');
  await expect(details.locator('.unity-bar')).toContainText('Unity running');
  await expect(details.getByRole('button', { name: 'Stop Unity' })).toBeEnabled();
  await expect(details).toContainText('Nightly: Windows runner');
  if (!isMobile(page)) await proof(page, 'machine-sandbox');
  await details.getByRole('button', { name: 'Log', exact: true }).click();
  const log = page.locator('.drawer');
  await expect(log).toContainText('Nightly e2e run (lothdesktop/sb1)');
  // WebKit did not hand this fetch to the route mock in local runs (the real server answered "no machine"), so the
  // lines themselves are checked in Chromium.
  if (browserName === 'chromium') await expect(log.locator('.log-err')).toHaveText("error CS0103: The name 'Foo' does not exist");
});

test('fleet: the machine sandbox routes answer, and name what is missing', async ({ page }) => {
  await signIn(page);
  const r = await page.request.get('/api/machines/nosuch/sandboxes/sb1/unity-log');
  expect(r.ok()).toBeFalsy();
  expect(await r.text()).toMatch(/nosuch/);
  const u = await page.request.post('/api/machines/nosuch/sandboxes/sb1/unity', { data: { action: 'reboot' } });
  expect(u.status()).toBe(400);
});

test("fleet: BEAST's own daemon holds its sandboxes: they stay under BEAST, and open as its machine sandboxes", async ({ page }) => {
  await fixedFleet(page, '#/', onBeastsDaemon());
  const sidebar = await openSidebar(page);
  const groups = sidebar.locator('.fl-group');
  // No group of its own for the daemon: the same four computers as before the migration. Counted first, as above: the
  // machines' groups render a moment after the sidebar, and a read before that failed about half the time.
  await expect(groups).toHaveCount(4);
  expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['fl-group-host', 'fl-group-lothdesktop', 'fl-group-m5', 'fl-group-m3']);
  await expect(sidebar.locator('.section-head', { hasText: 'Computers' }).locator('.count')).toHaveText('4');
  const beast = sidebar.getByTestId('fl-group-host');
  await expect(beast.locator('.fl-name')).toHaveText('BEAST');
  await expect(beast.getByTestId('fl-os')).toHaveText('Windows · host');
  // Its limits are the daemon's pool now (max_sandboxes 5, max_unity 4).
  await expect(beast.getByTestId('fl-capacity')).toHaveText('2/5 sandboxes · 1/4 editors');
  await expect(beast.getByTestId('fl-agents-sum')).toHaveText('1 agent, 1 busy');
  const play = beast.getByTestId('fl-sandbox-beast/agent-a');
  await expect(play.getByTestId('fl-agent')).toContainText(/Honest co-op: BEAST client\s*busy\s*1m/);
  await expect(beast.getByTestId('fl-sandbox-beast/agent-b').locator('.fl-free')).toHaveText('FREE');
  if (!isMobile(page)) await proof(page, 'sidebar-beast-daemon');
  await play.getByTestId('fl-agent').click();
  await expect(page).toHaveURL(/#\/machine\/beast\/sandbox\/agent-a\/b-play$/);
  await expect(page.getByTestId('machine-sandbox-panel')).toBeVisible();
});

test("fleet: BEAST's card says when its daemon is down, and opens the daemon's page", async ({ page }) => {
  await fixedFleet(page, '#/overview', onBeastsDaemon(false));
  const board = page.getByTestId('overview');
  await expect(board.locator('.board-card')).toHaveCount(4);
  const card = board.getByTestId('board-host');
  await expect(card.getByTestId('fl-os')).toHaveText('Windows · host · daemon offline');
  await expect(card.locator('.board-head-link')).toHaveAttribute('title', "Open BEAST's daemon (beast)");
  await card.locator('.board-head-link').click();
  await expect(page).toHaveURL(/#\/machine\/beast$/);
});

/**
 * w1430 (Ben: "there are so many inactive chats in every slot ... i also feel like if there is work waiting for live view
 * workflow, it should be obvious maybe as a go button next to the slot"): LothDesktop's free sb2 holds a worker stopped
 * while it waits on the viewer in its Live view, and three older chats. `live`: whether that worker streams one; `on`: whom
 * it waits on.
 */
function waitingInSb2(opts: { live: boolean; on?: string }) {
  return (s: AppState): AppState => {
    const f = fleet(s);
    const orch = f.sessions.find((x) => x.id === f.orchestratorId)!;
    const me = opts.on ?? s.me!.displayName;
    const sb2 = { machineId: 'lothdesktop', machineSandbox: 'sb2' };
    const sessions = [
      ...f.sessions,
      worker(orch, 'l-knob', 'w1325: Radiators: slower, smaller panel fold', 'stopped', 9, { ...sb2, waitingOn: { who: me, what: "Drag the fin colour in sb2's Live view", at: min(9), request: 'w1325' } }),
      worker(orch, 'l-done1', 'w1301: Belt splitter tooltip', 'stopped', 300, sb2),
      worker(orch, 'l-done2', 'w1288: Deck research scroll', 'stopped', 500, sb2),
      worker(orch, 'l-fin', 'w1428: Windows saves on the Mac', 'idle', 30, sb2),
    ];
    const view: LiveViewInfo = { liveId: 'live-sb2', sessionId: 'l-knob', machineId: 'lothdesktop', sandbox: 'sb2', state: 'live', detail: '', fps: 15, width: 960, materials: ['heatExchangerMaterial'], startedAt: min(12), updatedAt: min(0), frames: 100 };
    return {
      ...f,
      sessions,
      work: [...(f.work ?? []), request('w1325', 'active', ['l-knob']), request('w1428', 'done', ['l-fin'])],
      config: { ...f.config, live: { enabled: true } },
      live: opts.live ? [view] : [],
      machines: f.machines.map((m) =>
        m.id === 'lothdesktop' ? { ...m, sandboxes: m.sandboxes!.map((x) => (x.id === 'sb2' ? { ...x, sessionIds: ['l-done2', 'l-done1', 'l-fin', 'l-knob'] } : x)) } : m,
      ),
    };
  };
}

test('fleet: a slot lists the chats that matter now, folds the rest behind "+N older", and calls you to its Live view (w1430)', async ({ page }) => {
  await fixedFleet(page, '#/', waitingInSb2({ live: true }));
  const sidebar = await openSidebar(page);
  const sb2 = sidebar.getByTestId('fl-sandbox-lothdesktop/sb2');
  // Only the worker that waits on you; the stopped and finished chats fold.
  await expect(sb2.getByTestId('fl-agent')).toHaveCount(1);
  await expect(sb2.getByTestId('fl-agent')).toContainText(/w1325: Radiators.*asked you/);
  await expect(sb2.getByTestId('fl-older')).toHaveText('+3 older');
  await expect(sb2.getByTestId('fl-call')).toHaveText('Live view: go');
  // The call is the first line under the slot's row, on the row's text edge; the row keeps its name and branch whole, and
  // no FREE chip says the slot is free while its work waits on you.
  await expect(sb2.getByTestId('fl-sandbox-row').locator('.row-title')).toHaveText('sb2');
  await expect(sb2.locator('.fl-free')).toHaveCount(0);
  // It says the worker asked you, quietly (w1521): "Needs you" and its badge are a permission's.
  await expect(sb2.getByTestId('fl-sandbox-row').locator('.row-sub')).toContainText(/Asked you · w1325: Radiators/);
  await expect(sb2.getByTestId('fl-sandbox-row').locator('.badge-amber')).toHaveCount(0);
  // A thumb's target on a phone.
  if (isMobile(page)) expect((await sb2.getByTestId('fl-call').boundingBox())!.height).toBeGreaterThanOrEqual(36);
  const row = (await sb2.getByTestId('fl-sandbox-row').boundingBox())!;
  const name = (await sb2.getByTestId('fl-sandbox-row').locator('.row-title').boundingBox())!;
  const call = (await sb2.getByTestId('fl-call').boundingBox())!;
  const first = (await sb2.getByTestId('fl-agent').first().boundingBox())!;
  expect(call.y, 'the call is under the row').toBeGreaterThanOrEqual(row.y + row.height - 1);
  expect(first.y, 'and above the chats').toBeGreaterThanOrEqual(call.y + call.height - 1);
  expect(Math.abs(call.x - name.x), "the call starts on the row's text edge").toBeLessThan(1.5);
  if (!isMobile(page)) await proof(page, 'sidebar-slot-call');
  // "+3 older" opens them in place, the newest first, and folds them again.
  await sb2.getByTestId('fl-older').click();
  await expect(sb2.getByTestId('fl-agent')).toHaveText([/w1325/, /w1428.*idle/, /w1301.*stopped/, /w1288.*stopped/]);
  await expect(sb2.getByTestId('fl-older')).toHaveText('Hide 3 older');
  await sb2.getByTestId('fl-older').click();
  await expect(sb2.getByTestId('fl-agent')).toHaveCount(1);
  // One click opens the waiting worker's Live view.
  await sb2.getByTestId('fl-call').click();
  await expect(page).toHaveURL(/#\/live\/l-knob$/);
});

test("fleet: an owner sees a quiet \"Live view: go\" on a slot whose view is for someone else's request, beside the amber call (w1599)", async ({ page }) => {
  // lothsahn: "Give everyone a button to go to the live view even if it's not theirs". sb2's worker waits on the viewer (amber);
  // sb1's idle reviewer was asked for by Lothsahn and streams a view the viewer, an owner, may watch (quiet, outlined chip).
  const both = (s: AppState): AppState => {
    const f = waitingInSb2({ live: true })(s);
    const view: LiveViewInfo = { liveId: 'live-sb1', sessionId: 'l-review', machineId: 'lothdesktop', sandbox: 'sb1', state: 'live', detail: '', fps: 15, width: 960, materials: ['VfxComet'], startedAt: min(8), updatedAt: min(0), frames: 100 };
    // A worker copies its orchestrator's lastRequestedBy, which an earlier test of the shared server may have set to the viewer.
    const lothsahn = { userId: 'lothsahn', displayName: 'Lothsahn' };
    const sessions = f.sessions.map((x) => (x.id === 'l-review' ? { ...x, requestedBy: lothsahn, lastRequestedBy: lothsahn } : x));
    return { ...f, sessions, live: [...(f.live ?? []), view] };
  };
  await fixedFleet(page, '#/', both);
  const sidebar = await openSidebar(page);
  const sb2 = sidebar.getByTestId('fl-sandbox-lothdesktop/sb2');
  const sb1 = sidebar.getByTestId('fl-sandbox-lothdesktop/sb1');
  await expect(sb2.getByTestId('fl-call')).toHaveClass(/needs-you/);
  await expect(sb1.getByTestId('fl-call')).toHaveText('Live view: go');
  await expect(sb1.getByTestId('fl-call')).toHaveClass(/fl-call-quiet/);
  await expect(sb1.getByTestId('fl-call')).not.toHaveClass(/needs-you/);
  // It calls nobody: the row keeps its state (no "Asked you"), no amber badge.
  await expect(sb1.getByTestId('fl-sandbox-row').locator('.row-sub')).not.toContainText(/Asked you/);
  await expect(sb1.getByTestId('fl-sandbox-row').locator('.badge-amber')).toHaveCount(0);
  // The quiet one is as tall as the amber one and on the same text edge.
  const quiet = (await sb1.getByTestId('fl-call').boundingBox())!;
  const amber = (await sb2.getByTestId('fl-call').boundingBox())!;
  const name = (await sb1.getByTestId('fl-sandbox-row').locator('.row-title').boundingBox())!;
  expect(Math.abs(quiet.height - amber.height)).toBeLessThan(1.5);
  expect(Math.abs(quiet.x - name.x), "the button starts on the row's text edge").toBeLessThan(1.5);
  if (isMobile(page)) expect(quiet.height).toBeGreaterThanOrEqual(36);
  await sb1.evaluate((el) => el.scrollIntoView({ block: 'start' })); // both slots in the shot, on a phone too
  await proof(page, 'sidebar-slot-call-quiet');
  await sb1.getByTestId('fl-call').click();
  await expect(page).toHaveURL(/#\/live\/l-review$/);
});

test("fleet: the request's card on the Dispatcher's Waiting tab opens the waiting worker's Live view too (w1430)", async ({ page }) => {
  await fixedFleet(page, '#/dispatcher/waiting', waitingInSb2({ live: true }));
  const card = page.getByTestId('wait-w1325');
  await expect(card.getByTestId('wait-live-w1325')).toHaveText('Watch it in the Live view');
  await card.getByTestId('wait-live-w1325').click();
  await expect(page).toHaveURL(/#\/live\/l-knob$/);
});

test('fleet: a worker\'s question to you shows "Asked you" with no Needs-you badge or button; a pending permission keeps both (w1521)', async ({ page }) => {
  // Ben: "needs you should just be approving/denying coommands, if they have questions for me they should pipe it through you
  // and then i answer you". sb2's worker asked the viewer a question (no Live view); sb1's worker waits on a permission.
  const permission = (s: AppState): AppState => ({
    ...s,
    sessions: s.sessions.map((x) =>
      x.machineSandbox === 'sb1' && x.status === 'running'
        ? { ...x, status: 'waiting_permission', pendingPermissions: [{ requestId: 'p1', toolName: 'Bash', input: { command: 'git push origin w1521' }, createdAt: min(1) }] }
        : x,
    ),
  });
  await fixedFleet(page, '#/', (s) => permission(waitingInSb2({ live: false })(s)));
  const sidebar = await openSidebar(page);
  const sb2 = sidebar.getByTestId('fl-sandbox-lothdesktop/sb2');
  await expect(sb2.getByTestId('fl-sandbox-row').locator('.row-sub')).toContainText(/Asked you · w1325: Radiators/);
  await expect(sb2.getByTestId('fl-agent')).toContainText(/w1325: Radiators.*asked you/);
  await expect(sb2.getByTestId('fl-call')).toHaveCount(0);
  await expect(sb2.locator('.badge-amber')).toHaveCount(0);
  await expect(sb2).not.toContainText(/needs you/i);
  // The question is in the row's hint, with where to answer it.
  await expect(sb2.getByTestId('fl-sandbox-row')).toHaveAttribute('title', /Asked you: Drag the fin colour in sb2's Live view \(answer it in your orchestrator chat\)/);
  const sb1 = sidebar.getByTestId('fl-sandbox-lothdesktop/sb1');
  await expect(sb1.getByTestId('fl-sandbox-row').locator('.row-sub')).toContainText(/^Needs you/);
  await expect(sb1.getByTestId('fl-sandbox-row').locator('.badge-amber')).toHaveText('1');
  await expect(sb1.getByTestId('fl-agent').first()).toContainText(/needs you/);
  if (!isMobile(page)) await proof(page, 'sidebar-asked-after');
});

test("fleet: a worker that waits on someone else is listed with whom, and the slot calls nobody (w1430)", async ({ page }) => {
  // No Live view: one up for the person who asked for the worker would call them (slotCall).
  await fixedFleet(page, '#/', waitingInSb2({ live: false, on: 'Somebody Else' }));
  const sb2 = (await openSidebar(page)).getByTestId('fl-sandbox-lothdesktop/sb2');
  await expect(sb2.getByTestId('fl-agent')).toContainText(/w1325.*waits on Somebody Else/);
  await expect(sb2.getByTestId('fl-call')).toHaveCount(0);
});
