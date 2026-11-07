import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuSampler, LOAD_GATES, LOTHDESKTOP_GATE, LoadGate, winSuspendScript, type LoadGateDeps, type LoadGateState } from '../machine/loadRunners.ts';
import type { Proc } from '../machine/unity.ts';

/**
 * w3305: LothDesktop's two ffu runners (V:/ffw/ffu-runners/ffu-lothdesktop-1 and -2) take ffu jobs only while the
 * machine is under about 70% CPU (Ben, 2026-11-06). These tests feed a process listing of that machine and a CPU series;
 * no real process is suspended.
 */

const R = 'V:/ffw/ffu-runners';
const L = (pid: number, name: string): Proc => ({ pid, ppid: 1, cmd: `"${R}\\${name}\\bin\\Runner.Listener.exe" run` });
const L1 = L(4101, 'ffu-lothdesktop-1');
const L2 = L(4102, 'ffu-lothdesktop-2');
const GAME = { pid: 4103, ppid: 1, cmd: `"V:/actions-runner\\bin\\Runner.Listener.exe" run` };
const JOB2: Proc[] = [{ pid: 4200, ppid: 4102, cmd: `"${R}\\ffu-lothdesktop-2\\bin\\Runner.Worker.exe" spawnclient 1 2` }];
const NOW = Date.parse('2026-11-07T01:00:00Z');
const IDLE_LOG = '[2026-11-07 00:00:00Z INFO Terminal] WRITE LINE: 2026-11-07 00:00:00Z: Job check completed with result: Succeeded\n';
const G = LOTHDESKTOP_GATE;

function harness(o: { state?: LoadGateState; settings?: LoadGateDeps['settings'] | null } = {}) {
  const s = {
    procs: [L1, L2, GAME] as Proc[],
    cpu: 0,
    now: NOW,
    calls: [] as string[],
    diag: {} as Record<string, string>,
    /** A log a root gets once its listener is suspended (a job line written as the suspend landed). */
    diagAfter: undefined as { pid: number; root: string; log: string } | undefined,
    written: [] as LoadGateState[],
    log: [] as string[],
  };
  const d: LoadGateDeps = {
    settings: o.settings === null ? undefined : (o.settings ?? G),
    procs: async () => s.procs,
    cpu: () => s.cpu,
    suspend: async (pid, resume) => {
      s.calls.push(`${resume ? 'resume' : 'suspend'} ${pid}`);
    },
    diag: (root) => {
      const name = root.split('/').pop()!;
      const a = s.diagAfter;
      if (a && a.root === name && s.calls.includes(`suspend ${a.pid}`)) s.diag[name] = a.log;
      return s.diag[name] ?? IDLE_LOG;
    },
    read: () => o.state,
    write: (st) => s.written.push(JSON.parse(JSON.stringify(st))),
    log: (t) => s.log.push(t),
    now: () => s.now,
  };
  const g = new LoadGate(d);
  /** Ticks every 5 s for `ms` at `cpu` percent. */
  const run = async (ms: number, cpu: number) => {
    for (let t = 0; t <= ms; t += 5_000) {
      s.cpu = cpu;
      await g.tick();
      s.now += 5_000;
    }
  };
  return { s, g, run, d };
}

test('w3305: a minute at or over 70% suspends the idle ffu listeners; another runner and a busy one are left', async () => {
  const { s, g, run } = harness();
  s.procs = [L1, L2, ...JOB2, GAME];
  await run(55_000, 90);
  assert.deepEqual(s.calls, [], 'under a minute of samples: nothing yet');
  await run(10_000, 90);
  assert.deepEqual(s.calls, ['suspend 4101'], 'ffu-lothdesktop-2 runs a job, the game runner is not gated');
  assert.equal(g.state().closed, true);
  // its job ends: it is suspended on the next tick
  s.procs = [L1, L2, GAME];
  await run(0, 90);
  assert.deepEqual(s.calls, ['suspend 4101', 'suspend 4102']);
  assert.deepEqual(g.state().suspended.map((x) => x.pid), [4101, 4102]);
});

