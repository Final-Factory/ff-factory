// The host guard in a machine's daemon (w466, docs/portal-on-ffbox-host.md change 4, D11): BEAST's sandbox drive watched
// and remounted by its daemon, with the retries, the editors and agents brought back, the reports reaching the portal,
// new work refused while the drive is gone; and the portal's own guard leaving the drive to it meanwhile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MachineGuard, machineGuardConfig, runnerRestartScript, type MachineGuardEffects, type MachineGuardPorts } from '../machine/hostGuard.ts';
import { HostHealthMonitor, type HostDeps } from './hostHealth.ts';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle } from './sessions.ts';
import { MachineManager, convertMachineRecord, guardSettingsOf } from './machines.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import type { DeployOptions } from './machineDeploy.ts';
import type { Config } from './config.ts';
import type { HelperResult } from './privileged.ts';
import { diskAboveLine } from '../shared/blockers.ts';
import type { Machine, MachineGuardSettings, Sandbox, SessionInfo } from '../shared/types.ts';

const GB = 1024 ** 3;
const MIN = 60_000;
const SETTINGS: MachineGuardSettings = { pollSeconds: 30, warnFreeGB: 80, criticalFreeGB: 40, hysteresisGB: 10, remountMinFreeGB: 30, hostDiskPaths: ['C:/'], reapBrowsersAfterHours: 3, reapEveryMinutes: 15, minFreeRamGB: 10 };

/** BEAST's daemon as its guard sees it: one editor up, one agent mid-turn and one idle in sandboxes, F: and C:. */
function world(over: { drive?: boolean; freeC?: number; helper?: (n: number) => boolean } = {}) {
  const w = {
    now: Date.parse('2026-10-05T22:00:00Z'),
    drive: over.drive ?? true,
    freeC: over.freeC ?? 400 * GB,
    helperAt: [] as number[],
    reapLines: [] as string[],
    log: [] as string[],
    reports: [] as string[],
    sandboxes: [{ id: 'mp-r2', unity: { state: 'running' } }, { id: 'slot-5', unity: { state: 'stopped' } }] as unknown as Sandbox[],
    sessions: [
      { id: 'a1', kind: 'worker', status: 'running', sandboxId: 'mp-r2' },
      { id: 'a2', kind: 'worker', status: 'idle', sandboxId: 'slot-5' },
    ] as unknown as SessionInfo[],
  };
  const fx: MachineGuardEffects = {
    exists: (p) => (p.startsWith('F') ? w.drive : true),
    statfs: async (p) => (p.startsWith('C') ? { free: w.freeC, total: 2000 * GB } : { free: 600 * GB, total: 900 * GB }),
    mem: () => ({ free: 30 * GB, total: 64 * GB }),
    runHelper: async (a): Promise<HelperResult> => {
      w.helperAt.push(w.now);
      w.log.push(`helper ${a}`);
      const ok = over.helper?.(w.helperAt.length) ?? false;
      if (ok) w.drive = true;
      return { action: a, ok, at: new Date(w.now).toISOString(), detail: ok ? 'attached' : 'Mount-VHD: the file is in use' };
    },
    reap: async () => w.reapLines,
    now: () => w.now,
  };
  const ports: MachineGuardPorts = {
    sandboxes: () => w.sandboxes,
    sessions: () => w.sessions,
    startEditor: async (id) => void w.log.push(`start ${id}`),
    stopEditor: async (id) => void w.log.push(`stop ${id}`),
    interrupt: async (id) => {
      w.log.push(`interrupt ${id}`);
      const s = w.sessions.find((x) => x.id === id);
      if (s) s.status = 'stopped';
    },
    tell: (id) => void w.log.push(`tell ${id}`),
    report: (title) => void w.reports.push(title),
    changed: () => undefined,
    log: () => undefined,
  };
  return { w, fx, ports };
}

test('machine guard: the config it gives the host guard is the drive, its disks and the reaper; no clean-up or idle stop of its own', () => {
  const c = machineGuardConfig(SETTINGS, 'F:\\ffsb');
  assert.equal(c.sandboxRoot, 'F:\\ffsb');
  assert.deepEqual(c.hostDiskPaths, ['C:/']);
  assert.deepEqual([c.hostGuard.pollSeconds, c.hostGuard.remountMinFreeGB, c.hostGuard.reapBrowsersAfterHours, c.hostGuard.cleanup.everyMinutes, c.unity.idleStopMinutes, c.limits.minFreeRamGB], [30, 30, 3, 0, 0, 10]);
});

