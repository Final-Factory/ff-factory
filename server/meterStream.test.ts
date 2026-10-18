import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { Requester, TranscriptEvent } from '../shared/types.ts';
import type { TurnUsage } from '../shared/spend.ts';

/**
 * w1469: the context meter against the stream as the CLI sends it. A model call's assistant messages leave as each content
 * block ends, carrying message_start's usage (an output of 1); the real output count comes after them, in the
 * message_delta stream event (the CLI writes it into the messages it already sent, measured in its binary, 0.3.284:
 * `case"message_delta":... for(let tc of pu){tc.message.usage=Da ...}`, so only its own transcript has it). The meter
 * took message_start's count, and the agent's own output, read again by every later call, fell in `base`.
 */

let withDelta = true;
setQueryForTesting((({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
  const sid = 'meter-stream';
  let n = 0;
  const abort = options.abortController ?? new AbortController();
  const usage = (cr: number, cw: number) => ({ input_tokens: 2, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: 1 });
  const ev = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: null, uuid: `e${++n}`, session_id: sid, event }) as never as SDKMessage;
  const asst = (id: string, content: unknown[], cr: number, cw: number) =>
    ({ type: 'assistant', parent_tool_use_id: null, uuid: `a${++n}`, session_id: sid, message: { id, role: 'assistant', model: 'claude-opus-5-5', content, usage: usage(cr, cw) } }) as never as SDKMessage;
  const state = (s: string) => ({ type: 'system', subtype: 'session_state_changed', state: s, session_id: sid, uuid: `s${++n}` }) as never as SDKMessage;
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    yield { type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', uuid: 'init' } as never;
    for await (const m of prompt) {
      if (abort.signal.aborted) return;
      yield state('running');
      // call 1: the base (50,000 written), thinking and a Read; 2,000 output tokens
      yield ev({ type: 'message_start', message: { usage: usage(0, 50_000) } });
      yield asst('c1', [{ type: 'thinking', thinking: '' }], 0, 50_000);
      yield asst('c1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }], 0, 50_000);
      if (withDelta) yield ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2_000 } });
      yield { type: 'user', parent_tool_use_id: null, uuid: `r${++n}`, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(2_300) }] } } as never;
      // call 2: reads call 1's context, writes the file (about 1,000) and call 1's output (2,000)
      yield ev({ type: 'message_start', message: { usage: usage(50_002, 3_000) } });
      yield asst('c2', [{ type: 'text', text: 'done' }], 50_002, 3_000);
      if (withDelta) yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300 } });
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        total_cost_usd: 0.1,
        modelUsage: { 'claude-opus-5-5': { inputTokens: 4, outputTokens: 2_300, cacheReadInputTokens: 50_002, cacheCreationInputTokens: 53_000, costUSD: 0.1 } },
        usage: { input_tokens: 4, output_tokens: 2_300, cache_read_input_tokens: 50_002, cache_creation_input_tokens: 53_000 },
        num_turns: 1,
        duration_ms: 10,
        user_message_uuids: [m.uuid ?? ''],
        session_id: sid,
        uuid: `x${++n}`,
      } as never;
      yield state('idle');
    }
  }
  const q = Object.assign(stream(), {
    async interrupt() {},
    async setPermissionMode() {},
    async getContextUsage() {
      return { categories: [], totalTokens: 0, maxTokens: 1_000_000, settings: {} };
    },
    async setModel() {},
    close() {
      abort.abort();
    },
  });
  return q as unknown as Query;
}) as never);

const LOTHSAHN: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

async function meterOfOneTurn(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-meter-'));
  const store = new Store(dir);
  const sessions = new SessionManager({} as Config, store);
  t.after(async () => {
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const o = sessions.create({ kind: 'orchestrator', title: 'o', permissionMode: 'default', options: () => ({ model: 'opus' }), orchestratorRole: 'personal', requestedBy: LOTHSAHN });
  sessions.send(o.info.id, 'go', 'human', undefined, { requestedBy: LOTHSAHN });
  const end = Date.now() + 3000;
  let r: (TranscriptEvent & { kind: 'result' }) | undefined;
  while (!(r = store.readTranscript(o.info.id).find((e): e is TranscriptEvent & { kind: 'result' } => e.kind === 'result'))) {
    if (Date.now() > end) throw new Error('no result');
    await new Promise((res) => setTimeout(res, 5));
  }
  return (r as { usage?: TurnUsage }).usage!.meter!;
}

test("w1469: the meter takes a call's output from message_delta, so the agent's own output is not base", async (t) => {
  withDelta = true;
  const m = await meterOfOneTurn(t);
  assert.equal(m.calls, 2);
  // 2,300 output tokens charged as output, and call 1's 2,000 written into call 2's context
  assert.ok(Math.abs(m.cats.assistant.tok - 4_300) < 5, `assistant ${m.cats.assistant.tok}`);
  assert.ok(m.cats['file-read'].tok > 900 && m.cats['file-read'].tok < 1_100, `file-read ${m.cats['file-read'].tok}`);
  // the base is call 1's 50,000 less the message, and the same read again by call 2: nothing of the output
  assert.ok(m.cats.base.tok < 100_100, `base ${m.cats.base.tok}`);
});

test('w1469: without message_delta (an older stream) the output is not explained: unitemised, still never base', async (t) => {
  withDelta = false;
  const m = await meterOfOneTurn(t);
  assert.ok(m.cats.assistant.tok < 10, `assistant ${m.cats.assistant.tok}`);
  assert.ok(m.cats.unitemised.tok > 1_900, `unitemised ${m.cats.unitemised.tok}`);
  assert.ok(m.cats.base.tok < 100_100, `base ${m.cats.base.tok}`);
});
