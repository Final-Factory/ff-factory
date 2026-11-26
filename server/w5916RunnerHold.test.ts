import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_LAPSE_MS, LOTHDESKTOP_GATE, LoadGate, RECONNECT_AFTER_MS, RECONNECT_FOR_MS, type LoadGateDeps, type LoadGateState } from '../machine/loadRunners.ts';
import { runnerHoldReportOf, runnerHoldText } from '../shared/runnerHold.ts';
import { MachineManager } from './machines.ts';
import type { Proc } from '../machine/unity.ts';

/**
 * w5916 (lothsahn: "Make it so a portal hold shuts down CI workers when they finish"): a person's hold on a machine drains
 * its CI runners (each idle listener suspended, a busy one once its job ends), keeps them stopped across a daemon restart,
 * and starts them again when it lifts. Fake process listings; no real process is suspended (the real one: the PR's
 * evidence, a fake Runner.Listener.exe suspended and resumed by winSuspend).
 */

const R = 'V:/ffw/ffu-runners';
const L = (pid: number, name: string): Proc => ({ pid, ppid: 1, cmd: `"${R}\\${name}\\bin\\Runner.Listener.exe" run` });
const L1 = L(4101, 'ffu-lothdesktop-1');
const L2 = L(4102, 'ffu-lothdesktop-2');
const GAME: Proc = { pid: 4103, ppid: 1, cmd: `"V:/actions-runner\\bin\\Runner.Listener.exe" run` };
const OPS: Proc = { pid: 4104, ppid: 1, cmd: `"V:/ffw/ops-runner\\bin\\Runner.Listener.exe" run` };
const JOB2: Proc[] = [{ pid: 4200, ppid: 4102, cmd: `"${R}\\ffu-lothdesktop-2\\bin\\Runner.Worker.exe" spawnclient 1 2` }];
const NOW = Date.parse('2026-11-26T01:00:00Z');
const IDLE_LOG = '[2026-11-26 00:00:00Z INFO Terminal] WRITE LINE: 2026-11-26 00:00:00Z: Job check completed with result: Succeeded\n';
const WHY = 'lothsahn: "Hold it" (w5814)';

function harness(o: { state?: LoadGateState; settings?: LoadGateDeps['settings']; start?: LoadGateDeps['start']; othersPaused?: number[] } = {}) {
  const s = { procs: [L1, L2, GAME, OPS] as Proc[], now: NOW, calls: [] as string[], written: [] as LoadGateState[], log: [] as string[], started: [] as string[] };
  const d: LoadGateDeps = {
    settings: o.settings,
    procs: async () => s.procs,
    cpu: () => 0,
    suspend: async (pid, resume) => void s.calls.push(`${resume ? 'resume' : 'suspend'} ${pid}`),
    diag: () => IDLE_LOG,
    opsRunner: (root) => root.includes('ops-runner'),
    othersPaused: () => new Set(o.othersPaused ?? []),
    ...(o.start ? { start: o.start } : {}),
    read: () => o.state,
    write: (st) => s.written.push(JSON.parse(JSON.stringify(st))),
    log: (t) => s.log.push(t),
    now: () => s.now,
  };
  return { s, d, g: new LoadGate(d) };
}

test('w5916: a hold suspends every idle runner listener but the operations runner; a busy one finishes its job first', async () => {
  const { s, g } = harness();
  s.procs = [L1, L2, ...JOB2, GAME, OPS];
  await g.setHold(WHY);
  assert.deepEqual(s.calls, ['suspend 4101', 'suspend 4103'], 'ffu-lothdesktop-2 runs a job; the ops runner is never held');
  assert.equal(runnerHoldText(g.holdReport()), 'runners draining (1 busy: ffu-lothdesktop-2; 2 stopped)');
  assert.ok(s.log.some((l) => /^ci hold: this machine is held/.test(l)));
  // its job ends: suspended on the next look
  s.procs = [L1, L2, GAME, OPS];
  await g.tick();
  assert.deepEqual(s.calls, ['suspend 4101', 'suspend 4103', 'suspend 4102']);
  assert.equal(runnerHoldText(g.holdReport()), 'runners stopped by hold (actions-runner, ffu-lothdesktop-1, ffu-lothdesktop-2)');
  // repeated by the portal: nothing more is done
  await g.setHold(WHY);
  await g.tick();
  assert.equal(s.calls.length, 3);
});

