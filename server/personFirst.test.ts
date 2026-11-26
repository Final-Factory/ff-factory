// w5931 (lothsahn, 2026-11-26: "my next message to you took over a minute to respond. Why this long delay?" and "You never
// replied earlier to that question"): after the 05:35Z portal deploy his orchestrator launched behind the dispatcher's, and the
// harness messages that came in while it launched ([follow-ups to file], [dispatch], [ops worker]) went into his turn, whose only
// text answered a [dispatch]: his four questions were answered in its thinking alone. Now a launch a person's message waits on
// goes first, and beside one of the harness's; a harness message to an orchestrator waits for its person's turn to end; and a
// person's message to a process still launching goes ahead of the harness messages waiting in its input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentSession, launchTurn, launchesSettled, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { SessionInfo } from '../shared/types.ts';

const tick = () => new Promise((r) => setTimeout(r, 30));

/** A fake Claude Code whose messages the test sends (out), and which records what it read (got). */
function scene(t: { after: (f: () => void) => void }, kind: SessionInfo['kind'] = 'orchestrator') {
  const launches: { options: Options; got: string[]; out: (m: unknown) => void }[] = [];
  setQueryForTesting((({ prompt, options }: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Options }) => {
    const waiting: unknown[] = [];
    let wake: (() => void) | undefined;
    const l = {
      options,
      got: [] as string[],
      out: (m: unknown) => {
        waiting.push(m);
        wake?.();
      },
    };
    launches.push(l);
    void (async () => {
      for await (const m of prompt) l.got.push(typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content));
    })();
    const g = (async function* () {
      const aborted = new Promise<void>((r) => options.abortController!.signal.addEventListener('abort', () => r()));
      for (;;) {
        while (waiting.length) yield waiting.shift() as SDKMessage;
        const more = new Promise<void>((r) => (wake = r));
        if ((await Promise.race([more.then(() => 'more'), aborted.then(() => 'gone')])) === 'gone') return;
      }
    })();
    return Object.assign(g, { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => undefined });
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-person-first-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const session = (id: string) => {
    const info: SessionInfo = { id, kind, title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0, pendingPermissions: [], sdkSessionId: `conv-${id}` };
    store.putSession(info);
    return new AgentSession(info, store, () => ({ model: 'claude-opus-5-5', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } }), new EventEmitter());
  };
  const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
  const words = (got: string[], of: string[]) => got.map((g) => of.find((w) => g.includes(w)) ?? '?');
  return { launches, session, store, idle, words };
}

test("w5931: harness messages sent during a person's turn reach the orchestrator only after it ends, so that turn answers the person", async (t) => {
  const { launches, session, store, idle, words } = scene(t);
  const s = session('sess-held');
  const all = ['biscuit', 'w5911', 'BEAST', 'w5919'];
  s.send('Is biscuit still open for work?', 'human');
  s.send('[follow-ups to file] w5911', 'system');
  s.send('Is BEAST open for work?', 'human');
  s.send('[dispatch] w5919', 'system');
  await launchesSettled();
  await tick();
  assert.equal(launches.length, 1);
  assert.deepEqual(words(launches[0].got, all), ['biscuit', 'BEAST'], "the person's turn holds only their messages");
  assert.equal(s.turnRelayed, false, 'no harness message joined it, so it is no relayed turn');
  assert.deepEqual(
    s.snapshot().unanswered.map((u) => u.from),
    ['human', 'human', 'system', 'system'],
    'a restart now resumes the held messages too',
  );
  assert.equal(store.readTranscript('sess-held').filter((e) => e.kind === 'user').length, 2, 'the chat shows a held message when it is delivered');
  launches[0].out(idle);
  await tick();
  assert.deepEqual(words(launches[0].got, all), ['biscuit', 'BEAST', 'w5911', 'w5919'], 'the held ones go at its end, in order');
  assert.equal(s.snapshot().turnOpen, true, 'and open a turn of their own');
  assert.equal(s.snapshot().lastFrom, 'system');
  s.stop();
});

