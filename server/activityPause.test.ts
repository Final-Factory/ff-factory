// The activity pause as a per-machine setting (w1574), end to end below the browser: a real daemon in this process
// (server/testMachine.ts) linked to a MachineManager wired as server/index.ts wires it. lothsahn: "if the mouse and keyboard
// was being used the worker would go to sleep. That needs to be configurable. We want it off on all of the workers currently
// so that they continue to work even if a user is at the station." and "I will be adding some new workers soon that will
// want that on."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { setAppConfig } from './appConfig.ts';
import { machineActivityPause, type Config } from './config.ts';
import { createTestMachine, until } from './testMachine.ts';
import type { MachinePause } from '../shared/types.ts';

test('w1574: off by default, input never pauses; the portal turns it on for one machine, the tray turns it off again', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-pause-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}\n');
  const cfg = {
    dataDir: dir,
    port: 0,
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  const pc = await createTestMachine({ sandboxes: ['alpha'] });
  store.putMachine(pc.record({}));
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  };
  // As server/index.ts: config machines.activityPause is the machine's setting; the tray's choice is written there.
  machines.activityFor = (id) => machineActivityPause(cfg, id);
  machines.onActivitySet = (id, a) => {
    setAppConfig(file, cfg, 'machines.activityPause.enabled', a.enabled, { machine: id });
    return true;
  };
  const unpaused: string[] = [];
  machines.onPause = (id, p) => void (p.paused ? undefined : unpaused.push(id));
  t.after(async () => {
    console.log = log;
    await pc.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await pc.connect(machines);
  const daemon = pc.daemon!;
  const tray = (m: Record<string, unknown>) => (daemon as unknown as { onTray(m: Record<string, unknown>): void }).onTray(m);
  const onPortal = () => store.machines.get('pc')?.pause;
  await until('the daemon reports its pause', () => onPortal()?.settings !== undefined, 20_000);

  // Off on a machine nobody set: a person's clicks and keys (as the tray sends them) never pause it.
  assert.deepEqual(onPortal()!.settings!.activity, { enabled: false, idleMinutes: 90 }, 'read back from the machine: off');
  for (const kind of ['click', 'key', 'click']) tray({ type: 'input', kind, at: Date.now() });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(daemon.pause.current().paused, false);
  assert.equal(onPortal()!.paused, false, 'input while off: the machine keeps taking work');

  // The portal turns it on for this machine (the settings tool or the machine panel) with 45 minutes: the daemon has it.
  setAppConfig(file, cfg, 'machines.activityPause.enabled', true, { machine: 'pc' });
  setAppConfig(file, cfg, 'machines.activityPause.idleMinutes', 45, { machine: 'pc' });
  machines.pushActivityConfig('pc');
  await until('the machine reports it on', () => onPortal()?.settings?.activity.enabled === true && onPortal()?.settings?.activity.idleMinutes === 45, 20_000);
  assert.equal(machineActivityPause(cfg, 'other').enabled, false, 'the other machines stay off');
  tray({ type: 'input', kind: 'click', at: Date.now() });
  await until('a click now pauses it', () => onPortal()?.paused === true && onPortal()?.reason === 'activity', 20_000);

  // The tray's "Pause when someone uses this PC" turned off: config follows, and the machine takes work at once.
  tray({ type: 'settings', settings: { ...daemon.pause.currentSettings(), activity: { enabled: false, idleMinutes: 45 } } });
  await until('the portal keeps the tray\'s choice', () => machineActivityPause(cfg, 'pc').enabled === false, 20_000);
  await until('running again', () => onPortal()?.paused === false && onPortal()?.settings?.activity.enabled === false, 20_000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).machines.activityPause.enabled, { pc: false });
  assert.ok(unpaused.includes('pc'));
  assert.ok(lines.some((l) => l.includes('machine pc: activity pause off on the machine')), lines.join('\n'));

  // A daemon from before w1574 still pauses on input by itself: with the setting off, the portal neither holds it nor takes
  // its work.
  const old: MachinePause = { paused: true, reason: 'activity', detail: 'someone is using this PC', until: new Date(Date.now() + 90 * 60_000).toISOString(), settings: { ...daemon.pause.currentSettings(), activity: { enabled: true, idleMinutes: 90 } }, at: new Date().toISOString() };
  (machines as unknown as { takePause(id: string, p: unknown): void }).takePause('pc', old);
  assert.equal(onPortal()!.paused, false);
  assert.match(onPortal()!.detail, /input ignored: the activity pause is off for pc/);
});
