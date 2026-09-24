import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { SessionManager, setQueryForTesting, snapshotOf, type SessionHandle } from './sessions.ts';
import { Store, bus } from './store.ts';
import type { Config } from './config.ts';
import type { ServerEvent, SessionInfo, TranscriptEvent } from '../shared/types.ts';
import { RED_PNG, fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * AgentSession end to end against the scripted fake SDK (e2e/fakeAgent.ts): the status a session
 * shows, what lands in its transcript, permission prompts, interrupts, stops and resumes, restore
 * after a restart, and the agent limit.
 */

const seen: { options: Options }[] = [];
const fake = fakeQuery({ stepMs: 1 });
setQueryForTesting(((args: { prompt: never; options: Options }) => {
  seen.push({ options: args.options });
  return fake(args);
}) as never);

function setup(t: { after: (fn: () => void | Promise<void>) => void }, maxSessions = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-agent-'));
  const store = new Store(dir);
  t.after(async () => {
    sessions.stopAll();
    // Let the stopped sessions' last status updates land before the folder goes (the Store would
    // otherwise keep retrying a save into a deleted folder).
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const sessions = new SessionManager({ limits: { maxSessions } } as Config, store);
  const worker = (permissionMode: SessionInfo['permissionMode'] = 'bypassPermissions', kind: SessionInfo['kind'] = 'worker') =>
    sessions.create({ kind, title: 'w', permissionMode, options: () => ({ model: 'opus' }) });
  return { dir, store, sessions, worker };
}

/** Wait until `pred` holds (polling; the fake answers within milliseconds). */
async function until(pred: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const kinds = (evs: TranscriptEvent[]) => evs.map((e) => e.kind);
const texts = (store: Store, id: string) => store.readTranscript(id).map((e) => ('text' in e ? e.text : ''));

test('a message: starting, running, idle; the transcript and events a turn leaves', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  const deltas: string[] = [];
  const onEvent = (e: ServerEvent) => e.type === 'delta' && e.sessionId === s.info.id && deltas.push(e.text);
  bus.on('event', onEvent);
  t.after(() => bus.off('event', onEvent));
  const turnEnds: string[] = [];
  sessions.events.on('turnEnd', (_h: SessionHandle, text: string) => turnEnds.push(text));

  assert.equal(s.live, false);
  sessions.send(s.info.id, 'hello there');
  assert.equal(s.live, true);
  assert.equal(s.info.status, 'running');
  await until(() => s.info.status === 'idle', 'idle');

  assert.deepEqual(kinds(store.readTranscript(s.info.id)), ['user', 'assistant', 'result']);
  assert.deepEqual(texts(store, s.info.id).slice(0, 2), ['hello there', 'Echo: hello there']);
  assert.equal(deltas.join(''), 'Echo: hello there');
  assert.deepEqual(turnEnds, ['Echo: hello there']);
  assert.equal(s.info.turns, 1);
  assert.ok(s.info.costUsd > 0);
  assert.equal(s.info.sdkSessionId?.startsWith('fake-'), true);
  assert.equal(s.info.lastResult, 'Echo: hello there');
  // Everything sent has been answered.
  assert.deepEqual(snapshotOf(s).unanswered, []);
  // The SDK was asked for streaming state events and partial messages, and never to prompt git.
  const opts = seen.at(-1)!.options;
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  assert.equal(opts.env?.GIT_TERMINAL_PROMPT, '0');
});

test('orchestrator messages are marked as such for the agent', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  sessions.send(s.info.id, 'build it', 'orchestrator');
  await until(() => s.info.status === 'idle', 'idle');
  assert.equal(s.lastFrom, 'orchestrator');
  // Stored as sent (the UI shows who it came from), but the agent was told the sender.
  const [user, reply] = store.readTranscript(s.info.id);
  assert.deepEqual([user.kind, 'from' in user && user.from, 'text' in user && user.text], ['user', 'orchestrator', 'build it']);
  assert.equal('text' in reply && reply.text, 'Echo: build it');
});

test('permission: the prompt waits for the user; Allow runs the tool', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker('default');
  const asked: string[] = [];
  sessions.events.on('permission', (_h: SessionHandle, p: { toolName: string }) => asked.push(p.toolName));
  sessions.send(s.info.id, 'clean up #perm');
  await until(() => s.info.pendingPermissions.length === 1, 'the permission prompt');
  assert.equal(s.info.status, 'waiting_permission');
  assert.deepEqual(asked, ['Bash']);
  // Not answered yet: a restart now would have to resume it.
  assert.deepEqual(snapshotOf(s).unanswered, [{ text: 'clean up #perm', from: 'human' }]);

  const p = s.info.pendingPermissions[0];
  assert.equal(s.decide('no-such-request', true), false);
  assert.equal(s.decide(p.requestId, true), true);
  await until(() => s.info.status === 'idle', 'idle');
  assert.deepEqual(s.info.pendingPermissions, []);
  const perm = store.readTranscript(s.info.id).find((e) => e.kind === 'permission');
  assert.equal(perm && 'decision' in perm && perm.decision, 'allow');
  assert.ok(texts(store, s.info.id).includes('Allowed: I cleaned the build folder.'));
  // A decision is final.
  assert.equal(s.decide(p.requestId, false), false);
});

test('permission: Deny tells the agent why', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker('default');
  sessions.send(s.info.id, '#perm');
  await until(() => s.info.pendingPermissions.length === 1, 'the permission prompt');
  s.decide(s.info.pendingPermissions[0].requestId, false, 'not today');
  await until(() => s.info.status === 'idle', 'idle');
  const result = store.readTranscript(s.info.id).find((e) => e.kind === 'tool_result');
  assert.equal(result && 'text' in result && result.text, 'Permission denied: not today');
  assert.ok(texts(store, s.info.id).includes('Denied: I left the build folder alone.'));
});