test('machine guard: the drive goes with an agent mid-turn; remount at once, then 2, 5, 10 and 30 min; back: editor restarted, agent resumed', async () => {
  const { w, fx, ports } = world({ helper: (n) => n === 5 });
  const g = new MachineGuard(SETTINGS, 'F:\\ffsb', fx, ports);
  await g.tick();
  assert.equal(g.health.sandboxRoot, 'ok');
  assert.equal(g.blockReason('agent'), undefined);

  w.drive = false; // Windows dropped F: (2026-09-24)
  await g.tick();
  assert.deepEqual(w.log.slice(0, 2), ['interrupt a1', 'helper mount'], 'the busy agent stopped, then the first remount at once');
  assert.ok(w.reports.includes('Sandbox drive is gone'));
  assert.match(g.blockReason('agent') ?? '', /sandbox drive is offline/);
  assert.match(g.blockReason('editor') ?? '', /sandbox drive is offline/);
  assert.equal(g.health.sandboxRoot, 'missing');
  // A look a minute later tries nothing: the next attempt is 2 minutes after the first.
  w.now += MIN;
  await g.tick();
  assert.equal(w.helperAt.length, 1);
  for (const wait of [1, 5, 10, 30]) {
    w.now += wait * MIN;
    await g.tick();
  }
  const gaps = w.helperAt.slice(1).map((t, i) => (t - w.helperAt[i]) / MIN);
  assert.deepEqual(gaps, [2, 5, 10, 30], 'the retries');
  assert.equal(w.helperAt.length, 5);
  assert.equal(g.health.sandboxRoot, 'ok', 'the fifth attached it');
  assert.ok(w.reports.includes('Sandbox drive is back'));
  assert.deepEqual(
    w.log.filter((l) => /^(start|tell)/.test(l)),
    ['start mp-r2', 'tell a1'],
    'the editor that was up, then the agent that was mid-turn (not the idle one)',
  );
  assert.equal(g.blockReason('agent'), undefined);
});

