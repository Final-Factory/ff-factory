import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextCycles, contextReport, messageKind } from './contextGrowth.ts';
import { readPortalLogs } from './portalLogs.ts';
import { CHARS_PER_TOKEN } from '../shared/spend.ts';

/** w1866: what fills a coordinator's context between compactions, from Claude Code's own transcript, as counts only. */

const SECRET_WORDS = 'the-private-words-of-a-person';
let seq = 0;
const at = (m: number) => new Date(Date.parse('2026-10-23T10:00:00Z') + m * 60_000).toISOString();
const line = (d: Record<string, unknown>) => JSON.stringify({ uuid: `u${++seq}`, ...d });
const call = (id: string, ctx: number, out: number, m: number, blocks: unknown[] = [{ type: 'text', text: 'ok' }]) =>
  line({ type: 'assistant', timestamp: at(m), message: { id, content: blocks, usage: { input_tokens: 10, cache_read_input_tokens: ctx - 110, cache_creation_input_tokens: 100, output_tokens: out } } });
const prompt = (text: string, m: number) => line({ type: 'user', timestamp: at(m), message: { role: 'user', content: text } });
const result = (id: string, text: string, m: number) => line({ type: 'user', timestamp: at(m), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input });

const RELAY = 'Tell the user what matters in a line or two, and say what every id is, every time, on every appearance: the paragraph that repeats.';

function transcript(): string {
  seq = 0;
  return [
    // a cycle that began before the window: the person asks, the orchestrator lists its timers
    prompt(`[from Lothsahn]\nhow is it going ${SECRET_WORDS}`, 0),
    call('c1', 30_000, 100, 0, [use('t1', 'mcp__sandboxes__list_timers')]),
    result('t1', 'x'.repeat(2300), 1),
    call('c2', 31_100, 50, 1),
    // a worker's report with the relay paragraph, twice: the second time it is repeated text
    prompt(`[worker update] w1 finished a turn.\n\n${'r'.repeat(460)}\n\n${RELAY}`, 2),
    call('c3', 31_500, 20, 2),
    prompt(`[worker update] w2 finished a turn.\n\n${'s'.repeat(460)}\n\n${RELAY}`, 3),
    call('c4', 31_900, 20, 3),
    // the same line again (a resumed process wrote it twice): counted once
    // a subagent's line: not the coordinator's context
    line({ type: 'assistant', isSidechain: true, timestamp: at(3), message: { id: 'side', content: [], usage: { input_tokens: 999_999, output_tokens: 1 } } }),
    // compaction, its summary and a re-attached file
    line({ type: 'system', subtype: 'compact_boundary', timestamp: at(4), compactMetadata: { trigger: 'auto', preTokens: 31_900, postTokens: 6_000 } }),
    line({ type: 'user', isCompactSummary: true, timestamp: at(4), message: { role: 'user', content: 'S'.repeat(4600) } }),
    line({ type: 'attachment', timestamp: at(4), attachment: { type: 'file', filename: '/srv/fff/data/reports/m5-ab.md', content: { type: 'text', file: { filePath: 'm5-ab.md', content: 'F'.repeat(2300) } } } }),
    line({ type: 'attachment', timestamp: at(4), attachment: { type: 'prompt_snapshot', systemPrompt: ['P'.repeat(23_000)] } }),
    prompt('[timer abc12345 "close finished requests"] Close what is done.', 5),
    call('c5', 20_000, 100, 5, [use('t2', 'mcp__sandboxes__list_work', { id: 'w1' }), use('t3', 'mcp__sandboxes__list_work', {})]),
    result('t2', 'w'.repeat(4600), 5),
    result('t3', 'l'.repeat(2300), 5),
    call('c5b', 23_100, 10, 5),
    // a call written over several lines (one per content block): one call
    call('c5b', 23_100, 40, 5),
    prompt('[dispatch] w3 "x": started.', 6),
    call('c6', 23_200, 10, 6),
  ].join('\n');
}

test('w1866: messages are sorted by their tag, a person\'s own words apart from the harness\'s', () => {
  assert.equal(messageKind('[from Lothsahn]\nhi'), 'person');
  assert.equal(messageKind('[via FFBox: lothsahn] hi'), 'person');
  assert.equal(messageKind('[from FFBox, conversation 3] hi'), 'from FFBox');
  assert.equal(messageKind('[worker update] x finished'), 'worker update');
  assert.equal(messageKind('[timer t1 "x"] note'), 'timer');
  assert.equal(messageKind('[dispatch] w3 "x"'), 'dispatch');
  assert.equal(messageKind('[heartbeat] 3 open'), 'heartbeat');
  assert.equal(messageKind('<command-name>/compact</command-name>'), 'command');
  assert.equal(messageKind('plain'), 'untagged');
});

