import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Store, lineTime } from './store.ts';
import { describeTurnTimings, shortToolName, timeTurn, turnTimings } from './turnTiming.ts';
import type { TranscriptEvent } from '../shared/types.ts';

/** w5222: a transcript with chosen times, 07:00:00 + `s` seconds. */
const at = (s: number) => new Date(Date.parse('2026-11-23T07:00:00Z') + s * 1000).toISOString();
let seq = 0;
const ev = (s: number, e: Record<string, unknown>) => ({ ...e, seq: ++seq, t: at(s) }) as TranscriptEvent;

/**
 * The w5222 case in miniature: a turn files follow-ups one by one (each a long brief the model writes, then a fast
 * request_work), a person's question arrives after the first filing and is answered only after the last one.
 */
function bulkFilingTurn(): TranscriptEvent[] {
  const brief = 'x'.repeat(3000);
  return [
    ev(0, { kind: 'user', from: 'system', text: '[follow-ups to file] w5196 handed up 3' }),
    ev(20, { kind: 'tool_use', toolUseId: 'a', name: 'mcp__sandboxes__request_work', input: { brief } }),
    ev(20.5, { kind: 'tool_result', toolUseId: 'a', isError: false, text: 'filed w5199' }),
    ev(21, { kind: 'user', from: 'human', text: 'What is w5194?' }),
    ev(41, { kind: 'tool_use', toolUseId: 'b', name: 'mcp__sandboxes__request_work', input: { brief } }),
    ev(41.4, { kind: 'tool_result', toolUseId: 'b', isError: false, text: 'filed w5200' }),
    ev(61, { kind: 'thinking', text: 'next' }),
    ev(61, { kind: 'tool_use', toolUseId: 'c', name: 'mcp__sandboxes__request_work', input: { brief } }),
    ev(61.6, { kind: 'tool_result', toolUseId: 'c', isError: false, text: 'filed w5201' }),
    ev(65, { kind: 'assistant', text: 'w5194 hides the green brackets.' }),
    ev(65.1, { kind: 'result', ok: true, text: 'w5194 hides the green brackets.', costUsd: 1.5, turns: 4, durationMs: 65000 }),
  ];
}

test('w5222: a turn splits into model steps and tool calls, and a mid-turn question waits behind the filings', () => {
  const t = timeTurn(bulkFilingTurn());
  assert.equal(t.wallMs, 65100);
  assert.equal(t.toolMs, 1500, 'the three request_work calls');
  assert.equal(t.modelMs, 63600, 'the rest: writing the briefs and the answer');
  assert.deepEqual(t.tools.request_work.ms, [500, 400, 600]);
  assert.equal(t.steps.length, 4, 'three filings and the answer');
  assert.deepEqual(t.steps, [20000, 20000, 19600, 3400]);
  assert.ok(t.stepChars[0] > 3000);
  assert.equal(t.midTurnNotes, 0, 'the turn-opening note is not mid-turn');
  assert.equal(t.personWaits.length, 1);
  assert.equal(t.personWaits[0].ms, 44000, 'from 07:00:21 to the answer at 07:01:05');
  assert.equal(t.personWaits[0].toolCalls, 2, 'two filings ran ahead of the answer');
  assert.equal(t.sdkMs, 65000);
  const text = describeTurnTimings([t], 'the test window');
  assert.match(text, /model 63\.6s \(98%/);
  assert.match(text, /person waited 44\.0s behind 2 tool call\(s\)/);
  assert.match(text, /request_work: 3, 1\.5s, 0\.5s, 0\.6s/);
});

test('w5222: turnTimings drops a turn the window cut and a subagent\'s events, and keeps the later turns', () => {
  const cut = [ev(0, { kind: 'tool_result', toolUseId: 'z', isError: false, text: '' }), ev(1, { kind: 'result', ok: true, text: '', costUsd: 0, turns: 1, durationMs: 0 })];
  const sub = ev(30, { kind: 'tool_use', toolUseId: 's', name: 'Read', input: {}, parentToolUseId: 'a' });
  const turns = turnTimings([...cut, ...bulkFilingTurn().slice(0, 3), sub, ...bulkFilingTurn().slice(3)]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].tools.Read, undefined);
  assert.equal(shortToolName('mcp__sandboxes__request_work'), 'request_work');
  assert.equal(shortToolName('Bash'), 'Bash');
  assert.match(describeTurnTimings([], 'w'), /No whole turn/);
});

test('w5222: lineTime reads the time an event line ends with', () => {
  assert.equal(lineTime(JSON.stringify({ kind: 'user', text: '"t":"1999-01-01T00:00:00Z"}', seq: 3, t: at(5) })), Date.parse(at(5)));
  assert.equal(lineTime('{"kind":"user"}'), undefined);
  assert.equal(lineTime('torn line'), undefined);
});

test('w5222: readTranscriptBetween finds a window by offset in a long transcript, and scans a compressed one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turntiming-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  // 20,000 events a second apart, some with a 100 KB tool result (longer than a read chunk), so the search crosses big lines
  const lines: string[] = [];
  for (let i = 0; i < 20000; i++) {
    const text = i % 997 === 0 ? 'y'.repeat(100_000) : `event ${i}`;
    lines.push(JSON.stringify({ kind: 'tool_result', toolUseId: `u${i}`, isError: false, text, seq: i + 1, t: at(i) }));
  }
  const file = path.join(dir, 'transcripts', 'orch.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const r = await store.readTranscriptBetween('orch', at(12000), at(12009));
  assert.equal(r.truncated, false);
  assert.deepEqual(
    r.events.map((e) => e.seq),
    Array.from({ length: 10 }, (_, i) => 12001 + i),
  );
  assert.equal((await store.readTranscriptBetween('orch', at(0), at(2))).events.length, 3, 'the window at the very start');
  assert.equal((await store.readTranscriptBetween('orch', at(19998), at(30000))).events.length, 2, 'the window at the end');
  assert.equal((await store.readTranscriptBetween('orch', at(-50), at(-1))).events.length, 0, 'before the transcript');
  // any window, wherever its edges fall against the read chunks and the big lines, holds exactly its events
  for (let k = 0; k < 60; k++) {
    const a = Math.floor(Math.random() * 20000);
    const b = Math.min(19999, a + Math.floor(Math.random() * 40));
    const w = await store.readTranscriptBetween('orch', at(a), at(b));
    assert.deepEqual([w.events.length, w.events[0]?.seq], [b - a + 1, a + 1], `window ${a}..${b}`);
  }
  const big = await store.readTranscriptBetween('orch', at(0), at(20000), 1024 * 1024);
  assert.equal(big.truncated, true, 'a window past maxBytes is cut short and says so');
  // compressed (idle a day): the same window by a scan
  fs.writeFileSync(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file)));
  fs.rmSync(file);
  const gz = await store.readTranscriptBetween('orch', at(12000), at(12009));
  assert.equal(gz.events.length, 10);
  assert.equal(gz.events[0].seq, 12001);
});
