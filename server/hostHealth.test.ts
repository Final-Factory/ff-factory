import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostHealthMonitor, blockReason, diskLevel, idleEditors, remountDelayMs, type HostDeps } from './hostHealth.ts';
import type { Config } from './config.ts';
import type { HelperResult } from './privileged.ts';
import type { Sandbox, SessionInfo } from '../shared/types.ts';

const GB = 1024 ** 3;
const G = { warnFreeGB: 80, criticalFreeGB: 40, hysteresisGB: 10 };

test('disk levels: thresholds with hysteresis, unknown keeps the last level', () => {
  assert.equal(diskLevel(200, 'ok', G), 'ok');
  assert.equal(diskLevel(79, 'ok', G), 'warn');
  assert.equal(diskLevel(39, 'warn', G), 'critical');
  assert.equal(diskLevel(45, 'critical', G), 'critical'); // not 10 GB above the threshold yet
  assert.equal(diskLevel(51, 'critical', G), 'warn');
  assert.equal(diskLevel(85, 'warn', G), 'warn');
  assert.equal(diskLevel(91, 'warn', G), 'ok');
  assert.equal(diskLevel(undefined, 'warn', G), 'warn');
});

test('gates: offline drive and low disk refuse all new work; low RAM refuses editors only', () => {
  const ok = { sandboxRoot: 'ok' as const, level: 'ok' as const, disks: [] };
  const mem = { freeGB: 30, minFreeRamGB: 10 };
  assert.equal(blockReason(ok, 'editor', mem), undefined);
  assert.match(blockReason({ ...ok, sandboxRoot: 'missing' }, 'agent', mem) ?? '', /sandbox drive is offline/);
  assert.match(blockReason({ ...ok, level: 'warn', disks: [{ path: 'C:\\', freeBytes: 70 * GB, level: 'warn' }] }, 'agent', mem) ?? '', /low \(C:\\ 70 GB free\)/);
  assert.match(blockReason(ok, 'editor', { freeGB: 6, minFreeRamGB: 10 }) ?? '', /only 6.0 GB of RAM/);
  assert.equal(blockReason(ok, 'agent', { freeGB: 6, minFreeRamGB: 10 }), undefined);
});

const sb = (id: string, state: string, startedAt = '2026-09-24T10:00:00Z') => ({ id, unity: { state, startedAt } }) as unknown as Sandbox;
const sess = (id: string, sandboxId: string | undefined, status: string, lastActivityAt = '2026-09-24T10:00:00Z') =>
  ({ id, sandboxId, status, lastActivityAt, kind: 'worker' }) as unknown as SessionInfo;

test('idle editors: stopped only when nobody in the sandbox is busy and nothing happened for N minutes', () => {
  const now = Date.parse('2026-09-24T12:30:00Z');
  const sbs = [sb('a', 'running'), sb('b', 'running'), sb('c', 'running', '2026-09-24T12:00:00Z'), sb('d', 'stopped')];
  const ss = [sess('s1', 'b', 'running'), sess('s2', 'a', 'idle', '2026-09-24T10:30:00Z')];
  assert.deepEqual(idleEditors(sbs, ss, now, 90), ['a']);
  assert.deepEqual(idleEditors(sbs, ss, now, 0), []);
  assert.equal(remountDelayMs(1), 0);
  assert.equal(remountDelayMs(3), 5 * 60_000);
});

