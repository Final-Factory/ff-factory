import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ContextMeter, METER_READS_KEPT, type Cats, type MeterState, type MeterTurn } from '../shared/spend.ts';
import { METER_STATE_DAYS, meterStates } from './meterStates.ts';
import { AgentSession, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { SessionInfo, TranscriptEvent } from '../shared/types.ts';

/**
 * w1484 (Lothsahn: "Can we eliminate carried by accounting for it properly as each worker goes?"): a conversation resumed in a
 * new process keeps its history in its categories, from the meter state the process before saved; its base is measured again.
 */

/** What a saved state looks like after the file: JSON through and back. */
const viaDisk = (s: MeterState): MeterState => JSON.parse(JSON.stringify(s));
const near = (a: number | undefined, b: number, tol = 3, what = '') => assert.ok(Math.abs((a ?? 0) - b) <= tol, `${what} ${a} ≠ ${b}`);
const tokOf = (c: Cats) => Object.values(c).reduce((a, x) => a + x.tok, 0);

/**
 * The first process of a conversation: a brief of 1,000 tokens over a base of 60,001, then a file read of 100,000 tokens.
 * Its last call reads 161,001.
 */
function firstProcess(): ContextMeter {
  const m = new ContextMeter();
  m.addUser(2_300);
  m.call({ id: 'a1', in: 0, out: 0, cr: 0, cw: 61_001 });
  m.addToolUse('t1', 'Read', { file_path: 'F:/x/a.cs' }, 10);
  m.addToolResult('t1', 230_000);
  m.call({ id: 'a2', in: 0, out: 0, cr: 61_001, cw: 100_000 });
  m.drain();
  return m;
}

test('w1484: a resumed process with the saved state reads its history in its categories, the same as a process that never stopped', () => {
  const kept = new ContextMeter();
  assert.equal(kept.resume(viaDisk(firstProcess().snapshot())), true);
  const unbroken = firstProcess();
  for (const m of [kept, unbroken]) {
    m.addUser(2_300); // the follow-up message, 1,000 tokens
    m.call({ id: 'b1', in: 0, out: 0, cr: 161_001, cw: 1_000 });
  }
  const t = kept.drain();
  const u = unbroken.drain();
  assert.equal(t.cats.carried, undefined, 'nothing carried');
  near(t.cats.base.tok, 60_001, 3, 'base');
  near(t.cats['file-read'].tok, 100_000, 3, 'file-read');
  assert.deepEqual(t.resumed, { kept: true, base: 60_001, prevBase: 60_001, by: 'cache' });
  for (const k of new Set([...Object.keys(t.cats), ...Object.keys(u.cats)])) near(t.cats[k]?.tok, u.cats[k]?.tok ?? 0, 3, k);
  assert.equal(u.resumed, undefined);
  near(tokOf(t.cats), 162_001, 1, 'every token of the call shared out');
  // and the next call is an ordinary one
  kept.call({ id: 'b2', in: 0, out: 0, cr: 162_001, cw: 200 });
  const t2 = kept.drain();
  assert.equal(t2.resumed, undefined);
  near(t2.cats.base.tok, 60_001, 3);
  assert.equal(t2.cats.carried, undefined);
});

test('w1484: a new process with a bigger base (CLAUDE.md grew) and a cold cache measures its own base; the history is written again in its categories', () => {
  const m = new ContextMeter();
  m.resume(viaDisk(firstProcess().snapshot()));
  m.addUser(2_300);
  // the base is 2,000 tokens bigger; only the 17,000 tokens before the change are read from the cache
  m.call({ id: 'b1', in: 0, out: 0, cr: 17_000, cw: 147_001 });
  const t = m.drain();
  assert.equal(t.cats.carried, undefined);
  assert.deepEqual(t.resumed, { kept: true, base: 62_001, prevBase: 60_001, by: 'count' }, 'its read stops where the prompt changed: counted');
  near(t.cats.base.tok, 62_001, 3, 'base: read and written');
  near(t.cats['file-read'].tok, 100_000, 3, 'file-read written again');
  near(t.cats.brief.tok, 2_000, 3, 'both messages');
});

test('w1484: a cold resume that counts less than the base before (Claude Code dropped old thinking): the base stays, the history reads less', () => {
  const m = new ContextMeter();
  m.resume(viaDisk(firstProcess().snapshot()));
  m.addUser(2_300);
  // 30,000 tokens of the history are gone, and the cache is cold
  m.call({ id: 'b1', in: 0, out: 0, cr: 17_000, cw: 115_001 });
  const t = m.drain();
  assert.deepEqual(t.resumed, { kept: true, base: 60_001, prevBase: 60_001, by: 'history-shrank' });
  near(t.cats.base.tok, 60_001, 3, 'base');
  near(t.cats['file-read'].tok + t.cats.brief.tok - 1_000, 71_000, 3, 'what is left of the history, shared by its categories');
  assert.equal(t.cats.carried, undefined);
});

test('w1484: a resume after a compaction in the earlier process: the summary stays summary, not carried', () => {
  const a = firstProcess();
  a.summary(12_000);
  a.addUser(2_300);
  // the compacted context: the base, the summary and a message
  a.call({ id: 'a3', in: 0, out: 0, cr: 20_000, cw: 53_001 });
  const ta = a.drain();
  assert.equal(ta.compacted, true);
  const m = new ContextMeter();
  assert.equal(m.resume(viaDisk(a.snapshot())), true);
  m.addUser(2_300);
  m.call({ id: 'b1', in: 0, out: 0, cr: 73_001, cw: 1_000 });
  const t = m.drain();
  assert.equal(t.cats.carried, undefined);
  assert.equal(t.compacted, undefined, 'no compaction in this process');
  near(t.cats.summary.tok, 12_000, 30, 'summary read');
  near(t.cats.base.tok, 60_001, 30, 'base');
  // a file read before the compaction and read again in the new process is a re-read after a compaction
  m.addToolUse('t2', 'Read', { file_path: 'F:/x/a.cs' }, 10);
  m.addToolResult('t2', 2_300);
  m.call({ id: 'b2', in: 0, out: 0, cr: 74_001, cw: 1_000 });
  assert.deepEqual(m.drain().reread, { n: 1, chars: 2_300, afterCompact: 1 });
});

test('w1484: a compaction as the new process starts: its first call shows the context shrunk, the summary is summary and the base is measured', () => {
  const m = new ContextMeter();
  assert.equal(m.resume(viaDisk(firstProcess().snapshot())), true);
  m.summary(12_000); // compact_boundary before the first call
  m.call({ id: 'b1', in: 0, out: 0, cr: 17_000, cw: 55_001 });
  const t = m.drain();
  assert.equal(t.compacted, true);
  assert.equal(t.cats.carried, undefined);
  near(t.cats.summary.tok, 12_000, 30, 'summary');
  near(t.cats.base.tok, 60_001, 30, 'base');
  assert.equal(t.cats['file-read'], undefined, 'the history before the compaction is gone');
});

test('w1484: no saved state (the conversation began before w1484, or moved machines): the resume falls back to carried and says so', () => {
  for (const state of [undefined, { v: 2 } as unknown as MeterState, { ...firstProcess().snapshot(), lastCtx: 0 }]) {
    const m = new ContextMeter();
    assert.equal(m.resume(state), false);
    m.addUser(2_300);
    m.call({ id: 'b1', in: 0, out: 0, cr: 161_001, cw: 1_000 });
    const t = m.drain();
    assert.deepEqual(t.resumed, { kept: false });
    near(t.cats.carried.tok, 161_000, 3, 'the unexplained read is carried');
    assert.ok((t.cats.base?.tok ?? 0) < 1, 'not base');
  }
});

test('w1484: the same meter starting the process again (the portal\'s own sessions) keeps its tally and measures the base again', () => {
  const m = firstProcess();
  assert.equal(m.resume(), true);
  m.addUser(2_300);
  m.call({ id: 'b1', in: 0, out: 0, cr: 161_001, cw: 1_000 });
  const t = m.drain();
  assert.equal(t.cats.carried, undefined);
  assert.deepEqual(t.resumed, { kept: true, base: 60_001, prevBase: 60_001, by: 'cache' });
});

test('w1484: a carried conversation stays carried across later processes, never counted as base', () => {
  const a = new ContextMeter();
  a.carry();
  a.call({ id: 'a1', in: 1, out: 0, cr: 200_000, cw: 1_000 });
  a.drain();
  const m = new ContextMeter();
  assert.equal(m.resume(viaDisk(a.snapshot())), true);
  m.call({ id: 'b1', in: 1, out: 0, cr: 201_001, cw: 500 });
  const t = m.drain();
  near(t.cats.carried.tok, 200_000 * 1, 3, 'its carried part is read as carried');
  assert.ok((t.cats.base?.tok ?? 0) < 600, `base ${t.cats.base?.tok}`);
});

test('w1484: the saved state stays small: file reads are hashed and only the newest are kept', () => {
  const m = new ContextMeter();
  m.call({ id: 'a1', in: 1, out: 0, cr: 0, cw: 50_000 });
  for (let i = 0; i < 4 * METER_READS_KEPT; i++) {
    m.addToolUse(`t${i}`, 'Read', { file_path: `F:/ffw/sandboxes/slot4/Assets/Scripts/FFSystems/Some/Long/Path/File${i}.cs` }, 10);
    m.addToolResult(`t${i}`, 100);
  }
  m.call({ id: 'a2', in: 1, out: 0, cr: 50_001, cw: 1_000 });
  const s = m.snapshot();
  assert.equal(s.readSeen.length, METER_READS_KEPT);
  const bytes = JSON.stringify(s).length;
  assert.ok(bytes < 40_000, `${bytes} bytes`);
  // the newest read is kept: read again in the next process, it is a re-read
  const n = new ContextMeter();
  n.resume(viaDisk(s));
  n.addToolUse('x', 'Read', { file_path: `F:/ffw/sandboxes/slot4/Assets/Scripts/FFSystems/Some/Long/Path/File${4 * METER_READS_KEPT - 1}.cs` }, 10);
  n.addToolResult('x', 100);
  n.call({ id: 'b1', in: 1, out: 0, cr: 51_001, cw: 100 });
  assert.equal(n.drain().reread?.n, 1);
});

test('w1484: meterStates keeps one file per conversation, refuses ids that are no file name, and drops old ones', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-meters-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = firstProcess().snapshot();
  const old = path.join(dir, 'old-conversation.json');
  fs.writeFileSync(old, '{}');
  const past = (Date.now() - (METER_STATE_DAYS + 1) * 86_400_000) / 1000;
  fs.utimesSync(old, past, past);
  const store = meterStates(dir);
  store.save('3f2c-uuid', s);
  assert.deepEqual(store.load('3f2c-uuid'), s);
  assert.equal(fs.existsSync(old), false, 'past METER_STATE_DAYS');
  store.save('../escape', s);
  assert.equal(store.load('../escape'), undefined);
  assert.equal(fs.existsSync(path.join(dir, '..', 'escape.json')), false);
  assert.equal(store.load('nobody'), undefined);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"v":1,');
  assert.equal(store.load('broken'), undefined);
});

