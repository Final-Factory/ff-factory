import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './sessions.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';

test('agent titles: one line, trimmed, at most 80 characters, and stored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-sessions-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessions = new SessionManager({ limits: { maxSessions: 6 } } as Config, store);
  const s = sessions.create({ kind: 'worker', title: 'Fix the null reference in BeltSystem when splitting', permissionMode: 'default', options: () => ({}) });
  assert.equal(sessions.setTitle(s.info.id, '  Belt splitter\n fix  (spec 098) '), 'Belt splitter fix (spec 098)');
  assert.equal(store.sessions.get(s.info.id)!.title, 'Belt splitter fix (spec 098)');
  assert.throws(() => sessions.setTitle(s.info.id, '   '), /empty/);
  assert.throws(() => sessions.setTitle(s.info.id, 'x'.repeat(81)), /80/);
  assert.throws(() => sessions.setTitle('nope', 'x'), /no session/);
});