test("w5931: what comes of the turn's person joins their turn: a relay about them (w831) and their own reaction; a notice about them or a relay about another waits", async (t) => {
  const { launches, session, store, idle, words } = scene(t);
  const s = session('sess-theirs');
  const loth = { userId: 'lothsahn', displayName: 'Lothsahn' };
  const cara = { userId: 'cara', displayName: 'Cara' };
  const all = ['FFBox turn', 'own words', 'reacted', 'w5888', 'from Cara']; // the relayed mark names "own words"
  s.send('[via FFBox] his own words', 'human', undefined, [], loth);
  s.send('[from FFBox via Discord] the whole FFBox turn', 'system', undefined, [], loth, [], true);
  s.send('Lothsahn reacted 🎉', 'system', undefined, [], loth, [], false, true);
  // 2026-11-26 05:38Z: a [dispatch] about him joined his turn, and the turn's only text answered it, not him.
  s.send('[dispatch] w5888 started', 'system', undefined, [], loth);
  s.send('[from Cara, via message_person] close his requests', 'system', undefined, [], cara, [], true);
  await launchesSettled();
  await tick();
  assert.deepEqual(words(launches[0].got, all), ['own words', 'FFBox turn', 'reacted']);
  assert.equal(s.turnRelayed, true, 'the relay about him marks his turn relayed (w5507)');
  assert.ok(store.readTranscript('sess-theirs').some((e) => e.kind === 'user' && e.text.includes('reacted')), 'the reaction is in the chat at once, so a second click changes nothing');
  launches[0].out(idle);
  await tick();
  assert.deepEqual(words(launches[0].got, all), ['own words', 'FFBox turn', 'reacted', 'w5888', 'from Cara']);
  s.stop();
});

test("w5931: a person's message to an orchestrator still launching goes ahead of the harness messages waiting in its input", async (t) => {
  const { launches, session, store, idle, words } = scene(t);
  const s = session('sess-ahead');
  const all = ['w5911', 'w5919', 'delay'];
  s.send('[follow-ups to file] w5911', 'system');
  s.send('[dispatch] w5919', 'system');
  s.send('Why this long delay?', 'human');
  await launchesSettled();
  await tick();
  assert.deepEqual(words(launches[0].got, all), ['delay'], "the person's message opens the first turn");
  assert.equal(s.turnRelayed, false);
  launches[0].out(idle);
  await tick();
  assert.deepEqual(words(launches[0].got, all), ['delay', 'w5911', 'w5919']);
  const users = store.readTranscript('sess-ahead').filter((e) => e.kind === 'user');
  assert.equal(users.length, 3, 'each message shows once in the chat, as sent');
  s.stop();
});

test('w5931: a stop on purpose drops held messages; a worker\'s harness messages join its turn as before', async (t) => {
  const { launches, session } = scene(t);
  const s = session('sess-stop');
  s.send('question', 'human');
  s.send('[dispatch] w1', 'system');
  assert.equal(s.snapshot().unanswered.length, 2);
  s.stop();
  assert.equal(s.snapshot().unanswered.length, 0);
  await launchesSettled();

  const w = scene(t, 'worker').session('sess-worker');
  w.send('brief', 'human');
  w.send('[worker update] x', 'system');
  await launchesSettled();
  await tick();
  assert.equal(launches.length, 0, 'the first scene launched nothing once stopped');
  w.stop();
});

test("w5931: a launch a person's message waits on goes first, beside a running launch of the harness's own", async () => {
  const order: string[] = [];
  const gate = (name: string) => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { open, run: async () => (order.push(`${name} start`), await p, order.push(`${name} end`)) };
  };
  const dispatcher = gate('dispatcher');
  const worker = gate('worker');
  const person = gate('person');
  let urgentLater = false;
  const later = gate('later');
  const a = launchTurn(dispatcher.run);
  const b = launchTurn(worker.run);
  const c = launchTurn(person.run, () => true);
  const d = launchTurn(later.run, () => urgentLater);
  await tick();
  assert.deepEqual(order, ['person start', 'dispatcher start'], "a person's launch does not wait behind the harness's");
  urgentLater = true;
  person.open();
  await tick();
  assert.deepEqual(order.slice(2), ['person end', 'later start'], 'a launch a person wrote to while it waited moves up');
  later.open();
  dispatcher.open();
  await tick();
  assert.ok(order.indexOf('worker start') > order.indexOf('dispatcher end'), "the harness's own launches still go one at a time");
  worker.open();
  await Promise.all([a, b, c, d]);
  await launchesSettled();
});
