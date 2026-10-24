// w1996: a daemon with a bench queue history sends its hours to the portal after the welcome (a real daemon in this process,
// server/testMachine.ts, linked to a MachineManager wired as server/index.ts wires benchHours), and one with none sends nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import type { Config } from './config.ts';
import { createTestMachine, until } from './testMachine.ts';
import { BenchHoursStore } from './benchHoursStore.ts';
import { benchHistoryFiles } from '../machine/benchHours.ts';

test('w1996: the daemon sends its bench hours after the welcome, and the portal keeps them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-hours-daemon-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-hours-root-'));
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
  const kept = new BenchHoursStore({ dataDir: dir });
  const seen: unknown[] = [];
  machines.benchHours = (id, rows) => {
    seen.push(rows);
    kept.merge(id, rows);
  };
  t.after(async () => {
    await pc.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await pc.connect(machines);
  const daemon = pc.daemon as unknown as { cfg: { root?: string }; ws?: { terminate(): void }; reportBenchHours(): Promise<void> };
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(seen, [], 'a machine with no worker root, or no bench history, sends nothing');

  // a hold of 10 minutes that ended a moment ago, in the queue's own place
  const end = Date.now() - 60_000;
  const [, cur] = benchHistoryFiles(root);
  fs.mkdirSync(path.dirname(cur), { recursive: true });
  const line = (ev: string, ts: number, extra: object = {}) => JSON.stringify({ at: new Date(ts).toISOString(), ts: ts / 1000, ev, ticket: 't00000001', mode: 'exclusive', what: 'probe', session: 's1', sandbox: 'alpha', requests: ['w1996'], ...extra });
  fs.writeFileSync(cur, [line('take', end - 700_000), line('grant', end - 600_000, { waited_s: 100 }), line('release', end, { held_s: 600 })].join('\n') + '\n');
  daemon.cfg.root = root;

  // the link drops and comes back: the welcome carries the hours
  daemon.ws!.terminate();
  await until('the daemon reports its hours after the welcome', () => seen.length > 0, 30_000);
  const rows = kept.hours('pc');
  assert.ok(rows.length >= 1 && rows.length <= 2, 'the hold spans one or two UTC hours');
  assert.equal(rows.reduce((a, r) => a + r.exclusiveS, 0), 600);
  assert.equal(rows.reduce((a, r) => a + r.holds, 0), rows.length);
  assert.ok(rows.every((r) => r.byRequest.w1996 > 0));
});
