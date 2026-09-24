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
function harness(over: Partial<{ helper: (n: number) => HelperResult }> = {}) {
  const world = {
    now: Date.parse('2026-09-24T13:00:00Z'),
    driveThere: true,
    freeC: 200 * GB,
    sandboxes: [sb('blackhole', 'running'), sb('agent-mcp', 'running'), sb('idle', 'stopped')],
    sessions: [sess('w1', 'blackhole', 'running'), sess('w2', 'agent-mcp', 'idle'), { ...sess('orch', undefined, 'running'), kind: 'orchestrator' } as SessionInfo],
  };
  const log: string[] = [];
  let helperCalls = 0;
  const cfg = {
    sandboxRoot: 'F:\\ffsb',
    hostDiskPaths: ['C:\\'],
    limits: { minFreeRamGB: 10 },
    unity: { idleStopMinutes: 0 },
    hostGuard: { pollSeconds: 30, warnFreeGB: 80, criticalFreeGB: 40, hysteresisGB: 10, remountMinFreeGB: 30, devDriveVhdx: '', compactWhenReclaimGB: 0, cleanup: {} },
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
    cleanup: async () => (log.push('cleanup'), { removed: 3 }),
    changed: () => undefined,
    now: () => world.now,
  };
  return { world, log, m: new HostHealthMonitor(deps) };
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

test('sandbox drive lost with the host volume nearly full: clean up and wait before remounting', async () => {
  const { world, log, m } = harness();
  await m.tick();
  world.driveThere = false;
  world.freeC = 10 * GB;
  await m.tick();
  assert.ok(log.includes('cleanup'));
  assert.ok(!log.includes('helper mount'), log.join('\n'));
  assert.match(m.status.detail ?? '', /waiting for 30 GB free/);
  world.freeC = 60 * GB;
  world.now += 5 * 60_000 + 1;
  await m.tick();
  assert.ok(log.includes('helper mount'));
  assert.equal(m.status.sandboxRoot, 'ok');
});

test('disk critical: busy agents asked to checkpoint once, idle editors stopped, junk cleaned', async () => {
  const { world, log, m } = harness();
  world.freeC = 30 * GB;
  await m.tick();
  assert.equal(m.status.level, 'critical');
  assert.ok(log.includes('report Disk space critical'));
  assert.ok(log.includes('cleanup'));
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
