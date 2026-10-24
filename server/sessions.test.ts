import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, firstResultBase, seedSdkCost, setQueryForTesting, type TurnBudgetHit } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { SessionInfo, TranscriptEvent } from '../shared/types.ts';

test('after a portal restart a machine agent that was mid-turn shows stopped, saying it may still run there (w424)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-sessions-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = { kind: 'worker' as const, title: 't', permissionMode: 'default' as const, createdAt: 'x', lastActivityAt: 'x', turns: 1, costUsd: 0, pendingPermissions: [], machineId: 'lothdesktop', machineSandbox: 'ghosts-fly' };
  store.putSession({ ...base, id: 'busy', status: 'running' });
  store.putSession({ ...base, id: 'idle', status: 'idle' });
  const sessions = new SessionManager({} as Config, store);
  const handle = (info: SessionInfo) => ({ info, live: false, lastFrom: 'human' as const, send: () => 'u', interrupt: async () => undefined, setMode: async () => undefined, stop: () => undefined, decide: () => false });
  const cutOff = sessions.restore(() => undefined, handle);
  assert.deepEqual(cutOff.map((i) => i.id), ['busy']);
  assert.equal(store.sessions.get('busy')!.status, 'stopped');
  assert.match(store.sessions.get('busy')!.statusDetail ?? '', /^was running when the portal stopped; not heard from its daemon since \(it may still be running there\)$/);
  assert.equal(store.sessions.get('idle')!.statusDetail, undefined, 'an idle one: nothing to say');
});

test('agent titles: one line, trimmed, at most 80 characters, and stored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-sessions-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessions = new SessionManager({} as Config, store);
  const s = sessions.create({ kind: 'worker', title: 'Fix the null reference in BeltSystem when splitting', permissionMode: 'default', options: () => ({}) });
  assert.equal(sessions.setTitle(s.info.id, '  Belt splitter\n fix  (spec 098) '), 'Belt splitter fix (spec 098)');
  assert.equal(store.sessions.get(s.info.id)!.title, 'Belt splitter fix (spec 098)');
  assert.throws(() => sessions.setTitle(s.info.id, '   '), /empty/);
  assert.throws(() => sessions.setTitle(s.info.id, 'x'.repeat(81)), /80/);
  assert.throws(() => sessions.setTitle('nope', 'x'), /no session/);
});

test('turnFrom (w607): a message folded into a turn keeps its starter; a queued one answered in a turn of its own is that turn\'s starter', async (t) => {
  // A scripted CLI: the test says when each message is answered, and whether the turn goes on.
  const seen: { uuid: string; text: string }[] = [];
  const out: unknown[] = [];
  let wake: (() => void) | undefined;
  const emit = (m: unknown) => {
    out.push(m);
    wake?.();
  };
  setQueryForTesting((({ prompt }: { prompt: AsyncIterable<{ uuid: string; message: { content: unknown } }> }) => {
    void (async () => {
      for await (const m of prompt) seen.push({ uuid: m.uuid, text: String(m.message.content) });
    })();
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'scripted', model: 'm', uuid: 'init' };
      for (;;) {
        while (!out.length) await new Promise<void>((r) => (wake = r));
        yield out.shift();
      }
    })();
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-turnfrom-'));
  const store = new Store(dir);
  const sessions = new SessionManager({} as Config, store);
  const s = sessions.create({ kind: 'orchestrator', title: 'Lothsahn', permissionMode: 'bypassPermissions', options: () => ({}) });
  const state = (st: string) => emit({ type: 'system', subtype: 'session_state_changed', state: st, session_id: 'scripted', uuid: `st-${Math.random()}` });
  const result = (uuids: string[]) => emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, duration_ms: 1, user_message_uuids: uuids, session_id: 'scripted', uuid: `r-${Math.random()}` });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const person = sessions.send(s.info.id, 'Please drain and install on BEAST and m5', 'human');
  state('running');
  await settle();
  const update = sessions.send(s.info.id, '[worker update] w602 finished a turn', 'system');
  assert.equal(s.turnFrom, 'human', 'delivered mid-turn: the turn stays the person\'s');
  // The CLI answers the person's message alone; the update waited and gets a turn of its own: the harness's.
  result([person]);
  await settle();
  assert.equal(s.turnFrom, 'system');
  result([update]);
  state('idle');
  await settle();
  // No turn now: the last sender, as before.
  assert.equal(s.turnFrom, 'system');
  // Folded: a person's message and an update answered by one result keep the person's turn to the end.
  const go = sessions.send(s.info.id, 'go', 'human');
  state('running');
  await settle();
  const later = sessions.send(s.info.id, '[dispatch] w596 started', 'system');
  assert.equal(s.turnFrom, 'human');
  result([go, later]);
  await settle();
  assert.equal(s.turnFrom, 'human');
  state('idle');
  await settle();
  assert.equal(seen.length, 4);
});