test('w5916: a hold works on a machine without a CPU gate, and keeps the CPU gate\'s runners held after the CPU calms', async () => {
  const { s, g } = harness({ settings: undefined });
  await g.setHold(WHY);
  assert.deepEqual(s.calls.sort(), ['suspend 4101', 'suspend 4102', 'suspend 4103']);
  const lg = harness({ settings: LOTHDESKTOP_GATE });
  await lg.g.setHold(WHY);
  for (let i = 0; i < 40; i++) {
    await lg.g.tick();
    lg.s.now += 5_000;
  }
  assert.ok(!lg.s.calls.some((c) => c.startsWith('resume')), 'a calm CPU does not reopen what the hold closed');
});

test('w5916: a daemon restarted while held keeps the runners stopped, and the lift resumes them', async () => {
  const a = harness();
  await a.g.setHold(WHY);
  const kept = a.s.written.at(-1)!;
  assert.equal(kept.hold?.why, WHY);
  // the daemon restarts: a new gate reads the file; the portal has not spoken yet
  const b = harness({ state: kept });
  await b.g.tick();
  assert.deepEqual(b.s.calls, [], 'still suspended (the same pids), nothing resumed before the portal says so');
  assert.equal(runnerHoldText(b.g.holdReport()), 'runners stopped by hold (actions-runner, ffu-lothdesktop-1, ffu-lothdesktop-2)');
  // the portal says there is no hold any more
  await b.g.setHold(undefined);
  assert.deepEqual(b.s.calls.sort(), ['resume 4101', 'resume 4102', 'resume 4103']);
  assert.deepEqual(b.g.state().suspended, []);
  assert.equal(b.g.holdReport(), undefined);
  assert.ok(b.s.log.some((l) => /hold on this machine was lifted/.test(l)));
});

test('w5916: a daemon that dies between the write and the suspend still resumes that listener on the lift (write-ahead)', async () => {
  const a = harness();
  let crashAt: LoadGateState | undefined;
  a.d.suspend = async (pid) => {
    crashAt = a.s.written.at(-1);
    throw new Error(`daemon gone as it suspended ${pid}`);
  };
  await a.g.setHold(WHY);
  assert.ok(crashAt?.suspended.some((p) => p.pid === 4101), 'the entry was written before the suspend');
  const b = harness({ state: crashAt });
  await b.g.setHold(undefined);
  assert.ok(b.s.calls.includes('resume 4101'));
});

test('w5916: a hold the portal stops repeating lapses after HOLD_LAPSE_MS, so a lost portal never leaves the runners off', async () => {
  const { s, g } = harness();
  await g.setHold(WHY);
  s.now += HOLD_LAPSE_MS - 60_000;
  await g.tick();
  assert.ok(!s.calls.some((c) => c.startsWith('resume')));
  s.now += 120_000;
  await g.tick();
  assert.deepEqual(s.calls.filter((c) => c.startsWith('resume')).sort(), ['resume 4101', 'resume 4102', 'resume 4103']);
  assert.equal(g.state().hold, undefined);
  assert.ok(s.log.some((l) => /lapses here/.test(l)));
});

test('w5916: a listener suspended a week is resumed to reconnect to GitHub (14 days offline removes it), then suspended again', async () => {
  const { s, g } = harness();
  await g.setHold(WHY);
  for (let t = 0; t <= RECONNECT_AFTER_MS; t += 6 * 3_600_000) {
    s.now += 6 * 3_600_000;
    await g.setHold(WHY); // the portal repeats it
  }
  assert.deepEqual(s.calls.filter((c) => c.startsWith('resume')).sort(), ['resume 4101', 'resume 4102', 'resume 4103']);
  const n = s.calls.length;
  await g.tick();
  assert.equal(s.calls.length, n, 'left to reconnect meanwhile');
  assert.match(runnerHoldText(g.holdReport()) ?? '', /draining/);
  s.now += RECONNECT_FOR_MS + 1;
  await g.tick();
  assert.deepEqual(s.calls.slice(n).sort(), ['suspend 4101', 'suspend 4102', 'suspend 4103']);
});

