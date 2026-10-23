// w1839 part 2: Keep writes a Live view knob into the .mat on the worker's branch (server/live.ts keep, machine/daemon.ts
// liveKeep, machine/matText.ts). Ben, 2026-10-23: "Write it straight into the material file on the worker's branch."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { LiveError, LiveHub } from './live.ts';
import { createTestMachine, until } from './testMachine.ts';
import { fakeLiveGame } from './testLiveGame.ts';
import type { ToDaemon } from './machineProtocol.ts';
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';

const ben = { userId: 'ben', displayName: 'Ben' };
const MAT = 'Assets/Resources/Vfx/VfxComet.mat';
const COMET = ['%YAML 1.1', '--- !u!21 &2100000', 'Material:', '  m_Name: VfxComet', '  m_SavedProperties:', '    serializedVersion: 3', '    m_Ints: []', '    m_Floats:', '    - _FlowSpeed: 3.5', '    - _Intensity: 1', '    m_Colors:', '    - _ComaColor: {r: 0.25, g: 0.9, b: 1.1, a: 1}', '  m_AllowLocking: 1', ''].join('\n');

function hub(o: { canKeep?: boolean; knobs?: object[] } = {}) {
  const ops: Omit<Extract<ToDaemon, { type: 'live' }>, 'type' | 'id'>[] = [];
  const logs: string[] = [];
  const session = { id: 's1', kind: 'worker', title: 'Comet', machineId: 'beast', machineSandbox: 'slot5', requestedBy: { userId: 'ben', displayName: 'Ben' } } as unknown as SessionInfo;
  const knobs = o.knobs ?? [
    { name: '_Intensity', label: 'Intensity', type: 'range', value: 2.25, moved: true },
    { name: '_Age', label: 'Age', type: 'float', value: 3, moved: true, driven: 'a script sets it' },
    { name: '_FlowSpeed', label: 'Flow', type: 'float', value: 3.5 },
  ];
  const h = new LiveHub({
    enabled: () => true,
    machines: {
      canLive: () => true,
      canKeep: () => o.canKeep ?? true,
      live: async (_m, op) => {
        ops.push(op);
        if (op.op === 'command') return JSON.stringify({ material: 'VfxComet', knobs });
        if (op.op === 'keep') return JSON.stringify({ path: MAT, change: `${op.name} 1 -> 2.25` });
        return 'ok';
      },
    },
    session: () => session,
    roleOf: (u) => (u === 'ben' ? 'owner' : undefined),
    changed: () => undefined,
    log: (l) => logs.push(l),
  });
  return { h, ops, logs, session };
}

test('w1839: Keep sends the daemon each moved knob the game does not drive, with the note for the agent', async () => {
  const k = hub();
  await k.h.tool(k.session, { action: 'start', materials: ['VfxComet'] });
  const r = await k.h.keep('s1', 'VfxComet', ben);
  assert.deepEqual(r, { kept: [{ name: '_Intensity', path: MAT, change: '_Intensity 1 -> 2.25' }] });
  const keeps = k.ops.filter((o) => o.op === 'keep');
  assert.equal(keeps.length, 1, 'the driven knob and the unmoved one stay out');
  assert.equal(keeps[0].material, 'VfxComet');
  assert.equal(keeps[0].name, '_Intensity');
  assert.equal(keeps[0].note, 'Ben kept VfxComet _Intensity');
  assert.ok(k.logs.some((l) => l === `live view beast/slot5 (s1): Ben kept 1 value of VfxComet in ${MAT}`), k.logs.join('\n'));
});