test("firstResultBase (w1161): a resume that carries the CLI's saved total adds only the rise; totals that began again add in full", () => {
  // The dispatcher on 2026-10-12: the portal's figure ($600) ran ahead of the CLI's own total ($200) after one restart from
  // zero. Resumed, the CLI starts from its saved $200 and this turn costs $0.50: the session's spend grows by $0.50.
  const resumed = firstResultBase(600, 200, 200.5);
  assert.deepEqual(resumed, { base: 400, restarted: false });
  assert.equal(resumed.base + 200.5, 600.5);
  // The same session, but the CLI saved nothing (a crash): its total is this turn alone, counted in full and flagged.
  assert.deepEqual(firstResultBase(600, 200, 0.7), { base: 600, restarted: true });
  // A brand-new session.
  assert.deepEqual(firstResultBase(0, undefined, 0.3), { base: 0, restarted: false });
  // A session from before sdkCostUsd keeps the old rule (seedSdkCost gives the portal's sessions their total first).
  assert.deepEqual(firstResultBase(5, undefined, 5.2), { base: 0, restarted: false });
  assert.deepEqual(firstResultBase(600, undefined, 200.5), { base: 600, restarted: true });
});

test("seedSdkCost (w1161): the portal's sessions without the CLI's total take it from the spend record; ones that have it, and machine sessions, keep theirs", () => {
  const a = { id: 'a', costUsd: 600 } as SessionInfo;
  const b = { id: 'b', costUsd: 9, sdkCostUsd: 9 } as SessionInfo;
  const c = { id: 'c', costUsd: 1 } as SessionInfo;
  const m = { id: 'm', costUsd: 50, machineId: 'beast' } as SessionInfo;
  const n = seedSdkCost([a, b, c, m], (id) => ({ a: 200, b: 1, m: 20 })[id]);
  assert.equal(n, 1);
  assert.equal(m.sdkCostUsd, undefined, 'a machine session: its daemon keeps the field');
  assert.equal(a.sdkCostUsd, 200);
  assert.equal(b.sdkCostUsd, 9);
  assert.equal(c.sdkCostUsd, undefined);
});

test("a resumed process's first turn after a portal restart costs only itself, not the CLI's whole running total (w1161)", async (t) => {
  // Before w1161 this turn read as $200.50 ("auto-compact f8862ae9 (Dispatcher): its last turn cost $214.51" a minute after
  // the 09:32 deploy, 2026-10-12), every result line said restarted, and spend counted the CLI's total again each restart.
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
      yield { type: 'system', subtype: 'init', session_id: 'scripted', model: 'm', uuid: 'init' };
      for (;;) {
        while (!out.length) await new Promise<void>((r) => (wake = r));
        yield out.shift();
      }
    })();
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-resume-cost-'));
  const store = new Store(dir);
  t.after(() => {
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessions = new SessionManager({} as Config, store);
  const s = sessions.create({ kind: 'orchestrator', title: 'Dispatcher', permissionMode: 'bypassPermissions', options: () => ({}) });
  // What the record held when the portal came back: its own figure ahead of the CLI's saved total.
  s.info.costUsd = 600;
  s.info.sdkCostUsd = 200;
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const cum = (usd: number) => ({ 'claude-opus-5-5': { inputTokens: 10, outputTokens: 100, cacheReadInputTokens: usd * 1_000_000, cacheCreationInputTokens: 1000, costUSD: usd } });
  const result = (uuid: string, total: number) => emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: total, modelUsage: cum(total), num_turns: 2, duration_ms: 60_000, user_message_uuids: [uuid], session_id: 'scripted', uuid: `r-${Math.random()}` });
  const first = sessions.send(s.info.id, '[app restarted] FF Factory restarted (update to ba015be24).', 'system');
  await settle();
  result(first, 200.5);
  await settle();
  assert.ok(Math.abs(s.info.costUsd - 600.5) < 1e-9, `costUsd ${s.info.costUsd}`);
  assert.ok(Math.abs((s.info.lastTurnCostUsd ?? 0) - 0.5) < 1e-9, `last turn ${s.info.lastTurnCostUsd}`);
  assert.equal(s.info.sdkCostUsd, 200.5);
  const r1 = store.readTranscript(s.info.id).filter((e) => e.kind === 'result').at(-1)!;
  assert.equal(r1.kind === 'result' && r1.usage?.restarted, undefined, 'not flagged as totals that began again');
  // The next turn in the same process: the rise again.
  const second = sessions.send(s.info.id, '[ledger] nothing waiting', 'system');
  await settle();
  result(second, 201.25);
  await settle();
  assert.ok(Math.abs(s.info.costUsd - 601.25) < 1e-9);
  assert.ok(Math.abs((s.info.lastTurnCostUsd ?? 0) - 0.75) < 1e-9);
});

