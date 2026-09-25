import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { activityLine, describeBusy } from './wake.ts';
import type { SessionInfo } from '../shared/types.ts';

function session(store: Store, over: Partial<SessionInfo> = {}): SessionInfo {
  const s: SessionInfo = {
    id: 'w1',
    kind: 'worker',
    title: 'belt test',
    status: 'running',
    permissionMode: 'default',
    createdAt: '2026-09-25T09:00:00Z',
    lastActivityAt: '2026-09-25T09:00:00Z',
    turns: 3,
    costUsd: 1.5,
    pendingPermissions: [],
    ...over,
  };
  store.putSession(s);
  return s;
}

test('activity: tool calls starting and ending, and streamed output, move it; a running tool call is kept', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const s = session(store);
  const tool = () => s.activeTool;
  store.append('w1', { kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'for i in $(seq 1 30); do ...; done' } });
  assert.ok(Date.parse(s.lastActivityAt) > Date.parse('2026-09-25T09:00:00Z'), 'a tool call starting is activity');
  assert.equal(tool()?.name, 'Bash');
  assert.equal(tool()?.id, 't1');
  // A subagent's tool calls are not the session's own foreground command.
  store.append('w1', { kind: 'tool_use', toolUseId: 'sub', name: 'Read', input: {}, parentToolUseId: 't0' });
  assert.equal(tool()?.id, 't1');
  // Two in parallel: the oldest shows until it ends.
  store.append('w1', { kind: 'tool_use', toolUseId: 't2', name: 'Grep', input: {} });
  assert.equal(tool()?.id, 't1');
  store.append('w1', { kind: 'tool_result', toolUseId: 't1', isError: false, text: 'done' });
  assert.equal(tool()?.id, 't2');
  store.append('w1', { kind: 'tool_result', toolUseId: 't2', isError: false, text: 'x' });
  assert.equal(tool(), undefined);
  // Streamed text (no event on file) counts too, at most every 15 s.
  s.lastActivityAt = '2026-09-25T09:00:00Z';
  store.noteActivity('w1');
  assert.equal(s.lastActivityAt, '2026-09-25T09:00:00Z', 'throttled: saved a moment ago');
  // A daemon's events (appendFull) count the same.
  store.appendFull('w1', { seq: 100, t: new Date().toISOString(), kind: 'tool_use', toolUseId: 'm1', name: 'Bash', input: {} });
  assert.equal(tool()?.id, 'm1');
  store.appendFull('w1', { seq: 101, t: new Date().toISOString(), kind: 'result', ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1 });
  assert.equal(tool(), undefined, 'a turn that ended has no tool call running');
  store.flush();
});

test('activity: "in a long command" while a tool call runs over a minute, else minutes since the last activity', () => {
  const now = Date.parse('2026-09-25T10:00:00Z');
  const base = { status: 'running' as const, lastActivityAt: '2026-09-25T09:13:00Z' };
  assert.equal(activityLine(base, now), 'last activity 47 min ago');
  assert.equal(activityLine({ ...base, activeTool: { id: 't', name: 'Bash', since: '2026-09-25T09:52:00Z' } }, now), 'in a long command: Bash (8 min)');
  assert.equal(activityLine({ ...base, activeTool: { id: 't', name: 'Bash', since: '2026-09-25T09:59:30Z' } }, now), 'last activity 47 min ago', 'a short call is not "long"');
  assert.equal(activityLine({ ...base, status: 'idle', activeTool: { id: 't', name: 'Bash', since: '2026-09-25T09:00:00Z' } }, now), 'last activity 47 min ago', 'only while busy');
  const line = describeBusy({ id: 'w1', kind: 'worker', title: 'belt test', status: 'running', permissionMode: 'default', createdAt: '', lastActivityAt: '2026-09-25T09:58:00Z', turns: 3, costUsd: 1.5, pendingPermissions: [], activeTool: { id: 't', name: 'Bash', since: '2026-09-25T09:50:00Z' } }, { machine: 'm5' }, now);
  assert.equal(line, 'w1 "belt test" on m5: running, in a long command: Bash (10 min), 3 turns, $1.50');
});