test('interrupt: the turn stops, pending prompts are denied, the session stays live', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  let streaming = false;
  const onEvent = (e: ServerEvent) => e.type === 'delta' && e.sessionId === s.info.id && (streaming = true);
  bus.on('event', onEvent);
  t.after(() => bus.off('event', onEvent));
  sessions.send(s.info.id, 'take your time #slow');
  // Mid-answer: the reply has started streaming.
  await until(() => streaming, 'the reply to start');
  await s.interrupt();
  assert.equal(s.info.status, 'idle');
  assert.equal(s.live, true);
  assert.equal(texts(store, s.info.id).at(-1), 'Interrupted.');
  assert.deepEqual(snapshotOf(s).unanswered, []);
  // It keeps working afterwards.
  sessions.send(s.info.id, 'again');
  await until(() => texts(store, s.info.id).includes('Echo: again'), 'the next answer');
});

test('stop and resume: a stopped session restarts on the next message, resuming its SDK session', async (t) => {
  const { sessions, worker } = setup(t);
  const s = worker('default');
  sessions.send(s.info.id, '#perm');
  await until(() => s.info.pendingPermissions.length === 1, 'the permission prompt');
  const sdk = s.info.sdkSessionId;
  const ended: string[] = [];
  sessions.events.on('ended', (h: SessionHandle) => ended.push(h.info.id));
  s.stop();
  assert.equal(s.live, false);
  assert.equal(s.info.status, 'stopped');
  assert.deepEqual(s.info.pendingPermissions, []);
  assert.deepEqual(ended, [s.info.id]);

  sessions.send(s.info.id, 'are you back?');
  assert.equal(seen.at(-1)!.options.resume, sdk);
  await until(() => s.info.status === 'idle', 'idle');
});

test('images: kept with the message and shown to the agent; tool-result images are kept too', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  sessions.send(s.info.id, 'look', 'human', [{ mediaType: 'image/png', data: RED_PNG }]);
  await until(() => s.info.status === 'idle', 'idle');
  const [user] = store.readTranscript(s.info.id);
  assert.equal(user.kind === 'user' && user.images?.length, 1);
  assert.ok(user.kind === 'user' && store.imagePath(s.info.id, user.images![0].id));
  assert.ok(texts(store, s.info.id).includes('Echo: look (1 image)'));

  sessions.send(s.info.id, '#screenshot');
  await until(() => texts(store, s.info.id).includes('Here is the screenshot.'), 'the screenshot');
  const shot = store.readTranscript(s.info.id).find((e) => e.kind === 'tool_result');
  assert.equal(shot?.kind === 'tool_result' && shot.images?.length, 1);
  assert.equal(shot?.kind === 'tool_result' && shot.text, '[image]');
});

test('a failed turn is recorded as not ok', async (t) => {
  const { store, sessions, worker } = setup(t);
  const s = worker();
  sessions.send(s.info.id, '#fail');
  await until(() => s.info.status === 'idle', 'idle');
  const result = store.readTranscript(s.info.id).find((e) => e.kind === 'result');
  assert.equal(result?.kind === 'result' && result.ok, false);
  assert.equal(s.info.lastResult, 'stopped: error_during_execution');
});

test('agent limit: a message that would start one agent too many is refused; the orchestrator is exempt', async (t) => {
  const { sessions, worker } = setup(t, 2);
  const a = worker();
  const b = worker();
  const c = worker();
  const o = worker('default', 'orchestrator');
  sessions.send(a.info.id, 'one');
  sessions.send(b.info.id, 'two');
  assert.equal(sessions.liveAgents(), 2);
  assert.throws(() => sessions.send(c.info.id, 'three'), /already 2 agents running/);
  // Already-live sessions can always be messaged, and the orchestrator never counts.
  sessions.send(a.info.id, 'more');
  sessions.send(o.info.id, 'hi');
  assert.equal(sessions.liveAgents(), 2);
  a.stop();
  sessions.send(c.info.id, 'three');
  await until(() => c.info.status === 'idle', 'idle');
});

test('restore: sessions come back stopped; one cut off mid-turn says so and is reported', (t) => {
  const { dir, store } = setup(t);
  const base = { title: 't', permissionMode: 'default' as const, createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0 };
  store.putSession({ ...base, id: 'busy', kind: 'worker', sandboxId: 'sb', status: 'running', pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, createdAt: 'x' }] });
  store.putSession({ ...base, id: 'calm', kind: 'worker', sandboxId: 'sb', status: 'idle', pendingPermissions: [] });
  store.putSession({ ...base, id: 'orphan', kind: 'worker', status: 'idle', pendingPermissions: [] });
  store.flush();

  const again = new Store(dir);
  const restored = new SessionManager({ limits: { maxSessions: 6 } } as Config, again);
  const cutOff = restored.restore((info) => (info.id === 'orphan' ? undefined : () => ({})));
  assert.deepEqual(cutOff.map((i) => i.id), ['busy']);
  assert.deepEqual([...restored.sessions.keys()].sort(), ['busy', 'calm']);
  for (const id of ['busy', 'calm']) {
    assert.equal(again.sessions.get(id)!.status, 'stopped');
    assert.deepEqual(again.sessions.get(id)!.pendingPermissions, []);
  }
  assert.match(texts(again, 'busy').at(-1)!, /server restarted while this session was working/);
  assert.deepEqual(again.readTranscript('calm'), []);
  again.flush();
});
