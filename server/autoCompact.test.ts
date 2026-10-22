import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, setQueryForTesting, type AutoCompaction, type SessionHandle, type TurnEndMeta } from './sessions.ts';
import { AUTO_COMPACT_DEFAULTS, AutoCompactor, COMPACT_HOLD, COST_TRIGGER_MIN_TOKENS, DISPATCHER_FOCUS, MAX_COMPACT_ATTEMPTS, MIN_TURNS_BETWEEN, PERSONAL_FOCUS, QUIET_COMPACT_DEFAULTS, RETRY_AFTER_MS, autoCompactSettings, compactBlocker, compactionDue, quietWaitMs } from './autoCompact.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * w535: the orchestrators compact their conversations by themselves, between turns, once the context or a turn's cost
 * passes its threshold, against the scripted fake SDK (e2e/fakeAgent.ts: "#ctx <tokens>" sets the context its usage
 * reports, "#spend <usd>" what the turn costs, "/compact" compacts it to 18,000 tokens).
 */

// "#slow" turns take about 1 s here (40 pieces 25 ms apart), not 4 s.
setQueryForTesting(fakeQuery({ stepMs: 1, slowStepMs: 25 }) as never);

const LOTHSAHN: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

function setup(t: { after: (fn: () => void | Promise<void>) => void }, orchestrator: Partial<Config['orchestrator']> = { compactAtTokens: 50_000 }, settleMs = 20) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-autocompact-'));
  const store = new Store(dir);
  // No quiet wait (w1538) unless a test sets one: the tests from before it compact at the turn's end.
  // dataDir: the send queue is saved there (w1749: what a restart must not lose).
  const cfg = { dataDir: dir, limits: { maxSessions: 6 }, orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false, compactIdleSeconds: 0, ...orchestrator } } as unknown as Config;
  const sessions = new SessionManager(cfg, store);
  const auto = new AutoCompactor(sessions, cfg, { settleMs, retryDelaysMs: RETRIES });
  t.after(async () => {
    auto.stop();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  // What each compaction was sent with: the focus and FF Factory's reason.
  const compactions: { focus: string; auto?: AutoCompaction }[] = [];
  const real = sessions.compact.bind(sessions);
  sessions.compact = (id, focus = '', by, a) => {
    compactions.push({ focus, ...(a ? { auto: a } : {}) });
    return real(id, focus, by, a);
  };
  const ends: { text: string; meta?: TurnEndMeta }[] = [];
  sessions.events.on('turnEnd', (_h: SessionHandle, text: string, meta?: TurnEndMeta) => ends.push({ text, meta }));
  const make = (role: 'personal' | 'dispatcher' = 'personal') =>
    sessions.create({ kind: 'orchestrator', title: role === 'personal' ? 'lothsahn' : 'Dispatcher', permissionMode: 'default', options: () => ({ model: 'opus' }), orchestratorRole: role, ...(role === 'personal' ? { requestedBy: LOTHSAHN } : {}) });
  const say = (id: string, text: string) => sessions.send(id, text, 'human', undefined, { requestedBy: LOTHSAHN });
  return { dir, store, sessions, auto, compactions, ends, make, say, cfg };
}

/** w1749: the retries' waits here, ms (the portal's are 10 s to 5 min). */
const RETRIES = [30, 30, 30, 30, 30];

async function until(pred: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const systemLines = (store: Store, id: string) => store.readTranscript(id).filter((e) => e.kind === 'system').map((e) => ('text' in e ? e.text : ''));
const compacted = (store: Store, id: string) => systemLines(store, id).filter((l) => l.startsWith('Compacted'));

const info = (over: Partial<SessionInfo>) => ({ turns: 10, ...over }) as SessionInfo;
const S = { atTokens: 200_000, atTurnUsd: 1 };

test('compactionDue: the context past compactAtTokens, or a costly turn with 100k or more; 0 turns either off', () => {
  assert.equal(compactionDue(info({ contextTokens: 199_999 }), S), undefined);
  assert.deepEqual(compactionDue(info({ contextTokens: 200_000 }), S), { trigger: 'tokens', reason: 'the context passed 200,000 tokens' });
  assert.equal(compactionDue(info({ contextTokens: 900_000 }), { ...S, atTokens: 0 }), undefined, 'the token trigger off');
  assert.equal(compactionDue(info({}), S), undefined, 'nothing measured yet');
  // The cost trigger: a turn that cost $1 or more, but only with the context at 100k or more (below, it saves too little).
  assert.deepEqual(compactionDue(info({ contextTokens: 120_000, lastTurnCostUsd: 1.25 }), S), { trigger: 'cost', reason: 'its last turn cost $1.25, $1.00 or more, with the context at 120,000 tokens' });
  assert.equal(compactionDue(info({ contextTokens: COST_TRIGGER_MIN_TOKENS - 1, lastTurnCostUsd: 3 }), S), undefined);
  assert.equal(compactionDue(info({ contextTokens: 120_000, lastTurnCostUsd: 0.99 }), S), undefined);
  assert.equal(compactionDue(info({ contextTokens: 120_000, lastTurnCostUsd: 5 }), { ...S, atTurnUsd: 0 }), undefined, 'the cost trigger off');
});

test('compactionDue: never within a few turns of the last compaction, nor again before the context grew by half the threshold', () => {
  const last = { at: '2026-10-06T15:11:07Z', trigger: 'tokens' as const, before: 260_000, after: 40_000, turns: 10 };
  assert.equal(compactionDue(info({ contextTokens: 250_000, turns: 10 + MIN_TURNS_BETWEEN - 1, lastCompaction: last }), S), undefined);
  assert.equal(compactionDue(info({ contextTokens: 250_000, turns: 10 + MIN_TURNS_BETWEEN, lastCompaction: last }), S)?.trigger, 'tokens');
  // A compaction that left 180k (a threshold set below what a summary can reach) waits until 280k, not every 3 turns.
  const big = { ...last, after: 180_000 };
  assert.equal(compactionDue(info({ contextTokens: 250_000, turns: 20, lastCompaction: big }), S), undefined);
  assert.equal(compactionDue(info({ contextTokens: 280_000, turns: 20, lastCompaction: big }), S)?.trigger, 'tokens');
});

test('autoCompactSettings: defaults 200,000 tokens, $1, 120 s quiet and 100,000 hard, as config sets them; 0 is off', () => {
  assert.deepEqual(autoCompactSettings({ orchestrator: {} } as Config), { atTokens: AUTO_COMPACT_DEFAULTS.atTokens, atTurnUsd: AUTO_COMPACT_DEFAULTS.atTurnUsd, idleSeconds: QUIET_COMPACT_DEFAULTS.idleSeconds, hardAtTokens: QUIET_COMPACT_DEFAULTS.hardAtTokens });
  assert.deepEqual(AUTO_COMPACT_DEFAULTS, { atTokens: 200_000, atTurnUsd: 1 });
  assert.deepEqual(QUIET_COMPACT_DEFAULTS, { idleSeconds: 120, hardAtTokens: 100_000 });
  assert.deepEqual(autoCompactSettings({ orchestrator: { compactAtTokens: 0, compactAtTurnUsd: 2.5, compactIdleSeconds: 0, compactHardAtTokens: 300_000 } } as Config), { atTokens: 0, atTurnUsd: 2.5, idleSeconds: 0, hardAtTokens: 300_000 });
});

test('quietWaitMs (w1538): above the soft threshold it waits for 120 s without a turn; at the hard one, or with hard at or under soft, never', () => {
  const live = { atTokens: 80_000, atTurnUsd: 1, idleSeconds: 120, hardAtTokens: 100_000 };
  const end = Date.parse('2026-10-19T12:00:00Z');
  // Below the soft threshold nothing is due, so nothing waits either.
  assert.equal(compactionDue(info({ contextTokens: 79_999 }), live), undefined);
  // Above it: 2 minutes of quiet after the last turn's end compacts; a turn that ended 30 s ago waits 90 s more.
  assert.equal(compactionDue(info({ contextTokens: 85_000 }), live)?.trigger, 'tokens');
  assert.equal(quietWaitMs({ contextTokens: 85_000 }, live, end, end + 120_000), 0);
  assert.equal(quietWaitMs({ contextTokens: 85_000 }, live, end, end + 30_000), 90_000);
  // A message answered at +100 s starts the clock again from that turn's end.
  assert.equal(quietWaitMs({ contextTokens: 85_000 }, live, end + 100_000, end + 120_000), 100_000);
  // At the hard threshold: at once, whatever just happened.
  assert.equal(quietWaitMs({ contextTokens: 100_000 }, live, end, end + 1), 0);
  // Hard at or under soft, or 0 s: as before w1538, at once.
  assert.equal(quietWaitMs({ contextTokens: 85_000 }, { ...live, hardAtTokens: 80_000 }, end, end + 1), 0);
  assert.equal(quietWaitMs({ contextTokens: 85_000 }, { ...live, hardAtTokens: 0 }, end, end + 1), 0);
  assert.equal(quietWaitMs({ contextTokens: 85_000 }, { ...live, idleSeconds: 0 }, end, end + 1), 0);
  // No turn known to have ended (nothing says it was busy): at once. A worker's settings carry no wait.
  assert.equal(quietWaitMs({ contextTokens: 85_000 }, live, undefined, end), 0);
  assert.equal(quietWaitMs({ contextTokens: 85_000 }, { atTokens: 80_000, atTurnUsd: 0 }, end, end + 1), 0);
});

test('compactBlocker: only between turns, with nothing waiting', () => {
  const h = (over: Partial<SessionInfo>, extra: Partial<{ live: boolean; compactingNow: boolean }> = {}) =>
    ({ info: { kind: 'orchestrator', status: 'idle', sdkSessionId: 'x', pendingPermissions: [], ...over }, live: true, compact: () => '', ...extra }) as unknown as SessionHandle & { compactingNow?: boolean };
  assert.equal(compactBlocker(h({}), false), undefined);
  assert.match(compactBlocker(h({ status: 'running' }), false)!, /running/);
  assert.match(compactBlocker(h({ status: 'waiting_permission' }), false)!, /waiting permission/);
  assert.match(compactBlocker(h({ turnOpenSince: '2026-10-06T15:00:00Z' }), false)!, /not answered/);
  assert.match(compactBlocker(h({}), true)!, /send queue/);
  assert.match(compactBlocker(h({}, { live: false }), false)!, /process is not running/);
  assert.match(compactBlocker(h({}, { compactingNow: true }), false)!, /compacting already/);
  // w1469: a worker too, when its daemon can compact it (its handle has compact); a standing agent never
  assert.equal(compactBlocker(h({ kind: 'worker' }), false), undefined);
  assert.match(compactBlocker(h({ kind: 'worker' }, { compact: undefined } as never), false)!, /daemon cannot compact/);
  assert.match(compactBlocker(h({ kind: 'standing' }), false)!, /not an orchestrator/);
});

test('past the threshold, an orchestrator compacts by itself after its turn: one line "Compacted: N → M tokens", no notification, the last report stays', async (t) => {
  const { store, auto, compactions, ends, make, say } = setup(t);
  const o = make();
  say(o.info.id, 'small talk');
  await until(() => o.info.status === 'idle', 'the first turn');
  await sleep(60);
  assert.equal(compactions.length, 0, 'under 50,000 tokens: no compaction');
  assert.equal(o.info.contextTokens, 25_000, "the context measured from the reply's usage");
  say(o.info.id, 'a long one #ctx 60000');
  await until(() => compacted(store, o.info.id).length === 1 && o.info.status === 'idle' && !!o.info.lastCompaction, 'the automatic compaction');
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].focus, PERSONAL_FOCUS, "a person's orchestrator keeps its open requests, questions, decisions and ids");
  assert.deepEqual(compactions[0].auto, { trigger: 'tokens', reason: 'the context passed 50,000 tokens' });
  // One line in the chat, when it is done; nothing when it starts.
  assert.deepEqual(systemLines(store, o.info.id).filter((l) => /ompact/.test(l)), ['Compacted: 60,000 → 18,000 tokens (automatically: the context passed 50,000 tokens), in 2 s.']);
  assert.deepEqual({ ...o.info.lastCompaction, at: undefined }, { at: undefined, trigger: 'tokens', before: 60_000, after: 18_000, turns: 2 });
  assert.equal(o.info.contextTokens, 18_000);
  assert.equal(o.info.lastResult, 'Echo: a long one #ctx 60000', 'the last report is the last real reply');
  assert.equal(o.info.turns, 2);
  // Its end is marked as an automatic compaction (notify.ts sends nothing for it), and carries the last reply's text.
  assert.deepEqual(ends.at(-1), { text: 'Echo: a long one #ctx 60000', meta: { compaction: 'tokens' } });
  // No loop: the compaction's own end is not checked, and the next turns are under the threshold again.
  say(o.info.id, 'still there?');
  await until(() => o.info.lastResult === 'Echo: still there?' && o.info.status === 'idle', 'the next answer');
  await sleep(60);
  assert.equal(compactions.length, 1);
  assert.equal(auto.check(o.info.id), 'not due');
});