test('w3305: a short spike does not close the gate; a mean under 70% keeps it open', async () => {
  const { s, run } = harness();
  await run(60_000, 40);
  await run(20_000, 100); // a 20 s compile
  await run(60_000, 50);
  assert.deepEqual(s.calls, []);
});

test('w3305: hysteresis: it resumes only after two minutes under 55%, not at 60%', async () => {
  const { s, g, run } = harness();
  await run(65_000, 95);
  assert.equal(g.state().suspended.length, 2);
  await run(180_000, 60);
  assert.equal(g.state().closed, true, '60% is under 70% but over 55%: still closed');
  await run(10_000, 20);
  assert.ok(!s.calls.some((c) => c.startsWith('resume')), 'the two-minute mean is still 55% or more');
  await run(120_000, 20);
  assert.deepEqual(s.calls.filter((c) => c.startsWith('resume')), ['resume 4101', 'resume 4102']);
  assert.equal(g.state().closed, false);
  assert.deepEqual(g.state().suspended, []);
  assert.ok(s.log.some((l) => /resumed: it takes CI jobs again/.test(l)));
});

test('w3305: ticks a little over 5 s apart (a tick waits on the process listing) still reopen the gate', async () => {
  const { s, g } = harness();
  const tick = async (n: number, cpu: number) => {
    for (let i = 0; i < n; i++) {
      s.cpu = cpu;
      await g.tick();
      s.now += 5_700;
    }
  };
  await tick(15, 95);
  assert.equal(g.state().suspended.length, 2);
  await tick(40, 30); // about 3.8 min under 55%
  assert.equal(g.state().closed, false, 'LothDesktop 2026-11-07: the gate stayed closed at 30-40% CPU for an hour');
  assert.deepEqual(s.calls.filter((c) => c.startsWith('resume')), ['resume 4101', 'resume 4102']);
});

test('w3305: a listener taking a job (its log) is not suspended; one that took one as it was suspended is resumed at once', async () => {
  const { s, g, run } = harness();
  s.diag['ffu-lothdesktop-1'] = `${IDLE_LOG}[2026-11-07 01:00:50Z INFO Runner] Acknowledging runner request 'a1'\n`;
  s.diagAfter = { pid: 4102, root: 'ffu-lothdesktop-2', log: `${IDLE_LOG}[2026-11-07 01:01:05Z INFO Runner] Acknowledging runner request 'b2'\n` };
  await run(60_000, 90);
  assert.deepEqual(s.calls, ['suspend 4102', 'resume 4102']);
  assert.deepEqual(g.state().suspended, []);
  assert.ok(s.log.some((l) => /ffu-lothdesktop-1 .*not suspended yet/.test(l)));
  assert.ok(s.log.some((l) => /took a job as it was suspended: resumed/.test(l)));
});

test('w3305: a restarted daemon resumes the listeners it had suspended once load drops, and only live ones', async () => {
  const state: LoadGateState = { closed: true, since: '2026-11-07T00:50:00Z', suspended: [{ pid: 4101, root: `${R}/ffu-lothdesktop-1`, at: '2026-11-07T00:50:00Z' }, { pid: 9999, root: `${R}/ffu-lothdesktop-2`, at: '2026-11-07T00:50:00Z' }] };
  const { s, run } = harness({ state });
  await run(125_000, 10);
  // closed until it has two minutes of samples: ffu-lothdesktop-2's new listener is suspended meanwhile, pid 9999 is no listener
  assert.deepEqual(s.calls, ['suspend 4102', 'resume 4101', 'resume 4102']);
});

test('w3305: a machine with no gate resumes what an old gate left suspended and does nothing more', async () => {
  const state: LoadGateState = { closed: true, suspended: [{ pid: 4101, root: `${R}/ffu-lothdesktop-1`, at: '2026-11-07T00:50:00Z' }] };
  const { s, run } = harness({ state, settings: null });
  await run(120_000, 100);
  assert.deepEqual(s.calls, ['resume 4101']);
});