test('w1866: cycles, their start, their measured growth and each source by name', () => {
  const cycles = contextCycles(transcript());
  assert.equal(cycles.length, 2);
  const [a, b] = cycles;
  assert.equal(a.began.kind, 'window');
  assert.deepEqual(a.ended, { kind: 'compaction', trigger: 'auto', pre: 31_900, post: 6_000 });
  assert.equal(a.startCtx, 30_000);
  assert.equal(a.calls, 4, 'the sidechain call is not the coordinator\'s');
  assert.equal(a.growth, 1_900);
  assert.equal(a.turns, 3);
  assert.equal(a.ownOut, 100 + 50 + 20);
  assert.equal(a.sources.get('tool: list_timers')?.chars, 2300);
  // the relay paragraph is repeated text the second time only
  assert.equal(a.sources.get('message: worker update')?.repeat, RELAY.length);

  assert.equal(b.startCtx, 20_000);
  assert.equal(b.systemPrompt, 23_000);
  assert.deepEqual(b.reattached, [{ name: 'm5-ab.md', chars: 2300 + 'm5-ab.md'.length }]);
  assert.equal(b.startParts.get('compaction summary'), 4600);
  assert.equal(b.calls, 3, 'one call over several lines is one call');
  assert.equal(b.growth, 3_200);
  assert.equal(b.ownOut, 100 + 40, 'the larger output of a call written over several lines');
  assert.equal(b.sources.get('tool: list_work id')?.chars, 4600);
  assert.equal(b.sources.get('tool: list_work list')?.chars, 2300);
  assert.equal(b.kinds.get('timer')?.tokens, 3_100);
  assert.equal(b.kinds.get('dispatch')?.tokens, 100);
});

test('w1866: the report is counts only, every line starts with the coordinator, and a shrink with no marker starts a cycle', () => {
  const lines = contextReport("Lothsahn's orchestrator", contextCycles(transcript()));
  const text = lines.join('\n');
  assert.ok(lines.every((l) => l.startsWith("Lothsahn's orchestrator: ") && l.length <= 1000));
  assert.doesNotMatch(text, new RegExp(SECRET_WORDS));
  assert.doesNotMatch(text, /Tell the user/);
  assert.match(text, /tool: list_timers: 1,000 /);
  assert.match(text, /tool: list_work id: 2,000 /);
  assert.match(text, /Re-attached: m5-ab\.md /);
  assert.match(text, /timer: 1 turn\(s\), 3,100 tokens/);
  assert.equal(Math.round(2300 / CHARS_PER_TOKEN), 1000);

  seq = 0;
  const shrink = [prompt('[from Ben] a', 0), call('k1', 90_000, 10, 0), prompt('[from Ben] b', 1), call('k2', 40_000, 10, 1), prompt('[from Ben] c', 2), call('k3', 41_000, 10, 2)].join('\n');
  const cs = contextCycles(shrink);
  assert.equal(cs.length, 2);
  assert.equal(cs[1].began.kind, 'shrink');
  assert.equal(cs[1].growth, 1_000);
});

test('w1866: portal_logs coordinator_context reads the transcripts the server names, tail first, and shows no text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-growth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'c17a0657.jsonl');
  fs.writeFileSync(file, transcript());
  const out = await readPortalLogs(
    {
      dataDir: dir,
      journal: async () => ({ lines: [] }),
      machine: () => undefined,
      machineIds: () => [],
      now: () => Date.parse('2026-10-23T12:00:00Z'),
      coordinators: () => [
        { label: "Lothsahn's orchestrator", file },
        { label: 'dispatcher', file: path.join(dir, 'missing.jsonl') },
        { label: 'link', file: path.join(dir, 'not-a-transcript.txt') },
      ],
    },
    { source: 'coordinator_context', limit: 2000 },
  );
  assert.match(out, /Lothsahn's orchestrator: transcript 0\.0 MB, read whole/);
  assert.match(out, /Lothsahn's orchestrator: cycle 2, .*began with a auto compaction/);
  assert.match(out, /dispatcher: no transcript on this host/);
  assert.doesNotMatch(out, new RegExp(SECRET_WORDS));
  const grep = await readPortalLogs(
    { dataDir: dir, journal: async () => ({ lines: [] }), machine: () => undefined, machineIds: () => [], now: () => 0, coordinators: () => [{ label: 'dispatcher', file }] },
    { source: 'coordinator_context', grep: 'list_work id' },
  );
  assert.match(grep, /2 line\(s\) of 2 matching/);
});