test('the dispatcher gets the same, with its own focus', async (t) => {
  const { store, compactions, make, say } = setup(t);
  const d = make('dispatcher');
  say(d.info.id, '[intake] five reports #ctx 70000');
  await until(() => compacted(store, d.info.id).length === 1, 'the compaction');
  assert.equal(compactions[0].focus, DISPATCHER_FOCUS);
});

test('a costly turn compacts it once the context is 100k or more', async (t) => {
  const { store, compactions, make, say } = setup(t, { compactAtTokens: 0, compactAtTurnUsd: 0.5 });
  const o = make();
  say(o.info.id, 'a costly turn at 80k #ctx 80000 #spend 0.6');
  await until(() => o.info.status === 'idle', 'the turn');
  await sleep(60);
  assert.ok(o.info.lastTurnCostUsd! >= 0.6, `the turn's cost is measured (${o.info.lastTurnCostUsd})`);
  assert.equal(compactions.length, 0, 'at 80,000 tokens a compaction would save too little');
  say(o.info.id, 'another at 120k #ctx 120000 #spend 0.6');
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction');
  assert.equal(compactions[0].auto?.trigger, 'cost');
  assert.match(compacted(store, o.info.id)[0], /^Compacted: 120,000 → 18,000 tokens \(automatically: its last turn cost \$0\.6\d, \$0\.50 or more, with the context at 120,000 tokens\)/);
});