test('w1839: Keep refuses when nothing moved, a material the view does not have, and an old daemon', async () => {
  const none = hub({ knobs: [{ name: '_Intensity', label: 'Intensity', type: 'range', value: 1 }] });
  await none.h.tool(none.session, { action: 'start', materials: ['VfxComet'] });
  await assert.rejects(none.h.keep('s1', 'VfxComet', ben), (e: Error) => e instanceof LiveError && e.status === 400 && e.message === 'nothing moved on VfxComet to keep');
  assert.equal(none.ops.filter((o) => o.op === 'keep').length, 0);

  const k = hub();
  await k.h.tool(k.session, { action: 'start', materials: ['VfxComet'] });
  await assert.rejects(k.h.keep('s1', 'Other', ben), (e: Error) => e instanceof LiveError && e.status === 400 && /not one of this view's materials/.test(e.message));

  const old = hub({ canKeep: false });
  await old.h.tool(old.session, { action: 'start', materials: ['VfxComet'] });
  await assert.rejects(old.h.keep('s1', 'VfxComet', ben), (e: Error) => e instanceof LiveError && e.status === 409 && e.message === "this machine's daemon needs an update to keep values");
  assert.equal(old.ops.filter((o) => o.op === 'command').length, 0, 'the game is not asked');
});

test('w1839: the daemon writes the kept value into the .mat in the sandbox, tells the agent, and refuses what it should', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'live-keep-'));
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
  // What the game answers to look.material.keep: its real answer (the fake's), or the cases it can go wrong.
  let keepAs: 'real' | 'old game' | 'evil path' = 'real';
  const store = new Store(dir);
  const pc = await createTestMachine({
    sandboxes: ['alpha'],
    liveDeps: () => ({
      ...game.deps,
      command: async (ch, text) => {
        if (text.startsWith('look.material.keep') && keepAs === 'old game') return { ok: false, status: 200, result: 'unknown command look.material.keep', reason: 'unknown_command' };
        const r = await game.deps.command!(ch, text);
        if (text.startsWith('look.material.keep') && keepAs === 'evil path') return { ...r, result: r.result.replace(MAT, 'Assets/../ProjectSettings/x.mat') };
        return r;
      },
    }),
  });
  store.putMachine(pc.record({}));
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const info = { id: 'w1', kind: 'worker', title: 'Comet', machineId: 'pc', machineSandbox: 'alpha', requestedBy: { userId: 'kai', displayName: 'Kai' } } as unknown as SessionInfo;
  const h = new LiveHub({
    enabled: () => true,
    machines: { canLive: (m) => machines.canLive(m), canKeep: (m) => machines.canLiveKeep(m), live: (m, op, ms) => machines.live(m, op, ms) },
    session: (id) => (id === 'w1' ? info : undefined),
    roleOf: () => 'member',
    changed: () => undefined,
  });
  machines.onLiveFrames = (m, id, ws) => h.attachFrames(m, id, ws);
  machines.onLiveState = (m, msg) => h.onState(m, msg);
  t.after(async () => {
    game.stop();
    await pc.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const file = path.join(pc.path('alpha'), ...MAT.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, COMET);
  await pc.connect(machines);
  await until('the daemon offers Keep', () => machines.canLiveKeep('pc'), 20_000);
  await h.tool(info, { action: 'start', materials: ['VfxComet'], fps: 20, width: 320 });
  await until('the view says live', () => h.viewsFor('kai')[0]?.state === 'live', 20_000);
  const liveId = h.viewsFor('kai')[0].liveId;
  const op = { liveId, sessionId: 'w1', sandbox: 'alpha' };

  // Nothing moved yet.
  await assert.rejects(h.keep('w1', 'VfxComet', { userId: 'kai', displayName: 'Kai' }), /nothing moved on VfxComet to keep/);
  assert.equal(fs.readFileSync(file, 'utf8'), COMET);

  await h.setKnob('w1', { material: 'VfxComet', name: '_Intensity', value: 2.25 }, { userId: 'kai', displayName: 'Kai' });
  const r = await h.keep('w1', 'VfxComet', { userId: 'kai', displayName: 'Kai' });
  assert.deepEqual(r.kept, [{ name: '_Intensity', path: MAT, change: '_Intensity 1 -> 2.25' }]);
  assert.equal(fs.readFileSync(file, 'utf8'), COMET.replace('- _Intensity: 1', '- _Intensity: 2.25'), 'only that line changed');
  assert.ok(game.commands.includes('look.material.keep|VfxComet|_Intensity'));
  // The agent is told which value went into which file; it opens its next message.
  const notes = (pc.daemon as unknown as { liveNotes: Map<string, { text: string }[]> }).liveNotes.get('w1') ?? [];
  assert.ok(notes.some((n) => n.text === `Kai kept VfxComet _Intensity: _Intensity 1 -> 2.25, in ${MAT} (written to the file on your branch, not committed)`), JSON.stringify(notes));
  const withNotes = (pc.daemon as unknown as { withLiveNotes(id: string, text: string): string }).withLiveNotes('w1', 'hello');
  assert.match(withNotes, /\(Moves are not saved until the person keeps them; a kept value is already in the \.mat file on your branch: commit it with your work\.\)/);

  // An older game: its refusal becomes the sentence that says what to do. Nothing is written.
  keepAs = 'old game';
  await assert.rejects(machines.live('pc', { op: 'keep', ...op, material: 'VfxComet', name: '_Intensity' }), /this sandbox's game has no look\.material\.keep yet: merge master into its branch/);
  // A path outside Assets is refused and nothing is written.
  keepAs = 'evil path';
  await assert.rejects(machines.live('pc', { op: 'keep', ...op, material: 'VfxComet', name: '_Intensity' }), /not a \.mat under Assets/);
  assert.equal(fs.existsSync(path.join(pc.path('alpha'), 'ProjectSettings', 'x.mat')), false);
  assert.equal(fs.readFileSync(file, 'utf8'), COMET.replace('- _Intensity: 1', '- _Intensity: 2.25'));
  // Names are checked before the game is asked.
  keepAs = 'real';
  const before = game.commands.length;
  await assert.rejects(machines.live('pc', { op: 'keep', ...op, material: 'Vfx;Comet', name: '_Intensity' }), /not a material name/);
  await assert.rejects(machines.live('pc', { op: 'keep', ...op, material: 'VfxComet', name: '_Intensity|1' }), /not a shader property name/);
  assert.equal(game.commands.length, before);
  await assert.rejects(machines.live('pc', { op: 'keep', liveId: 'nope', sessionId: 'w1', sandbox: 'alpha', material: 'VfxComet', name: '_Intensity' }), /not running on the machine/);
});
