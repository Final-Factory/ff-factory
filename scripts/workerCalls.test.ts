import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kindOf, summarize } from './worker-calls.ts';

/** scripts/worker-calls.ts (w1478): counts a worker session's model calls by message id, main thread only. */

const tool = (name: string, input: Record<string, unknown>) => ({ name, input, id: 'x' });

test('kindOf: the buckets docs/spend.md reports', () => {
  assert.equal(kindOf(tool('Bash', { command: 'sed -n 1,40p a.ts' })), 'read');
  assert.equal(kindOf(tool('Bash', { command: 'gh pr checks 3' })), 'ci-poll');
  assert.equal(kindOf(tool('Bash', { command: 'until grep -q DONE x.log; do sleep 20; done' })), 'wait');
  assert.equal(kindOf(tool('Bash', { command: 'ff-pr push --base main' })), 'pr');
  assert.equal(kindOf(tool('Grep', { pattern: 'x' })), 'read');
  assert.equal(kindOf(tool('mcp__UnityMCP__run_tests', {})), 'unity');
  assert.equal(kindOf(tool('Bash', { command: 'npm test' })), 'shell');
});

test('summarize: one call per message id, sidechain lines left out, read runs and parallel calls counted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wcalls-'));
  const dir = path.join(root, 'F--ffw-sandboxes-slot9');
  fs.mkdirSync(dir);
  const lines: object[] = [{ type: 'user', message: { content: 'You are on request w1 for x' }, timestamp: '2026-10-18T10:00:00Z' }];
  const call = (id: string, tools: object[], ctx: number) =>
    tools.map((t, i) => ({ type: 'assistant', timestamp: '2026-10-18T10:00:01Z', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_read_input_tokens: ctx - 1, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: `${id}-${i}`, ...t }] } }));
  for (let i = 0; i < 6; i++) lines.push(...call(`r${i}`, [{ name: 'Read', input: { file_path: `f${i}` } }], 1000));
  lines.push(...call('p', [{ name: 'Grep', input: { pattern: 'a' } }, { name: 'Grep', input: { pattern: 'b' } }], 2000));
  lines.push(...call('e', [{ name: 'Edit', input: {} }], 3000));
  lines.push({ type: 'assistant', isSidechain: true, message: { id: 'side', model: 'claude-opus-5-5', usage: { input_tokens: 9 }, content: [] } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const s = summarize({ root, match: /sandboxes-slot/, days: 30 });
  assert.equal(s.sessions, 1);
  assert.equal(s.calls, 8);
  assert.equal(s.multiToolShare, 12.5);
  assert.equal(s.readRunsOf5PlusShare, 87.5);
  assert.equal(s.contextPerCall, Math.round((6 * 1000 + 2000 + 3000) / 8));
  assert.equal(s.callsPerTurn, 8);
});
