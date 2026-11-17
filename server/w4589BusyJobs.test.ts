import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEFTOVER, LeftoverReaper, readEnvs, sessionVerdict, type LeftoverDeps, type ProcEnv } from '../machine/leftovers.ts';
import type { Proc, UnityPlatform } from '../machine/unity.ts';
import { inspectProcs, type ProcFacts } from '../machine/unityReaper.ts';

/**
 * w4589: a worker's own live background jobs count as activity. On biscuit, 2026-11-17, w4568's worker 202bc503 (slot1)
 * was stopped by the portal as "idle for 61 min" between turns while its scenario batches ran; its sandbox was released
 * and the leftover sweep ended the batches; 58 scenarios were lost and the set restarted on lothdesktop/slot5.
 *
 * The sweep half runs real child processes (fixture scripts, never a real worker's process): one spins the CPU as a
 * scenario batch does, one hangs idle. Their environments are read by this platform's real reader and their CPU by its
 * real inspector. The sweep's clock runs 60 times real time (a look a "minute" apart is a real second apart), so their CPU
 * time is scaled by 60 to match. The only processes it can signal are those children.
 */

const MIN = 60_000;
const WORKER = '202bc503';
const MACHINE = 'biscuit';
const SPEED = 60;

const SPIN = `setInterval(() => { const end = Date.now() + 80; while (Date.now() < end); }, 100);`;
const HANG = `setInterval(() => {}, 1000);`;

async function scenario(o: { requestOpen: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4589-'));
  const env = { ...process.env, FF_SESSION_ID: WORKER, FF_MACHINE_ID: MACHINE, FF_WORKER_ROOT: dir, FF_SANDBOX_ID: 'slot1' };
  const start = (name: string, body: string): ChildProcess => {
    const f = path.join(dir, `${name}.cjs`);
    fs.writeFileSync(f, body);
    return spawn(process.execPath, [f], { env, stdio: 'ignore' });
  };
  const batch = start('scenario_batch', SPIN);
  const hung = start('hung_wait', HANG);
  const kids = [batch, hung];
  const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
  const platform = process.platform as UnityPlatform;
  let now = 1_000 * 60 * MIN;
  const events: string[] = [];
  const deps: LeftoverDeps = {
    platform,
    machineId: MACHINE,
    root: dir,
    procs: async () => kids.filter(alive).map((c) => ({ pid: c.pid!, ppid: process.pid, cmd: `${process.execPath} ${c.spawnargs[1]}` })),
    envOf: (pids) => readEnvs(platform, pids.filter((p) => kids.some((c) => c.pid === p))),
    inspect: async (pids) => (await inspectProcs(platform, pids.filter((p) => kids.some((c) => c.pid === p)))).map((f): ProcFacts => ({ pid: f.pid, startedAt: now - 70 * MIN, ...(f.cpuMs !== undefined ? { cpuMs: f.cpuMs * SPEED } : {}) })),
    sessionLive: () => false,
    sessionKnown: () => true,
    resumable: () => o.requestOpen,
    wakeAt: () => undefined,
    liveSandboxes: () => new Set(),
    ready: () => true,
    slotRoots: () => [],
    tempRoot: () => path.join(dir, 'tmp'),
    leases: () => [],
    protectedPaths: () => [],
    places: () => [],
    self: () => [process.pid],
    host: os.hostname(),
    kill: (p, sig) => {
      if (!kids.some((c) => c.pid === p)) throw new Error(`the sweep tried to signal pid ${p}, not a fixture's`);
      try {
        process.kill(p, sig);
      } catch {
        // already gone
      }
    },
    exists: (p) => fs.existsSync(p),
    remove: () => undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 200))),
    now: () => now,
    log: () => undefined,
    onEvent: (t) => void events.push(t),
  };
  const reaper = new LeftoverReaper(deps);
  // Past their start-up CPU before the first look, then a look each real second.
  await new Promise((r) => setTimeout(r, 1500));
  const look = async () => {
    await new Promise((r) => setTimeout(r, 1000));
    now += MIN;
    return reaper.look();
  };
  const done = () => {
    for (const c of kids) if (alive(c)) c.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { batch, hung, alive, look, events, reaper, done };
}

test('biscuit, 2026-11-17: a stopped worker\'s CPU-busy scenario batch outlives the sweep while its request is open, and is reported busy; its hung, idle process still ends', async () => {
  const s = await scenario({ requestOpen: true });
  try {
    // 13 looks a minute apart: past the 10 min a waited-for worker's leftovers are kept.
    for (let i = 0; i < 13; i++) await s.look();
    assert.ok(s.alive(s.batch), 'the busy batch still runs');
    assert.ok(!s.alive(s.hung) || (await new Promise((r) => setTimeout(r, 500)), !s.alive(s.hung)), 'the hung, idle one was ended');
    assert.equal(s.events.length, 1, s.events.join('\n'));
    assert.match(s.events[0], new RegExp(`ended 1 process\\(es\\) left by worker ${WORKER}.*pid ${s.hung.pid}.*a request still waits for it, with no check-in pending`));
    assert.doesNotMatch(s.events[0], new RegExp(`pid ${s.batch.pid}`));
    const busy = s.reaper.report().busyJobs;
    assert.equal(busy.length, 1);
    assert.equal(busy[0].session, WORKER);
    assert.deepEqual(busy[0].pids, [s.batch.pid]);
    assert.ok(busy[0].cpuSec >= LEFTOVER.BUSY_CPU_MS / 1000, String(busy[0].cpuSec));
  } finally {
    s.done();
  }
});

