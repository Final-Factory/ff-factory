import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CATALOG } from './launch.ts';
import { refreshKeptTools, sdkToolsNow, type ToolNow } from './keptTools.ts';
import { AgentSession, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { SessionInfo } from '../shared/types.ts';

/**
 * w2626 (lothsahn: "File a fix so workers' tool search shows the current tool descriptions"): after PR #773 gave
 * list_ffbox_files `what: "threads"`, a resumed worker's ToolSearch still showed `symbols|reports|diagnosis`. Claude Code keeps
 * the schema it first loaded in the transcript (a `deferred_tools_record`) and resolves the same name against it on resume.
 */

type Shape = Record<string, z.ZodType>;
const SHAPES = CATALOG as unknown as Record<string, Shape>;
const noop = async () => ({ content: [] });
const DESC = 'List FFBox files.';

/** The list_ffbox_files of before PR #773: no "threads". */
const OLD_SHAPE: Shape = { ...SHAPES.list_ffbox_files, what: z.enum(['symbols', 'reports', 'diagnosis']).describe('symbols, reports or diagnosis.') };

const server = (tools: [string, Shape, string?][]) => createSdkMcpServer({ name: 'machine', version: '1.0.0', tools: tools.map(([n, s, d]) => tool(n, d ?? DESC, s, noop)) });

/** What a client of the server lists, over a real MCP connection. */
async function listed(srv: ReturnType<typeof createSdkMcpServer>): Promise<Map<string, ToolNow>> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (srv as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(a);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(b);
  const out = new Map((await c.listTools()).tools.map((t) => [`mcp__machine__${t.name}`, { description: t.description ?? '', input_schema: t.inputSchema }]));
  await c.close();
  return out;
}

/** A transcript line as Claude Code 2.1.312 writes it when ToolSearch first loads tools. */
const recordLine = (uuid: string, parent: string | null, entries: [string, ToolNow][]) =>
  JSON.stringify({ parentUuid: parent, isSidechain: false, attachment: { type: 'deferred_tools_record', entries: entries.map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true, defer_loading: true })) }, type: 'attachment', uuid, timestamp: '2026-10-31T01:34:06.000Z', sessionId: 'conv-2626' });
const userLine = (uuid: string, parent: string | null, text: string) => JSON.stringify({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, sessionId: 'conv-2626' });

/**
 * A model of Claude Code's resolution on resume (claude.exe 2.1.312: R9n seeds references from the records, nn() resolves a
 * new reference against a kept entry): a recorded entry wins, the current tool otherwise.
 */
function toolSearch(file: string, name: string, current: Map<string, ToolNow>): ToolNow | undefined {
  let kept: ToolNow | undefined;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const a = JSON.parse(l).attachment;
    if (a?.type !== 'deferred_tools_record') continue;
    for (const e of a.entries) if (e.name === name) kept = { description: e.description, input_schema: e.input_schema };
  }
  return kept ?? current.get(name);
}
const whatEnum = (t: ToolNow | undefined) => (t?.input_schema as { properties: { what: { enum: string[] } } } | undefined)?.properties.what.enum;

test('w2626: sdkToolsNow gives every catalog tool exactly as a client of the server lists it', async () => {
  const names = Object.keys(SHAPES);
  const now = sdkToolsNow({ machine: server(names.map((n) => [n, SHAPES[n], `${n}: what it does.`])) });
  const real = await listed(server(names.map((n) => [n, SHAPES[n], `${n}: what it does.`])));
  assert.equal(now.size, names.length);
  for (const [name, t] of real) assert.deepEqual(now.get(name), t, name);
  assert.deepEqual(whatEnum(now.get('mcp__machine__list_ffbox_files')), ['symbols', 'reports', 'diagnosis', 'threads']);
  // what is not an in-process server, or cannot be read, adds nothing
  assert.equal(sdkToolsNow({ unity: { type: 'stdio', command: 'x' }, odd: { type: 'sdk', name: 'odd' } as never }).size, 0);
  assert.equal(sdkToolsNow(undefined).size, 0);
});