test("never ahead of a person's message: one that arrives as the turn ends is answered first, and the compaction follows that turn", async (t) => {
  const { store, compactions, make, say } = setup(t, { compactAtTokens: 50_000 }, 150);
  const o = make();
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.status === 'idle', 'the first turn');
  // Within the settle time after the turn: the person writes again.
  say(o.info.id, 'and one more thing #slow');
  await sleep(200);
  assert.equal(compactions.length, 0, 'mid-turn: not compacted');
  assert.equal(o.info.status, 'running');
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction after that turn', 15_000);
  const all = store.readTranscript(o.info.id).map((e) => ('text' in e ? e.text : ''));
  const answered = all.indexOf('Echo: and one more thing #slow');
  assert.ok(answered >= 0 && answered < all.findIndex((l) => l.startsWith('Compacted')), 'the reply came before the compaction');
});

test('a message that arrives while it compacts waits behind it and is answered after it', async (t) => {
  const { store, sessions, make, say } = setup(t);
  const o = make();
  // The person writes the moment the compaction has been sent.
  const compact = sessions.compact.bind(sessions);
  sessions.compact = (...args) => {
    const note = compact(...args);
    assert.equal(o.info.statusDetail, 'compacting the conversation');
    say(o.info.id, 'are you there?');
    return note;
  };
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.lastResult === 'Echo: are you there?' && o.info.status === 'idle', 'the answer');
  const all = store.readTranscript(o.info.id).map((e) => ('text' in e ? e.text : ''));
  assert.ok(all.findIndex((l) => l.startsWith('Compacted')) >= 0);
  assert.equal(o.info.turns, 2);
});

