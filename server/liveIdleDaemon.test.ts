// w1746 end to end below the browser: a real daemon in this process (server/testMachine.ts) with its stand-in editor and a
// stand-in game and editor bridge, a MachineManager, a LiveHub and the portal's LiveIdleCloser. A watched view keeps its
// editor; an idle one has it saved and quit through the editor (the scene saved, nothing killed), the sandbox line says so,
// a person opening the view wakes the worker, and the worker's next message starts the editor again with a note.
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
import { LiveIdleCloser, idleClosedPart } from './liveIdle.ts';
import { createTestMachine, until, type TestMachine } from './testMachine.ts';
import { fakeLiveGame } from './testLiveGame.ts';
import { INSPECT_SNIPPET, LEAVE_PLAY_SNIPPET, SAVE_AND_QUIT_SNIPPET } from '../machine/liveIdle.ts';
import type { Config } from './config.ts';
import type { SessionHandle } from './sessions.ts';
import type { SessionInfo } from '../shared/types.ts';

test('w1746: a watched view keeps its editor; idle 15 min it is saved and closed; a viewer wakes the worker; its next message reopens it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-idle-'));
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
  // The editor's state as the bridge answers it: in play mode, one scene with unsaved changes.
  const editor = { playing: true, dirty: ['Assets/Scenes/Look.unity'], saved: [] as string[], calls: [] as string[] };
  // What the daemon's agent for w1 was sent (a stand-in session: no Claude).
  const told: string[] = [];
  let pc: TestMachine | undefined;
  const alphaUp = () => !!pc && pc.running.has(pc.path('alpha'));
  pc = await createTestMachine({
    sandboxes: ['alpha'],
    liveDeps: () => ({
      ...game.deps,
      editorPid: () => (alphaUp() ? 4242 : undefined),
      bridge: async (code, o) => {
        editor.calls.push(code === INSPECT_SNIPPET ? 'look' : code === LEAVE_PLAY_SNIPPET ? 'leave' : code === SAVE_AND_QUIT_SNIPPET ? `save+quit${o?.safetyChecks === false ? '' : ' (checked)'}` : 'other');
        if (!alphaUp()) return 'no bridge: connect ECONNREFUSED';
        if (code === INSPECT_SNIPPET) return `playing=${editor.playing}|compiling=False|updating=False|dirty=${editor.dirty.join(';')}|untitled=0`;
        if (code === LEAVE_PLAY_SNIPPET) {
          editor.playing = false;
          return 'leaving play mode';
        }
        if (code === SAVE_AND_QUIT_SNIPPET && o?.safetyChecks === false) {
          const was = editor.dirty;
          editor.saved.push(...was);
          editor.dirty = [];
          // EditorApplication.Exit(0) on the editor's next update: its process goes by itself.
          setTimeout(() => pc!.running.delete(pc!.path('alpha')), 300);
          return `quitting saved=${was.join(';')}`;
        }
        return 'error: Blocked pattern detected';
      },
    }),
    makeSession: (info) => ({ info, live: false, send: (text: string) => void told.push(text), stop: () => undefined, interrupt: () => undefined }) as unknown as SessionHandle,
  });
  const store = new Store(dir);
  store.putMachine(pc.record({ alpha: ['w1'] }));
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const info = { id: 'w1', kind: 'worker', status: 'idle', title: 'w1466: Urso', machineId: 'pc', machineSandbox: 'alpha', lastActivityAt: new Date(Date.now() - 60_000).toISOString(), pendingPermissions: [], requestedBy: { userId: 'ben', displayName: 'Ben' } } as unknown as SessionInfo;
  const hub = new LiveHub({ enabled: () => true, machines, session: (id) => (id === 'w1' ? info : undefined), roleOf: () => 'member', changed: () => undefined, viewerOpened: (i, who) => closer.viewerOpened(i, who) });
  machines.onLiveFrames = (m, id, ws) => hub.attachFrames(m, id, ws);
  machines.onLiveState = (m, msg) => hub.onState(m, msg);
  // The idle clock: 16 minutes after the real one, so the view has sat idle past 15.
  let ahead = 0;
  const logs: string[] = [];
  const woke: { id: string; text: string }[] = [];
  const sbOf = () => store.machines.get('pc')?.sandboxes?.find((x) => x.id === 'alpha');
  const closer = new LiveIdleCloser({
    minutes: () => 15,
    views: () => hub.idleFacts(),
    sandbox: () => sbOf(),
    session: (id) => (id === 'w1' ? info : undefined),
    wakePending: () => false,
    canClose: (m) => machines.canLiveIdleClose(m),
    close: (v, minutes) => machines.live(v.machineId, { op: 'idleClose', liveId: v.liveId, sessionId: v.sessionId, sandbox: v.sandbox, minutes }, 60_000),
    send: (id, text) => void woke.push({ id, text }),
    log: (l) => logs.push(l),
    now: () => Date.now() + ahead,
  });
  t.after(async () => {
    game.stop();
    await pc!.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await pc.connect(machines);
  await until('the daemon closes idle editors', () => machines.canLiveIdleClose('pc'), 20_000);
  const pool = (pc.daemon as unknown as { pool: { unity(id: string, a: 'start'): Promise<string> } }).pool;
  await pool.unity('alpha', 'start');
  await until('the editor runs on the portal record', () => sbOf()?.unity.state === 'running', 30_000);
  assert.match(await hub.tool(info, { action: 'start', materials: ['VfxComet'], fps: 20, width: 320 }), /^Live view started/);
  await until('the view says live', () => hub.viewsFor('ben')[0]?.state === 'live', 20_000);

  // A person watching: no close, however long it has been.
  const page = new EventEmitter() as EventEmitter & { OPEN: number; readyState: number; bufferedAmount: number; send(b: Buffer): void; close(): void };
  Object.assign(page, { OPEN: 1, readyState: 1, bufferedAmount: 0 });
  page.send = () => undefined;
  page.close = () => ((page.readyState = 3), page.emit('close'));
  assert.equal(hub.addViewer('w1', page as unknown as WebSocket, 'Ben'), true);
  assert.equal(woke.length, 0, 'opening a view whose editor runs wakes nobody');
  ahead = 16 * 60_000;
  await closer.sweep();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(editor.calls, [], 'a watched view: the editor was not even asked');
  assert.ok(alphaUp());

  // Nobody watching for 16 minutes: saved through the editor, then quit.
  page.close();
  await closer.sweep();
  await until('the portal record says the editor was closed idle', () => !!sbOf()?.idleClosed, 60_000);
  assert.ok(!alphaUp(), 'the editor process is gone');
  assert.deepEqual(editor.saved, ['Assets/Scenes/Look.unity'], 'no data lost: the unsaved scene was saved first');
  assert.deepEqual(editor.calls.slice(0, 2), ['look', 'leave']);
  assert.equal(editor.calls.at(-1), 'save+quit', 'the quit went with the save, with the safety checks off for EditorApplication.Exit');
  assert.equal(sbOf()?.idleClosed?.minutes, 15);
  assert.deepEqual(sbOf()?.idleClosed?.saved, ['Assets/Scenes/Look.unity']);
  assert.match(idleClosedPart(sbOf()!) ?? '', /^editor closed: idle 15 min; reopens on resume \(closed \d\d:\d\dZ, saved Assets\/Scenes\/Look\.unity first\)$/);
  await until('the close is logged', () => logs.some((l) => /editor closed \(saved Assets\/Scenes\/Look\.unity and the assets first\)/.test(l)), 5000);
  await until('the view holds, saying why', () => hub.viewsFor('ben')[0]?.detail === 'editor closed: idle 15 min; reopens on resume', 20_000);
  assert.equal(hub.viewsFor('ben').length, 1, 'the view itself stays');

  // A person opens the view: the worker is woken (its turn starts the editor).
  assert.equal(hub.addViewer('w1', page as unknown as WebSocket, 'Ben'), true);
  assert.equal(woke.length, 1);
  assert.match(woke[0].text, /^\[live view\] Ben opened your Live view/);

  // The worker's next message (that wake, or a person's): the daemon starts the editor and the message starts with why.
  const daemon = pc.daemon as unknown as { onMessage(m: unknown): void };
  daemon.onMessage({ type: 'send', info, lastSeq: 0, spec: { cwd: pc.path('alpha'), sandbox: 'alpha', env: {} }, text: woke[0].text, from: 'system' });
  await until('the message reached the agent', () => told.length === 1, 10_000);
  assert.match(told[0], /^\[live view\] Your sandbox's Unity editor was closed at \d\d:\d\dZ after 15 min .* It saved Assets\/Scenes\/Look\.unity first/);
  assert.ok(told[0].includes(woke[0].text), "the person's line follows");
  await until('the editor runs again', () => alphaUp(), 10_000);
  await until('the portal record no longer says closed', () => !sbOf()?.idleClosed, 30_000);
  await closer.sweep();
  assert.ok(logs.some((l) => /its editor opened again/.test(l)), 'the reopen is logged');
  // A later message is not told again.
  daemon.onMessage({ type: 'send', info, lastSeq: 0, spec: { cwd: pc.path('alpha'), sandbox: 'alpha', env: {} }, text: 'brighter please', from: 'human' });
  await until('the second message', () => told.length === 2, 10_000);
  assert.equal(told[1], 'brighter please');

  // Closed idle again, then the view ends (its hold over, the sandbox released): nothing is left to reopen for it.
  page.close();
  ahead += 32 * 60_000;
  await until('the reopened editor runs', () => sbOf()?.unity.state === 'running', 60_000);
  await closer.sweep();
  await until('closed idle a second time', () => !!sbOf()?.idleClosed, 60_000);
  assert.equal(await hub.tool(info, { action: 'stop' }), 'Live view stopped.');
  await until('the mark goes with the last view', () => !sbOf()?.idleClosed, 30_000);
  assert.ok(!alphaUp(), 'and the editor stays closed');
});
