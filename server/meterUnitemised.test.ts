import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ContextMeter, CHARS_PER_TOKEN, type Cats, type MeterState, type MeterTurn } from '../shared/spend.ts';
import { CliTranscriptTail, attachmentChars, cliTranscriptPath, rebuildMeter, replayLines } from './cliTranscript.ts';
import { AgentSession, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { SessionInfo, TranscriptEvent } from '../shared/types.ts';

/**
 * w1556 (lothsahn: "Why is over half the cost on w1510 unitemized?"): what the meter left `unitemised` gets its own category. The
 * reminders and hook output Claude Code adds out of the stream's view and the base a resumed process sends again come from its
 * transcript; what a compaction carries over beside its summary is counted; a carried conversation keeps its history written on a
 * cold cache as carried and has its base measured by its next compaction. The totals stay exact.
 */

const chars = (tokens: number) => tokens * CHARS_PER_TOKEN;
const viaDisk = (s: MeterState): MeterState => JSON.parse(JSON.stringify(s));
const near = (a: number | undefined, b: number, tol = 3, what = '') => assert.ok(Math.abs((a ?? 0) - b) <= tol, `${what} ${a} ≠ ${b}`);
const tokOf = (c: Cats) => Object.values(c).reduce((a, x) => a + x.tok, 0);
type U = { in?: number; cr: number; cw: number; out?: number };
/** A meter whose calls are summed, to check that every call's tokens are shared out whole. */
function counted(m = new ContextMeter()) {
  let all = 0;
  const call = (id: string, u: U) => {
    all += (u.in ?? 0) + u.cr + u.cw + (u.out ?? 0);
    m.call({ id, in: u.in ?? 0, out: u.out ?? 0, cr: u.cr, cw: u.cw });
  };
  const exact = (t: MeterTurn) => near(tokOf(t.cats), all, 1, 'the totals stay exact');
  return { m, call, exact, reset: () => (all = 0) };
}

/** A first process: a brief of 1,000 tokens over a base of 60,001, then a file read of 100,000 tokens. Its last call reads 161,001. */
function firstProcess(): ContextMeter {
  const m = new ContextMeter();
  m.addUser(chars(1_000));
  m.call({ id: 'a1', in: 0, out: 0, cr: 0, cw: 61_001 });
  m.addToolUse('t1', 'Read', { file_path: 'F:/x/a.cs' }, 10);
  m.addToolResult('t1', chars(100_000));
  m.call({ id: 'a2', in: 0, out: 0, cr: 61_001, cw: 100_000 });
  m.drain();
  return m;
}

test('w1556: a fresh process — reminders and hook output have their categories, the base its first call sends is base, nothing is left', () => {
  const { m, call, exact } = counted();
  m.addUser(chars(1_000));
  m.attachment('skill_listing', chars(10_000)); // the first call's base: in what it measures
  m.attachment('total_tokens_reminder', chars(50));
  call('a1', { cr: 0, cw: 61_051 });
  m.addToolUse('t1', 'Read', { file_path: 'F:/x/a.cs' }, 10);
  m.addToolResult('t1', chars(100_000));
  m.attachment('total_tokens_reminder', chars(50));
  m.attachment('hook_additional_context', chars(1_000));
  m.attachment('prompt_snapshot', chars(40_000)); // a record of the CLI's, never sent
  call('a2', { cr: 61_051, cw: 101_050 });
  m.attachment('total_tokens_reminder', chars(50));
  call('a3', { cr: 162_101, cw: 50 });
  const t = m.drain();
  exact(t);
  near(t.cats.base.tok, 3 * 60_001, 3, 'base: the system prompt and the skill list, read by every call');
  near(t.cats.reminder.tok, 50 + 50 + 50 + 50 + 100, 3, 'reminders: written once each, then read');
  near(t.cats.hook.tok, 2_000, 3, 'hook output: written, then read');
  near(t.cats['file-read'].tok, 200_000, 3);
  assert.ok((t.cats.unitemised?.tok ?? 0) < 3, `unitemised ${t.cats.unitemised?.tok}`);
});

test('w1556: a resumed process — the CLAUDE.md and skill list it sends again are base, read as base by every later call', () => {
  const { m, call, exact } = counted();
  assert.equal(m.resume(viaDisk(firstProcess().snapshot())), true);
  m.attachment('instructions', chars(15_000));
  m.attachment('skill_listing', chars(10_000));
  m.addUser(chars(1_000));
  call('b1', { cr: 161_001, cw: 26_000 });
  call('b2', { in: 1, cr: 187_001, cw: 0 });
  const t = m.drain();
  exact(t);
  assert.deepEqual(t.resumed, { kept: true, base: 60_001, prevBase: 60_001, by: 'cache' });
  near(t.cats.base.tok, 60_001 + 25_000 + 60_001 + 25_000, 3, 'the base, and what it sent again');
  assert.ok((t.cats.unitemised?.tok ?? 0) <= 1, `unitemised ${t.cats.unitemised?.tok}`);
  // the meter before w1556 never saw them: 25,000 tokens unitemised, written, then read by every call
  const old = new ContextMeter();
  old.resume(viaDisk(firstProcess().snapshot()));
  old.addUser(chars(1_000));
  old.call({ id: 'b1', in: 0, out: 0, cr: 161_001, cw: 26_000 });
  old.call({ id: 'b2', in: 1, out: 0, cr: 187_001, cw: 0 });
  assert.ok((old.drain().cats.unitemised?.tok ?? 0) > 49_000);
});

test('w1556: a compacted process — what the compaction carries over beside its summary is compact-carry, held and read again', () => {
  const { m, call, exact } = counted(firstProcess());
  m.summary(12_000);
  m.attachment('instructions', chars(15_000)); // the base the compaction sends again: in the base the meter holds
  m.attachment('file', chars(2_000)); // a file it attaches again
  m.attachment('total_tokens_reminder', chars(50));
  // the base, the summary, the file, the reminder and 3,000 tokens of the newest messages it kept (no attachment says so)
  call('c1', { cr: 17_000, cw: 60_051 });
  call('c2', { cr: 77_051, cw: 10 });
  const t = m.drain();
  exact(t);
  assert.equal(t.compacted, true);
  near(t.cats['compact-carry'].tok, 2 * (2_000 + 3_000), 3, 'the file and the kept messages: written, then read');
  near(t.cats.summary.tok, 24_000, 3);
  near(t.cats.base.tok, 2 * 60_001, 3, 'the base stays the base');
  assert.ok((t.cats.unitemised?.tok ?? 0) <= 10, `unitemised ${t.cats.unitemised?.tok}`);
  assert.equal(t.cats['file-read'], undefined, 'the history before it is gone');
});

test('w1556: a carried conversation (w1510) — its history written on a cold cache is carried, and its next compaction measures the base', () => {
  const { m, call, exact, reset } = counted();
  m.carry(); // a resume with no saved tally
  m.addUser(chars(1_000));
  call('a1', { cr: 50_000, cw: 151_000 }); // a cold cache: most of the history is written again
  call('a2', { cr: 201_000, cw: 500 });
  const t1 = m.drain();
  exact(t1);
  near(t1.cats.carried.tok, 50_000 + 150_000 + 200_000, 3, 'read and written again, then read: all carried');
  near(t1.cats.unitemised?.tok, 500, 3, 'only what the last call added unexplained');
  // the next process keeps the tally; the base is still inside the carried history
  const n = new ContextMeter();
  assert.equal(n.resume(viaDisk(m.snapshot())), true);
  const c = counted(n);
  c.call('b1', { cr: 201_500, cw: 300 });
  const t2 = n.drain();
  c.exact(t2);
  assert.deepEqual(t2.resumed, { kept: true, base: 0, prevBase: 0, by: 'carried' });
  // the compaction drops the carried history: the call after it holds the base and the summary, and measures the base
  n.summary(12_000);
  c.reset();
  c.call('b2', { cr: 0, cw: 72_001 });
  c.call('b3', { cr: 72_001, cw: 100 });
  const t3 = n.drain();
  c.exact(t3);
  near(t3.cats.base.tok, 2 * 60_001, 3, 'the base, measured and then read');
  near(t3.cats.unitemised?.tok, 100, 3);
  assert.equal(t3.cats.carried, undefined);
  reset();
  // Before w1556 the base stayed 0 after the compaction, and every call read it as unitemised: w1510's 37%. A tally saved then (a
  // base of a few hundred tokens, counted against a carried history that the compaction then dropped) is healed when resumed.
  const was = new ContextMeter();
  was.resume(viaDisk({ ...n.snapshot(), base: 500 }));
  was.call({ id: 'b4', in: 0, out: 0, cr: 72_101, cw: 100_000 });
  const healed = was.drain();
  assert.deepEqual(healed.resumed, { kept: true, base: 500, prevBase: 500, by: 'carried' }, 'a base under MIN_BASE is measured again');
  was.summary(12_000);
  was.call({ id: 'b5', in: 0, out: 0, cr: 0, cw: 72_001 });
  was.call({ id: 'b6', in: 0, out: 0, cr: 72_001, cw: 100 });
  near(was.drain().cats.base.tok, 2 * 60_001, 3, 'healed by its next compaction');
});

test('w1556: attachmentChars counts the text an attachment carries, not the keys that describe it', () => {
  assert.equal(attachmentChars({ type: 'hook_success', toolUseID: 'toolu_1', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', content: 'abc', stdout: 'de' }), 5);
  assert.equal(attachmentChars({ type: 'total_tokens_reminder', text: '<total_tokens>15000000 tokens left</total_tokens>' }), 49);
  assert.equal(attachmentChars({ type: 'instructions', files: [{ path: 'F:/x/CLAUDE.md', type: 'Project', content: 'x'.repeat(100) }] }), 'F:/x/CLAUDE.md'.length + 100);
});

/** Lines of a Claude Code transcript (its jsonl), as the CLI writes them. */
const L = {
  prompt: (uuid: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: text } }),
  att: (uuid: string, attachment: Record<string, unknown>) => ({ type: 'attachment', uuid, attachment }),
  call: (uuid: string, id: string, u: U, content: unknown[] = []) => ({ type: 'assistant', uuid, message: { id, model: 'claude-opus-5-5', content, usage: { input_tokens: u.in ?? 0, cache_read_input_tokens: u.cr, cache_creation_input_tokens: u.cw, output_tokens: u.out ?? 0 } } }),
  result: (uuid: string, id: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }),
};
const text = (n: number) => 'x'.repeat(n);
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

test('w1556: the transcript tail feeds what the CLI appended since the last call, and waits for a line still being written', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-cli-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(file, jsonl([L.prompt('p0', 'old history')]));
  const tail = new CliTranscriptTail(file, false); // a resumed process: the history before is in the tally
  const m = new ContextMeter();
  m.addUser(chars(1_000));
  m.call({ id: 'a1', in: 0, out: 0, cr: 0, cw: 61_000 });
  const line = JSON.stringify(L.att('r1', { type: 'hook_system_message', content: text(chars(1_000)) }));
  fs.appendFileSync(file, jsonl([L.att('r0', { type: 'total_tokens_reminder', text: text(chars(50)) })]) + line.slice(0, 20));
  assert.equal(tail.feed(m), 1, 'the whole line, not the half-written one');
  fs.appendFileSync(file, line.slice(20) + '\n' + jsonl([{ type: 'user', uuid: 'n1', message: { role: 'user', content: '<task-notification>done</task-notification>' } }]));
  assert.equal(tail.feed(m), 2);
  m.call({ id: 'a2', in: 0, out: 0, cr: 61_000, cw: 1_050 + 18 });
  const c = m.drain().cats;
  near(c.reminder.tok, 50, 1);
  near(c.hook.tok, 1_000, 1);
  near(c.brief.tok, 2 * 1_000 + 18, 3, 'the brief twice (written, read) and the task notification the CLI wrote');
  assert.ok((c.unitemised?.tok ?? 0) < 1);
});