test('compact_conversation: the orchestrator asks for it; it runs after the turn, with its focus, and not again within a few turns', async (t) => {
  const { store, auto, compactions, make, say } = setup(t);
  const o = make();
  say(o.info.id, 'hello');
  await until(() => o.info.status === 'idle', 'the first turn');
  assert.match(auto.request(o.info.id, 'keep the w530 numbers'), /compacted once this turn ends \(its context is 25,000 tokens now\)/);
  say(o.info.id, 'wrap up');
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction');
  assert.deepEqual(compactions[0], { focus: 'keep the w530 numbers', auto: { trigger: 'self', reason: 'the orchestrator asked for it' } });
  assert.match(compacted(store, o.info.id)[0], /\(automatically: the orchestrator asked for it\)/);
  await until(() => o.info.lastCompaction?.trigger === 'self', 'the record');
  assert.throws(() => auto.request(o.info.id), /compacted 0 turn\(s\) ago \(30,000 → 18,000 tokens\)/);
  assert.throws(() => auto.request(o.info.id, 'x'.repeat(2001)), /2001 characters/);
});

test('w1749: an automatic compaction that fails is retried, each attempt logged, and given up after MAX_COMPACT_ATTEMPTS; then not for half an hour', async (t) => {
  const { store, auto, make, say } = setup(t);
  const o = make();
  say(o.info.id, 'hello');
  await until(() => o.info.status === 'idle', 'the first turn');
  // Its own focus fails every time ("#fail"), and goes with every retry.
  auto.request(o.info.id, '#fail');
  const logged: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a: unknown[]) => void logged.push(a.join(' '));
  console.warn = (...a: unknown[]) => void logged.push(a.join(' '));
  t.after(() => {
    console.log = log;
    console.warn = warn;
  });
  say(o.info.id, 'big #ctx 60000');
  const errors = () => store.readTranscript(o.info.id).filter((e) => e.kind === 'error');
  await until(() => errors().length === MAX_COMPACT_ATTEMPTS && !o.info.compactOwed, 'every attempt', 8000);
  await until(() => o.info.status === 'idle', 'idle');
  assert.equal(errors().at(-1)!.text, 'The automatic compaction failed: the summary request failed.');
  assert.equal(o.info.lastResult, 'Echo: big #ctx 60000', 'a failed compaction is no reply');
  // One log line per attempt, and one per failure, numbered.
  for (let n = 1; n <= MAX_COMPACT_ATTEMPTS; n++) {
    assert.ok(logged.some((l) => l.includes(`; attempt ${n} of ${MAX_COMPACT_ATTEMPTS}`)), `attempt ${n} logged`);
    assert.ok(logged.some((l) => l.includes(`attempt ${n} of ${MAX_COMPACT_ATTEMPTS} failed (the summary request failed)`)), `failure ${n} logged`);
  }
  assert.match(systemLines(store, o.info.id).at(-1)!, /^FF Factory gave up compacting this conversation after 6 attempts \(the last failed: the summary request failed\)/);
  // Given up: the old rule holds the next automatic one for half an hour.
  assert.match(auto.check(o.info.id), /did not finish/);
  assert.match(auto.check(o.info.id, Date.now() + RETRY_AFTER_MS + 1000), /^compacting: the context passed 50,000 tokens/);
  await until(() => compacted(store, o.info.id).length === 1, 'the next one');
});

