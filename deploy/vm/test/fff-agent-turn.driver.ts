/**
 * One real agent turn the way the portal starts its orchestrators (w5651, the lockout review of w5598): the Agent SDK's
 * query() with server/agentAccount.ts's agentProcessOptions, an in-process MCP server and a permission callback, against a
 * stand-in for Anthropic's Messages API on 127.0.0.1 (ANTHROPIC_BASE_URL; no real credential anywhere: CI is public).
 *   node deploy/vm/test/fff-agent-turn.driver.ts turn <memory dir> <cwd>   a turn, a resume, an interrupt
 *   node deploy/vm/test/fff-agent-turn.driver.ts hang <memory dir> <cwd>   a turn the model never answers; prints "hanging"
 * The turn: the model calls the MCP tool (the call comes back over the socket to this process), then Write into the memory
 * folder (the permission callback is asked over the socket too), then ends. The resume sends the first turn's session id
 * and must reach the model with the first turn in its history. The interrupt stops a turn the model is slow to answer.
 * FFF_AGENT_SOCKET set: through fff-agent.socket (the mode is "on" unless FFF_AGENT_SWITCH says otherwise); unset: as this
 * account (tokenPipeSpawner), as before w5598. Prints "via: socket" or "via: portal", then "ok: ..." lines or "FAIL: ...".
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, query, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AGENT_SOCKET_VAR, agentAccountMode, agentProcessOptions, configureAgentAccount } from '../../../server/agentAccount.ts';

const [step, memory, cwd] = process.argv.slice(2);
if (!['turn', 'hang'].includes(step) || !memory || !cwd) throw new Error('usage: fff-agent-turn.driver.ts turn|hang <memory dir> <cwd>');
const fail = (why: string): never => {
  console.log(`FAIL: ${why}`);
  process.exit(1);
};
const note = path.join(memory, 'ci-agent-turn.md');

// The stand-in model: what it answers depends on what the conversation holds so far.
type Msg = { role: string; content: string | { type: string; text?: string; name?: string; content?: unknown }[] };
const seen: { tools: boolean; text: string }[] = [];
let slow = false;
const sse = (res: http.ServerResponse, blocks: ({ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown })[], stop: string) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-ci-stand-in', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${index}_${Date.now()}`, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev('message_stop', {});
  res.end();
};
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const b = JSON.parse(body || '{}') as { stream?: boolean; messages?: Msg[]; tools?: { name: string }[] };
    const text = JSON.stringify(b.messages ?? []);
    const ours = (b.tools ?? []).some((t) => t.name === 'mcp__ci__ping');
    seen.push({ tools: ours, text });
    if (!b.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ id: 'msg_side', type: 'message', role: 'assistant', model: 'claude-ci-stand-in', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (!ours) return sse(res, [{ type: 'text', text: 'ok' }], 'end_turn');
    if (slow) return; // never answered: the interrupt or the portal's stop ends it
    const last = (b.messages ?? []).at(-1);
    const lastText = JSON.stringify(last?.content ?? '');
    if (lastText.includes('ci-step-resume')) return sse(res, [{ type: 'text', text: 'ci-resumed' }], 'end_turn');
    if (lastText.includes('ci-pong')) return sse(res, [{ type: 'tool_use', name: 'Write', input: { file_path: note, content: 'written by the CI agent turn (w5651)\n' } }], 'tool_use');
    if (lastText.includes('tool_result')) return sse(res, [{ type: 'text', text: 'ci-turn-done' }], 'end_turn');
    return sse(res, [{ type: 'tool_use', name: 'mcp__ci__ping', input: { word: 'ci' } }], 'tool_use');
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
const url = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

configureAgentAccount({ setting: () => 'on', alert: (t, b) => console.log(`alert: ${t}: ${b}`) });
// The warn mode's check runs in the background and only logs: keep its line so the warn leg can wait for it.
const logged: string[] = [];
const log = console.log.bind(console);
console.log = (...a: unknown[]) => (logged.push(a.join(' ')), log(...a));
const mode = process.env[AGENT_SOCKET_VAR] ? agentAccountMode(process.env) : 'off';
console.log(`mode: ${mode}; via: ${mode === 'on' ? 'socket' : 'portal'}`);
const pinged: string[] = [];
const asked: string[] = [];
const ci = createSdkMcpServer({ name: 'ci', version: '1.0.0', tools: [tool('ping', 'Answers pong', { word: z.string() }, async (a) => (pinged.push(a.word), { content: [{ type: 'text', text: 'ci-pong' }] }))] });
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ci-stand-in-not-a-token', ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}) };
const run = async (prompt: string, o: { resume?: string; interruptAfterMs?: number; ms?: number } = {}) => {
  const out: SDKMessage[] = [];
  let said = '';
  const q = query({
    prompt,
    options: {
      cwd,
      env,
      resume: o.resume,
      mcpServers: { ci },
      tools: ['Write'],
      settingSources: [],
      maxTurns: 6,
      canUseTool: async (name, input) => (asked.push(name), { behavior: 'allow', updatedInput: input }),
      spawnClaudeCodeProcess: (so) => {
        // What Claude Code wrote, kept for a turn that throws: its own error may be on stdout, not in the journal.
        const p = agentProcessOptions(process.env).spawnClaudeCodeProcess!(so);
        p.stdout.on('data', (d: Buffer) => (said = (said + d.toString()).slice(-4000)));
        return p;
      },
      stderr: (d) => process.stderr.write(d),
    },
  });
  const t0 = Date.now();
  if (o.interruptAfterMs) setTimeout(() => void q.interrupt().catch(() => {}), o.interruptAfterMs).unref();
  const guard = setTimeout(() => fail(`"${prompt}": no result within ${o.ms ?? 120_000} ms (${out.map((m) => m.type).join(' ')})`), o.ms ?? 120_000);
  let threw: string | undefined;
  try {
    for await (const m of q) out.push(m);
  } catch (e) {
    threw = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300);
  }
  clearTimeout(guard);
  const result = out.find((m) => m.type === 'result') as (SDKMessage & { subtype: string; result?: string; session_id: string }) | undefined;
  return { result, threw, said, ms: Date.now() - t0 };
};
// A failed turn's last lines from Claude Code, then the FAIL: its own error may be on stdout, not in the journal. Not for
// the interrupt, whose throw is expected.
const failWith = (r: { said: string }, why: string): never => {
  for (const l of r.said.split('\n').filter(Boolean).slice(-15)) console.log(`FAIL: its stdout: ${l.slice(0, 400)}`);
  return fail(why);
};

if (step === 'hang') {
  slow = true;
  console.log('hanging');
  await run('ci-step-hang', { ms: 3_600_000 });
  fail('the hung turn ended by itself');
}

const one = await run('ci-step-one: call the ping tool, then write the note');
if (one.threw) failWith(one, `the turn threw: ${one.threw}`);
if (one.result?.subtype !== 'success' || !one.result.result?.includes('ci-turn-done')) fail(`the turn did not end well: ${JSON.stringify(one.result)?.slice(0, 400)}`);
if (pinged.join() !== 'ci') fail(`the in-process MCP tool was not called through the agent: ${pinged.join()}`);
if (!asked.includes('Write')) fail(`the permission callback was not asked for Write: ${asked.join()}`);
if (!fs.existsSync(note)) fail(`the turn's Write did not reach ${note}`);
console.log(`ok: a turn (${one.ms} ms): the MCP tool called back to the portal's process, the permission callback asked for Write, the note written to ${note}`);
const sid = one.result.session_id;
const two = await run('ci-step-resume', { resume: sid });
if (two.threw) failWith(two, `the resume threw: ${two.threw}`);
if (two.result?.subtype !== 'success' || !two.result.result?.includes('ci-resumed')) fail(`the resume did not end well: ${JSON.stringify(two.result)?.slice(0, 400)}`);
if (!seen.at(-1)?.text.includes('ci-step-one')) fail('the resumed turn reached the model without the first turn in its history');
console.log(`ok: the resume (${two.ms} ms) of session ${sid} reached the model with the first turn in its history`);
slow = true;
const three = await run('ci-step-slow', { interruptAfterMs: 3_000, ms: 60_000 });
console.log(`ok: an interrupt ended a turn the model never answered in ${three.ms} ms (${three.result?.subtype ?? three.threw ?? 'no result'})`);
console.log(`session: ${sid}`);
if (mode === 'warn') {
  const t = Date.now();
  while (!logged.some((l) => l.startsWith('agent account (warn)')) && Date.now() - t < 60_000) await new Promise((r) => setTimeout(r, 500));
  if (!logged.some((l) => l.startsWith('agent account (warn)'))) fail('warn: no check of the agents\' account within 60 s');
}
api.close();
process.exit(0);