test('w2626: a record of a changed schema or description is dropped in place at its own length; a current one, another tool and a departed one stay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-kept-'));
  try {
    const before = await listed(server([['list_ffbox_files', OLD_SHAPE], ['read_work', SHAPES.read_work], ['wake_me', SHAPES.wake_me, 'Old words.'], ['gone_tool', SHAPES.read_work]]));
    const now = sdkToolsNow({ machine: server([['list_ffbox_files', SHAPES.list_ffbox_files], ['read_work', SHAPES.read_work], ['wake_me', SHAPES.wake_me]]) });
    const file = path.join(dir, 'conv-2626.jsonl');
    const lines = [
      userLine('u1', null, 'hello'),
      recordLine('r1', 'u1', [['mcp__machine__list_ffbox_files', before.get('mcp__machine__list_ffbox_files')!], ['mcp__machine__read_work', before.get('mcp__machine__read_work')!]]),
      userLine('u2', 'r1', 'more'),
      recordLine('r2', 'u2', [['mcp__machine__wake_me', before.get('mcp__machine__wake_me')!], ['mcp__machine__gone_tool', before.get('mcp__machine__gone_tool')!], ['mcp__other__list_ffbox_files', before.get('mcp__machine__list_ffbox_files')!]]),
      recordLine('r3', 'r2', [['mcp__machine__read_work', before.get('mcp__machine__read_work')!]]),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const bytes = fs.readFileSync(file);
    // before the fix: the resumed conversation's ToolSearch shows the old enum (the bug)
    assert.deepEqual(whatEnum(toolSearch(file, 'mcp__machine__list_ffbox_files', now)), ['symbols', 'reports', 'diagnosis']);

    assert.deepEqual(refreshKeptTools(file, now).sort(), ['mcp__machine__list_ffbox_files', 'mcp__machine__wake_me']);
    const after = fs.readFileSync(file);
    assert.equal(after.length, bytes.length, 'the file keeps its length');
    const out = after.toString('utf8').split('\n');
    assert.equal(out.length, lines.length + 1);
    for (let i = 0; i < lines.length; i++) assert.equal(Buffer.byteLength(out[i]), Buffer.byteLength(lines[i]), `line ${i + 1} keeps its length`);
    assert.equal(out[0], lines[0]);
    assert.equal(out[2], lines[2]);
    assert.equal(out[4], lines[4], 'an unchanged record stays byte for byte');
    const r1 = JSON.parse(out[1]);
    const r2 = JSON.parse(out[3]);
    assert.equal(r1.parentUuid, 'u1');
    assert.equal(r1.uuid, 'r1');
    assert.deepEqual(r1.attachment.entries.map((e: { name: string }) => e.name), ['mcp__machine__read_work']);
    assert.deepEqual(r2.attachment.entries.map((e: { name: string }) => e.name), ['mcp__machine__gone_tool', 'mcp__other__list_ffbox_files'], 'a departed tool and another server keep theirs');
    assert.match(out[1], /^\{.*\}$/, 'the padding sits inside the JSON');

    // the next ToolSearch resolves against the tool as it is now
    assert.deepEqual(whatEnum(toolSearch(file, 'mcp__machine__list_ffbox_files', now)), ['symbols', 'reports', 'diagnosis', 'threads']);
    assert.equal(toolSearch(file, 'mcp__machine__wake_me', now)?.description, DESC);
    // a second pass finds nothing to do and leaves the file as it is
    assert.deepEqual(refreshKeptTools(file, now), []);
    assert.deepEqual(fs.readFileSync(file), after);
    // no file, no tools: nothing
    assert.deepEqual(refreshKeptTools(path.join(dir, 'none.jsonl'), now), []);
    assert.deepEqual(refreshKeptTools(file, new Map()), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w2626: a line still being written (no JSON yet) is left alone, and the rest of the file is still refreshed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-kept-'));
  try {
    const before = await listed(server([['list_ffbox_files', OLD_SHAPE]]));
    const now = sdkToolsNow({ machine: server([['list_ffbox_files', SHAPES.list_ffbox_files]]) });
    const file = path.join(dir, 'c.jsonl');
    const rec = recordLine('r1', null, [['mcp__machine__list_ffbox_files', before.get('mcp__machine__list_ffbox_files')!]]);
    const half = rec.slice(0, Math.floor(rec.length / 2));
    fs.writeFileSync(file, `${rec}\n${half}`);
    assert.deepEqual(refreshKeptTools(file, now), ['mcp__machine__list_ffbox_files']);
    const out = fs.readFileSync(file, 'utf8').split('\n');
    assert.deepEqual(JSON.parse(out[0]).attachment.entries, []);
    assert.equal(out[1], half);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("w2626: a worker's resumed conversation, in a new process with a tool that gained an enum value, finds the new schema in tool search", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-kept-session-'));
  const store = new Store(path.join(dir, 'store'));
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cwd = path.join(dir, 'sandboxes', 'slot3');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'conv-2626.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // the conversation so far: its first process loaded list_ffbox_files before "threads" existed
  const old = await listed(server([['list_ffbox_files', OLD_SHAPE]]));
  fs.writeFileSync(file, [userLine('u1', null, 'w2618'), recordLine('r1', 'u1', [['mcp__machine__list_ffbox_files', old.get('mcp__machine__list_ffbox_files')!]])].join('\n') + '\n');

  // the new process (a new host after the update): its tool search answers from the transcript as Claude Code does
  let seen: number[] | string[] | undefined;
  let started = false;
  setQueryForTesting((({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
    started = true;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'conv-2626', model: 'm', uuid: 'init' };
      const current = await listed(options.mcpServers!.machine as ReturnType<typeof createSdkMcpServer>);
      for await (const _ of prompt) {
        void _;
        seen = whatEnum(toolSearch(file, 'mcp__machine__list_ffbox_files', current));
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, duration_ms: 1, session_id: 'conv-2626', uuid: 'res' };
        return;
      }
    })();
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const info: SessionInfo = { id: 'sess-2626', kind: 'worker', title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0, pendingPermissions: [], sdkSessionId: 'conv-2626' };
  store.putSession(info);
  const s = new AgentSession({ ...info }, store, () => ({ cwd, env, mcpServers: { machine: server([['list_ffbox_files', SHAPES.list_ffbox_files]]) } }), new EventEmitter());
  s.send('list the threads');
  for (let i = 0; i < 100 && seen === undefined; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(started, 'the process started');
  assert.deepEqual(seen, ['symbols', 'reports', 'diagnosis', 'threads']);
  const note = store.readTranscript('sess-2626').find((e) => e.kind === 'system' && /w2626/.test(e.text));
  assert.ok(note, 'the session says which schemas it refreshed');
});