test('a busy job of a worker whose request is closed is no work any more: ended after the grace, as before', async () => {
  const s = await scenario({ requestOpen: false });
  try {
    let ended = 0;
    for (let i = 0; i < 4 && ended < 2; i++) ended += (await s.look()).reduce((n, e) => n + e.pids.length, 0);
    assert.equal(ended, 2, s.events.join('\n'));
    assert.match(s.events.join('\n'), /no request waits for it/);
  } finally {
    s.done();
  }
});

test('under a running claude, only what it ran through a shell is its job: never the claude process or an MCP server it runs', async () => {
  const procs: Proc[] = [
    { pid: 100, ppid: 1, cmd: '/Users/x/.local/bin/claude --output-format stream-json' },
    { pid: 101, ppid: 100, cmd: '/bin/zsh -c source snapshot.sh && eval python3 run_scenarios.py' },
    { pid: 102, ppid: 101, cmd: 'python3 run_scenarios.py --set lab' },
    { pid: 103, ppid: 102, cmd: '/x/slots/slot1-1/FinalFactory -batchmode' },
    { pid: 104, ppid: 100, cmd: '/opt/homebrew/bin/uv tool uvx mcp-for-unity' },
    { pid: 105, ppid: 104, cmd: 'python3 -m mcp_for_unity' },
    { pid: 106, ppid: 100, cmd: '/bin/zsh -c sleep 600' },
  ];
  let now = 0;
  const cpu: Record<number, number> = { 100: 0, 101: 0, 102: 0, 103: 0, 104: 0, 105: 0, 106: 0 };
  const deps = {
    platform: 'darwin',
    machineId: MACHINE,
    root: '/x',
    procs: async () => procs,
    envOf: async (pids: number[]) => new Map<number, ProcEnv>(pids.filter((p) => p === 100).map((p) => [p, { session: WORKER }])),
    inspect: async (pids: number[]) => pids.map((pid) => ({ pid, startedAt: 0, cpuMs: cpu[pid] })),
    sessionLive: () => true,
    sessionKnown: () => true,
    resumable: () => true,
    wakeAt: () => undefined,
    liveSandboxes: () => new Set<string>(),
    ready: () => true,
    slotRoots: () => [],
    tempRoot: () => '/x/tmp',
    leases: () => [],
    protectedPaths: () => [],
    places: () => [],
    self: () => [1],
    host: 'biscuit',
    kill: (p: number) => {
      throw new Error(`no kill expected: pid ${p}`);
    },
    exists: () => false,
    remove: () => undefined,
    sleep: async () => undefined,
    now: () => now,
    log: () => undefined,
    onEvent: () => undefined,
  } as unknown as LeftoverDeps;
  const reaper = new LeftoverReaper(deps);
  await reaper.look();
  assert.deepEqual(reaper.report().busyJobs, [], 'the first look only records the CPU');
  now += MIN;
  // claude and the MCP server busy too; the game player of the batch busy; the wait loop idle.
  Object.assign(cpu, { 100: 30_000, 103: 40_000, 104: 9_000, 105: 9_000, 106: 5 });
  await reaper.look();
  assert.deepEqual(reaper.report().busyJobs, [{ session: WORKER, pids: [103], cpuSec: 40, what: 'FinalFactory' }]);
  now += MIN;
  Object.assign(cpu, { 100: 31_000, 103: 40_100, 104: 9_100, 105: 9_100, 106: 10 });
  await reaper.look();
  assert.deepEqual(reaper.report().busyJobs, [], 'a job gone quiet (0.1 s a minute) is not at work');
});

test('sessionVerdict: a busy job keeps its leftovers only while a request waits, and never for a ticket holder', () => {
  const t0 = 1_000 * MIN;
  const late = t0 + 3 * 60 * MIN;
  const busy = '1 process(es), 41 s of CPU in the last minute: python3';
  const kept = sessionVerdict({ live: false, resumable: true, busy, stoppedSince: t0, now: late });
  assert.equal(kept.end, false);
  assert.match(kept.why, /a request still waits for it, and its own job is still at work \(1 process\(es\), 41 s of CPU in the last minute: python3\): kept while it works \(w4589\)/);
  assert.equal(sessionVerdict({ live: false, resumable: false, moved: ['w4568'], busy, stoppedSince: t0, now: late }).end, false, 'a moved request still waits');
  assert.equal(sessionVerdict({ live: false, resumable: false, busy, stoppedSince: t0, now: late }).end, true, 'no request waits');
  assert.equal(sessionVerdict({ live: false, resumable: true, busy, holdsTicket: true, stoppedSince: t0, now: late }).end, true, 'w3715: a ticket holder');
  assert.equal(sessionVerdict({ live: false, resumable: true, stoppedSince: t0, now: late }).end, true, 'idle: ends as before');
});
