// The live view end to end below the browser (w1398): a real daemon in this process (server/testMachine.ts) with a
// stand-in game (server/testLiveGame.ts), linked to a MachineManager and a LiveHub: the tool starts it, frames reach a
// watching page over the daemon's own frame socket, a knob reaches the game and shows in the next frames, stop ends it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { LiveHub } from './live.ts';
import { createTestMachine, until } from './testMachine.ts';
import { fakeLiveGame } from './testLiveGame.ts';
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('w1398: live view: start, frames to a page, a knob in the next frames, stop', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-daemon-'));
  const cfg = {
    dataDir: dir,
    port: 0,
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    live: { enabled: true },
  } as unknown as Config;
  const game = fakeLiveGame({ width: 32, height: 18 });
  const store = new Store(dir);
  const pc = await createTestMachine({ sandboxes: ['alpha'], liveDeps: () => game.deps });
  store.putMachine(pc.record({}));
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const info = { id: 'w1', kind: 'worker', title: 'Comet', machineId: 'pc', machineSandbox: 'alpha', requestedBy: { userId: 'kai', displayName: 'Kai' } } as unknown as SessionInfo;
  const hub = new LiveHub({ enabled: () => true, machines, session: (id) => (id === 'w1' ? info : undefined), roleOf: () => 'member', changed: () => undefined });
  machines.onLiveFrames = (m, id, ws) => hub.attachFrames(m, id, ws);
  machines.onLiveState = (m, msg) => hub.onState(m, msg);
  t.after(async () => {
    game.stop();
    await pc.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await pc.connect(machines);
  await until('the daemon offers the live view', () => machines.canLive('pc'), 20_000);

  const started = await hub.tool(info, { action: 'start', materials: ['VfxComet'], fps: 20, width: 320 });
  assert.match(started, /^Live view started \(20 fps, 320 px, knobs on VfxComet\)/);
  await until('frames reach the portal', () => (hub.viewsFor('kai')[0]?.frames ?? 0) >= 3, 20_000);
  await until('the view says live', () => hub.viewsFor('kai')[0]?.state === 'live', 20_000);
  assert.ok(game.commands.includes('live.frames|on|20|320|' + game.commands.find((c) => c.startsWith('live.frames|on'))?.split('|')[4]));

  // A page watching it gets frames, the newest first.
  const page = new EventEmitter() as EventEmitter & { OPEN: number; readyState: number; bufferedAmount: number; sent: Buffer[]; send(b: Buffer): void; close(): void };
  Object.assign(page, { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [] as Buffer[] });
  page.send = (b: Buffer) => void page.sent.push(b);
  page.close = () => ((page.readyState = 3), page.emit('close'));
  assert.equal(hub.addViewer('w1', page as unknown as WebSocket), true);
  await until('the page gets frames', () => page.sent.length >= 2, 20_000);
  assert.deepEqual([...page.sent[0].subarray(0, 4)], [...PNG], 'a frame is the game\'s image, unchanged');

  // The knobs, read from the game, and one moved: the next frames follow it.
  const knobs = await hub.knobs('w1');
  assert.deepEqual(knobs[0].knobs.map((k) => k.name), ['_Intensity', '_ComaColor', '_Age']);
  assert.match(knobs[0].knobs[2].driven ?? '', /MaterialPropertyBlock/, 'the game\'s reason a knob cannot move the picture reaches the page');
  const before = page.sent.length;
  const answer = await hub.setKnob('w1', { material: 'VfxComet', name: '_Intensity', value: 4 }, { userId: 'kai', displayName: 'Kai' });
  assert.equal((answer as { value: number }).value, 4);
  assert.equal(game.knobs().VfxComet[0].value, 4);
  await until('frames after the knob', () => page.sent.length >= before + 3, 20_000);
  assert.notDeepEqual(page.sent.at(-1), page.sent[0], 'the picture changed with the knob');
  await assert.rejects(hub.setKnob('w1', { material: 'Nope', name: '_Intensity', value: 1 }, { userId: 'kai', displayName: 'Kai' }), /not one of this view's materials/);

  // w1582: a running view keeps its sandbox active, so the editor's idle stop leaves it while the person comes back to it.
  const activity = (pc.daemon as unknown as { sandboxActivity(id: string): { lastActivityMs: number } }).sandboxActivity.bind(pc.daemon);
  assert.ok(Date.now() - activity('alpha').lastActivityMs < 1000, 'a running view is activity now');

  assert.equal(await hub.tool(info, { action: 'stop' }), 'Live view stopped.');
  await until('the game stops streaming', () => game.commands.at(-1) === 'live.frames|off', 20_000);
  assert.equal(page.readyState, 3);
  await new Promise((r) => setTimeout(r, 50));
  const after = activity('alpha').lastActivityMs;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(activity('alpha').lastActivityMs, after, 'a stopped view is no activity: the idle clock runs from its last knob or start');
});

test('w1509: a daemon restart (a machine rollout) leaves the view working: frames come back and a knob reaches the game', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-restart-'));
  const cfg = {
    dataDir: dir,
    port: 0,
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    live: { enabled: true },
  } as unknown as Config;
  const game = fakeLiveGame({ width: 32, height: 18 });
  const store = new Store(dir);
  const first = await createTestMachine({ sandboxes: ['alpha'], liveDeps: () => game.deps });
  store.putMachine(first.record({}));
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const info = { id: 'w1', kind: 'worker', title: 'Shield', machineId: 'pc', machineSandbox: 'alpha', requestedBy: { userId: 'ben', displayName: 'Ben' } } as unknown as SessionInfo;
  const hub = new LiveHub({ enabled: () => true, machines, session: (id) => (id === 'w1' ? info : undefined), roleOf: () => 'member', changed: () => undefined });
  machines.onLiveFrames = (m, id, ws) => hub.attachFrames(m, id, ws);
  machines.onLiveState = (m, msg) => hub.onState(m, msg);
  machines.onLiveHello = (m, running) => void hub.daemonHello(m, running);
  let second: Awaited<ReturnType<typeof createTestMachine>> | undefined;
  t.after(async () => {
    game.stop();
    await second?.stop();
    await first.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await first.connect(machines);
  await until('the daemon offers the live view', () => machines.canLive('pc'), 20_000);
  await hub.tool(info, { action: 'start', materials: ['VfxComet'], fps: 20, width: 320 });
  await until('the view says live', () => hub.viewsFor('ben')[0]?.state === 'live', 20_000);
  const page = new EventEmitter() as EventEmitter & { OPEN: number; readyState: number; bufferedAmount: number; sent: Buffer[]; send(b: Buffer): void; close(): void };
  Object.assign(page, { OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [] as Buffer[] });
  page.send = (b: Buffer) => void page.sent.push(b);
  page.close = () => ((page.readyState = 3), page.emit('close'));
  hub.addViewer('w1', page as unknown as WebSocket);
  await until('the page gets frames', () => page.sent.length >= 2, 20_000);

  // The machine's daemon restarts, as every rollout does: the process ends with its views, a new one connects.
  first.daemon!.shutdown();
  await until('the machine goes offline', () => !machines.isOnline('pc'), 10_000);
  second = await createTestMachine({ id: 'pc', sandboxes: ['alpha'], liveDeps: () => game.deps });
  await second.connect(machines);

  const before = page.sent.length;
  await until('frames reach the page again', () => page.sent.length >= before + 3, 20_000);
  assert.equal(hub.viewsFor('ben').length, 1, 'still one view, the same page');
  const answer = await hub.setKnob('w1', { material: 'VfxComet', name: '_Intensity', value: 3 }, { userId: 'ben', displayName: 'Ben' });
  assert.equal((answer as { value: number }).value, 3, 'the knob reached the game after the restart');
  assert.equal(game.knobs().VfxComet[0].value, 3);
});
