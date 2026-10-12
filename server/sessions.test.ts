import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, firstResultBase, seedSdkCost, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { SessionInfo } from '../shared/types.ts';

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