test('w5916: runners a grow ended while held start when the hold lifts; one that fails is tried again', async () => {
  let fail = true;
  const { s, g } = harness({
    start: async (root) => {
      s.started.push(root);
      if (fail && root.endsWith('-2')) throw new Error('no scheduled task');
      return 'scheduled task';
    },
  });
  assert.equal(g.deferStart([`${R}/ffu-lothdesktop-1`]), false, 'no hold: the caller starts it');
  await g.setHold(WHY);
  s.procs = [GAME, OPS]; // the grow ended both ffu listeners
  assert.equal(g.deferStart([`${R}/ffu-lothdesktop-1`, `${R}/ffu-lothdesktop-2`]), true);
  await g.tick();
  assert.deepEqual(s.started, [], 'nothing starts while held');
  assert.match(runnerHoldText(g.holdReport()) ?? '', /2 start again when it lifts/);
  await g.setHold(undefined);
  assert.deepEqual(s.started, [`${R}/ffu-lothdesktop-1`, `${R}/ffu-lothdesktop-2`]);
  assert.deepEqual(g.state().startOnLift, [`${R}/ffu-lothdesktop-2`]);
  fail = false;
  s.procs = [L1, GAME, OPS];
  await g.tick();
  assert.deepEqual(s.started.slice(2), [`${R}/ffu-lothdesktop-2`]);
  assert.equal(g.state().startOnLift, undefined);
});

test('w5916: a listener a timed run paused is left to it, and counts as stopped', async () => {
  const { s, g } = harness({ othersPaused: [4101] });
  await g.setHold(WHY);
  assert.ok(!s.calls.includes('suspend 4101'));
  assert.ok(g.holdReport()?.stopped.includes('ffu-lothdesktop-1'));
});

test('w5916: the runner hold text and the portal\'s check of a daemon\'s report', () => {
  assert.equal(runnerHoldText(undefined), undefined);
  assert.equal(runnerHoldText({ why: 'x', since: 's', stopped: [], busy: [], startOnLift: [] }), undefined);
  assert.equal(runnerHoldText({ why: 'x', since: 's', stopped: ['a'], busy: ['b'], startOnLift: [] }), 'runners draining (1 busy: b; 1 stopped)');
  assert.equal(runnerHoldText({ why: 'x', since: 's', stopped: ['a'], busy: [], startOnLift: ['c'] }), 'runners stopped by hold (a); 1 start again when it lifts');
  assert.equal(runnerHoldReportOf(null), null);
  assert.equal(runnerHoldReportOf({ why: 1 }), undefined);
  assert.equal(runnerHoldReportOf({ why: 'x', since: 's', stopped: [3], busy: [] }), undefined);
  assert.deepEqual(runnerHoldReportOf({ why: 'x', since: 's', stopped: ['a'], busy: [] }), { why: 'x', since: 's', stopped: ['a'], busy: [], startOnLift: [] });
});

test('w5916: the portal tells a daemon its hold when it changes and every 10 minutes, and its lift at once', () => {
  const sent: { id: string; msg: unknown }[] = [];
  const m = Object.create(MachineManager.prototype) as MachineManager;
  Object.assign(m, { links: new Map([['lothdesktop', {}], ['beast', {}]]), runnerHoldSent: new Map() });
  m.post = (id, msg) => void sent.push({ id, msg });
  let hold: string | undefined = WHY;
  m.runnerHoldFor = (id) => (id === 'lothdesktop' ? hold : undefined);
  m.syncRunnerHolds(undefined, NOW);
  assert.deepEqual(sent, [
    { id: 'lothdesktop', msg: { type: 'runner_hold', why: WHY } },
    { id: 'beast', msg: { type: 'runner_hold', why: null } },
  ]);
  m.syncRunnerHolds(undefined, NOW + 60_000);
  assert.equal(sent.length, 2, 'unchanged: nothing sent');
  m.syncRunnerHolds(undefined, NOW + 10 * 60_000);
  assert.deepEqual(sent.slice(2), [{ id: 'lothdesktop', msg: { type: 'runner_hold', why: WHY } }], 'a hold is repeated (the daemon lapses it after 12 h of silence); no hold is not');
  hold = undefined;
  m.syncRunnerHolds('lothdesktop', NOW + 10 * 60_000 + 1);
  assert.deepEqual(sent.at(-1), { id: 'lothdesktop', msg: { type: 'runner_hold', why: null } });
});
