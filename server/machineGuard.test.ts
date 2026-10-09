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
import { MachineGuard, machineGuardConfig, type MachineGuardEffects, type MachineGuardPorts } from '../machine/hostGuard.ts';
import { HostHealthMonitor, type HostDeps } from './hostHealth.ts';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle } from './sessions.ts';
import { MachineManager, convertMachineRecord, guardSettingsOf } from './machines.ts';
import { Daemon, type Probes } from '../machine/daemon.ts';
import type { DeployOptions } from './machineDeploy.ts';
import type { Config } from './config.ts';
import type { HelperResult } from './privileged.ts';
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