// LothDesktop's ffu-lothdesktop-1 _diag log at the second job the first gate was blamed for (2026-11-07 04:55Z): the
// listener had just started its worker (pid 49660 here, Runner.Worker.exe spawnclient) when the 30 s hand-off ran out.
const HANDOFF_LOG = [
  "[2026-11-07 04:55:33Z INFO BrokerMessageListener] Acknowledging runner request '9ebf3377-1047-5d89-af96-f87195113e4a'.",
  '[2026-11-07 04:55:37Z INFO Terminal] WRITE LINE: 2026-11-07 04:55:37Z: Running job: test (ffu-windows)',
  '[2026-11-07 04:55:41Z INFO ProcessInvokerWrapper] Process started with process id 49660, waiting for process exit.',
  '[2026-11-07 04:55:41Z INFO JobDispatcher] Send job request message to worker for job 9ebf3377-1047-5d89-af96-f87195113e4a.',
].join('\n');
const W1 = (ppid: number): Proc => ({ pid: 49660, ppid, cmd: `"V:\\ffw\\ffu-runners\\ffu-lothdesktop-1\\bin\\Runner.Worker.exe" spawnclient 2388 2460` });

test('w3305: a runner whose worker lost its parent link is still busy: never suspended', async () => {
  const { s, run } = harness();
  s.procs = [L1, L2, W1(77777), GAME]; // the worker's parent pid is not the listener's (a reused or lost link)
  s.diag['ffu-lothdesktop-1'] = `${IDLE_LOG}`; // even with a log that says idle
  await run(65_000, 95);
  assert.deepEqual(s.calls, ['suspend 4102'], 'ffu-lothdesktop-1 has a worker from its folder');
});

test('w3305: LothDesktop\'s real hand-off log (a worker just started) holds the listener even with no worker in the listing', async () => {
  const { s, run } = harness();
  s.now = Date.parse('2026-11-07T04:54:40Z');
  s.diag['ffu-lothdesktop-1'] = HANDOFF_LOG;
  s.procs = [L1, L2, GAME];
  await run(65_000, 95);
  assert.deepEqual(s.calls, ['suspend 4102']);
  assert.ok(s.log.some((l) => /ffu-lothdesktop-1 .*handed a job at 2026-11-07T04:55:37/.test(l)));
});

test('w3305: the look after a suspend reads a fresh listing: a worker started as it landed resumes the listener', async () => {
  const { s, g, run, d } = harness();
  let fresh = 0;
  d.freshProcs = async () => {
    fresh++;
    return [L1, L2, W1(4101), GAME];
  };
  s.procs = [L1, L2, GAME]; // the cached listing, from before the suspend
  await run(60_000, 90);
  assert.ok(fresh > 0);
  assert.deepEqual(s.calls.slice(0, 2), ['suspend 4101', 'suspend 4102']);
  assert.ok(s.calls.includes('resume 4101'), 'ffu-lothdesktop-1 had a worker in the fresh listing');
  assert.ok(!g.state().suspended.some((x) => x.pid === 4101));
});

test('w3305: LothDesktop is gated again, at Ben\'s about 70%; BEAST and every other machine are not', () => {
  assert.deepEqual(Object.keys(LOAD_GATES), ['lothdesktop']);
  assert.equal(LOAD_GATES.lothdesktop, G);
  assert.equal(G.pauseAtPct, 70);
  assert.ok(G.resumeBelowPct < G.pauseAtPct);
  assert.ok(G.runners.test('ffu-lothdesktop-1') && !G.runners.test('actions-runner'));
});

test('w3305: the CPU sampler reads the busy share since its last call', () => {
  let t = { idle: 100, user: 0 };
  const cpus = () => [{ model: 'x', speed: 1, times: { idle: t.idle, user: t.user, sys: 0, irq: 0, nice: 0 } }];
  const f = cpuSampler(cpus);
  t = { idle: 125, user: 75 };
  assert.equal(f(), 75);
  t = { idle: 225, user: 75 };
  assert.equal(f(), 0);
});

test('w3305: the Windows script suspends or resumes one pid and refuses a system pid', () => {
  assert.match(winSuspendScript(4101, false), /\[FFSuspend\]::Run\(4101, \$false\)/);
  assert.match(winSuspendScript(4101, true), /\$true/);
  assert.match(winSuspendScript(4101, false), /OpenProcess\(0x0800/);
  assert.throws(() => winSuspendScript(4, false));
});