/** A monitor over fake effects; `world` is what it sees. */
function harness(over: Partial<{ helper: (n: number) => HelperResult; driveThere: boolean; cfg: Partial<Config> }> = {}) {
  const world = {
    now: Date.parse('2026-09-24T13:00:00Z'),
    driveThere: over.driveThere ?? true,
    freeC: 200 * GB,
    sandboxes: [sb('blackhole', 'running'), sb('agent-mcp', 'running'), sb('idle', 'stopped')],
    sessions: [sess('w1', 'blackhole', 'running'), sess('w2', 'agent-mcp', 'idle'), { ...sess('orch', undefined, 'running'), kind: 'orchestrator' } as SessionInfo],
  };
  const log: string[] = [];
  /** Each clean-up pass: "low" (below the soft threshold, or asked/critical) or "regular". */
  const cleaned: string[] = [];
  let helperCalls = 0;
  const cfg = {
    sandboxRoot: 'F:\\ffsb',
    hostDiskPaths: ['C:\\'],
    limits: { minFreeRamGB: 10 },
    unity: { idleStopMinutes: 0 },
    hostGuard: { pollSeconds: 30, warnFreeGB: 80, criticalFreeGB: 40, hysteresisGB: 10, remountMinFreeGB: 30, devDriveVhdx: '', compactWhenReclaimGB: 0, cleanup: { everyMinutes: 60, softFreeGB: 0 } },
    ...over.cfg,
  } as unknown as Config;
  const deps: HostDeps = {
    cfg,
    statfs: async (p) => (p.startsWith('C') ? { free: world.freeC, total: 1800 * GB } : { free: 700 * GB, total: 900 * GB }),
    exists: (p) => (p.startsWith('F') ? world.driveThere : true),
    mem: () => ({ free: 30 * GB, total: 64 * GB }),
    sandboxes: () => world.sandboxes,
    sessions: () => world.sessions,
    startEditor: async (id) => void log.push(`start ${id}`),
    stopEditor: async (id) => void log.push(`stop ${id}`),
    interrupt: async (id) => void log.push(`interrupt ${id}`),
    tell: (id, text) => void log.push(`tell ${id}: ${text.slice(0, 40)}`),
    report: (title) => void log.push(`report ${title}`),
    runHelper: async (a) => {
      helperCalls++;
      log.push(`helper ${a}`);
      const r = over.helper?.(helperCalls) ?? { action: a, ok: true, at: '', detail: 'attached' };
      if (r.ok) world.driveThere = true;
      return r;
    },
    cleanup: {
      pass: async (low) => (cleaned.push(low ? 'low' : 'regular'), { removed: [{ path: 'C:/Temp/x', bytes: 3 * GB, rule: 'temp-old' }], failed: [], bytes: 3 * GB }),
      consumers: async () => [{ path: 'C:/Users/me/big', bytes: 500 * GB }],
      log: () => undefined,
      diskPaths: () => ['C:\\'],
    },
    changed: () => undefined,
    now: () => world.now,
  };
  return { world, log, cleaned, m: new HostHealthMonitor(deps) };
}

test('sandbox drive lost: turns stopped, remounted by the helper (retrying), editors restarted, agents resumed', async () => {
  const { world, log, m } = harness({ helper: (n) => ({ action: 'mount', ok: n > 1, at: '', detail: n > 1 ? 'attached' : 'Access denied' }) });
  await m.tick(); // all well: remembers the running editors and the busy worker
  assert.equal(m.blockReason('agent'), undefined);
  world.driveThere = false;
  world.sandboxes = world.sandboxes.map((s) => ({ ...s, unity: { ...s.unity, state: 'crashed' } }));
  await m.tick();
  assert.deepEqual(log.slice(0, 3), ['interrupt w1', 'report Sandbox drive is gone', 'helper mount']);
  assert.ok(!log.includes('interrupt orch') && !log.includes('interrupt w2'), 'only agents mid-turn in sandboxes');
  assert.equal(m.status.sandboxRoot, 'missing');
  assert.match(m.status.detail ?? '', /attempt 1 failed \(Access denied\); next in 2 min/);
  assert.match(m.blockReason('agent') ?? '', /sandbox drive is offline/);
  await m.tick(); // too early for the second attempt
  assert.equal(log.filter((l) => l === 'helper mount').length, 1);
  world.now += 2 * 60_000;
  await m.tick(); // second attempt succeeds
  assert.equal(m.status.sandboxRoot, 'ok');
  assert.ok(log.includes('report Sandbox drive is back'));
  // Both editors that were up come back, one at a time, then the interrupted worker is resumed.
  const after = log.slice(log.indexOf('report Sandbox drive is back') + 1);
  assert.deepEqual(after.slice(0, 2), ['start blackhole', 'start agent-mcp']);
  assert.match(after[2], /^tell w1: The sandbox drive went offline/);
});