test('a person\'s /compact (w518) still says so at once and when done, and counts as the last compaction', async (t) => {
  const { store, sessions, ends, make, say } = setup(t, { compactAtTokens: 0, compactAtTurnUsd: 0 });
  const o = make();
  say(o.info.id, 'hello');
  await until(() => o.info.status === 'idle', 'the first turn');
  sessions.compact(o.info.id, '', LOTHSAHN);
  await until(() => o.info.lastCompaction?.trigger === 'person', 'the record');
  assert.match(systemLines(store, o.info.id).find((l) => l.startsWith('Compacting'))!, /asked by Lothsahn/);
  assert.match(compacted(store, o.info.id)[0], /^Compacted: the context went from 25,000 tokens to 18,000 tokens/);
  assert.deepEqual(ends.at(-1)?.meta, { compaction: 'person' });
});

/** w1538's live cases: a short quiet wait (fractional seconds; set_app_config takes whole ones), and when each turn ended. */
function quietSetup(t: Parameters<typeof setup>[0], idleSeconds: number) {
  const env = setup(t, { compactAtTokens: 50_000, compactHardAtTokens: 100_000, compactIdleSeconds: idleSeconds });
  const turnEnds: number[] = [];
  const compactedAt: number[] = [];
  env.sessions.events.on('turnEnd', (_h: SessionHandle, _text: string, meta?: TurnEndMeta) => {
    if (!meta?.compaction) turnEnds.push(Date.now());
  });
  const real = env.sessions.compact;
  env.sessions.compact = (...args) => {
    compactedAt.push(Date.now());
    return real(...args);
  };
  return { ...env, turnEnds, compactedAt };
}

