import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPILE_DONE, COMPILE_FAILED, readSince, Waker } from './wake.ts';
import { Store } from './store.ts';
import type { SessionManager } from './sessions.ts';
import type { SessionInfo } from '../shared/types.ts';

const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  title: id,
  status: 'idle',
  permissionMode: 'default',
  createdAt: '',
  lastActivityAt: new Date().toISOString(),
  turns: 0,
  costUsd: 0,
  pendingPermissions: [],
  ...over,
});

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-wake-'));
  const store = new Store(dir);
  const sent: { id: string; text: string }[] = [];
  const sessions = {
    sessions: new Map([['w1', {}], ['orch', {}]]),
    get: (id: string) => {
      if (!['w1', 'orch'].includes(id)) throw new Error(`no session "${id}"`);
      return {};
    },
    send: (id: string, text: string) => (sent.push({ id, text }), 'u'),
  } as unknown as SessionManager;
  const w = new Waker(sessions, store);
  let now = 1_000_000;
  w.now = () => now;
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { w, store, sent, advance: (ms: number) => (now += ms) };
}

test('wake_me: the note comes back after N minutes; a new wake replaces the old; cancel works', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, sent } = setup(t);
  assert.match(w.schedule('w1', 30, 'check the build'), /\(30 min\)/);
  t.mock.timers.tick(29 * 60_000);
  assert.equal(sent.length, 0);
  w.schedule('w1', 5, 'actually check the tests');
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(sent, [{ id: 'w1', text: '[wake_me] Time is up. Your note: actually check the tests' }]);
  t.mock.timers.tick(60 * 60_000);
  assert.equal(sent.length, 1, 'the replaced wake never fires');
  w.schedule('orch', 10, 'x');
  assert.equal(w.cancel('orch'), true);
  t.mock.timers.tick(20 * 60_000);
  assert.equal(sent.length, 1);
  assert.throws(() => w.schedule('w1', 0, 'x'), /minutes/);
  assert.throws(() => w.schedule('nope', 5, 'x'), /no session/);
});

test('heartbeat: only while a worker is busy, every N minutes, never over a busy orchestrator', (t) => {
  const { w, store, sent, advance } = setup(t);
  const beat = (m: number | null) => w.heartbeat('orch', m, (s) => `${s.id} ${s.status}`);
  store.putSession(info('orch', { kind: 'orchestrator' }));
  store.putSession(info('w1'));
  beat(15);
  advance(60 * 60_000);
  beat(15);
  assert.equal(sent.length, 0, 'everything idle: no wakes');

  store.putSession(info('w1', { status: 'running' }));
  beat(15); // busy starts now
  advance(14 * 60_000);
  beat(15);
  assert.equal(sent.length, 0);
  advance(60_000);
  beat(15);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^\[heartbeat\] 1 worker\(s\) busy:\n- w1 running/);

  advance(15 * 60_000);
  store.putSession(info('orch', { kind: 'orchestrator', status: 'running' }));
  beat(15);
  assert.equal(sent.length, 1, 'the orchestrator is mid-turn: skipped');
  store.putSession(info('orch', { kind: 'orchestrator', status: 'idle' }));
  beat(15);
  assert.equal(sent.length, 2);
  advance(30 * 60_000);
  beat(null);
  assert.equal(sent.length, 2, 'off');
});

test('wait_for_unity: compile markers and reading only what the log gained', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'Editor.log');
  fs.writeFileSync(log, 'old stuff\nReloading assemblies after finishing script compilation.\n');
  const start = readSince(log, 0).size;
  fs.appendFileSync(log, 'Assets/Scripts/Belt.cs(12,5): error CS1002: ; expected\n');
  const r = readSince(log, start);
  assert.ok(COMPILE_FAILED.test(r.text));
  assert.ok(!COMPILE_DONE.test(r.text), 'the earlier reload is not in the new part');
  assert.ok(COMPILE_DONE.test('Domain Reload Profiling: 1234ms'));
  assert.equal(readSince(path.join(dir, 'missing.log'), 0).size, 0);
  assert.equal(readSince(log, 10_000_000).text.length > 0, true, 'a shorter log (editor restarted) is read from the start');
});