// ---------------------------------------------------------------- w2007: the coordinators' per-turn budget

/** A scripted CLI for the budget tests: the test emits the stream; `interrupts` counts the process's interrupt() calls. */
function scriptedCli(t: { after: (fn: () => void) => void }) {
  const out: unknown[] = [];
  let wake: (() => void) | undefined;
  const state = { interrupts: 0 };
  const emit = (m: unknown) => {
    out.push(m);
    wake?.();
  };
  setQueryForTesting((({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    void (async () => {
      for await (const _ of prompt) void _;
    })();
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'scripted', model: 'm', uuid: 'init' };
      for (;;) {
        while (!out.length) await new Promise<void>((r) => (wake = r));
        yield out.shift();
      }
    })();
    return Object.assign(stream, { interrupt: async () => void state.interrupts++ });
  }) as never);
  t.after(() => setQueryForTesting(fakeQuery() as never));
  let n = 0;
  /** One content block of model call `id`; a call with several blocks arrives as several messages with the one id. */
  const block = (id: string, read = 1000, sub?: string) =>
    emit({ type: 'assistant', parent_tool_use_id: sub ?? null, uuid: `a${++n}`, session_id: 'scripted', message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `block ${n}` }], usage: { input_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: 7 } } });
  const result = (uuids: string[]) => emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, duration_ms: 1, user_message_uuids: uuids, session_id: 'scripted', uuid: `r${++n}` });
  const idle = () => emit({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: 'scripted', uuid: `st${++n}` });
  const settle = () => new Promise((r) => setTimeout(r, 80));
  return { state, emit, block, result, idle, settle };
}