test('boot without the sandbox drive: nothing starts on it before the guard has seen it back', async () => {
  const { log, m } = harness({ driveThere: false });
  // Before the first look (5 s after start): the old guard said "ok" here and let agents start on a missing F:.
  assert.equal(m.status.sandboxRoot, 'missing');
  assert.match(m.blockReason('agent') ?? '', /sandbox drive is offline/);
  assert.match(m.blockReason('editor') ?? '', /sandbox drive is offline/);
  await m.tick();
  assert.deepEqual(log.slice(0, 3), ['report Sandbox drive not attached at startup', 'helper mount', 'report Sandbox drive is back']);
  assert.ok(!log.some((l) => l.startsWith('interrupt')), 'nothing was running on it to stop');
  assert.equal(m.blockReason('agent'), undefined);
});

test('between two looks, a drive that went away blocks new work at once', async () => {
  const { world, m } = harness();
  await m.tick();
  assert.equal(m.blockReason('agent'), undefined);
  world.driveThere = false;
  assert.match(m.blockReason('agent') ?? '', /sandbox drive is offline/);
});

/** Let the passes the guard started without waiting (the clean-up) finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test('sandbox drive lost with the host volume nearly full: clean up and wait before remounting', async () => {
  const { world, log, cleaned, m } = harness();
  await m.tick();
  await settle();
  cleaned.length = 0;
  world.driveThere = false;
  world.freeC = 10 * GB;
  await m.tick();
  await settle();
  assert.deepEqual(cleaned, ['low']);
  assert.ok(!log.includes('helper mount'), log.join('\n'));
  assert.match(m.status.detail ?? '', /waiting for 30 GB free/);
  world.freeC = 60 * GB;
  world.now += 5 * 60_000 + 1;
  await m.tick();
  assert.ok(log.includes('helper mount'));
  assert.equal(m.status.sandboxRoot, 'ok');
});

test('disk critical: busy agents asked to checkpoint once, idle editors stopped, junk cleaned', async () => {
  const { world, log, cleaned, m } = harness();
  world.freeC = 30 * GB;
  await m.tick();
  await settle();
  assert.equal(m.status.level, 'critical');
  assert.ok(log.includes('report Disk space critical'));
  assert.ok(cleaned.includes('low'));
  assert.ok(log.some((l) => l.startsWith('tell w1: [disk critical]')));
  assert.ok(!log.some((l) => l.startsWith('tell orch')), 'the orchestrator is not told to stop');
  assert.ok(log.includes('stop agent-mcp') && !log.includes('stop blackhole'), 'only the editor nobody is working in');
  const told = log.filter((l) => l.startsWith('tell w1')).length;
  await m.tick();
  assert.equal(log.filter((l) => l.startsWith('tell w1')).length, told, 'asked once per episode');
  world.freeC = 95 * GB;
  await m.tick();
  assert.equal(m.status.level, 'ok');
  assert.ok(log.includes('report Disk space is fine again'));
});

test('recovery self-test: detach through the helper, the guard notices and reattaches, sandboxes are back', async () => {
  const { world, log, m } = harness();
  world.sandboxes = world.sandboxes.map((s) => ({ ...s, status: 'ready', path: `F:\ffsb\${s.id}`, unity: { ...s.unity, state: 'stopped' } })) as Sandbox[];
  world.sessions = [];
  await m.tick();
  // The fake helper: "detach" makes F: vanish; "mount" brings it back.
  const deps = (m as unknown as { d: HostDeps }).d;
  deps.runHelper = async (a) => {
    log.push(`helper ${a}`);
    world.now += 3000;
    world.driveThere = a !== 'detach';
    return { action: a, ok: true, at: '', detail: a };
  };
  const sleep = async (ms: number) => void (world.now += ms);
  const out = await m.selftest({ pollMs: 1000, sleep });
  assert.match(out, /^Self-test passed: detach helper: 3\.0 s \(detach\); F:\\ffsb gone after 3\.0 s; noticed by the guard after 0\.0 s; reattached by ffsb-helper-mount 3\.0 s later \(1 attempt\(s\)\); all 3 sandbox folder\(s\) back; total 6\.0 s\.$/);
  assert.deepEqual(log.filter((l) => l.startsWith('helper')), ['helper detach', 'helper mount']);
  assert.equal(m.status.sandboxRoot, 'ok');
  // Refused while an editor is up or an agent is busy in a sandbox.
  world.sandboxes = [{ ...world.sandboxes[0], unity: { state: 'running' } } as Sandbox];
  await assert.rejects(m.selftest({ sleep }), /editors are up/);
  world.sandboxes = [];
  world.sessions = [sess('w9', 'blackhole', 'running')];
  await assert.rejects(m.selftest({ sleep }), /mid-turn/);
  // Compacting takes the drive away too: refused the same way, and the helper is never started.
  log.length = 0;
  const r = await m.compact('asked for');
  assert.equal(r.ok, false);
  assert.match(r.detail, /^refused: agents on this host are mid-turn \(w9\)/);
  world.sessions = [];
  world.sandboxes = [{ ...world.sandboxes[0], unity: { state: 'starting' } } as Sandbox];
  assert.match((await m.compact('asked for')).detail, /^refused: editors are up/);
  assert.deepEqual(log.filter((l) => l.startsWith('helper')), []);
});

test('continuous clean-up: a regular pass each hour, sooner below the soft threshold, a notice only when it cannot get above', async () => {
  const { world, log, cleaned, m } = harness();
  await m.tick();
  await settle();
  assert.deepEqual(cleaned, ['regular'], 'the first look runs a pass');
  assert.equal(m.status.lastCleanup?.trigger, 'hourly');
  assert.equal(m.status.lastCleanup?.freedBytes, 3 * GB);
  assert.equal(m.status.lastCleanup?.softFreeGB, 120, 'default soft threshold: warnFreeGB + 40');
  assert.ok(!log.some((l) => l.startsWith('report Clean-up')), 'a pass that is fine says nothing');
  world.now += 30 * 60_000;
  await m.tick();
  await settle();
  assert.equal(cleaned.length, 1, 'not due yet');
  world.now += 31 * 60_000;
  await m.tick();
  await settle();
  assert.deepEqual(cleaned, ['regular', 'regular']);
  // Below the soft threshold (120 GB) but above the warn level: a pass every 15 minutes, with the low rules.
  world.freeC = 100 * GB;
  world.now += 15 * 60_000;
  await m.tick();
  await settle();
  assert.deepEqual(cleaned.slice(2), ['low']);
  assert.equal(m.status.lastCleanup?.trigger, 'low-space');
  assert.equal(m.status.lastCleanup?.belowSoft, true);
  assert.deepEqual(m.status.lastCleanup?.consumers, [{ path: 'C:/Users/me/big', bytes: 500 * GB }]);
  assert.equal(log.filter((l) => l === 'report Clean-up cannot free enough disk space').length, 1);
  assert.equal(m.blockReason('agent'), undefined, 'still above the hard block');
  world.now += 15 * 60_000;
  await m.tick();
  await settle();
  assert.equal(cleaned.length, 4);
  assert.equal(log.filter((l) => l === 'report Clean-up cannot free enough disk space').length, 1, 'the notice is not repeated every pass');
  world.now += 5 * 60_000;
  await m.tick();
  await settle();
  assert.equal(cleaned.length, 4, 'at most every 15 minutes while low');
  assert.match(await m.cleanupNow(), /\(asked, with stale output\): 1 item\(s\), 3\.0 GB, 100\.0 GB free \(below the soft 120 GB\)\.\nRemoved \(biggest first\):\n- C:\/Temp\/x  3\.0 GB  \(temp-old\)\nStill below the soft threshold of 120 GB/);
});

test('portal-only (w464): no sandbox drive is watched or reattached, nothing blocks on it, and the data volume is measured', async () => {
  // The VM has no F: drive; the data folder is on its own volume (here "D:").
  const { world, log, m } = harness({ driveThere: false, cfg: { hostSandboxes: false, dataDir: 'D:\\fff\\data' } as Partial<Config> });
  assert.equal(m.status.sandboxRoot, 'ok', 'not "missing" at start');
  assert.equal(m.blockReason('agent'), undefined);
  await m.tick();
  assert.equal(m.status.sandboxRoot, 'ok');
  assert.deepEqual(m.status.disks.map((d) => d.path), ['D:\\fff\\data', 'C:\\']);
  assert.ok(!log.some((l) => l.startsWith('helper') || l.startsWith('report Sandbox drive')), log.join('; '));
  assert.equal(m.blockReason('agent'), undefined);
  // The data volume filling up still blocks, like any watched disk.
  world.freeC = 10 * GB;
  await m.tick();
  assert.match(m.blockReason('agent') ?? '', /C:/);
});