test('w1538: above the soft threshold, after the quiet wait with no message, it compacts by itself', async (t) => {
  const { store, auto, compactions, turnEnds, compactedAt, make, say } = quietSetup(t, 0.4);
  const o = make();
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.status === 'idle' && turnEnds.length === 1, 'the turn');
  await sleep(100);
  assert.equal(compactions.length, 0, 'not at the turn end: under 100,000 tokens it waits for quiet');
  assert.match(auto.check(o.info.id), /^not yet: the context passed 50,000 tokens; it compacts after 0.4 s without a turn/);
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction after the quiet wait');
  assert.equal(compactions.length, 1);
  assert.deepEqual(compactions[0].auto, { trigger: 'tokens', reason: 'the context passed 50,000 tokens' });
  assert.ok(compactedAt[0] - turnEnds[0] >= 390, `it waited the quiet spell (${compactedAt[0] - turnEnds[0]} ms)`);
});

test('w1538: above the soft threshold, a message inside the wait holds it off and starts the clock again from that turn', async (t) => {
  const { store, compactions, turnEnds, compactedAt, make, say } = quietSetup(t, 0.6);
  const o = make();
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.status === 'idle' && turnEnds.length === 1, 'the first turn');
  await sleep(350);
  // The person writes inside the 0.6 s: a turn, and the wait starts over from its end.
  say(o.info.id, 'one more thing #ctx 62000');
  await until(() => o.info.status === 'idle' && turnEnds.length === 2, 'the second turn');
  await sleep(400);
  assert.equal(compactions.length, 0, `${Date.now() - turnEnds[0]} ms after the first turn, but only ${Date.now() - turnEnds[1]} ms after the second`);
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction after the second quiet wait');
  assert.equal(compactions.length, 1, 'once, not once per turn');
  assert.ok(compactedAt[0] - turnEnds[1] >= 590, `measured from the second turn's end (${compactedAt[0] - turnEnds[1]} ms)`);
  assert.equal(o.info.lastResult, 'Echo: one more thing #ctx 62000');
});

test('w1538: at the hard threshold it compacts at the turn end, however busy the conversation is', async (t) => {
  const { store, compactions, turnEnds, compactedAt, make, say } = quietSetup(t, 60);
  const o = make();
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.status === 'idle' && turnEnds.length === 1, 'the first turn');
  // A message right after: under the hard threshold this would wait a minute; past it, it does not.
  say(o.info.id, 'bigger #ctx 120000');
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction at the turn end');
  assert.equal(compactions.length, 1);
  assert.deepEqual(compactions[0].auto, { trigger: 'tokens', reason: 'the context passed 50,000 tokens' });
  assert.ok(compactedAt[0] - turnEnds[1] < 2000, `at the turn end (${compactedAt[0] - turnEnds[1]} ms), not after a minute`);
});

test('w1538: below the soft threshold, quiet changes nothing', async (t) => {
  const { auto, compactions, make, say } = quietSetup(t, 0.2);
  const o = make();
  say(o.info.id, 'small talk');
  await until(() => o.info.status === 'idle', 'the turn');
  await sleep(500);
  assert.equal(o.info.contextTokens, 25_000);
  assert.equal(compactions.length, 0);
  assert.equal(auto.check(o.info.id), 'not due');
});

test('w1538: the quiet clock survives a portal restart: a new compactor reads the saved end of the last turn', async (t) => {
  const { sessions, cfg, compactions, make, say } = quietSetup(t, 60);
  const o = make();
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.status === 'idle' && !!o.info.lastResultAt, 'the turn');
  const ended = Date.parse(o.info.lastResultAt!);
  const after = new AutoCompactor(sessions, cfg, { settleMs: 20 });
  t.after(() => after.stop());
  assert.match(after.check(o.info.id, ended + 30_000), /^not yet: .*\(30 s more\)/, 'it knows nothing of the turn but its saved end');
  assert.equal(compactions.length, 0);
  assert.match(after.check(o.info.id, ended + 60_000), /^compacting: the context passed 50,000 tokens/);
});