test('w1556: a conversation with no saved tally is rebuilt from its transcript: the same tally as one kept, no carried', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-cli-rebuild-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [
    L.prompt('p1', text(chars(1_000) - 200)),
    L.att('s1', { type: 'skill_listing', content: text(chars(10_000)) }),
    L.call('c1', 'a1', { cr: 0, cw: 61_001 }, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'F:/x/a.cs' } }]),
    L.result('r1', 't1', text(chars(100_000))),
    L.call('c2', 'a2', { cr: 61_001, cw: 100_000 }),
    // a second process: its attachment pass sends CLAUDE.md again
    L.prompt('p2', text(chars(1_000) - 200)),
    L.att('i2', { type: 'instructions', files: [{ content: text(chars(15_000)) }] }),
    L.call('c3', 'b1', { cr: 161_001, cw: 16_000 }),
  ];
  const file = path.join(dir, 'conv.jsonl');
  fs.writeFileSync(file, jsonl(lines));
  const turns: MeterTurn[] = [];
  const r = replayLines(lines, { hidden: true, onTurn: (x) => turns.push(x) });
  assert.equal(r.processes, 2);
  assert.equal(r.calls, 3);
  assert.deepEqual(turns[1].resumed, { kept: true, base: 60_001, prevBase: 60_001, by: 'cache' });
  const s = rebuildMeter(file)!;
  assert.equal(s.lastCtx, 177_001);
  assert.equal(s.base, 60_001);
  const m = new ContextMeter();
  assert.equal(m.resume(s), true);
  m.call({ id: 'n1', in: 1, out: 0, cr: 177_001, cw: 0 });
  const c = m.drain().cats;
  assert.equal(c.carried, undefined);
  near(c['file-read'].tok, 100_000, 3);
  near(c.base.tok, 60_001 + 15_000, 3, 'the base and the CLAUDE.md the second process sent again');
  assert.equal(rebuildMeter(path.join(dir, 'none.jsonl')), undefined);
});

