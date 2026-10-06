import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './sessions.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';

test('after a portal restart a machine agent that was mid-turn shows stopped, saying it may still run there (w424)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-sessions-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = { kind: 'worker' as const, title: 't', permissionMode: 'default' as const, createdAt: 'x', lastActivityAt: 'x', turns: 1, costUsd: 0, pendingPermissions: [], machineId: 'lothdesktop', machineSandbox: 'ghosts-fly' };
  store.putSession({ ...base, id: 'busy', status: 'running' });
  store.putSession({ ...base, id: 'idle', status: 'idle' });
  const sessions = new SessionManager({} as Config, store);
  const handle = (info: SessionInfo) => ({ info, live: false, lastFrom: 'human' as const, send: () => 'u', interrupt: async () => undefined, setMode: async () => undefined, stop: () => undefined, decide: () => false });
  const cutOff = sessions.restore(() => undefined, handle);
  assert.deepEqual(cutOff.map((i) => i.id), ['busy']);
  assert.equal(store.sessions.get('busy')!.status, 'stopped');
  assert.match(store.sessions.get('busy')!.statusDetail ?? '', /^was running when the portal stopped; not heard from its daemon since \(it may still be running there\)$/);
  assert.equal(store.sessions.get('idle')!.statusDetail, undefined, 'an idle one: nothing to say');
});

test('agent titles: one line, trimmed, at most 80 characters, and stored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-sessions-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessions = new SessionManager({} as Config, store);
  const s = sessions.create({ kind: 'worker', title: 'Fix the null reference in BeltSystem when splitting', permissionMode: 'default', options: () => ({}) });
  assert.equal(sessions.setTitle(s.info.id, '  Belt splitter\n fix  (spec 098) '), 'Belt splitter fix (spec 098)');
  assert.equal(store.sessions.get(s.info.id)!.title, 'Belt splitter fix (spec 098)');
  assert.throws(() => sessions.setTitle(s.info.id, '   '), /empty/);
  assert.throws(() => sessions.setTitle(s.info.id, 'x'.repeat(81)), /80/);
  assert.throws(() => sessions.setTitle('nope', 'x'), /no session/);
});