test('w1538: a message that arrives while a quiet-wait compaction runs waits behind it and is answered after it', async (t) => {
  const { store, sessions, make, say } = quietSetup(t, 0.2);
  const o = make();
  const compact = sessions.compact;
  sessions.compact = (...args) => {
    const note = compact(...args);
    assert.equal(o.info.statusDetail, 'compacting the conversation');
    say(o.info.id, 'are you there?');
    return note;
  };
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.lastResult === 'Echo: are you there?' && o.info.status === 'idle', 'the answer');
  const all = store.readTranscript(o.info.id).map((e) => ('text' in e ? e.text : ''));
  const done = all.findIndex((l) => l.startsWith('Compacted'));
  assert.ok(done >= 0 && done < all.indexOf('Echo: are you there?'), 'the compaction first, then the answer');
  assert.equal(o.info.turns, 2);
});

/**
 * w1749 (lothsahn: "Can you make sure compaction works even if I close the browser or the session is closed?"): on
 * 2026-10-22 the portal stopped lothsahn's orchestrator 35 s into an automatic compaction (a deploy's SIGTERM, 05:44) and
 * 79 s into the next (the nightly restart, 06:00); stop() failed each one ("the session was stopped") and nothing ran it
 * again until a later turn. No browser takes part in any of these tests: the compaction is the portal's alone.
 */
const queuedFor = (sessions: SessionManager, id: string) => sessions.queued().filter((q) => q.id === id);
const index = (store: Store, id: string, pred: (l: string) => boolean) => store.readTranscript(id).findIndex((e) => 'text' in e && pred(e.text));

test('w1749: due while the session is closed, the portal starts it and compacts it', async (t) => {
  const { store, compactions, make, say } = quietSetup(t, 0.3);
  const o = make();
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.status === 'idle', 'the turn');
  // Due, waiting for quiet: owed from now on, so neither a stop nor a restart loses it.
  await until(() => o.info.compactOwed?.attempts === 0, 'owed');
  assert.equal(o.info.compactOwed!.reason, 'the context passed 50,000 tokens');
  // The person closes the session inside the quiet wait.
  o.stop();
  assert.equal(o.live, false);
  await until(() => compacted(store, o.info.id).length === 1, 'the compaction, its process started for it');
  assert.equal(compactions.length, 1);
  assert.equal(o.info.compactOwed, undefined, 'nothing owed once it is done');
  await until(() => o.info.status === 'idle', 'idle again');
  assert.equal(o.info.lastResult, 'Echo: big #ctx 60000');
});

test('w1749: closed partway through, the compaction is retried; the messages sent meanwhile wait and are answered after it', async (t) => {
  const { store, sessions, compactions, make, say } = setup(t);
  const o = make();
  const compact = sessions.compact.bind(sessions);
  let first = true;
  sessions.compact = (...args) => {
    const note = compact(...args);
    if (first) {
      first = false;
      // A worker's update arrives while it compacts, then the person closes the session, then a dispatch arrives.
      sessions.send(o.info.id, '[worker update] w1 is done', 'system');
      o.stop();
      sessions.send(o.info.id, '[dispatch] w2 is yours', 'system');
    }
    return note;
  };
  say(o.info.id, 'big #ctx 60000');
  await until(() => o.info.lastResult === 'Echo: [dispatch] w2 is yours' && o.info.status === 'idle', 'both answered', 8000);
  assert.equal(compactions.length, 2, 'the attempt the stop cut off, and the retry');
  const failed = index(store, o.info.id, (l) => l === 'The automatic compaction failed: the session was stopped.');
  const done = index(store, o.info.id, (l) => l.startsWith('Compacted: '));
  const update = index(store, o.info.id, (l) => l === 'Echo: [worker update] w1 is done');
  const dispatch = index(store, o.info.id, (l) => l === 'Echo: [dispatch] w2 is yours');
  assert.ok(failed >= 0 && failed < done, 'the stop failed the first attempt; the retry finished it');
  assert.ok(done < update && update < dispatch, 'both messages after the compaction, in the order they came');
  assert.ok(systemLines(store, o.info.id).some((l) => l.startsWith(`A message is waiting for this conversation's compaction (${COMPACT_HOLD})`)));
  assert.equal(o.info.compactOwed, undefined);
  assert.deepEqual(queuedFor(sessions, o.info.id), []);
});