function budgetSession(t: { after: (fn: () => void) => void }, kind: SessionInfo['kind']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-budget-'));
  const store = new Store(dir);
  const sessions = new SessionManager({} as Config, store);
  t.after(() => {
    sessions.stopAll();
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const s = sessions.create({ kind, title: kind, permissionMode: 'bypassPermissions', options: () => ({}) });
  const hits: TurnBudgetHit[] = [];
  sessions.events.on('turnBudget', (_s: unknown, hit: TurnBudgetHit) => hits.push(hit));
  const errors = () => store.readTranscript(s.info.id).filter((e): e is Extract<TranscriptEvent, { kind: 'error' }> => e.kind === 'error');
  return { sessions, s, store, hits, errors };
}

test("w2007: a coordinator turn of 151 distinct model calls is interrupted once with one event; 150 are not, and a call's repeated content blocks count once", async (t) => {
  const cli = scriptedCli(t);
  const { sessions, s, hits, errors } = budgetSession(t, 'orchestrator');
  sessions.send(s.info.id, 'sweep the whole ledger\nand report', 'human');
  // 150 calls, each arriving as two messages with one id, the first 40 of them a subagent's: the cap is 150, not passed.
  for (let i = 1; i <= 150; i++) for (let b = 0; b < 2; b++) cli.block(`m${i}`, 1000, i <= 40 ? 'toolu_sub' : undefined);
  await cli.settle();
  assert.equal(cli.state.interrupts, 0);
  assert.equal(hits.length, 0);
  // The 151st passes it.
  cli.block('m151');
  await cli.settle();
  assert.equal(cli.state.interrupts, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].calls, 151);
  assert.equal(hits[0].cap, 'calls');
  assert.equal(hits[0].tokensRead, 151 * 1005);
  assert.ok(hits[0].since, 'when the turn opened');
  assert.deepEqual(hits[0].starter, { from: 'human', text: 'sweep the whole ledger\nand report' });
  // What the stream still delivers before the CLI's result stops nothing again.
  cli.block('m152');
  cli.block('m153');
  await cli.settle();
  assert.equal(cli.state.interrupts, 1);
  assert.equal(hits.length, 1);
  // The transcript says it was FF Factory, in words; the stop is on purpose, so a restart resumes nothing.
  assert.deepEqual(errors().map((e) => e.text), ['FF Factory stopped this turn: it made 151 model calls and read 151,755 tokens, over the per-turn budget (150 calls / 25M tokens, w2007).']);
  assert.ok(sessions.get(s.info.id).snapshot!().stoppedOnPurpose);
  assert.equal(s.info.status, 'idle');
});

test('w2007: the token cap fires on a few calls with huge reads', async (t) => {
  const cli = scriptedCli(t);
  const { sessions, s, hits, errors } = budgetSession(t, 'orchestrator');
  sessions.send(s.info.id, 'read everything', 'human');
  cli.block('m1', 9_000_000);
  cli.block('m2', 9_000_000);
  await cli.settle();
  assert.equal(hits.length, 0, '18M read: under 25M');
  cli.block('m3', 8_000_000);
  await cli.settle();
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].calls, hits[0].cap, hits[0].tokensRead], [3, 'tokens', 26_000_015]);
  assert.equal(cli.state.interrupts, 1);
  assert.match(errors()[0].text, /^FF Factory stopped this turn: it made 3 model calls and read 26,000,015 tokens, over the per-turn budget \(150 calls \/ 25M tokens, w2007\)\.$/);
});

test('w2007: a worker is never stopped by the budget, however many calls its turn makes; nor is a standing agent', async (t) => {
  for (const kind of ['worker', 'standing'] as const) {
    const cli = scriptedCli(t);
    const { sessions, s, hits, errors } = budgetSession(t, kind);
    sessions.send(s.info.id, 'long job', 'human');
    for (let i = 1; i <= 500; i++) cli.block(`m${i}`, 100_000);
    await cli.settle();
    assert.equal(cli.state.interrupts, 0, kind);
    assert.equal(hits.length, 0, kind);
    assert.equal(errors().length, 0, kind);
  }
});

test('w2007: the counters start again with each turn: turns of 100 calls each, a queued message in the same CLI turn too, stop nothing', async (t) => {
  const cli = scriptedCli(t);
  const { sessions, s, hits } = budgetSession(t, 'orchestrator');
  const one = sessions.send(s.info.id, 'first', 'human');
  for (let i = 1; i <= 100; i++) cli.block(`a${i}`);
  cli.result([one]);
  cli.idle();
  await cli.settle();
  const two = sessions.send(s.info.id, 'second', 'human');
  for (let i = 1; i <= 100; i++) cli.block(`b${i}`);
  await cli.settle();
  assert.equal(hits.length, 0);
  // Not idle in between: the CLI answers `two`, and goes on with a message queued behind it; its calls are a turn of their own.
  cli.result([two]);
  for (let i = 1; i <= 100; i++) cli.block(`c${i}`);
  await cli.settle();
  assert.equal(hits.length, 0);
  assert.equal(cli.state.interrupts, 0);
  // The same ids in a later turn are new calls, not the earlier turn's.
  cli.result([]);
  cli.idle();
  sessions.send(s.info.id, 'third', 'human');
  for (let i = 1; i <= 150; i++) cli.block(`a${i}`);
  await cli.settle();
  assert.equal(hits.length, 0);
  assert.equal(cli.state.interrupts, 0);
});
