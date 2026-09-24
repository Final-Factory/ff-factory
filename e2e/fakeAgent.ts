/**
 * A scripted stand-in for the Agent SDK's query(), for the E2E server and unit tests: no Claude, no
 * CLI process. It reads the same streaming input AgentSession writes and answers each user message
 * with the SDK messages a real session would send (init, state changes, text deltas, assistant
 * blocks, tool calls, a result), chosen by a tag in the message:
 *
 *   "#perm"        asks canUseTool for a Bash call, then reports whether it was allowed
 *   "#long"        a reply of 60 paragraphs (for scrolling and jump-to-latest)
 *   "#screenshot"  a tool result carrying a PNG (an inline image)
 *   "#slow"        streams for a few seconds (for the running state and interrupts)
 *   "#fail"        ends the turn with an error result
 *   anything else  "Echo: <text>" (and how many images came with it)
 */
import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** A 16x16 red PNG. */
export const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4o6FBEmIY1TCqYfhqAAAyBCwQhvh37QAAAABJRU5ErkJggg==';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let counter = 0;

export interface FakeOptions {
  /** Pause between streamed pieces, ms (default 40). */
  stepMs?: number;
}

export function fakeQuery(fake: FakeOptions = {}) {
  const step = fake.stepMs ?? 40;
  return ({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    const sessionId = options?.resume ?? `fake-${process.pid}-${++counter}`;
    const abort = options?.abortController ?? new AbortController();
    let interrupted = false;
    let msgId = 0;

    const text = (t: string): SDKMessage =>
      ({ type: 'assistant', parent_tool_use_id: null, uuid: `a${++msgId}`, session_id: sessionId, message: { id: `m${msgId}`, role: 'assistant', content: [{ type: 'text', text: t }] } }) as never;
    const delta = (t: string): SDKMessage =>
      ({ type: 'stream_event', parent_tool_use_id: null, uuid: `d${++msgId}`, session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } }) as never;
    const state = (s: 'running' | 'idle' | 'requires_action'): SDKMessage => ({ type: 'system', subtype: 'session_state_changed', state: s, session_id: sessionId, uuid: `s${++msgId}` }) as never;
    const toolUse = (id: string, name: string, input: unknown): SDKMessage =>
      ({ type: 'assistant', parent_tool_use_id: null, uuid: `t${++msgId}`, session_id: sessionId, message: { id: `m${msgId}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) as never;
    const toolResult = (id: string, content: unknown, isError = false): SDKMessage =>
      ({ type: 'user', parent_tool_use_id: null, uuid: `r${++msgId}`, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } }) as never;
    const result = (uuid: string, ok: boolean, t: string): SDKMessage =>
      ({
        type: 'result',
        subtype: ok ? 'success' : 'error_during_execution',
        is_error: !ok,
        result: t,
        total_cost_usd: 0.01 * msgId,
        num_turns: 1,
        duration_ms: 1234,
        user_message_uuids: [uuid],
        session_id: sessionId,
        uuid: `x${++msgId}`,
      }) as never;

    async function* stream(): AsyncGenerator<SDKMessage, void> {
      yield { type: 'system', subtype: 'init', session_id: sessionId, model: options?.model ?? 'fake-model', uuid: 'init' } as never;
      if (typeof prompt === 'string') return;
      for await (const m of prompt) {
        if (abort.signal.aborted) return;
        const content = m.message.content;
        const said = typeof content === 'string' ? content : content.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
        const images = typeof content === 'string' ? 0 : content.filter((b) => b.type === 'image').length;
        const uuid = m.uuid ?? '';
        yield state('running');
        const words = said.replace(/^\[from the orchestrator\]\n/, '');
        if (/#perm\b/i.test(words)) {
          const toolId = `tool-${++msgId}`;
          const input = { command: 'rm -rf build', description: 'Clean the build folder' };
          yield toolUse(toolId, 'Bash', input);
          yield state('requires_action');
          const decision: PermissionResult = (options?.canUseTool
            ? await options.canUseTool('Bash', input, { signal: abort.signal, toolUseID: toolId } as never)
            : { behavior: 'allow', updatedInput: input }) ?? { behavior: 'deny', message: 'no answer' };
          yield state('running');
          if (decision.behavior === 'allow') {
            yield toolResult(toolId, 'removed build/');
            yield text('Allowed: I cleaned the build folder.');
          } else {
            yield toolResult(toolId, `Permission denied: ${decision.message}`, true);
            yield text('Denied: I left the build folder alone.');
          }
          yield result(uuid, true, decision.behavior === 'allow' ? 'allowed' : 'denied');
        } else if (/#long\b/i.test(words)) {
          for (let i = 1; i <= 60; i++) yield text(`Paragraph ${i} of a long answer. ${'Lorem ipsum dolor sit amet. '.repeat(3)}`);
          yield text('The end of the long answer.');
          yield result(uuid, true, 'long answer done');
        } else if (/#screenshot\b/i.test(words)) {
          const toolId = `tool-${++msgId}`;
          yield toolUse(toolId, 'Read', { file_path: 'Screenshots/proof.png' });
          yield toolResult(toolId, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG } }]);
          yield text('Here is the screenshot.');
          yield result(uuid, true, 'screenshot shown');
        } else if (/#fail\b/i.test(words)) {
          yield text('Something went wrong.');
          yield result(uuid, false, 'failed');
        } else {
          const reply = `Echo: ${words.trim()}${images ? ` (${images} image${images > 1 ? 's' : ''})` : ''}`;
          const pieces = /#slow\b/i.test(words) ? 40 : 3;
          const size = Math.ceil(reply.length / pieces);
          for (let i = 0; i < reply.length && !interrupted; i += size) {
            yield delta(reply.slice(i, i + size));
            await sleep(/#slow\b/i.test(words) ? 100 : step);
          }
          if (interrupted) {
            // The interrupt ends this turn (an interrupt that came before it started ends it too).
            interrupted = false;
            continue;
          }
          yield text(reply);
          yield result(uuid, true, reply);
        }
        interrupted = false;
        yield state('idle');
      }
    }

    const gen = stream();
    const q = Object.assign(gen, {
      async interrupt() {
        interrupted = true;
      },
      async setPermissionMode() {},
      async setModel() {},
      close() {
        abort.abort();
      },
    });
    return q as unknown as Query;
  };
}