test('w1556: AgentSession reads Claude Code\'s transcript before each call: hook output and reminders have their categories live', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-cli-live-'));
  const work = path.join(dir, 'work');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'cfg') };
  const sid = 'conv-1556-live';
  const file = path.join(env.CLAUDE_CONFIG_DIR, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out: unknown[] = [];
  let wake: (() => void) | undefined;
  const emit = (m: unknown) => {
    out.push(m);
    wake?.();
  };
  setQueryForTesting((({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    void (async () => {
      for await (const _ of prompt) void _;
    })();
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: sid, model: 'm', uuid: 'init' };
      for (;;) {
        while (!out.length) await new Promise<void>((r) => (wake = r));
        const m = out.shift();
        if (m === 'END') return;
        yield m;
      }
    })();
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const store = new Store(path.join(dir, 'data'));
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const call = (id: string, u: U, content: unknown[] = [{ type: 'text', text: 'ok' }]) =>
    emit({ type: 'assistant', parent_tool_use_id: null, uuid: `as-${id}`, session_id: sid, message: { id, model: 'claude-opus-5-5', content, usage: { input_tokens: u.in ?? 0, cache_read_input_tokens: u.cr, cache_creation_input_tokens: u.cw, output_tokens: 0 } } });
  const info: SessionInfo = { id: 'sess-1556', kind: 'worker', title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0, pendingPermissions: [] };
  store.putSession(info);
  const s = new AgentSession({ ...info }, store, () => ({ cwd: work, env }), new EventEmitter());
  const u1 = s.send('x'.repeat(2_300));
  await settle();
  // the CLI writes the prompt and its attachments before the first call
  fs.writeFileSync(file, jsonl([L.prompt('p1', 'x'.repeat(2_300)), L.att('s1', { type: 'skill_listing', content: text(chars(10_000)) })]));
  call('a1', { cr: 0, cw: 61_001 }, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }]);
  await settle();
  fs.appendFileSync(file, jsonl([L.att('h1', { type: 'hook_additional_context', content: [text(chars(1_000))] }), L.att('r1', { type: 'total_tokens_reminder', text: text(chars(50)) })]));
  emit({ type: 'user', parent_tool_use_id: null, uuid: 'tr1', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(chars(2_000)) }] } });
  call('a2', { cr: 61_001, cw: 3_050 });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, duration_ms: 1, user_message_uuids: [u1], session_id: sid, uuid: 'r-1' });
  await settle();
  const r = store.readTranscript('sess-1556').filter((e: TranscriptEvent) => e.kind === 'result').at(-1)!;
  const c = (r.kind === 'result' && r.usage?.meter?.cats) as Cats;
  near(c.hook?.tok, 1_000, 2, 'hook');
  near(c.reminder?.tok, 50, 2, 'reminder');
  assert.ok((c.unitemised?.tok ?? 0) < 2, `unitemised ${c.unitemised?.tok}`);
  assert.equal(cliTranscriptPath(work, sid, env), file);
  emit('END');
  await settle();
});