test('machine guard: six failed remounts give up and say so; the daemon restarted during an outage reattaches without stopping anyone', async () => {
  const failing = world();
  const g = new MachineGuard(SETTINGS, 'F:\\ffsb', failing.fx, failing.ports);
  await g.tick();
  failing.w.drive = false;
  for (let i = 0; i < 8; i++) {
    await g.tick();
    failing.w.now += 31 * MIN;
  }
  assert.equal(failing.w.helperAt.length, 6, 'MAX_REMOUNT_ATTEMPTS');
  assert.equal(g.health.sandboxRoot, 'failed');
  assert.ok(failing.w.reports.includes('Sandbox drive: could not reattach it'));
  assert.match(g.blockReason('agent') ?? '', /sandbox drive is offline \(failed/);

  // A reboot during the outage: the daemon starts with F: missing. Nothing of its was mid-turn in this process.
  const boot = world({ drive: false, helper: () => true });
  boot.w.sessions = [];
  const g2 = new MachineGuard(SETTINGS, 'F:\\ffsb', boot.fx, boot.ports);
  assert.match(g2.blockReason('agent') ?? '', /sandbox drive is offline/, 'before its first look: nothing starts on a drive not seen yet');
  await g2.tick();
  assert.deepEqual(boot.w.reports.slice(0, 2), ['Sandbox drive not attached at startup', 'Sandbox drive is back']);
  assert.equal(boot.w.log.filter((l) => l.startsWith('interrupt')).length, 0);
  assert.equal(g2.health.sandboxRoot, 'ok');
});

test('machine guard: a remount waits for space on the VHDX volume; the reaper reports what it ended', async () => {
  const { w, fx, ports } = world({ freeC: 12 * GB, helper: () => true });
  w.reapLines = ['killed chrome.exe 4242 and its children (headless chrome.exe running for 5.0 h)'];
  const g = new MachineGuard(SETTINGS, 'F:\\ffsb', fx, ports);
  await g.tick();
  assert.ok(w.reports.includes('Reaped leftover headless browsers'));
  w.drive = false;
  await g.tick();
  assert.equal(w.helperAt.length, 0, 'not with 12 GB free on C: (remountMinFreeGB 30)');
  assert.ok(w.reports.includes('Sandbox drive: waiting for disk space'));
  assert.match(g.health.detail ?? '', /waiting for 30 GB free on the host volume/);
  w.freeC = 300 * GB;
  w.now += 6 * MIN;
  await g.tick();
  assert.equal(w.helperAt.length, 1);
  assert.equal(g.health.sandboxRoot, 'ok');
});

test("a guard that owns no drive (the portal's, w510: watchDrive no) never remounts or blocks on it; one that gives it up mid-outage drops its recovery", async () => {
  let handedOver = true;
  let drive = false;
  const helper: string[] = [];
  const deps: HostDeps = {
    cfg: { sandboxRoot: 'F:\\ffsb', dataDir: 'C:\\fff\\data', hostDiskPaths: ['C:\\'], limits: { minFreeRamGB: 0 }, unity: { idleStopMinutes: 0 }, hostGuard: { pollSeconds: 30, warnFreeGB: 80, criticalFreeGB: 40, hysteresisGB: 10, remountMinFreeGB: 30, devDriveVhdx: '', reapBrowsersAfterHours: 0, reapEveryMinutes: 15, cleanup: { everyMinutes: 0, softFreeGB: 0 } } } as unknown as Config,
    statfs: async () => ({ free: 500 * GB, total: 900 * GB }),
    exists: (p) => (p.startsWith('F') ? drive : true),
    mem: () => ({ free: 30 * GB, total: 64 * GB }),
    sandboxes: () => [],
    sessions: () => [],
    startEditor: async () => undefined,
    stopEditor: async () => undefined,
    interrupt: async () => undefined,
    tell: () => undefined,
    report: () => undefined,
    runHelper: async (a) => (helper.push(a), { action: a, ok: false, at: '', detail: 'x' }),
    cleanup: { pass: async () => ({ removed: [], failed: [], bytes: 0 }), consumers: async () => [], log: () => undefined, diskPaths: () => [] },
    changed: () => undefined,
    watchDrive: () => !handedOver,
  };
  const portal = new HostHealthMonitor(deps);
  await portal.tick();
  assert.deepEqual([portal.status.sandboxRoot, helper.length, portal.blockReason('agent')], ['ok', 0, undefined], 'the daemon remounts it, not the portal');
  handedOver = false; // a guard that owns the drive (a daemon's) watches it
  await portal.tick();
  assert.deepEqual([portal.status.sandboxRoot, helper], ['missing', ['mount']]);
  handedOver = true; // and hands back mid-outage: its recovery is dropped
  await portal.tick();
  assert.equal(portal.status.sandboxRoot, 'ok');
  drive = true;
});

const PROBES: Probes = {
  stats: async () => ({ hostname: 'beast', platform: 'win32', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: 64 * GB, memFreeBytes: 30 * GB }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};
const until = async (what: string, cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("a daemon with the guard says so in its hello; its reports and state reach the portal; a new sandbox agent waits while the drive is gone", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mguard-'));
  const cfg = { dataDir: tmp, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  const store = new Store(tmp);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = { specFor: () => ({ cwd: tmp, settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: tmp, protectedPaths: [], gameRepos: [] } }), handlersFor: () => ({}) };
  const reports: string[] = [];
  mm.hostReport = (id, title) => reports.push(`${id}: ${title}`);
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = mm.register({ id: 'beast', host: 'beast', purpose: 'unused', status: 'ready', repoPath: tmp, home: tmp, portalUrl: url });
  const drive = path.join(tmp, 'F');
  const { fx } = world({ drive: false });
  const daemonFx: MachineGuardEffects = { ...fx, exists: (p) => (p === drive ? false : fs.existsSync(p)) };
  const sandboxes = { root: drive, maxSandboxes: 5, maxAgentsPerSandbox: 6, maxUnity: 2, diskWarnGB: 80, diskCriticalGB: 40 };
  const d = new Daemon({ portalUrl: url, id: 'beast', token, repoPath: tmp, appDir: tmp, claude: 'no-such-claude', maxSessions: 3, maxEventsFile: null, sandboxes, hostGuard: SETTINGS }, () => ({}) as unknown as SessionHandle, PROBES, undefined, daemonFx);
  const plain = new Daemon({ portalUrl: url, id: 'beast', token, repoPath: tmp, appDir: tmp, claude: 'no-such-claude', maxSessions: 3, maxEventsFile: null, sandboxes }, () => ({}) as unknown as SessionHandle, PROBES, undefined);
  t.after(async () => {
    d.shutdown();
    plain.shutdown();
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  // Without hostGuard settings, no guard and no flag.
  plain.start();
  await until('the plain daemon online', () => mm.isOnline('beast'));
  assert.equal(plain.guard, undefined);
  assert.equal(mm.guards('beast'), false);
  plain.shutdown();
  await until('offline', () => !mm.isOnline('beast'));

  d.start();
  await until('online with its guard', () => mm.isOnline('beast') && mm.guards('beast'));
  assert.ok(d.guard, 'the guard runs (test effects stand in for Windows)');
  await d.guard!.tick();
  await until('its reports relayed', () => reports.includes('beast: Sandbox drive not attached at startup'));
  await until('its state on the record', () => store.machines.get('beast')!.guard?.sandboxRoot !== undefined);
  assert.match(store.machines.get('beast')!.guard!.sandboxRoot, /missing|remounting/);
  const refusal = (d as unknown as { startRefusal(spec: { sandbox?: string; cwd: string }): string | undefined }).startRefusal({ sandbox: 'mp-r2', cwd: path.join(drive, 'mp-r2') });
  assert.match(refusal ?? '', /sandbox drive is offline/);
  const standing = (d as unknown as { startRefusal(spec: { sandbox?: string; cwd: string }): string | undefined }).startRefusal({ cwd: path.join(tmp, 'agents', 'st') });
  assert.equal(standing, undefined, 'a standing agent is not on the drive: it is not held up');
});

test('the settings: the portal gives its own guard\'s to its own host\'s daemon at deploy, and convert_machine keeps them', async (t) => {
  const cfg = {
    hostGuard: { pollSeconds: 30, warnFreeGB: 80, criticalFreeGB: 40, hysteresisGB: 10, remountMinFreeGB: 30, devDriveVhdx: 'C:/ffsb-devdrive.vhdx', reapBrowsersAfterHours: 3, reapEveryMinutes: 15, cleanup: { everyMinutes: 60, softFreeGB: 0 } },
    hostDiskPaths: ['C:/'],
    limits: { minFreeRamGB: 10, maxSandboxes: 5, maxUnity: 2, maxSessions: 6 },
  } as unknown as Config;
  assert.deepEqual(guardSettingsOf(cfg), SETTINGS);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mguard-deploy-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const full = { ...cfg, dataDir: tmp, port: 8790, sandboxRoot: 'F:/ffsb', repo: { url: 'x', basePath: tmp }, protectedPaths: [], librarySeed: '', worker: { effort: 'high' }, unity: { idleStopMinutes: 120 } } as unknown as Config;
  const store = new Store(tmp);
  const mm = new MachineManager(full, store, new SessionManager(full, store));
  mm.allowLocalAnywhere = true;
  const deployed: DeployOptions[] = [];
  mm.deployer = async (o) => {
    deployed.push(o);
    throw new Error('no real deploy');
  };
  mm.deployMachine({ id: 'beast', local: true });
  await until('deployed', () => deployed.length === 1);
  assert.deepEqual(deployed[0].extra?.hostGuard, SETTINGS);
  store.flush();

  const beast = { id: 'beast', local: true, host: 'localhost', purpose: 'unused', status: 'ready', online: true, repoPath: 'C:\\ffsb\\_base', home: 'C:\\Users\\rydin', portalUrl: 'http://127.0.0.1:8790', maxSessions: 3, sessionIds: [], createdAt: '' } as Machine;
  const ssh = convertMachineRecord(beast, 'ssh', { sshHost: 'beast', portalUrl: 'https://fff.example.ts.net', port: 8790, extras: deployed[0].extra });
  assert.deepEqual(ssh.daemonExtras?.hostGuard, SETTINGS, 'BEAST keeps its guard when the portal moves to the VM');
});

test('machine guard: the sandbox volume is judged by the pool\'s disk_warn_gb, not daemon.json\'s hostGuard.warnFreeGB (w1581)', async () => {
  // lothdesktop, 2026-10-19: V:\ffw\sandboxes at 49.6 GB free, hostGuard.warnFreeGB 50 carried in daemon.json, and lothsahn's
  // "Let's reduce the buffer on v: drives to 25GB" set on the pool (add_machine disk_warn_gb 25), which reached the pool only.
  const run = async (floor: { warnGB: number; criticalGB: number } | undefined, freeV: number) => {
    const { fx, ports } = world();
    const g = new MachineGuard({ ...SETTINGS, warnFreeGB: 50, criticalFreeGB: 20, hostDiskPaths: ['D:/'] }, 'V:\\ffw\\sandboxes', { ...fx, exists: () => true, statfs: async (p) => ({ free: p.startsWith('V') ? freeV : 199 * GB, total: 1000 * GB }) }, { ...ports, ...(floor ? { poolFloor: () => floor } : {}) });
    await g.tick();
    return g;
  };
  const before = await run(undefined, 49.6 * GB);
  assert.match(before.blockReason('agent') ?? '', /V:\\ffw\\sandboxes 50 GB free.*new agent processes wait/, 'without the pool floor: the 50 GB that blocked lothdesktop');
  const after = await run({ warnGB: 25, criticalGB: 20 }, 49.6 * GB);
  assert.equal(after.blockReason('agent'), undefined, 'at 25: agents start at 49.6 GB free');
  assert.equal(after.health.disks.find((d) => d.path.startsWith('D'))?.level, 'ok');
  const low = await run({ warnGB: 25, criticalGB: 20 }, 24 * GB);
  assert.match(low.blockReason('agent') ?? '', /disk space is low \(V:\\ffw\\sandboxes 24 GB free\)/, 'below 25: still refused');
  assert.match((await run({ warnGB: 25, criticalGB: 20 }, 19 * GB)).blockReason('agent') ?? '', /critically low/, 'below its disk_critical_gb: critical');
  // Another volume keeps hostGuard's own levels: D: at 40 GB is under the guard's 50, whatever the pool says.
  const { fx, ports } = world();
  const d = new MachineGuard({ ...SETTINGS, warnFreeGB: 50, criticalFreeGB: 20, hostDiskPaths: ['D:/'] }, 'V:\\ffw\\sandboxes', { ...fx, exists: () => true, statfs: async (p) => ({ free: p.startsWith('V') ? 100 * GB : 40 * GB, total: 1000 * GB }) }, { ...ports, poolFloor: () => ({ warnGB: 25, criticalGB: 20 }) });
  await d.tick();
  assert.equal(d.health.disks.find((x) => x.path.startsWith('D'))?.level, 'warn');
});

test('w5167: the sandbox volume\'s guard lifts its low-disk refusal of new agents at the reading that clears a disk gate (warning line + DISK_RESUME_MARGIN_GB), not at the Dev Drive install\'s hysteresisGB 10', async () => {
  // lothdesktop, 2026-11-23: critical at 9 GB, then 24 GB free over its pool's 15 GB line. The disk gate cleared at 15 + 5 at
  // 03:48Z and the resumed workers were refused at 03:49Z ("disk space is low (V:\ffw\sandboxes 24 GB free); new agent
  // processes wait"): the daemon's guard lifted only at 15 + 10, daemon.json's hysteresisGB (scripts/worker/devdrive.ts).
  const { fx, ports } = world();
  let freeV = 9 * GB;
  const floor = { warnGB: 15, criticalGB: 10 };
  const g = new MachineGuard({ ...SETTINGS, warnFreeGB: 15, criticalFreeGB: 10, hysteresisGB: 10, hostDiskPaths: ['D:/'] }, 'V:\\ffw\\sandboxes', { ...fx, exists: () => true, statfs: async (p) => ({ free: p.startsWith('V') ? freeV : 199 * GB, total: 1000 * GB }) }, { ...ports, poolFloor: () => floor });
  await g.tick();
  assert.match(g.blockReason('agent') ?? '', /critically low \(V:\\ffw\\sandboxes 9 GB free\)/);
  for (const gb of [12, 16, 19, 19.9, 20, 21, 24, 30]) {
    freeV = gb * GB;
    await g.tick();
    const gate = diskAboveLine('lothdesktop', { freeBytes: freeV, warnGB: floor.warnGB });
    const refusal = g.blockReason('agent');
    assert.equal(refusal === undefined, gate !== undefined, `${gb} GB free: the gate says "${gate ?? 'still low'}", the guard "${refusal ?? 'starts agents'}"`);
  }
  assert.equal(g.blockReason('agent'), undefined);
});

test("w1918: a wanted Dev Drive maximum waits while an agent or editor is in a sandbox, says so once, then grows through ffsb-helper-grow with new work held; a failed grow is tried again after 30 min", async () => {
  const { w, fx, ports } = world();
  let state: Record<string, unknown> = { letter: 'F', maxGB: 80, wantGB: 112 };
  const read: string[] = [];
  const blocked: (string | undefined)[] = [];
  let ok = false;
  let g!: MachineGuard;
  const fx2: MachineGuardEffects = {
    ...fx,
    readJson: (p) => (read.push(p), state),
    runHelper: async (a) => {
      w.log.push(`helper ${a}`);
      blocked.push(g.blockReason('agent'));
      if (ok) state = { letter: 'F', maxGB: 112 };
      return { action: a, ok, at: new Date(w.now).toISOString(), detail: ok ? 'grew F: from 80 to 112 GB' : 'diskpart: the file is in use' };
    },
  };
  // The VHDX holds 60 GB on D:, so the room it can still take there is the maximum less that (w1947).
  g = new MachineGuard({ ...SETTINGS, hostDiskPaths: ['C:/', 'D:/'], devDriveVhdx: 'D:/work/ffw/devdrive.vhdx', devDriveMaxGB: 80 }, 'F:/ffsb', { ...fx2, fileBytes: () => 60 * GB }, ports);
  const growth = () => (g.health.disks.find((d) => d.path.startsWith('D'))?.growthBytes ?? 0) / GB;
  assert.deepEqual(g.pendingGrow(), { wantGB: 112, maxGB: 80 });
  assert.equal(read[0], path.join('D:/work/ffw', 'devdrive.json'));

  // An editor up and an agent mid-turn: it waits, and says so once.
  await g.tick();
  await g.tick();
  assert.equal(w.log.filter((l) => l === 'helper grow').length, 0);
  assert.equal(w.reports.filter((r) => r === 'Dev Drive: grow pending').length, 1);
  assert.equal(growth(), 20, 'judged by the 80 GB maximum before the grow');
  // An agent between turns still holds its sandbox.
  w.sandboxes = [{ id: 'mp-r2', unity: { state: 'stopped' } }] as unknown as Sandbox[];
  w.sessions = [{ id: 'a2', kind: 'worker', status: 'idle', sandboxId: 'slot-5' }] as unknown as SessionInfo[];
  await g.tick();
  assert.equal(w.log.filter((l) => l === 'helper grow').length, 0);

  // Nothing in the sandboxes: it grows, holding new agents meanwhile; the helper fails, so it waits 30 min.
  w.sessions = [{ id: 'a2', kind: 'worker', status: 'stopped', sandboxId: 'slot-5' }] as unknown as SessionInfo[];
  await g.tick();
  assert.equal(w.log.filter((l) => l === 'helper grow').length, 1);
  assert.match(blocked[0] ?? '', /Dev Drive is being grown to 112 GB/);
  assert.equal(g.blockReason('agent'), undefined, 'free again once the helper is done');
  assert.ok(w.reports.includes('Dev Drive: grow failed'));
  w.now += 10 * MIN;
  await g.tick();
  assert.equal(w.log.filter((l) => l === 'helper grow').length, 1, 'not again within 30 min');
  w.now += 25 * MIN;
  ok = true;
  await g.tick();
  assert.equal(w.log.filter((l) => l === 'helper grow').length, 2);
  assert.ok(w.reports.includes('Dev Drive: grown'));
  assert.equal(g.pendingGrow(), undefined);
  assert.equal(growth(), 52, 'and by the 112 GB one after it, before any update writes daemon.json again');
  await g.tick();
  assert.equal(w.log.filter((l) => l === 'helper grow').length, 2, 'nothing more to do');

  // No VHDX (a machine without a Dev Drive): never pending.
  const none = new MachineGuard(SETTINGS, 'F:/ffsb', fx2, ports);
  assert.equal(none.pendingGrow(), undefined);
});

test('w3721: a Dev Drive grow waits for a CI job on a runner on the drive, then starts again every listener it ended; runners on other drives are not its business', async () => {
  // lothdesktop, 2026-11-08 20:33 UTC: "growing the Dev Drive from 300 to 320 GB" detached V: mid-job, and ffu-lothdesktop-1
  // and -2 (V:\ffw\ffu-runners) stayed offline in GitHub until their scheduled tasks were started by hand.
  const { w, fx, ports: base } = world();
  const said: string[] = [];
  const ports: MachineGuardPorts = { ...base, report: (title, text) => (w.reports.push(title), void said.push(text)) };
  w.sessions = [];
  w.sandboxes = [];
  let state: Record<string, unknown> = { letter: 'F', maxGB: 80, wantGB: 112 };
  let runners = [
    { root: 'F:/ffsb/ffu-runners/ffu-1', busy: true },
    { root: 'f:/ffsb/ffu-runners/ffu-2', busy: false },
    { root: 'C:/Users/x/ffu-runner', busy: true },
  ];
  const restarted: string[] = [];
  const fx2: MachineGuardEffects = {
    ...fx,
    readJson: () => state,
    runners: async () => runners,
    restartRunner: async (root) => {
      restarted.push(root);
      if (root.endsWith('ffu-2')) throw new Error('no scheduled task and no run.cmd');
      return `scheduled task ${root.split('/').pop()}`;
    },
    runHelper: async (a) => {
      w.log.push(`helper ${a}`);
      state = { letter: 'F', maxGB: 112 };
      runners = runners.filter((r) => r.root.startsWith('C')); // the detach ends what ran from F:
      return { action: a, ok: true, at: new Date(w.now).toISOString(), detail: 'grew F: from 80 to 112 GB' };
    },
  };
  const g = new MachineGuard({ ...SETTINGS, hostDiskPaths: ['C:/', 'D:/'], devDriveVhdx: 'D:/work/ffw/devdrive.vhdx', devDriveMaxGB: 80 }, String.raw`F:\ffsb`, fx2, ports);

  // A job runs on ffu-1 (F:): it waits and names it; the busy runner on C: does not hold it.
  await g.tick();
  await g.tick();
  assert.equal(w.log.filter((l) => l === 'helper grow').length, 0);
  assert.equal(w.reports.filter((r) => r === 'Dev Drive: grow pending').length, 1);
  assert.ok(said.some((l) => /once no CI job runs on a runner on the drive; 1 runner\(s\) \(ffu-1\)/.test(l)), said.join('\n'));

  // The job ends: it grows, then starts both F: listeners again, says which one could not be, and leaves C:'s alone.
  runners[0].busy = false;
  await g.tick();
  assert.equal(w.log.filter((l) => l === 'helper grow').length, 1);
  assert.deepEqual(restarted, ['F:/ffsb/ffu-runners/ffu-1', 'f:/ffsb/ffu-runners/ffu-2']);
  assert.ok(w.reports.includes('Dev Drive: CI runners still down'));
  assert.ok(said.some((l) => /ffu-1: started again \(scheduled task ffu-1\); ffu-2: could not start it again \(no scheduled task/.test(l)), said.join('\n'));

  // A listener that came back by itself is not started twice.
  restarted.length = 0;
  state = { letter: 'F', maxGB: 112, wantGB: 120 };
  runners = [{ root: 'F:/ffsb/ffu-runners/ffu-1', busy: false }];
  fx2.runHelper = async (a) => ({ action: a, ok: true, at: new Date(w.now).toISOString(), detail: 'grew' });
  await g.tick();
  assert.deepEqual(restarted, []);
});

test('w3721: the runner restart script starts the scheduled task naming the runner folder, else its run.cmd, and refuses a path it cannot quote', () => {
  const s = runnerRestartScript('V:/ffw/ffu-runners/ffu-lothdesktop-1');
  assert.match(s, /^\$root = 'V:\\ffw\\ffu-runners\\ffu-lothdesktop-1'$/m);
  assert.ok(s.includes(String.raw`$re = [regex]::Escape($root) + '(?![\w.-])'`), 'ffu-lothdesktop-1 must not match ffu-lothdesktop-10');
  assert.match(s, /Start-ScheduledTask -InputObject \$t/);
  assert.match(s, /Start-Process -FilePath \(Join-Path \$root 'run\.cmd'\)/);
  assert.throws(() => runnerRestartScript("V:/x'; Write-Host hi"), /not a runner folder/);
  assert.throws(() => runnerRestartScript('/home/x/runner'), /not a runner folder/);
});

test("w3328: below the critical line a disk clean-up request's worker starts on the machine while an ordinary worker is still refused; under the 3 GB floor it waits too", async () => {
  // lothdesktop, 2026-11-07 05:11 UTC: V:\ffw\sandboxes 17 GB free under its pool's critical 20 (warn 25), and w3327's
  // clean-up worker 6f0fee97 was refused with "disk space is critically low ... new agent processes wait until space is freed".
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w3328-'));
  try {
    let freeV = 17 * GB;
    const { fx, ports } = world();
    const guard = new MachineGuard({ ...SETTINGS, warnFreeGB: 50, criticalFreeGB: 20, hostDiskPaths: ['D:/'] }, String.raw`V:\ffw\sandboxes`, { ...fx, exists: () => true, statfs: async (p) => ({ free: p.startsWith('V') ? freeV : 199 * GB, total: 1000 * GB }) }, { ...ports, poolFloor: () => ({ warnGB: 25, criticalGB: 20 }) });
    await guard.tick();
    assert.equal(guard.health.level, 'critical');

    const sbPath = path.join(tmp, 'slot3');
    const d = new Daemon({ portalUrl: 'http://127.0.0.1:1', id: 'lothdesktop', token: 't', repoPath: tmp, appDir: tmp, maxEventsFile: null }, () => ({}) as unknown as SessionHandle, PROBES) as unknown as {
      guard?: MachineGuard;
      pool: { list(): unknown[] };
      startRefusal(spec: object, id: string): string | undefined;
      shutdown(): void;
    };
    d.guard = guard;
    d.pool.list = () => [{ id: 'slot3', status: 'ready', path: sbPath }];
    const ordinary = { cwd: sbPath, sandbox: 'slot3' };
    const cleanup = { ...ordinary, diskCleanup: true };

    assert.match(d.startRefusal(ordinary, 's-ordinary') ?? '', /disk space is critically low \(V:.ffw.sandboxes 17 GB free\); new agent processes wait/, 'an ordinary worker: refused as before');
    assert.equal(d.startRefusal(cleanup, 's-cleanup'), undefined, 'the clean-up worker starts');
    assert.match(guard.blockReason('editor', { diskCleanup: true }) ?? '', /new editors wait/, 'the flag never starts an editor');

    // At the warn level too, and under the floor even the clean-up worker waits.
    freeV = 27 * GB; // above critical + DISK_RESUME_MARGIN_GB (25), under warn + it (30): the sandbox volume lifts at the gate's margin (w5167)
    await guard.tick();
    assert.match(d.startRefusal(ordinary, 's-ordinary') ?? '', /disk space is low/);
    assert.equal(d.startRefusal(cleanup, 's-cleanup'), undefined);
    freeV = 2.5 * GB;
    await guard.tick();
    assert.match(d.startRefusal(cleanup, 's-cleanup') ?? '', /below the clean-up floor \(V:.ffw.sandboxes 3 GB free; a clean-up worker starts down to 3 GB free\)/);
    freeV = 3.2 * GB;
    await guard.tick();
    assert.equal(d.startRefusal(cleanup, 's-cleanup'), undefined, 'just above the floor: it starts');
    d.shutdown();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** w5906: a pending grow on a Dev Drive machine with nothing else in the way; `stopped` lists the hosts the guard stopped. */
function idleGrowWorld(sessions: Partial<SessionInfo>[], o: { holds?: Record<string, string>; ends?: boolean } = {}) {
  const { w, fx, ports: base } = world();
  w.sandboxes = [];
  w.sessions = sessions as SessionInfo[];
  const said: string[] = [];
  const logged: string[] = [];
  const stopped: string[] = [];
  const ports: MachineGuardPorts = {
    ...base,
    report: (title, text) => (w.reports.push(title), void said.push(text)),
    log: (line) => void logged.push(line),
    idleHold: (id) => o.holds?.[id],
    stopIdle: async (id) => {
      stopped.push(id);
      if (o.ends === false) return false;
      const s = w.sessions.find((x) => x.id === id);
      if (s) s.status = 'stopped';
      return true;
    },
  };
  let state: Record<string, unknown> = { letter: 'V', maxGB: 320, wantGB: 360 };
  const fx2: MachineGuardEffects = {
    ...fx,
    exists: () => true,
    readJson: () => state,
    runHelper: async (a) => {
      w.log.push(`helper ${a}`);
      state = { letter: 'V', maxGB: 360 };
      return { action: a, ok: true, at: new Date(w.now).toISOString(), detail: 'grew V: from 320 to 360 GB' };
    },
  };
  const g = new MachineGuard({ ...SETTINGS, hostDiskPaths: ['D:/'], devDriveVhdx: 'D:/ffw/devdrive.vhdx', devDriveMaxGB: 320 }, String.raw`F:\ffw\sandboxes`, fx2, ports);
  const grows = () => w.log.filter((l) => l === 'helper grow').length;
  return { w, g, said, logged, stopped, grows };
}

test('w5906: an idle agent between turns with no check-in does not hold a pending grow: its host is stopped and the grow runs in that one look', async () => {
  // lothdesktop, 2026-11-26 04:58:37Z: 2c75765f (w5475) ended its turn in slot2 with no check-in; its host (pid 4744) idled
  // and the grow waited until the ops worker stopped it by hand at 05:00:14Z. Before that, w5814's own worker 74e5a46e.
  const { w, g, stopped, grows, logged } = idleGrowWorld([{ id: '2c75765f-aaaa', kind: 'worker', status: 'idle', sandboxId: 'slot2' }]);
  await g.tick();
  assert.deepEqual(stopped, ['2c75765f-aaaa'], 'stopped through the daemon\'s stop op');
  assert.equal(grows(), 1, 'and grown within the same guard tick');
  assert.ok(logged.some((l) => /stopping 1 idle agent\(s\) \(2c75765f in slot2\) for the Dev Drive grow/.test(l)), logged.join('\n'));
  assert.ok(w.reports.includes('Dev Drive: grown'));
});

test('w5906: an agent mid-turn, waiting on a permission, mid-tool or with a pending check-in holds the grow, and no idle agent is stopped meanwhile', async () => {
  for (const [s, why] of [
    [{ id: 'a1', kind: 'worker', status: 'running', sandboxId: 'slot1' }, /slot1: running/],
    [{ id: 'a1', kind: 'worker', status: 'waiting_permission', sandboxId: 'slot1' }, /slot1: waiting_permission/],
    [{ id: 'a1', kind: 'worker', status: 'idle', sandboxId: 'slot1', activeTool: { id: 't', name: 'Bash', since: '2026-10-05T21:59:00Z' } }, /slot1: mid-tool, Bash/],
    [{ id: 'a1', kind: 'worker', status: 'idle', sandboxId: 'slot1' }, /slot1: a check-in at 2026-10-05T22:20:00/],
  ] as [Partial<SessionInfo>, RegExp][]) {
    const { g, said, stopped, grows } = idleGrowWorld([s, { id: 'a2', kind: 'worker', status: 'idle', sandboxId: 'slot2' }], { holds: { a1: 'a check-in at 2026-10-05T22:20:00.000Z' } });
    await g.tick();
    await g.tick();
    assert.equal(grows(), 0, `${s.status} holds it`);
    assert.deepEqual(stopped, [], 'the idle one in slot2 is left alone while something else holds the grow');
    assert.match(said.join('\n'), why);
    assert.doesNotMatch(said.join('\n'), /slot2/, 'and is not named as a blocker');
  }
});

test('w5906: an idle agent stopped for the grow whose host has not ended yet holds it until the next look', async () => {
  const k = idleGrowWorld([{ id: 'a2', kind: 'worker', status: 'idle', sandboxId: 'slot4' }], { ends: false });
  await k.g.tick();
  assert.equal(k.grows(), 0);
  assert.match(k.said.join('\n'), /once the idle agent\(s\) it stopped have ended; 1 \(slot4\) still up/);
  k.w.sessions[0].status = 'stopped';
  await k.g.tick();
  assert.equal(k.grows(), 1);
});

test('w5906: the "grow pending" reason is said again when its blockers change (logged at most every 2 min, reported every 15), never left naming agents gone long ago', async () => {
  const { w, g, said, logged, grows } = idleGrowWorld([
    { id: 'a1', kind: 'worker', status: 'running', sandboxId: 'slot2' },
    { id: 'a5', kind: 'worker', status: 'running', sandboxId: 'slot5' },
  ]);
  const pending = () => logged.filter((l) => /grows from 320 to 360 GB once/.test(l));
  await g.tick();
  assert.equal(pending().length, 1);
  assert.match(pending()[0], /2 agent\(s\) \(slot2: running, slot5: running\)/);
  // The same blockers: said once.
  w.now += 5 * MIN;
  await g.tick();
  assert.equal(pending().length, 1);
  // slot2 ends its turn and leaves; slot5 still runs: within 2 min of the last line, nothing; after, the new reason.
  w.sessions = w.sessions.filter((s) => s.id !== 'a1');
  await g.tick();
  assert.equal(pending().length, 2, 'more than 2 min since the last line: said at once');
  assert.match(pending()[1], /1 agent\(s\) \(slot5: running\)/);
  w.sessions[0].status = 'waiting_permission';
  w.now += 30_000;
  await g.tick();
  assert.equal(pending().length, 2, 'rate-limited');
  w.now += 2 * MIN;
  await g.tick();
  assert.equal(pending().length, 3);
  assert.match(pending()[2], /slot5: waiting_permission/);
  // The portal's report follows at most every 15 min, with the latest reason.
  assert.equal(said.length, 1);
  w.now += 15 * MIN;
  await g.tick();
  assert.equal(said.length, 2);
  assert.match(said[1], /slot5: waiting_permission/);
  // It ends its turn with no check-in: stopped and grown.
  w.sessions[0].status = 'idle';
  await g.tick();
  assert.equal(grows(), 1);
});

test("w5906: the daemon's own ports: an idle agent with a pending check-in or a timed run holds its sandbox; any other is stopped through its stop op", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mguard-idle-'));
  const drive = path.join(tmp, 'V');
  fs.mkdirSync(drive);
  const { fx } = world();
  const sandboxes = { root: drive, maxSandboxes: 5, maxAgentsPerSandbox: 6, maxUnity: 2, diskWarnGB: 80, diskCriticalGB: 40 };
  const d = new Daemon({ portalUrl: 'http://127.0.0.1:9', id: 'lothdesktop', token: 'x', repoPath: tmp, appDir: tmp, claude: 'no-such-claude', maxSessions: 3, maxEventsFile: null, sandboxes, hostGuard: SETTINGS }, () => ({}) as unknown as SessionHandle, PROBES, undefined, { ...fx, exists: (p) => fs.existsSync(p) });
  t.after(() => {
    d.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const inner = d as unknown as { startGuard(): void; entries: Map<string, unknown>; wakes: Map<string, number>; timed?: { active(): string[] } };
  const host = (id: string) => {
    const s = { info: { id, kind: 'worker', status: 'idle' }, live: true, stops: 0, stop: () => (s.stops++, setTimeout(() => (s.live = false), 50)) };
    inner.entries.set(id, { s, spec: { sandbox: id } });
    return s;
  };
  const free = host('slot2');
  const checkIn = host('slot4');
  host('slot5');
  inner.wakes = new Map([['slot4', Date.parse('2026-11-26T05:30:00Z')]]);
  inner.timed = { active: () => ['slot5'] };
  inner.startGuard();
  const ports = (d.guard as unknown as { ports: MachineGuardPorts }).ports;
  assert.equal(ports.idleHold!('slot2'), undefined);
  assert.equal(ports.idleHold!('slot4'), 'a check-in at 2026-11-26T05:30:00.000Z');
  assert.equal(ports.idleHold!('slot5'), 'a timed run');
  assert.equal(await ports.stopIdle!('slot2'), true, 'its host ended');
  assert.equal(free.stops, 1);
  assert.equal(checkIn.stops, 0);
  assert.equal(await ports.stopIdle!('slot2'), true, 'one already gone is not stopped again');
  assert.equal(free.stops, 1);
});
