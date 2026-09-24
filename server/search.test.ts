import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchTranscripts, snippet, terms } from './search.ts';
import type { SessionInfo, TranscriptEvent } from '../shared/types.ts';

const session = (id: string, over: Partial<SessionInfo>): SessionInfo => ({
  id,
  kind: 'worker',
  title: id,
  status: 'idle',
  permissionMode: 'default',
  createdAt: '',
  lastActivityAt: '',
  turns: 0,
  costUsd: 0,
  pendingPermissions: [],
  ...over,
});

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (id: string, events: Partial<TranscriptEvent>[]) =>
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), events.map((e, i) => JSON.stringify({ seq: i + 1, ...e })).join('\n') + '\n');
  write('w1', [
    { t: '2026-09-20T10:00:00Z', kind: 'user', text: 'Fix the belt splitter', from: 'human' },
    { t: '2026-09-20T10:05:00Z', kind: 'assistant', text: 'The BeltSystem has a null\nreference in Tick().' },
    { t: '2026-09-20T10:06:00Z', kind: 'tool_use', toolUseId: 'a', name: 'Bash', input: { command: 'grep -rn "BeltSystem" Assets' } },
  ] as Partial<TranscriptEvent>[]);
  write('m1', [{ t: '2026-09-22T09:00:00Z', kind: 'assistant', text: 'BeltSystem fixed on the Mac: "null reference" gone.' }] as Partial<TranscriptEvent>[]);
  write('orch', [{ t: '2026-09-23T08:00:00Z', kind: 'assistant', text: 'Started a worker for the belts.' }] as Partial<TranscriptEvent>[]);
  const sessions = new Map([
    ['w1', session('w1', { title: 'Belt fix', sandboxId: 'sb1' })],
    ['m1', session('m1', { title: 'Mac belt check', machineId: 'm5' })],
    ['orch', session('orch', { kind: 'orchestrator', title: 'Main' })],
  ]);
  return { dir, sessions };
}

test('search: all words must match, newest first, with where and a snippet', (t) => {
  const { dir, sessions } = setup(t);
  const r = searchTranscripts(dir, sessions, { q: 'beltsystem null' });
  assert.deepEqual(
    r.hits.map((h) => [h.sessionId, h.seq, h.kind]),
    [
      ['m1', 1, 'assistant'],
      ['w1', 2, 'assistant'],
    ],
  );
  assert.equal(r.hits[0].machineId, 'm5');
  assert.equal(r.hits[1].sandboxId, 'sb1');
  assert.equal(r.hits[1].snippet, 'The BeltSystem has a null reference in Tick().');
  assert.equal(searchTranscripts(dir, sessions, { q: '"null reference"' }).hits.length, 2, 'a phrase across a newline and inside quotes');
  assert.equal(searchTranscripts(dir, sessions, { q: 'grep assets' }).hits[0].kind, 'tool_use', 'tool inputs are searched');
  assert.equal(searchTranscripts(dir, sessions, { q: 'zebra' }).hits.length, 0);
  assert.equal(searchTranscripts(dir, sessions, { q: '   ' }).hits.length, 0);
});

test('search: filters by session set and by date', (t) => {
  const { dir, sessions } = setup(t);
  assert.deepEqual(
    searchTranscripts(dir, sessions, { q: 'belt', sessionIds: new Set(['w1']) }).hits.map((h) => h.sessionId),
    ['w1', 'w1', 'w1'],
  );
  assert.deepEqual(
    searchTranscripts(dir, sessions, { q: 'belt', since: '2026-09-22' }).hits.map((h) => h.sessionId),
    ['orch', 'm1'],
  );
  assert.deepEqual(
    searchTranscripts(dir, sessions, { q: 'belt', until: '2026-09-20' }).hits.map((h) => h.seq),
    [3, 2, 1],
    'a bare until date includes that whole day',
  );
});

test('search: terms and snippets', () => {
  assert.deepEqual(terms('Belt "null reference"  tick'), ['belt', 'null reference', 'tick']);
  const long = 'x'.repeat(300) + ' needle ' + 'y'.repeat(300);
  const s = snippet(long, ['needle']);
  assert.ok(s.startsWith('…') && s.endsWith('…') && s.includes('needle') && s.length < 200);
});