test('w1484: AgentSession saves the meter after its calls and a new process of the conversation picks it up (no carried)', async (t) => {
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
      yield { type: 'system', subtype: 'init', session_id: 'conv-1484', model: 'm', uuid: 'init' };
      for (;;) {
        while (!out.length) await new Promise<void>((r) => (wake = r));
        const m = out.shift();
        if (m === 'END') return;
        yield m;
      }
    })();
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-meter-resume-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const call = (id: string, u: { in: number; cr: number; cw: number }, content: unknown[] = [{ type: 'text', text: 'ok' }]) =>
    emit({ type: 'assistant', parent_tool_use_id: null, uuid: `as-${id}`, session_id: 'conv-1484', message: { id, model: 'claude-opus-5-5', content, usage: { input_tokens: u.in, cache_read_input_tokens: u.cr, cache_creation_input_tokens: u.cw, output_tokens: 0 } } });
  const result = (uuid: string) => emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, duration_ms: 1, user_message_uuids: [uuid], session_id: 'conv-1484', uuid: `r-${Math.random()}` });
  const meterOf = (sid: string): MeterTurn => {
    const r = store.readTranscript(sid).filter((e: TranscriptEvent) => e.kind === 'result').at(-1)!;
    return (r.kind === 'result' && r.usage?.meter) as MeterTurn;
  };
  const info: SessionInfo = { id: 'sess-1484', kind: 'worker', title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0, pendingPermissions: [] };
  store.putSession(info);

  // the first process: a brief, a file read, a reply
  const one = new AgentSession({ ...info }, store, () => ({}), new EventEmitter());
  const u1 = one.send('x'.repeat(2_300));
  await settle();
  call('a1', { in: 0, cr: 0, cw: 61_001 }, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'F:/x/a.cs' } }]);
  emit({ type: 'user', parent_tool_use_id: null, uuid: 'tr1', session_id: 'conv-1484', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(230_000) }] } });
  call('a2', { in: 0, cr: 61_001, cw: 100_000 });
  result(u1);
  await settle();
  emit('END');
  await settle();
  assert.equal(one.live, false, 'the process ended');
  assert.equal(one.info.sdkSessionId, 'conv-1484');
  assert.equal(store.meters.load('conv-1484')?.lastCtx, 161_001, 'saved for the next process');

  // the next process of the same conversation: a new host, a new AgentSession
  const two = new AgentSession({ ...info, sdkSessionId: 'conv-1484', id: 'sess-1484b' }, store, () => ({}), new EventEmitter());
  const u2 = two.send('z'.repeat(2_300));
  await settle();
  call('b1', { in: 0, cr: 161_001, cw: 1_000 });
  result(u2);
  await settle();
  const m = meterOf('sess-1484b');
  assert.equal(m.cats.carried, undefined, `carried ${JSON.stringify(m.cats.carried)}`);
  near(m.cats['file-read']?.tok, 100_000, 3, 'file-read');
  // the base is what the first process measured (its brief less the characters send() wraps around it), measured again
  const r = m.resumed;
  assert.ok(r?.kept, 'kept');
  assert.ok(r.prevBase > 59_000 && r.prevBase <= 60_001, `prevBase ${r.prevBase}`);
  near(r.base, r.prevBase, 3, 'the same base, measured again');
  near(m.cats.base?.tok, r.base, 3, 'base');
  emit('END');
  await settle();
});
