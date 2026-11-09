// w3855: a resumed conversation's process launches after the task that started it, one launch at a time (sessions.ts
// launchResumed): start() reads no transcript and spawns nothing, the messages sent meanwhile reach the process in order, a stop
// meanwhile launches nothing, and a model chosen meanwhile is the one it starts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession, launchesSettled, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { SessionInfo } from '../shared/types.ts';

function scene(t: { after: (f: () => void) => void }) {
  const launches: { options: Options; got: string[] }[] = [];
  setQueryForTesting((({ prompt, options }: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Options }) => {
    const l = { options, got: [] as string[] };
    launches.push(l);
    void (async () => {
      for await (const m of prompt) l.got.push(typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content));
    })();
    const g = (async function* () {
      await new Promise((r) => options.abortController!.signal.addEventListener('abort', r));
    })();
    return Object.assign(g, { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => undefined });
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-lazy-launch-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const info: SessionInfo = { id: 'sess-3855', kind: 'worker', title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0, pendingPermissions: [], sdkSessionId: 'conv-3855' };
  store.putSession(info);
  const session = (id: string) => new AgentSession({ ...info, id }, store, () => ({ model: 'claude-opus-5-5', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } }), new EventEmitter());
  return { launches, session };
}

test('w3855: a resumed start launches after the task that sent the message, and every message reaches the process in order', async (t) => {
  const { launches, session } = scene(t);
  const s = session('sess-a');
  s.send('one', 'system');
  s.send('two', 'system');
  assert.equal(launches.length, 0, 'nothing launched inside the task that sent');
  assert.equal(s.live, true, 'the session is running from start() on');
  await launchesSettled();
  s.send('three', 'system');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(launches.length, 1);
  assert.equal(launches[0].options.resume, 'conv-3855');
  assert.deepEqual(
    launches[0].got.map((g) => ['one', 'two', 'three'].find((w) => g.includes(w))),
    ['one', 'two', 'three'],
  );
  s.stop();
});

test('w3855: a session stopped before its process launched launches none', async (t) => {
  const { launches, session } = scene(t);
  const s = session('sess-b');
  s.send('hello', 'system');
  s.stop();
  await launchesSettled();
  assert.equal(launches.length, 0);
  assert.equal(s.live, false);
});

test('w3855: a model chosen while the process waits to launch is the one it starts on', async (t) => {
  const { launches, session } = scene(t);
  const s = session('sess-c');
  s.send('hello', 'system');
  (s as unknown as { switchModel: (m: string, k: string) => void }).switchModel('claude-sonnet-5-5', 'routine');
  await launchesSettled();
  assert.equal(launches.length, 1);
  assert.equal(launches[0].options.model, 'claude-sonnet-5-5');
  s.stop();
});
