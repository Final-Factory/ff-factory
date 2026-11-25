/**
 * w5555: the worker fence fails closed, with a portal alert (lothsahn). A failed fence probe holds the machine's sandbox
 * workers (no unfenced start), the portal alerts naming the machine and the probe's error and placement sees it busy; a
 * start while the fence is still being set up waits; a fence switched off on purpose starts workers as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager, fenceReportOf } from './machines.ts';
import { startTestMachine, until, type TestMachine } from './testMachine.ts';
import { busyReasons, agentBusyReasons, type Computer } from './placement.ts';
import { FenceGate, fenceKindFor, fenceWanted, fenceRefusal } from '../machine/fenceGate.ts';
import type { Config } from './config.ts';
import type { SessionHandle } from './sessions.ts';
import type { SessionInfo } from '../shared/types.ts';
import type { FromDaemon } from './machineProtocol.ts';

test('w5555: fenceWanted reads only this OS key; fenceKindFor names its fence', () => {
  assert.equal(fenceWanted({ workerIntegrity: 'low' }, 'win32'), true);
  assert.equal(fenceWanted({ workerFence: 'seatbelt' }, 'win32'), false, "another OS's key turns nothing on here");
  assert.equal(fenceWanted({}, 'win32'), false, 'worker_fence off (key absent): not wanted');
  assert.equal(fenceWanted({ workerFence: 'seatbelt' }, 'darwin'), true);
  assert.equal(fenceWanted({ writeLock: true }, 'linux'), true);
  assert.equal(fenceWanted({ writeLock: false }, 'linux'), false);
  assert.equal(fenceKindFor('win32'), 'low');
  assert.equal(fenceKindFor('darwin'), 'seatbelt');
  assert.equal(fenceKindFor('linux'), 'landlock');
});

test('w5555: FenceGate: setting up waits, on and off go, failed refuses; non-sandbox agents always go; decided once', async () => {
  const told: string[] = [];
  const g = new FenceGate({ wanted: true, kind: 'low', machine: 'pc', changed: (r) => told.push(r.state) });
  assert.equal(g.state.state, 'setting_up');
  const w = g.startGate(true);
  assert.ok('wait' in w, 'a sandbox start while the fence is set up waits');
  assert.deepEqual(g.startGate(false), { go: true }, 'a standing agent (no sandbox) never waits');
  assert.equal(g.allowsSandboxRun(), false);
  let released = false;
  void (w as { wait: Promise<void> }).wait.then(() => (released = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(released, false);
  g.failed('the Low claude could not run (exit 5)');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(released, true, 'the wait ends once the fence is decided');
  const r = g.startGate(true);
  assert.ok('refuse' in r);
  assert.match(r.refuse, /worker fence on pc failed \(the Low claude could not run \(exit 5\)\)/);
  g.on();
  assert.equal(g.state.state, 'failed', 'decided once per daemon start');
  assert.deepEqual(told, ['failed']);
  assert.equal(g.state.kind, 'low');

  const off = new FenceGate({ wanted: false });
  assert.equal(off.state.state, 'off');
  assert.deepEqual(off.startGate(true), { go: true }, 'fence off on purpose: workers start');
  assert.equal(off.allowsSandboxRun(), true);
  const on = new FenceGate({ wanted: true });
  on.on();
  assert.deepEqual(on.startGate(true), { go: true });
});

test('w5555: placement sees a failed fence as busy for game and agent work', () => {
  const p: Computer = { id: 'pc', online: true, live: 0, midTurn: 0, maxAgents: 4, sandboxes: 1, maxSandboxes: 3, freeSandboxes: 1 };
  assert.deepEqual(busyReasons(p), []);
  const held = { ...p, fenceFailed: 'no Low claude copy' };
  assert.deepEqual(busyReasons(held), ['worker fence failed: no Low claude copy']);
  assert.deepEqual(agentBusyReasons(held), ['worker fence failed: no Low claude copy']);
});

test('w5555: fenceReportOf keeps only a well-formed report', () => {
  assert.equal(fenceReportOf(undefined), undefined);
  assert.equal(fenceReportOf({ state: 'nope' }), undefined);
  assert.deepEqual(fenceReportOf({ state: 'failed', kind: 'low', why: 'x', since: '2026-11-25T00:00:00Z', extra: 1 }), { state: 'failed', kind: 'low', why: 'x', since: '2026-11-25T00:00:00Z' });
  assert.deepEqual(fenceReportOf({ state: 'on', kind: 'bogus' }), { state: 'on' });
});

test('w5555: a daemon whose fence failed starts no sandbox worker, the portal alerts and records it; setting up waits; off starts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-closed-'));
  const cfg = {
    dataDir: dir,
    port: 0,
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const started: string[] = [];
  let pc: TestMachine | undefined;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const alerts: { machine: string; title: string; text: string }[] = [];
  machines.fenceAlert = (machine, title, text) => void alerts.push({ machine, title, text });
  t.after(async () => {
    await pc?.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  pc = await startTestMachine(machines, {
    sandboxes: ['alpha'],
    makeSession: (info) => ({ info, live: false, send: () => void started.push(info.id), stop: () => undefined, interrupt: () => undefined }) as unknown as SessionHandle,
  });
  const daemon = pc.daemon!;
  const d = daemon as unknown as { fence: FenceGate; send(m: FromDaemon): void; out(m: FromDaemon): void; onMessage(m: unknown): void };
  assert.equal(d.fence.state.state, 'off', 'a daemon.json with no fence key: off, as before w5555');
  const failures: string[] = [];
  const out = d.out.bind(daemon);
  d.out = (m) => {
    if (m.type === 'failed') failures.push(m.error);
    out(m);
  };
  const gate = (): FenceGate => new FenceGate({ wanted: true, kind: 'low', machine: 'pc', changed: (r) => d.send({ type: 'worker_fence', fence: r }) });
  const info = (id: string) => ({ id, kind: 'worker', status: 'idle', title: id, machineId: 'pc', machineSandbox: 'alpha', pendingPermissions: [] }) as unknown as SessionInfo;
  const send = (id: string) => d.onMessage({ type: 'send', info: info(id), lastSeq: 0, spec: { cwd: pc!.path('alpha'), sandbox: 'alpha', env: {} }, text: 'go', from: 'human' });

  // Setting up: the start waits, then goes once the fence is on.
  d.fence = gate();
  send('w-wait');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(started.length, 0, 'no start while the fence is being set up');
  assert.equal(failures.length, 0, 'and no failure either: it waits');
  d.fence.on();
  await until('the waiting start goes once the fence is on', () => started.includes('w-wait'), 5000);

  // Failed: refused with the probe's error, no start, the portal records it and alerts once, naming the machine.
  d.fence = gate();
  send('w-held');
  d.fence.failed('the Low claude could not run (exit 5)');
  await until('the held start is refused', () => failures.length === 1, 5000);
  assert.match(failures[0], /worker fence on pc failed \(the Low claude could not run \(exit 5\)\)/);
  assert.ok(!started.includes('w-held'), 'no unfenced start');
  send('w-held2');
  await until('a later start is refused at once', () => failures.length === 2, 5000);
  assert.ok(!started.includes('w-held2'));
  await until('the portal has the failed fence', () => store.machines.get('pc')?.fence?.state === 'failed', 5000);
  assert.equal(store.machines.get('pc')?.fence?.why, 'the Low claude could not run (exit 5)');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].machine, 'pc');
  assert.match(alerts[0].title, /pc: worker fence failed/);
  assert.match(alerts[0].text, /The worker fence on pc failed: the Low claude could not run \(exit 5\)/);
  // A reconnect's welcome sends the same failed state again: no second alert.
  d.send({ type: 'worker_fence', fence: d.fence.state });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alerts.length, 1, 'one alert per failure');

  // A restarted daemon whose fence is on: the portal says it is back.
  d.fence = gate();
  d.fence.on();
  await until('the portal has the fence on again', () => store.machines.get('pc')?.fence?.state === 'on', 5000);
  assert.equal(alerts.length, 2);
  assert.match(alerts[1].text, /on again/);

  // Off on purpose (worker_fence off): the worker starts.
  d.fence = new FenceGate({ wanted: false });
  send('w-off');
  await until('a start with the fence off goes', () => started.includes('w-off'), 5000);
  assert.equal(fenceRefusal('pc', 'x').includes('worker_fence off'), true, 'the refusal names the switch');
});