test('w1749: a portal restart during the compaction: the next portal runs it again, then delivers what waited', async (t) => {
  const { dir, store, sessions, auto, cfg, make, say } = setup(t);
  const o = make();
  const compact = sessions.compact.bind(sessions);
  sessions.compact = (...args) => {
    const note = compact(...args);
    // A timer fires while it compacts; then the portal stops (index.ts stopServer: stopAll, flush).
    sessions.send(o.info.id, '[timer] check w3', 'system');
    sessions.stopAll();
    // This portal is gone: its pending checks (the retry the stop just timed) with it.
    auto.stop();
    store.flush();
    return note;
  };
  say(o.info.id, 'big #ctx 60000');
  await until(() => !!o.info.compactOwed?.lastError, 'the attempt cut off');
  assert.equal(o.info.compactOwed!.lastError, 'the session was stopped');
  store.flush();

  // The next portal: the session comes back stopped, its owed compaction and its waiting message with it.
  const again = new Store(dir);
  const restored = new SessionManager(cfg, again);
  const cutOff = restored.restore(() => () => ({ model: 'opus' }));
  assert.deepEqual(cutOff, [], 'a compaction is no turn of a person\'s to resume');
  assert.equal(restored.queued().length, 1, 'the timer waits in the saved send queue');
  const next = new AutoCompactor(restored, cfg, { settleMs: 20, retryDelaysMs: RETRIES });
  t.after(() => {
    next.stop();
    restored.stopAll();
  });
  const r = restored.get(o.info.id);
  assert.equal(r.info.compactOwed?.attempts, 1);
  assert.equal(next.boot(), 1);
  await until(() => r.info.lastResult === 'Echo: [timer] check w3' && r.info.status === 'idle', 'the timer answered', 8000);
  const done = index(again, o.info.id, (l) => l.startsWith('Compacted: '));
  assert.ok(done >= 0 && done < index(again, o.info.id, (l) => l === 'Echo: [timer] check w3'), 'compacted first');
  assert.equal(r.info.compactOwed, undefined);
  assert.deepEqual(restored.queued(), []);
  again.flush();
});

test('w1749: a portal killed mid-compaction (no clean stop): the next portal says so and compacts it', async (t) => {
  const { dir, cfg } = setup(t);
  const seed = new Store(dir);
  const base = { title: 'lothsahn', permissionMode: 'default' as const, createdAt: 'x', lastActivityAt: 'x', turns: 5, costUsd: 0, pendingPermissions: [], requestedBy: LOTHSAHN, orchestratorRole: 'personal' as const };
  seed.putSession({ ...base, id: 'o1', kind: 'orchestrator', sdkSessionId: 'fake-killed', contextTokens: 60_000, status: 'running', statusDetail: 'compacting the conversation', compactOwed: { trigger: 'tokens', reason: 'the context passed 50,000 tokens', since: new Date().toISOString(), attempts: 1, lastAttemptAt: new Date().toISOString() } });
  seed.flush();
  const again = new Store(dir);
  const restored = new SessionManager(cfg, again);
  assert.deepEqual(restored.restore(() => () => ({ model: 'opus' })), []);
  assert.match(again.readTranscript('o1').map((e) => ('text' in e ? e.text : '')).at(-1)!, /restarted while this conversation was being compacted; FF Factory compacts it again now/);
  const next = new AutoCompactor(restored, cfg, { settleMs: 20, retryDelaysMs: RETRIES });
  t.after(() => {
    next.stop();
    restored.stopAll();
  });
  // A message before the retry goes: it waits for it.
  restored.send('o1', 'are you there?', 'human', undefined, { requestedBy: LOTHSAHN });
  assert.equal(restored.queued().length, 1);
  next.boot();
  const r = restored.get('o1');
  await until(() => r.info.lastResult === 'Echo: are you there?' && r.info.status === 'idle', 'the answer', 8000);
  assert.ok(index(again, 'o1', (l) => l.startsWith('Compacted: ')) < index(again, 'o1', (l) => l === 'Echo: are you there?'));
  assert.equal(r.info.compactOwed, undefined);
  again.flush();
});
