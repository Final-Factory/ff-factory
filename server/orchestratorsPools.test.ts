import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { promptText, reportClip, SessionManager, setQueryForTesting, type SessionHandle } from './sessions.ts';
import { MachineManager, STANDING_CAP_NO_POOL, agentCap, type RemoteSession } from './machines.ts';
import { Agents } from './agents.ts';
import { SpendStore } from './spend.ts';
import { Identity } from './identity.ts';
import { PERSONAL_TOOLS, beltFor } from './belts.ts';
import { OPS_ID } from './opsWorker.ts';
import { crossOwnerLine, delegationConstraints, DispatcherChatRefused, DISPATCHER_CHAT_REFUSED, FILINGS_PER_MESSAGE, loopGuards, FOLLOW_UPS_PER_MESSAGE, MESSAGES_PER_PERSON, OFFLINE_NOTICE_MS, offlineNoticeMs, OWNER_LOOP_MESSAGES_PER_HOUR, PERSON_MESSAGE_CHARS, personMessage, toldOf, unpushedText, type Orchestrators } from './orchestrators.ts';
import { configPath, type Config } from './config.ts';
import { memoryDirFor } from './orchestratorMemory.ts';
import { handoverNote, isOpen, requestAsFiled, requestNotice } from './work.ts';
import { BlockerWatch, compileErrorsIn, COMPILE_READ_MS, ghCompileVerdict, ghMerge, MERGE_TRIES, notMergeableRefusal, remergeJob, REPORTED_WAIT_MS } from './blockerWatch.ts';
import { noteBudget, resetBudgets } from './ghBudget.ts';
import { poolForRef, type GatePoolToken } from './usageGate.ts';
import { inheritedPayer, personForWork, sessionPerson, setVaultContext } from './vault.ts';
import { fakeToken, useFakeVault } from './testVault.ts';
import { parseNotice } from '../shared/notices.ts';
import { diskWaitIn, handUpLive, handUpsPending, holdsOf, portalWaitIn, requestWaitOf, siblingWaitOf } from '../shared/workState.ts';
import { latestLine } from '../shared/latestLine.ts';
import { CARDS_MARK, HELD_MARK, RELAYED_MARK, inPersonWords } from '../shared/conditional.ts';
import { personMessageView } from '../shared/personMessage.ts';
import { ANSWER_EXCERPT_CHARS, answeredText, answerExcerpt, splitReply, splitSent } from '../shared/replies.ts';
import { forYouId, splitForYou } from '../shared/forYou.ts';
import { blockerName, gatesOf, type PrHealth } from '../shared/blockers.ts';
import { answersText } from '../shared/questionCard.ts';
import { cargoShortOf, fetchPlayerNote, isCargoRepo, needsTimed, PAIR_HOLD_MS, TIMED_HOLD_MS, pairText, unfitWhy } from '../shared/capacity.ts';
import { pickReclaim, type Pressure } from './priorityReclaim.ts';
import { STEAM_READ } from '../shared/steam.ts';
import { benchLockIn, type BenchState, type BusyJob, type Machine, type MachineStats, type Requester, type SessionInfo, type TranscriptEvent, type UserInfo, type WorkBlocker, type WorkItem } from '../shared/types.ts';
import { LIVE_HOLD_MS, releaseWhy } from './placeAgain.ts';
import { ReportStore } from './reports.ts';
import { reportProblem } from './ledgerRules.ts';
import { MOVE_AFTER_MS } from './resumeMove.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { PR2395_DIFF, W1958_0459, W1958_1632, W2651_0457, W2651_2051 } from './priorDecisions.fixtures.ts';
import { startTestMachine, type TestMachineOptions } from './testMachine.ts';
import { afterMergeReason } from './ledgerRules.ts';
import { doneIdsIn, legDoneIdsIn } from './ledgerRules.ts';
import { roomForWork, timedLine, type Computer, type RoomNow } from './placement.ts';
import type { Occupant } from './timedLegPlace.ts';
import { decisionsOn } from '../shared/waiting.ts';
import { TOOL_MANIFEST, deferredToolsLine, toolsOf } from './toolManifest.ts';
import { checkTimedAsk } from './timedAsk.ts';
import { buildOptions } from './launch.ts';
import { AttachmentStore } from './attachments.ts';
import { readCrashHold, readTimedAsk, writeBenchPriorities } from '../machine/benchLock.ts';
import { checkCrashHoldLaunch } from './guard.ts';
import { CRASH_HOLD_WINDOW_MS, liveCrashHolds, noteBench, recentPlayers, riskyTicket, type PlayerSeen } from './crashHolds.ts';
import {
  shortSlowTurns,
  BEN,
  LOTH,
  PEOPLE,
  CARA,
  WITH_CARA,
  T0,
  turnEnded,
  firstTurn,
  until,
  setup,
  setupOnMachine,
  OWNERS,
  type UserEv,
  R1,
  R2,
  R3,
  TH,
  fireTimer,
  investigations,
  agentsRoom,
  twoRequestsOneWorker,
  CIRCUIT_QUESTIONS,
  sleep,
  FRAME_Q,
  STRIP_Q,
  wakeOf,
  firstSaid,
  setupTwoAccounts,
  putRequests,
  startedFor,
  agentsRoomFacts,
  busySandbox,
  secondWorkerOn,
  mergeOnGreenArm,
  ownPrs,
  gateRefs,
  LOTH_TOKEN,
  POOL_HELD_UNTIL,
  lothPool,
  heldVault,
  M5_NO,
  fixTimedFacts,
  askFleet,
  queuedItem,
  twoComputers,
  W4595_BRIEF,
  pingOrder,
  legWorker,
  W1936,
  PR2340,
  legsStarted,
  livePairFor,
  heldLegFor,
  putReport,
  w2371Setup,
  timedLegRow,
  crossOwnerQuestion,
  toldPeople,
  relayAsCard,
} from './orchestratorsTestKit.ts';

/**
 * The orchestrator tests (docs/orchestrators.md), end to end on a real Agents with the scripted agent: Claude pool holds, usage gates, two accounts, queued and timed work, the bench.
 * One of the server/orchestrators*.test.ts files split out of orchestrators.test.ts (w5826); helpers in orchestratorsTestKit.ts.
 */


test('w3796: the backstop never sweeps a wait whose run at its head is still running (a finished headless wait on the same PR left its mark)', async () => {
  const at = new Date().toISOString();
  const pr = 'Final-Factory/ffu#533';
  const OLD = '5c1e2d4f00000000000000000000000000000000';
  const NEW = '98b6c01a00000000000000000000000000000000';
  // w3753 on 2026-11-09: its wait set before d24c7e7 carried no head and finished red at 04:08Z; its new wait at 98b6c01
  // (run 42561523761 in progress) was swept at once at 04:24Z and 04:26Z.
  const w = { id: 'w3753', status: 'blocked', blocked: { kind: 'ci', ref: pr, what: 'CI on #533', at, by: 'worker a' } } as unknown as WorkItem;
  const work = new Map([['w3753', w]]);
  let fail = true;
  const cleared: string[] = [];
  const orchestrators = {
    unblock: (id: string, why: string) => {
      if (fail) throw new Error('boom');
      cleared.push(`${id}: ${why}`);
      w.status = 'active';
    },
  } as unknown as ConstructorParameters<typeof BlockerWatch>[0]['orchestrators'];
  let clock = Date.now();
  const red = `CI on ${pr} finished: 1 of 1 workflow runs failed (ci: failure)`;
  const running = `1 of 1 workflow runs on ${pr} still running (ci)`;
  const done = `CI on ${pr} finished: all 1 workflow runs passed or skipped`;
  let newDone = false;
  const ci = async (_ref: string, _person?: string, head?: string) =>
    !head || head === OLD ? { done: true, text: red, head: OLD } : newDone ? { done: true, text: done, head: NEW } : { done: false, text: running, head: NEW };
  const watch = new BlockerWatch({ store: { work } as unknown as Store, orchestrators, now: () => clock, ci });
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...x: unknown[]) => void warned.push(x.join(' '));
  try {
    await watch.tick();
    fail = false;
    clock += 60_000;
    assert.equal((await watch.tick()).get('w3753'), `clear: ${red}`, 'the headless wait clears on its red run');
    // 16 minutes later the worker pushed 98b6c01 and waits on it; its run is in progress.
    clock += 16 * 60_000;
    w.status = 'blocked';
    w.blocked = { kind: 'ci', ref: pr, head: NEW, what: 'CI on #533', at: new Date(clock).toISOString(), by: 'worker a' } as WorkItem['blocked'];
    cleared.length = 0;
    fail = true;
    for (let i = 0; i < 8; i++) {
      assert.equal((await watch.tick()).get('w3753'), undefined, `tick ${i}: held while its run is still running`);
      clock += 60_000;
    }
    assert.equal(warned.filter((l) => l.includes('SWEEP')).length, 0, warned.join(' | '));
    assert.equal(w.status, 'blocked');
    // The run finishes; the clearing throws, and the backstop sweeps it 5 minutes on, by its own head's reading.
    newDone = true;
    for (let i = 0; i < 7; i++) {
      await watch.tick();
      clock += 60_000;
    }
    assert.equal(warned.filter((l) => l.startsWith(`blocker watch: SWEEP: w3753 is still Blocked on CI on ${pr}, which finished `) && l.includes(done)).length, 1, warned.join(' | '));
    fail = false;
    assert.equal((await watch.tick()).get('w3753'), `clear: ${done}`);
  } finally {
    console.warn = warn;
  }
});

test('w1126: a Claude pool hold ends and EVERY request blocked on it resumes: the dispatcher\'s block on "vault-lothsahn-1" (w1116..w1124), a worker\'s own token-stop gate, and one with no worker yet', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, call, heard } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
  const { pool, pools, usageClear } = lothPool();
  (agents as unknown as { usageRef: (ref: string) => unknown }).usageRef = (ref) => poolForRef(ref, pools());
  // 12:35Z, before the hold's own end (12:50Z): what clears it here is the pool having room again.
  const clock = Date.parse('2026-10-12T12:35:00Z');
  const watch = new BlockerWatch({ store, orchestrators: o, usageClear, now: () => clock });
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  const decide = (id: string, a2: Record<string, unknown>) => call(dispatcher().info, 'decide_work', { id, note: 'its worker fixes it once the pool frees', ...a2 });
  // 12:35Z, as on w1116: the dispatcher names the token without its last four.
  const b1 = await decide('w1', { action: 'block', blocker: { kind: 'usage', ref: 'vault-lothsahn-1', what: "lothsahn's Claude pool (held at 89% 5-hour until 12:50Z)" } });
  assert.equal(b1.isError, false, b1.text);
  assert.equal(store.work.get('w1')!.blocked!.ref, LOTH_TOKEN, 'kept as the token the pool knows');
  assert.equal(store.work.get('w1')!.blocked!.until, POOL_HELD_UNTIL, "the hold's end, from the pool");
  // A worker stopped at the dispatcher token's stop line (w1109): its own gate, the full label.
  assert.deepEqual(o.tokenStopBlocked(b.id, { ref: LOTH_TOKEN, what: `the dispatcher's token ${LOTH_TOKEN} at its stop line` }), ['w2']);
  // A request nobody has started yet, blocked on lothsahn's pool by its person.
  assert.equal((await decide('w3', { action: 'block', blocker: { kind: 'usage', ref: 'lothsahn', what: "lothsahn's Claude pool" } })).isError, false);
  await watch.tick();
  for (const id of ['w1', 'w2', 'w3']) assert.equal(store.work.get(id)!.status, 'blocked', `${id} waits while the pool is held`);
  // The 5-hour window resets: the pool serves again, and nothing else has to nudge them.
  pool.serving = true;
  const did = await watch.tick();
  for (const id of ['w1', 'w2', 'w3']) assert.match(did.get(id) ?? '', /^clear: /, `${id} clears`);
  assert.equal(store.work.get('w1')!.status, 'active');
  assert.match(agents.waker.pending(a.id)?.note ?? '', /^w1 is unblocked: vault-lothsahn-1 …EAAA's usage limit cleared/, "the dispatcher's block resumes w1's worker itself");
  assert.equal(store.work.get('w2')!.status, 'active');
  assert.match(agents.waker.pending(b.id)?.note ?? '', /^w2 is unblocked: /, 'the token-stop gate resumes its worker');
  assert.equal(store.work.get('w3')!.status, 'new', 'no worker: the dispatcher starts it');
  await until('the dispatcher hears w3 is unblocked', () => heard(dispatcher().info.id, '[ledger] w3').length > 0);
  agents.waker.cancel(a.id);
  agents.waker.cancel(b.id);
});

test("w1126: a usage gate also clears at the hold's end when the meters have not said so yet (a stale reading), and the dispatcher's own until wins", async (t) => {
  const env = setup(t);
  const { store, agents, o, dispatcher, call } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  const { pools, usageClear } = lothPool();
  (agents as unknown as { usageRef: (ref: string) => unknown }).usageRef = (ref) => poolForRef(ref, pools());
  let clock = Date.parse('2026-10-12T12:35:00Z');
  const watch = new BlockerWatch({ store, orchestrators: o, usageClear, now: () => clock });
  const block = (id: string, blocker: Record<string, unknown>) => call(dispatcher().info, 'decide_work', { id, action: 'block', note: 'pool held', blocker });
  assert.equal((await block('w1', { kind: 'usage', ref: 'vault-lothsahn-1', what: "lothsahn's Claude pool" })).isError, false);
  assert.equal((await block('w2', { kind: 'usage', ref: 'vault-lothsahn-1', until: '2026-10-12T13:30:00Z', what: "lothsahn's Claude pool" })).isError, false);
  assert.equal(store.work.get('w2')!.blocked!.until, '2026-10-12T13:30:00.000Z');
  await watch.tick();
  assert.equal(store.work.get('w1')!.status, 'blocked');
  clock = Date.parse('2026-10-12T12:51:00Z');
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: the hold on vault-lothsahn-1 …EAAA ended at 12:50 UTC/);
  assert.equal(store.work.get('w2')!.status, 'blocked', 'its own until is later');
  // An unknown account is refused, with what the pool knows, instead of a gate that can never clear.
  const bad = await block('w2', { kind: 'usage', ref: 'vault-lothsahn-9', what: 'x' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /no Claude account or vault pool is called "vault-lothsahn-9"/);
});

test("w1128: a CI gate's resume still waiting to be delivered when its request is blocked again on something else is not delivered: it is kept for the new gate and handed back when that clears", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, call, sessions } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2', status: 'active' }]);
  const pr = 'Final-Factory/FinalFactory#1537';
  let checks = { done: false, text: `1 of 2 workflow runs on ${pr} still running` };
  const watch = new BlockerWatch({ store, orchestrators: o, ci: async () => checks });
  const a = await startedFor(env, 'w1');
  await a.h.blocked_on!({ prs: [`ci:${pr}`], what: 'CI on #1537' });
  await watch.tick();
  // 06:48Z on w1083: CI finishes and a50a8ee1 is resumed, but its sandbox is gone, so the resume waits in the send queue.
  checks = { done: true, text: `CI on ${pr} finished: 1 of 2 workflow runs failed (Test Runner: failure)` };
  (watch as unknown as { ciSeen: Map<string, unknown> }).ciSeen.clear();
  await watch.tick();
  const note = agents.waker.pending(a.id)!.note;
  const full = sessions as unknown as { placeFull?: (s: unknown) => string | undefined };
  const placeFull = full.placeFull;
  full.placeFull = () => 'no sandbox on pc is free (test)';
  (agents.waker as unknown as { fire(id: string, tries: number): void }).fire(a.id, 0);
  assert.ok(sessions.queued().some((q) => q.id === a.id), 'the resume waits for a sandbox');
  // 06:49Z: the dispatcher blocks w1083 on w1110 before the resume goes.
  const blocked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'waits on the shared failure', blocker: { kind: 'request', ref: 'w2', on: 'report', what: "w2's finding on the shared Test Runner failure" } });
  assert.equal(blocked.isError, false, blocked.text);
  // 06:50Z: a sandbox frees. The resume must not go while w1 is blocked on w2.
  full.placeFull = placeFull;
  sessions.drain();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!store.readTranscript(a.id).some((e) => e.kind === 'user' && e.text.includes(note)), 'the bug: the CI resume reached the worker while w1 was blocked on w2');
  assert.ok(!sessions.queued().some((q) => q.id === a.id), 'not left in the queue either');
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'blocked');
  assert.equal(w.heldCheckIns?.[0]?.session, a.id, 'kept for when the new gate clears');
  // w2 is done: w1 is unblocked and the kept resume goes to its worker.
  const w2 = store.work.get('w2')!;
  w2.status = 'done';
  store.putWork(w2);
  await watch.tick();
  assert.equal(store.work.get('w1')!.status, 'active');
  assert.ok((agents.waker.pending(a.id)?.note ?? '').includes(note), 'handed back: CI cleared while it was blocked, and that is said now');
  agents.waker.cancel(a.id);
});

test('w1129: a message to a worker while its Claude pool is held is queued, not refused, and goes when the pool frees; a resume queued so is not counted lost by the sweep, and a pool hold is not given up after 24 hours', async (t) => {
  const env = await setupOnMachine(t);
  const held = heldVault(t);
  const { store, agents, o, dispatcher, call, sessions } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  const a = await startedFor(env, 'w1');
  held.on = true;
  // The dispatcher's follow-up (it was refused: "lothsahn's Claude token pool is held").
  const sent = await call(dispatcher().info, 'message_agent', { session_id: a.id, work_id: 'w1', text: 'Fix the Test Runner failure on #1552.' });
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /Queued, not refused: .*Claude token pool is held/);
  // A harness wake-up (a gate's resume, a check-in): queued as well, never "could not wake this session".
  agents.waker.schedule(a.id, 1, 'w1 is unblocked: CI cleared.');
  (agents.waker as unknown as { fire(id: string, tries: number): void }).fire(a.id, 0);
  assert.equal(sessions.queued().filter((q) => q.id === a.id).length, 2);
  assert.ok(!store.readTranscript(a.id).some((e) => e.kind === 'system' && /could not wake/.test(e.text)));
  // The sweep sees a message queued for it: on its way, not lost.
  const w = store.work.get('w1')!;
  w.status = 'active';
  w.gateResumes = [{ session: a.id, at: new Date(Date.now() - 6 * 60_000).toISOString(), mark: 'w1 is unblocked: CI cleared.', note: 'w1 is unblocked: CI cleared.', seq: store.lastSeq(a.id), tries: 3 }];
  store.putWork(w);
  const swept = o.sweepResumes((sid) => sessions.queued().some((q) => q.id === sid));
  assert.equal(swept.has('w1'), false, 'not "the message never reached it"');
  // A day later the pool is still held (a weekly limit): the messages are kept.
  for (const q of sessions.queued()) (q as { at: string }).at = new Date(Date.now() - 25 * 3_600_000).toISOString();
  sessions.drain();
  assert.equal(sessions.queued().filter((q) => q.id === a.id).length, 2, 'a pool hold with a known end is waited out');
  // The pool frees: both go, in order.
  held.on = false;
  sessions.drain();
  await until('the follow-up and the resume in its transcript', () => {
    const tx = store.readTranscript(a.id);
    return tx.some((e) => e.kind === 'user' && e.text.includes('Fix the Test Runner failure on #1552.')) && tx.some((e) => e.kind === 'user' && e.text.includes('w1 is unblocked: CI cleared.'));
  });
});


test("w2231: a worker whose Claude pool is held is Blocked on that pool, gives up its sandbox to another request's worker, and is resumed and placed again when the pool frees", async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta'] });
  const held = heldVault(t);
  const { store, agents, o, dispatcher, call, sessions } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  const { pool, pools, usageClear } = lothPool();
  (agents as unknown as { usageRef: (ref: string) => unknown }).usageRef = (ref) => poolForRef(ref, pools());
  const watch = new BlockerWatch({ store, orchestrators: o, usageClear, now: () => Date.parse('2026-10-12T12:35:00Z') });
  const a = await startedFor(env, 'w1', { extra_agent: false });
  // Its turn ended; the pool is held when its next message must start its process (w2222 on 2026-10-25: 39ba1854 sat Queued
  // in its sandbox for 21 minutes until lothsahn released it by hand).
  held.on = true;
  const sent = await call(dispatcher().info, 'message_agent', { session_id: a.id, work_id: 'w1', text: 'Fix the Test Runner failure on #1552.' });
  assert.equal(sent.isError, false, sent.text);
  const w1 = store.work.get('w1')!;
  assert.equal(w1.status, 'blocked', 'Blocked on the pool, not Queued');
  assert.equal(w1.blocked?.kind, 'usage');
  assert.equal(w1.blocked?.ref, LOTH_TOKEN);
  assert.equal(w1.blocked?.until, POOL_HELD_UNTIL, "the pool's reset");
  assert.ok(!sessions.queued().some((q) => q.id === a.id), 'not a queued message that keeps its sandbox or claims another');
  assert.equal(sessions.parked(a.id).length, 1, 'kept for when the pool frees');
  assert.ok(store.readTranscript(a.id).some((e) => e.kind === 'system' && /Claude pool is held/.test(e.text) && /w2231/.test(e.text)));
  // The release pass gives its sandbox up (Agents.waitOn: a usage gate since w2231).
  (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
  assert.match(agents.waitOn(store.sessions.get(a.id)!) ?? '', /w1: .*usage limit/);
  const sb = () => store.machines.get('pc')!.sandboxes!.find((x) => x.id === 'alpha')!;
  await until('alpha released', () => {
    (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
    // Its daemon's next 2-minute git read (keptWhy: the line the park wrote is newer than the last read).
    sb().git = { branch: 'sandbox/alpha', dirty: 0, untracked: 0, ...sb().git, at: new Date().toISOString() };
    (agents as unknown as { placeAgain: { tick(): string[] } }).placeAgain.tick();
    return !!store.sessions.get(a.id)!.placeReleased;
  });
  // The sandbox is free for another request's worker.
  held.on = false;
  const b = await startedFor(env, 'w2', { extra_agent: false });
  assert.equal(store.sessions.get(b.id)!.machineSandbox, 'alpha', "another job's worker is placed in the sandbox it gave up");
  sessions.drain();
  assert.equal(sessions.parked(a.id).length, 1, 'still parked while w1 is Blocked on the pool');
  // The pool frees: the gate clears, its worker is resumed, and its message goes, placed again (beta, alpha being taken).
  pool.serving = true;
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: /);
  assert.equal(store.work.get('w1')!.status, 'active');
  assert.match(agents.waker.pending(a.id)?.note ?? '', /^w1 is unblocked: /);
  (agents.waker as unknown as { fire(id: string, tries: number): void }).fire(a.id, 0);
  await until('the parked message and the resume reach it', () => {
    const tx = store.readTranscript(a.id);
    return tx.some((e) => e.kind === 'user' && e.text.includes('Fix the Test Runner failure on #1552.')) && tx.some((e) => e.kind === 'user' && e.text.includes('w1 is unblocked: '));
  });
  assert.equal(sessions.parked(a.id).length, 0);
  assert.equal(store.sessions.get(a.id)!.machineSandbox, 'beta', 'placed again on a free sandbox');
});

test("w6092: a dispatcher's message_agent naming a request, parked on a held pool, is linked before it is sent, so a 'running' drain holds it, never drops it", async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta'] });
  const held = heldVault(t);
  const { store, agents, o, dispatcher, call, sessions } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
  const { pool, pools, usageClear } = lothPool();
  (agents as unknown as { usageRef: (ref: string) => unknown }).usageRef = (ref) => poolForRef(ref, pools());
  const watch = new BlockerWatch({ store, orchestrators: o, usageClear, now: () => Date.parse('2026-10-12T12:35:00Z') });
  const a = await startedFor(env, 'w1', { extra_agent: false });
  // The dispatcher sends it the next request (as w6092 came to w5937's worker) while its pool is held: the message parks.
  held.on = true;
  const sent = await call(dispatcher().info, 'message_agent', { session_id: a.id, work_id: 'w2', title: 'follow-up', session: 'same', session_reason: 'a fix for what it shipped', text: 'A follow-up for you.' });
  assert.equal(sent.isError, false, sent.text);
  assert.equal(sessions.parked(a.id).length, 1, 'parked on its pool');
  // Its own request closes while the message waits, and a drain that lets only its running workers finish is set on pc meanwhile.
  store.putWork({ ...store.work.get('w1')!, status: 'done' });
  store.putWork({ ...store.work.get('w3')!, humanAsked: true });
  const drain = await call(dispatcher().info, 'hold_machine', { machine: 'pc', action: 'hold', words: 'Hold new work on pc and let the running workers finish', who: 'Lothsahn', work_id: 'w3' });
  assert.ok(!drain.isError, drain.text);
  assert.equal(store.machines.get('pc')!.drain?.resumes, 'running');
  // The pool frees: the parked message is unparked, and the drain holds it (w2 open, on it), never drops it.
  held.on = false;
  pool.serving = true;
  await watch.tick();
  sessions.drain();
  await new Promise((res) => setImmediate(res));
  assert.ok(!store.readTranscript(a.id).some((e) => e.kind === 'system' && /was not delivered/.test(e.text)), store.readTranscript(a.id).filter((e) => e.kind === 'system').map((e) => e.text).join(' | '));
  assert.ok(sessions.queued().some((q) => q.id === a.id && q.text.includes('A follow-up for you.')), 'held on the drain until it is lifted');
  // w2 was linked to its worker before the send, not left for a resume that never links it (another worker could be started on it).
  assert.ok(store.work.get('w2')!.sessionIds.includes(a.id));
});

test("w1463: a machine's gh login reaches list_machines, the Capacity block, start_agent's note and the worker's brief, as names only", async (t) => {
  const token = 'gho_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
  const logs: string[] = [];
  for (const k of ['log', 'warn', 'error'] as const) t.mock.method(console, k, (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  // A gh without --json whose answer carries the token, as `gh auth status --show-token` would print it.
  const gh = async (_cmd: string, args: string[]) =>
    args.includes('--json')
      ? { code: 1, stdout: '', stderr: `unknown flag: --json ${token}` }
      : { code: 0, stdout: `github.com\n  ✓ Logged in to github.com account bryding (keyring)\n  - Active account: true\n  - Token: ${token}\n  - Token scopes: 'gist', 'read:org', 'repo'\n`, stderr: '' };
  const { store, machines, dispatcher, chat, call } = await setupOnMachine(t, {}, { gh });
  await until('the daemon reported its gh login', () => !!store.machines.get('pc')?.gh?.ok);
  assert.deepEqual(store.machines.get('pc')!.gh!.scopes, ['gist', 'read:org', 'repo']);
  const listed = (await call(dispatcher().info, 'list_machines', {})).text;
  assert.match(listed, /gh: bryding \(gist, read:org, repo; cannot push \.github\/workflows \(no workflow scope\)\)/);
  const capacity = (await call(dispatcher().info, 'list_sandboxes', {})).text;
  assert.match(capacity, /Next work that changes \.github\/workflows \(its push needs a gh token with the workflow scope, w1463\): pc \(no computer reports a gh token with the workflow scope/);
  await call(chat(BEN).info, 'request_work', { title: 'CI: run the hooks tests', brief: 'Add a step to .github/workflows/main.yml that runs the hooks tests.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Add the CI step.', title: 'Hooks CI step', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /Note: this work changes \.github\/workflows, and pc's gh token \(bryding \(gist, read:org, repo\)\) lacks the workflow scope, so GitHub will refuse its push of a workflow file; no computer whose gh may push it has room now/);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const spec = machines.hooks!.specFor(store.sessions.get(id)!, store.machines.get('pc')!);
  assert.ok(spec.append.includes("- GitHub token: this machine's gh token: bryding (gist, read:org, repo): it cannot push .github/workflows"), 'the brief says it');
  // No part of the token in anything FF Factory wrote: the record, the tools' answers, the brief, the logs.
  for (const [what, text] of [['record', JSON.stringify(store.machines.get('pc'))], ['list_machines', listed], ['list_sandboxes', capacity], ['start_agent', started.text], ['brief', spec.append], ['logs', logs.join('\n')]] as const) {
    assert.ok(!text.includes(token) && !text.includes(token.slice(4)) && !text.includes(token.slice(-12)), `${what} carries the token`);
  }
  assert.ok(logs.some((l) => l.includes('gh login: bryding (gist, read:org, repo)')), 'the daemon and the portal log the names');
});

test('w1582: Agents.liveHold keeps a worker whose Live view is up while it waits on a person, never one waiting on a deploy, nor past the hold', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  const views = new Set<string>();
  agents.liveHub = { running: (id: string) => (views.has(id) ? { materials: ['WardenMaterial'], fps: 15, width: 960 } : undefined) } as unknown as NonNullable<typeof agents.liveHub>;
  const hold = (i: SessionInfo, now?: number) => {
    (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
    return agents.liveHold(i, now);
  };
  const a = await startedFor(env, 'w1');
  assert.match(String(await a.h.waiting_on_person!({ who: 'Ben', what: 'steer the Warden in the Live view' })), /^Recorded: your requests wait on Ben/);
  assert.equal(hold(a.info), undefined, 'no view: no hold (the w890 release goes ahead)');
  views.add(a.id);
  assert.equal(hold(a.info), 'its Live view is up while it waits on Ben (w1582: held for 12 h after its last activity)');
  assert.equal(agents.keepIdle(env.sessions.get(a.id), true, true), hold(a.info), 'the idle reaper keeps it too');
  assert.equal(hold(a.info, Date.parse(a.info.lastActivityAt) + LIVE_HOLD_MS + 1), undefined, 'past the hold');
  // A view up while it waits on a deploy: released as before (nobody is about to look).
  const b = await startedFor(env, 'w2', { override_duplicate: 'another request' });
  views.add(b.id);
  assert.match(String(await b.h.blocked_on!({ deploys: ['portal'], what: 'the portal deploy' })), /^Recorded: w2 is Blocked/);
  assert.equal(hold(b.info), undefined);
  // Its work over ends the hold.
  store.work.get('w1')!.status = 'done';
  assert.equal(hold(a.info), undefined);
  void dispatcher;
  void call;
});

test('w1600: a Live view marks its request; a bench lock holds its editor; stop_agent move_to moves the waiting worker to beast, refused mid-turn, held or full', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, machines, dispatcher, call, heard, cfg } = env;
  const beast = await startTestMachine(machines, { id: 'beast', sandboxes: ['slot1'] });
  env.closers.push(() => beast.stop());
  agentsRoom(agents, ['pc', 'beast']);
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }]);
  const ended: string[] = [];
  agents.liveHub = {
    tool: async () => 'Live view started (15 fps, 960 px, knobs on Ballista): streaming',
    running: () => false,
    endFor: async (id: string) => (ended.push(id), { materials: ['Ballista'], fps: 15, width: 960 }),
  } as unknown as NonNullable<typeof agents.liveHub>;
  const a = await startedFor(env, 'w1');

  // Its worker starts a Live view: the request needs one from now on.
  assert.match(String(await a.h.live_view!({ action: 'start', materials: ['Ballista'] })), /^Live view started/);
  assert.equal(store.work.get('w1')!.liveView?.machine, 'pc');
  assert.match(store.work.get('w1')!.log.join('\n'), /its worker \w+ started a Live view on pc: it needs one from now on, so it is placed on beast first \(w1600\)/);
  const listed = await call(dispatcher().info, 'list_sandboxes', {});
  assert.match(listed.text, /^Next Live view work \(game work whose worker streams a Live view, w1600\): beast \(Live view work goes to the first with room in placement\.live \(beast;/m);

  // A timed run holds pc's bench lock: its Live view editor and view wait; other actions go through.
  const stats = machines.statsOf.bind(machines);
  const lock = { owner: 'pc pid 4121 ben 21:04:10 probe A round 2 (/tmp/x)', since: new Date().toISOString() };
  machines.statsOf = (id: string) => (id === 'pc' ? { ...(stats(id) ?? ({} as NonNullable<ReturnType<typeof stats>>)), benchLock: lock } : stats(id));
  assert.match(String(await a.h.unity!({ action: 'start' })), /^Not now \(w1600\): on pc, its bench lock is held since \d\d:\d\dZ \(pc pid 4121 .*\): a timed run, and a Live view editor beside it would spoil that run's numbers\. .*wake_me in 10 minutes and start its editor again/);
  assert.match(String(await a.h.live_view!({ action: 'start' })), /^Not now \(w1600\)/);
  machines.statsOf = stats;

  // Refused: mid-turn, beast held, beast full. The worker stays where it is each time.
  const move = (extra: Record<string, unknown> = {}) => call(dispatcher().info, 'stop_agent', { session_id: a.id, move_to: 'BEAST', why: 'its Live view streams faster on beast (w1600)', ...extra });
  const was = a.info.status;
  a.info.status = 'running';
  assert.match((await move()).text, /is mid-turn: move it once its turn ends/);
  a.info.status = was;
  cfg.placement = { hold: { beast: 'Ben testing' } };
  assert.match((await move()).text, /beast is on hold \(Ben testing\).*stays on pc\/alpha/);
  cfg.placement = {};
  const places = agents.places.bind(agents);
  agents.places = () => places().map((p) => (p.id === 'beast' ? { ...p, live: p.maxAgents, midTurn: p.maxAgents } : p));
  assert.match((await move()).text, /beast has no room for game work now \(\d+ agents mid-turn of \d+\): \w+ stays on pc\/alpha/);
  agents.places = places;
  assert.equal(store.work.get('w1')!.status, 'active');
  assert.deepEqual(ended, []);

  // Moved: its view ends, it is taken off the worker and Queued for beast with its branch and the view's settings.
  const moved = await move();
  assert.equal(moved.isError, false, moved.text);
  assert.match(moved.text, /^Moved w1 off \w+ on pc\/alpha, for beast: its process stopped, its Live view ended, its sandbox (had no uncommitted work|'s uncommitted work)/);
  assert.match(moved.text, /start_agent with its work_id and branch "sandbox\/alpha" in a FREE beast sandbox \(it switches the sandbox while you go on, w5278\)/);
  assert.deepEqual(ended, [a.id]);
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'queued');
  assert.ok(!w.sessionIds.includes(a.id), 'taken off the old worker');
  assert.deepEqual(w.queuedFor?.needs, ['beast']);
  assert.equal(w.handedBack?.to, 'beast');
  assert.equal(w.handedBack?.branch, 'sandbox/alpha');
  assert.match(w.handedBack!.note, /^Its Live view ran on pc\/alpha \(materials \["Ballista"\], fps 15, width 960\): stage it again/);
  assert.match(w.log.join('\n'), /moved from pc\/alpha: queued for beast, from branch sandbox\/alpha/);
  await until('the dispatcher is told', () => heard(dispatcher().info.id, '[ledger] MOVED (w1600)').length > 0);
  assert.match(heard(dispatcher().info.id, '[ledger] MOVED (w1600)')[0].text, /w1 "Request w1" .*because it moves to beast: its Live view streams faster on beast \(w1600\) \(moved by stop_agent move_to \(w1600\)\)\. .*Place it on beast: start_agent with work_id "w1" and branch "sandbox\/alpha" in a FREE sandbox on beast/);
  // The new worker's handover says where it came from and what to stage.
  const note = handoverNote(w, { related: [], handedBack: w.handedBack });
  assert.match(note, /Moved \(w1600\): w1 was taken off worker \w+ on pc\/alpha at .* UTC, because it moves to beast: its Live view streams faster on beast \(w1600\) \(moved by stop_agent move_to \(w1600\)\)\. Continue from its branch sandbox\/alpha/);
});

test('w1606: a worker declares its build: the build computer is held, a worker that cannot move is paused, its resume waits for the build and goes when it is done', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, machines, dispatcher, call, heard, cfg } = env;
  const beast = await startTestMachine(machines, { id: 'beast', sandboxes: ['slot1'] });
  env.closers.push(() => beast.stop());
  agentsRoom(agents, ['pc', 'beast']);
  // pc is the build computer here (placement.build), and beast is full: the other worker there cannot move, so it is paused.
  cfg.placement = { build: ['pc'] };
  const places = agents.places.bind(agents);
  agents.places = () => places().map((p) => (p.id === 'beast' ? { ...p, live: p.maxAgents, midTurn: p.maxAgents } : p));
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }, { id: 'w2', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  const turnsBefore = b.info.turns;

  // w1628 (lothsahn: "Ben's guidance was only supposed to be for release builds of the software, not all builds that
  // workers do when making fixes"): a worker's own build is not planned, clears nothing and marks nothing.
  assert.match(String(await a.h.build_plan!({ action: 'coming', minutes: 0, what: 'a Windows player for the w1 clip' })), /^Nothing to plan \(w1628\): build_plan is for release builds only/);
  assert.match(String(await a.h.build_plan!({ action: 'start' })), /^Nothing to plan \(w1628\)/);
  assert.equal(agents.builds.plan('pc'), undefined);
  assert.equal(store.work.get('w1')!.build, undefined);
  const declared = String(await a.h.build_plan!({ action: 'coming', release: true, minutes: 0, what: 'a Windows player for the w1 clip' }));
  assert.match(declared, /^Declared \(w1606\): a Windows player for the w1 clip on pc at \d\d:\d\dZ\. No new work goes there from now\. FF Factory clears it now/);
  assert.equal(store.work.get('w1')!.build?.machine, 'pc', 'its request builds a player: placed on placement.build first from now on');
  await until('pc is cleared', () => !!agents.builds.plan('pc')?.clearedAt && agents.builds.plan('pc')!.paused.includes(b.id));
  assert.deepEqual(agents.builds.plan('pc')!.moved, [], 'beast is full: nothing could move');
  await until('the dispatcher is told', () => heard(dispatcher().info.id, '[ledger] BUILD COMING (w1606)').length > 0);
  const listed = await call(dispatcher().info, 'list_sandboxes', {});
  assert.match(listed.text, /^- pc \[held: cleared for a build since \d\d:\d\dZ \(a Windows player for the w1 clip, worker \w+ for w1; w1606\): no new work until it is done\]/m);

  // The paused worker's next message waits for the build (Blocked on its machine), the builder's own does not.
  const sent = await call(dispatcher().info, 'message_agent', { session_id: b.id, text: 'CI is green: merge it', work_id: 'w2' });
  assert.match(sent.text, /Queued, not refused: pc is cleared for a build since \d\d:\d\dZ .*: this worker was paused for it and resumes when it is done \(w1606\)/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.info.turns, turnsBefore, 'not resumed during the build');
  assert.match(String(await a.h.build_plan!({ action: 'start', release: true })), /^Go \(w1606\): pc is cleared for a Windows player for the w1 clip \(0 moved: none; 1 paused\)/);

  // Done: the hold lifts and the held message goes.
  assert.match(String(await a.h.build_plan!({ action: 'done' })), /^Done \(w1606\): pc takes work again; the build took \d+ min\./);
  assert.equal(agents.builds.plan('pc'), undefined);
  await until('the paused worker resumes with its message', () => b.info.turns > turnsBefore);
  assert.match(heard(dispatcher().info.id, '[ledger] BUILD DONE (w1606)')[0]?.text ?? '', /pc takes new work again/);
});

test('w1628: each worker\'s bench priority is the highest of its open requests, read again when one changes', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'high' }, { id: 'w2', by: BEN, status: 'active', priority: 'low' }]);
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  assert.deepEqual(agents.benchPriorities('pc'), { [a.id]: { priority: 'high', requests: ['w1'] }, [b.id]: { priority: 'low', requests: ['w2'] } });
  store.putWork({ ...store.work.get('w2')!, priority: 'urgent' });
  assert.equal(agents.benchPriorities('pc')[b.id].priority, 'urgent', 'a changed priority is what the next push sends');
  // w4620 (lothsahn: "add a new priority called release that's above urgent and not have special handling for releases"):
  // a release request's worker goes at release, sent as urgent with level release for old bench_queue.py copies, and no
  // build plan or exempt mark lifts anyone else.
  store.putWork({ ...store.work.get('w1')!, priority: 'frantic' });
  assert.deepEqual(agents.benchPriorities('pc')[a.id], { priority: 'urgent', level: 'release', requests: ['w1'] }, 'release rides as urgent + level');
  assert.equal(agents.benchPriorities('pc')[a.id].exempt, undefined, 'w4620: no release exemption is left');
  store.putWork({ ...store.work.get('w1')!, priority: 'high' });
  assert.deepEqual(agents.benchPriorities('pc')[a.id], { priority: 'high', requests: ['w1'] });
  store.putWork({ ...store.work.get('w1')!, status: 'done' });
  assert.equal(agents.benchPriorities('pc')[a.id], undefined, 'no open request: no mark, so its tickets count as low (w4620)');
  assert.deepEqual(agents.benchPriorities('elsewhere'), {});
  // w1832: the worker of the scheduled nightly run (the portal's nightly schedule files it as source kind nightly-run).
  store.putWork({ ...store.work.get('w2')!, source: { kind: 'nightly-run', untrusted: false, channel: 'nightly e2e', nightlyRun: { date: '2026-10-23', machine: 'pc' } } });
  assert.equal(agents.benchPriorities('pc')[b.id].exempt, 'nightly');
});

test('w4710: request_work and update_work take "release" as frantic (its name before w4710); the schema lists frantic', async (t) => {
  const { store, chat, call, agents } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  // what an agent sees and what the MCP layer parses: the five names, frantic on top; release still parses, as frantic
  for (const name of ['request_work', 'update_work']) {
    const shape = agents.orchestratorToolDefs(ben).find((d) => d.name === name)!.inputSchema as Record<string, z.ZodType>;
    const js = z.toJSONSchema(z.object(shape), { io: 'input' }) as unknown as { properties: { priority: { enum?: string[] } } };
    assert.deepEqual(js.properties.priority.enum, ['low', 'normal', 'high', 'urgent', 'frantic'], name);
    assert.equal(shape.priority.parse('release'), 'frantic', name);
    assert.equal(shape.priority.safeParse('panic').success, false, name);
  }
  const a = await call(ben, 'request_work', { title: 'Ship the hotfix build to players now', brief: 'An urgent release.', priority: 'release' });
  assert.equal(a.isError, false, a.text);
  assert.equal(store.work.get('w1')!.priority, 'frantic', 'a caller still passing release files at frantic');
  const b = await call(ben, 'request_work', { title: 'Tidy the belt tooltip wording', brief: 'Low stakes.', priority: 'frantic' });
  assert.equal(b.isError, false, b.text);
  assert.equal(store.work.get('w2')!.priority, 'frantic');
  const c = await call(ben, 'request_work', { title: 'Investigate the miner stall on load', brief: 'Seen once.', priority: 'urgent' });
  assert.equal(c.isError, false, c.text);
  const u = await call(ben, 'update_work', { id: 'w3', priority: 'release' });
  assert.equal(u.isError, false, u.text);
  assert.equal(store.work.get('w3')!.priority, 'frantic', 'update_work takes release as frantic too');
  const bad = await call(ben, 'request_work', { title: 'Something with a made-up priority level', brief: 'x', priority: 'panic' });
  assert.equal(bad.isError, true, 'an unknown priority is still refused');
});

test('w2446: a timed run sent to an xlarge computer carries "here" in its bench priorities, so its exclusive ticket is granted', async (t) => {
  // lothsahn, 2026-10-28 (w2446): tr_b6230bd66f and tr_c29be76860 on LothDesktop (xlarge) "gave up: w1995: an exclusive
  // timing ticket here waits for the dispatcher's answer": the run's ticket carries its worker's session (172ab5ee, on m3),
  // which never asked timed_place about LothDesktop, and bench_queue.py timed_ask_refusal passes only a "here"
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'high' }, { id: 'w2', by: BEN, status: 'active', priority: 'normal' }]);
  const local = await startedFor(env, 'w2');
  const runs = [
    { id: 'tr_b6230bd66f', session: 'sess-on-m3', requests: ['w1'], machine: 'pc', state: 'sent' },
    { id: 'tr_c29be76860', session: local.id, requests: ['w2'], machine: 'pc', state: 'queued' },
  ];
  (agents as unknown as { timedRuns: unknown }).timedRuns = { runsOn: (m: string) => runs.filter((r) => r.machine === m) };
  const p = agents.benchPriorities('pc');
  assert.equal(p['sess-on-m3'].timed?.verdict, 'here', 'the worker elsewhere: the ticket of its run passes the w1995 ask');
  assert.match(p['sess-on-m3'].timed!.why, /tr_b6230bd66f was sent to pc/);
  assert.ok(Date.parse(p['sess-on-m3'].timed!.until) > Date.now() + 30 * 60_000, 'it outlasts a 30-minute turn; the push each minute renews it');
  assert.equal(p[local.id].timed?.verdict, 'here', 'a worker of this computer with a run here and no verdict: here too');
  assert.deepEqual(agents.benchPriorities('elsewhere'), {}, 'no run there: nothing');
  // what the daemon writes and the guard reads back (machine/benchLock.ts), on a computer that asks first (timed_ask)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2446-'));
  writeBenchPriorities(root, p, new Date(), false, undefined, { required: true, why: 'lothdesktop is a xlarge computer (10 agent slots)' });
  assert.equal(readTimedAsk(root, 'sess-on-m3')?.verdict?.verdict, 'here');
  runs.length = 0;
  assert.equal(agents.benchPriorities('pc')['sess-on-m3'], undefined, 'the run ended: its "here" goes with it');
});

test('w2044: bench priorities read the ledger once per machine, not once per worker it ever had', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'high' }, { id: 'w2', by: BEN, status: 'active', priority: 'low' }]);
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  // The portal keeps every worker a machine ever had, and every request: each one's open work used to scan the whole ledger.
  for (let i = 0; i < 300; i++) store.sessions.set(`old${i}`, { ...a.info, id: `old${i}`, title: `w${1000 + i}: done long ago` });
  putRequests(store, Array.from({ length: 300 }, (_, i) => ({ id: `w${1000 + i}`, by: BEN, status: 'done' as const, sessionIds: [`old${i}`] })));
  const reads = t.mock.method(store.work, 'values');
  assert.deepEqual(agents.benchPriorities('pc'), { [a.id]: { priority: 'high', requests: ['w1'] }, [b.id]: { priority: 'low', requests: ['w2'] } });
  assert.equal(reads.mock.callCount(), 1, 'one read of the ledger for 302 workers');
});

// w1984, lothsahn: "a waiting ticket in a machine's bench queue must not outlive the worker that asked for it" (LothDesktop's
// t00000982 waited on after its worker was stopped and w1789's timed run moved to LothLaptop). bench_queue.py parks the
// waiting tickets of a session marked away and queues them again at the back once the mark goes.
test('w1984: a worker stopped on purpose, or whose timed work is on another machine, is marked away in its machine\'s bench priorities', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, machines } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }, { id: 'w2', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  assert.equal(agents.benchPriorities('pc')[a.id].away, undefined, 'a worker at work is not away');
  store.sessions.get(a.id)!.stoppedOnPurpose = true;
  assert.deepEqual(agents.benchPriorities('pc')[a.id].away, { why: `its worker ${a.id.slice(0, 8)} was stopped on purpose` });
  delete store.sessions.get(a.id)!.stoppedOnPurpose;
  assert.equal(agents.benchPriorities('pc')[a.id].away, undefined, 'messaged again, it is back: its tickets queue again at the back');
  // A ticket of its own in another machine's queue: its timed tickets here are parked, its builds here still count.
  const bench = (at: string) => ({ laptop: { hostname: 'l', platform: 'win32', cpuCount: 8, loadPct: 5, memTotalBytes: 1, memFreeBytes: 1, at, bench: { mode: 'exclusive' as const, running: [{ ticket: 't00000047', mode: 'exclusive' as const, what: 'cpu budget A/B', session: b.id }], runningCount: 1, waiting: 0 } } });
  const real = machines.allStats.bind(machines);
  machines.allStats = (() => bench(new Date().toISOString())) as unknown as typeof machines.allStats;
  assert.deepEqual(agents.benchPriorities('pc')[b.id].away, { why: `its worker ${b.id.slice(0, 8)} has ticket t00000047 on laptop now`, exclusive_only: true });
  assert.equal(agents.benchPriorities('laptop')[b.id], undefined, 'not its own machine');
  machines.allStats = (() => bench(new Date(Date.now() - 10 * 60_000).toISOString())) as unknown as typeof machines.allStats;
  assert.equal(agents.benchPriorities('pc')[b.id].away, undefined, 'a stale bench state counts for nothing');
  machines.allStats = real;
  // Its timed leg placed elsewhere (timed_place), the leg still open (w2620: a closed one holds nothing).
  putRequests(store, [{ id: 'w9', by: BEN, status: 'queued' }]);
  store.sessions.get(b.id)!.timedVerdict = { verdict: 'elsewhere', why: 'big computer', until: new Date(Date.now() + 3_600_000).toISOString(), leg: 'w9' };
  assert.deepEqual(agents.benchPriorities('pc')[b.id].away, { why: `its worker ${b.id.slice(0, 8)}'s timed leg was placed elsewhere (w9)`, exclusive_only: true });
});

// w2410, lothsahn: a queued bench ticket must not outlive its worker's wait. On BEAST worker d2d9c644's t00002471 waited at
// the front for hours after its worker stopped blocked on w2402 and its sandbox was released.
test('w2410: a stopped worker whose sandbox was released is marked away in its machine\'s bench priorities; one that keeps its sandbox is not', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w1');
  const info = store.sessions.get(a.id)!;
  const status = info.status;
  info.status = 'stopped';
  assert.equal(agents.benchPriorities('pc')[a.id].away, undefined, 'stopped, its sandbox still its own (a check-in, a run going): it keeps its place');
  info.placeReleased = { at: '2026-10-27T14:07:00.000Z', sandbox: 'slot4', branch: 'sandbox/slot4-w1', why: 'stopped idle while it waits' };
  assert.deepEqual(agents.benchPriorities('pc')[a.id].away, { why: `its worker ${a.id.slice(0, 8)} stopped and released its sandbox slot4 at 14:07 UTC (stopped idle while it waits)` });
  delete info.placeReleased;
  info.status = status;
  assert.equal(agents.benchPriorities('pc')[a.id].away, undefined, 'placed again: its tickets queue again at the back');
});

// w3398 (ben, via the orchestrator): "A timed_run ticket is never parked because its requesting worker is absent. Exempt
// tickets whose waiter is the daemon." timed_run tells its worker to end its turn on a long check-in, which stops it; the
// run's exclusive ticket carries that worker's session, so on LothDesktop, 2026-11-07, t00004607 for tr_7673462869 sat
// "PARKED since 10:55Z: its worker 25e6bb06 was stopped on purpose" until 13:49Z, though the daemon waited on it.
test("w3398: a worker stopped on its timed run's check-in is not marked away where that run waits; elsewhere it still is", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'high' }]);
  const a = await startedFor(env, 'w1');
  const info = store.sessions.get(a.id)!;
  const runs: { id: string; session: string; requests: string[]; machine: string; state: string }[] = [];
  (agents as unknown as { timedRuns: unknown }).timedRuns = { runsOn: (m: string) => runs.filter((r) => r.machine === m) };
  info.stoppedOnPurpose = true;
  assert.deepEqual(agents.benchPriorities('pc')[a.id].away, { why: `its worker ${a.id.slice(0, 8)} was stopped on purpose` }, 'w1984 unchanged: no run, its tickets park');
  runs.push({ id: 'tr_7673462869', session: a.id, requests: ['w1'], machine: 'pc', state: 'sent' });
  const p = agents.benchPriorities('pc')[a.id];
  assert.equal(p.away, undefined, "the daemon waits on the run's ticket: nothing of that session parks here");
  assert.equal(p.timed?.verdict, 'here');
  assert.equal(p.priority, 'high', "the run keeps its request's priority");
  // stopped with its sandbox released (a check-in over 30 minutes lets it go, w2410): the same
  delete info.stoppedOnPurpose;
  const status = info.status;
  info.status = 'stopped';
  info.placeReleased = { at: '2026-11-07T10:55:00.000Z', sandbox: 'slot4', branch: 'sandbox/slot4-w1', why: 'stopped on a 78-minute check-in' };
  assert.equal(agents.benchPriorities('pc')[a.id].away, undefined, 'released its sandbox, its run waits here: not parked');
  // the run on another computer: its tickets here are its own waiters', parked as before
  runs[0].machine = 'laptop';
  assert.match(agents.benchPriorities('pc')[a.id].away?.why ?? '', /stopped and released its sandbox slot4/);
  assert.equal(agents.benchPriorities('laptop')[a.id].away, undefined, 'where the run is, not parked');
  // the run ended: runsOn leaves it out, and the w2410 mark is back
  runs.length = 0;
  assert.match(agents.benchPriorities('pc')[a.id].away?.why ?? '', /stopped and released/);
  delete info.placeReleased;
  info.status = status;
});

// w3663 (lothsahn): "a timed run cleared to run on its own computer takes that computer's exclusive ticket without parking".
// Worker 66b1c43c, answered "here" on BEAST, still had tr_ab680eca38 waiting in LothDesktop's queue: that ticket is
// LothDesktop's daemon's waiter, carrying the worker's session, not the worker's, so it parks nothing on BEAST.
test("w3663: a worker's own timed run in another machine's queue does not park its tickets here; another ticket of it still does", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, machines } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w1');
  const until = new Date(Date.now() + 3_600_000).toISOString();
  store.sessions.get(a.id)!.timedVerdict = { verdict: 'here', why: 'both sides of an A/B stay on one machine', until };
  const runs: { id: string; session: string; requests: string[]; machine: string; state: string }[] = [{ id: 'tr_ab680eca38', session: a.id, requests: ['w1'], machine: 'laptop', state: 'sent' }];
  (agents as unknown as { timedRuns: unknown }).timedRuns = { runsOn: (m: string) => runs.filter((r) => r.machine === m) };
  const at = new Date().toISOString();
  const real = machines.allStats.bind(machines);
  t.after(() => (machines.allStats = real));
  machines.allStats = (() => ({ laptop: { hostname: 'l', platform: 'win32', cpuCount: 8, loadPct: 5, memTotalBytes: 1, memFreeBytes: 1, at, bench: { mode: 'free' as const, running: [], waiters: [{ ticket: 't00000912', mode: 'exclusive' as const, what: 'timed run tr_ab680eca38', session: a.id, ahead: 0 }], runningCount: 0, waiting: 1 } } })) as unknown as typeof machines.allStats;
  const p = agents.benchPriorities('pc')[a.id];
  assert.equal(p.away, undefined, 'its run waits on that daemon; the worker times here');
  assert.equal(p.timed?.verdict, 'here');
  // the run ended, and a ticket of its own is still there: parked as before (w1984)
  runs.length = 0;
  assert.deepEqual(agents.benchPriorities('pc')[a.id].away, { why: `its worker ${a.id.slice(0, 8)} has ticket t00000912 on laptop now`, exclusive_only: true });
});

// w1984 with w1983, lothsahn (via the orchestrator): when stop_agent move_to moves a worker to another computer, its bench
// tickets on the old machine are dropped. Its requests leave it, so only the move's mark keeps it in that machine's list.
test("w1984: after a move, no ticket of that worker holds anyone back in the old machine's bench queue", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, machines, dispatcher, call, heard } = env;
  const beast = await startTestMachine(machines, { id: 'beast', sandboxes: ['slot1'] });
  env.closers.push(() => beast.stop());
  agentsRoom(agents, ['pc', 'beast']);
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w1');
  assert.equal(agents.benchPriorities('pc')[a.id].away, undefined);
  const moved = await call(dispatcher().info, 'stop_agent', { session_id: a.id, move_to: 'beast', why: 'its timed run goes to beast' });
  assert.equal(moved.isError, false, moved.text);
  // settle the move's own messages (the dispatcher's MOVED note) before the test's folders go
  await until('the dispatcher is told', () => heard(dispatcher().info.id, '[ledger] MOVED (w1600)').length > 0);
  const why = `its worker ${a.id.slice(0, 8)} was moved to beast`;
  assert.deepEqual(agents.benchPriorities('pc')[a.id]?.away, { why }, 'every waiting ticket of it on pc is parked');
  assert.equal(agents.benchPriorities('beast')[a.id], undefined, 'nothing on the new machine');
  assert.equal(store.sessions.get(a.id)!.movedAway?.machine, 'pc', 'kept in the store: a portal restart keeps the mark');
  store.sessions.get(a.id)!.movedAway!.at = new Date(Date.now() - 7 * 3_600_000).toISOString();
  assert.notEqual(agents.benchPriorities('pc')[a.id]?.away?.why, why, 'hours later the move mark is gone (its old waiters ended long before)');
});

// w3425: on 2026-11-07 the away move of worker 416bdb60 off beast/slot3 (w3408, w3407) to biscuit at 16:18Z was cut by a
// portal restart at 16:35Z. The worker ran on through beast's drop, but its away mark stayed, and bench_queue.py parked
// every exclusive ticket it took on beast (t00006043, t00006054: "parked: its worker 416bdb60 was moved to biscuit") for
// over an hour, through a timed_place "here" at 17:27Z.
test('w3425: an away move that never happened leaves no away mark: the worker running on its own machine, or asking timed_place there, clears it and its waiting tickets count again', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, sessions } = env;
  agentsRoom(agents, ['pc', 'beast']);
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }, { id: 'w2', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w1');
  store.work.get('w2')!.sessionIds.push(a.id);
  store.putWork(store.work.get('w2')!);
  const handle = sessions.sessions.get(a.id) as unknown as { liveFlag: boolean };
  const why = `its worker ${a.id.slice(0, 8)} was moved to beast`;
  const plan = () => {
    // 1. an away move is planned (moveAway -> moveForRoom marks it), and pc drops: its daemon reports nothing running
    handle.liveFlag = false;
    a.info.movedAway = { machine: 'pc', to: 'beast', at: new Date().toISOString() };
    store.putSession(a.info);
    assert.deepEqual(agents.benchPriorities('pc')[a.id]?.away, { why }, 'while the move is planned, its waiting tickets on pc are parked');
  };
  plan();
  // 2. pc comes back, 3. its daemon reports the worker ran on through the drop; the move was cut (a portal restart)
  handle.liveFlag = true;
  // 4. the mark is gone, and its waiting ticket counts again: an entry of its requests with no away
  const p = agents.benchPriorities('pc')[a.id];
  assert.equal(p?.away, undefined, 'its waiting tickets on pc are unparked');
  assert.deepEqual([...(p?.requests ?? [])].sort(), ['w1', 'w2']);
  assert.equal(store.sessions.get(a.id)!.movedAway, undefined, 'cleared in the store: a portal restart does not bring it back');

  // A timed_place from pc (the "here" at 17:27Z) clears it too, whatever its daemon last said.
  plan();
  await a.h.timed_place!({ what: 'w3408 LeechSystem before/after on LifeAsTwoMegaWave' });
  assert.equal(store.sessions.get(a.id)!.movedAway, undefined, 'timed_place from its own machine clears the mark');
  assert.equal(agents.benchPriorities('pc')[a.id]?.away, undefined);

  // A move that completed took its requests off it: the mark stays even if its old process is seen running (w1984).
  plan();
  for (const w of [store.work.get('w1')!, store.work.get('w2')!]) {
    w.sessionIds = w.sessionIds.filter((x) => x !== a.id);
    store.putWork(w);
  }
  handle.liveFlag = true;
  assert.deepEqual(agents.benchPriorities('pc')[a.id]?.away, { why }, 'a completed move keeps its mark');
});

// w1643, lothsahn: "let's make the setting the minimum priority work that can go to a machine. If normal (all work), if high,
// high and urgent, if urgent, urgent only".
test('w1643: placement.minPriority: start_agent refuses a request below the computer\'s level and takes it once its person raises it; a new request sent to a worker there follows the rule while the worker\'s own goes on', async (t) => {
  const { store, cfg, agents, dispatcher, chat, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  cfg.placement = { minPriority: { pc: 'urgent' } };
  putRequests(store, [{ id: 'w1' }, { id: 'w2', priority: 'high' }]);
  // The dispatcher's brief names the reservation in force and where its rule is (the brief's budget, w1158); read_rules machines has it.
  assert.match((agents.orchestratorOptions(dispatcher().info) as { systemPrompt: { append: string } }).systemPrompt.append, /\(now: pc RESERVED for urgent and frantic work only \(minPriority urgent, w1643: `read_rules machines` before you place, queue or move work there\)\)/);
  assert.match(agents.rulesText('machines'), /never goes there, not even when nothing else has room: it waits Queued, since a reservation that overflowed would reserve nothing/);
  const refused = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: do it', work_id: 'w1' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /pc is reserved for urgent and frantic work only \(placement\.minPriority urgent; this work is normal\): w1 is normal, so it does not go there\. Start it on another computer .*or queue it \(decide_work queue\)/);
  assert.deepEqual(store.work.get('w1')!.sessionIds, [], 'nothing started');
  // Its person raises it: eligible at once.
  assert.equal((await call(chat(LOTH).info, 'update_work', { id: 'w1', priority: 'urgent' })).isError, false);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: do it', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  await until('its first turn', () => store.sessions.get(id)!.status === 'idle');
  // w2 (high) is new work on pc: refused, whichever session it would go to.
  const sent = await call(dispatcher().info, 'message_agent', { session_id: id, text: 'also this', work_id: 'w2', title: 'w2: also this' });
  assert.equal(sent.isError, true);
  assert.match(sent.text, /pc is reserved for urgent and frantic work only \(placement\.minPriority urgent; this work is high\): w2 is high/);
  // w1 lowered again: its worker goes on, and a follow-up on it still reaches it.
  await call(chat(LOTH).info, 'update_work', { id: 'w1', priority: 'normal' });
  const follow = await call(dispatcher().info, 'message_agent', { session_id: id, text: 'go on', work_id: 'w1' });
  assert.equal(follow.isError, false, follow.text);
});

test('w1643: a request below a reserved computer\'s level waits Queued with the reservation named, not WRONG; raised to the level, queue is refused and the page and the WRONG flag count that computer', async (t) => {
  const { store, agents, o, dispatcher, chat, call } = setup(t);
  const f = { game: [] as string[], agent: [] as string[], held: [], reserved: [{ id: 'beast', min: 'high' as const, for: ['game', 'agent'] as ('game' | 'agent')[] }] };
  agents.roomNow = () => f.game;
  agents.roomFacts = () => f;
  putRequests(store, [{ id: 'w1' }, { id: 'w2', priority: 'urgent' }]);
  (o as unknown as { now: () => Date }).now = () => new Date(T0);
  const queued = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'only beast has room' });
  assert.equal(queued.isError, false, queued.text);
  assert.match(store.work.get('w1')!.log.join('\n'), /queued for capacity; beast has room but takes high, urgent and frantic work only \(placement\.minPriority; this is normal\)/);
  const urgent = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'only beast has room' });
  assert.equal(urgent.isError, true);
  assert.match(urgent.text, /queue is for capacity only, and beast has room for w2 now/);
  // After the grace it is still a right Queued: no flag, and the page says why.
  (o as unknown as { now: () => Date }).now = () => new Date(Date.parse(T0) + 11 * 60_000);
  const line = (await call(dispatcher().info, 'list_work', { id: 'w1' })).text;
  assert.doesNotMatch(line, /WRONG/);
  assert.match(line, /Queued \(queued for capacity: no computer that could take it has room; beast has room but takes high, urgent and frantic work only \(placement\.minPriority; this is normal\)\)/);
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), []);
  // Its person raises it to high: it fits BEAST now.
  await call(chat(LOTH).info, 'update_work', { id: 'w1', priority: 'high' });
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w1' })).text, /Queued \[WRONG: beast has room\]/);
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), ['w1']);
});

// ---------------------------------------------------------------- w1841: Stalled is only what nothing will move

test('w1841: a worker on a real portal: a reporter wait is Waiting with no [needs you]; an own-work wait on the orchestrator is answered at once, once; a free bench lock resumes a worker that waited on it; blocked_on reports waits for another request\'s worker', async (t) => {
  const { store, machines, agents, sessions, dispatcher, chat, call, heard } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  const ben = chat(BEN).info;
  putRequests(store, [{ id: 'w1', status: 'active', by: BEN }, { id: 'w2', by: BEN }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: 'w2: fix it', work_id: 'w2' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const live = async () => (await call(dispatcher().info, 'list_work', { id: 'w2' })).text;
  const spec = machines.hooks!.specFor(info, store.machines.get('pc')!);
  // (d) Every worker's prompt says pair checks and builds are its own work, and how to wait on another request's worker.
  assert.match(spec.append, /Two-machine and pair checks, builds, test runs and your own CI are your own work: run them; never end a turn waiting on the orchestrator for them\. A check that needs two or more computers at once \(a host and a client on two machines\) is `mcp__machine__request_pair`/);
  // w1945: and never holds its sandbox for a second machine's worker.
  assert.match(spec.append, /Never hold your sandbox waiting for a second machine's worker\./);
  assert.match(spec.append, /Files or results another request's worker makes for you: `blocked_on` with reports/);

  // (b) w1778: a wait on the reporter is Waiting on input on them, and nobody's orchestrator is asked.
  const reporter = 'w2: still open: waiting on the reporter Reteoteigam to answer in the Discord thread (when the asteroid vanished); FFBox passes the answer on.';
  info.lastResult = reporter;
  info.lastResultAt = new Date().toISOString();
  sessions.events.emit('turnEnd', sessions.get(id), reporter);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(await live(), /Waiting on input on the reporter Reteoteigam/);
  assert.equal(heard(ben.id, '[needs you]').length, 0, 'no [needs you] for a wait on the reporter');

  // (d) w1685: "waiting on the orchestrator to run the two-machine check": told at once that it is its own work; once.
  const own = 'w2: still open: waiting on the orchestrator to run the two-machine check `MP-W2-2p` on a Windows or Linux pair, then the merge of PR #2254';
  info.lastResult = own;
  sessions.events.emit('turnEnd', sessions.get(id), own);
  await until('the notice reaches it', () => store.readTranscript(id).some((e) => e.kind === 'user' && /Two-machine and pair checks, builds, test runs and your own CI are your own work \(w1841\)/.test((e as { text: string }).text)));
  assert.match(store.work.get('w2')!.log.join('\n'), new RegExp(`worker ${id} was told its wait on the orchestrator \\("w2: still open: waiting on the orchestrator to run the two-machine check`));
  await until('that turn ends', () => info.status === 'idle');
  const told = () => store.readTranscript(id).filter((e) => e.kind === 'user' && /your own work \(w1841\)/.test((e as { text: string }).text)).length;
  info.lastResult = own;
  sessions.events.emit('turnEnd', sessions.get(id), own);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(told(), 1, 'told once per request');

  // (a) A report waiting on the machine's bench lock: Blocked on it while a timed run holds it; told once when it is free.
  const ms = machines as unknown as { statsOf: (id: string) => unknown };
  const statsOf = ms.statsOf.bind(machines);
  let lock: { owner: string; since: string } | undefined = { owner: 'pc pid 4121 w1739 timed run (/f/ffw/sandboxes/beta)', since: new Date().toISOString() };
  let bench: unknown;
  ms.statsOf = (m: string) => (m === 'pc' ? { ...((statsOf(m) as object) ?? {}), at: new Date().toISOString(), ...(lock ? { benchLock: lock } : {}), ...(bench ? { bench } : {}) } : statsOf(m));
  t.after(() => void (ms.statsOf = statsOf));
  info.lastResult = "w2: still open: waiting on pc's bench lock (w1739's timed run) before the raid clips record";
  info.lastResultAt = new Date(Date.now() + 1000).toISOString();
  assert.match(await live(), /Blocked on pc's bench lock/);
  assert.deepEqual(agents.resumeBenchWaits(), [], 'held: nothing to tell');
  lock = undefined;
  // w3294: no lock file, but shared tickets hold the queue and an exclusive one waits behind them (lothdesktop, 2026-11-07
  // 02:08-02:12 UTC: w3252's worker 25e6bb06 was told "bench lock is free" four times while four shared tickets held it).
  bench = { mode: 'shared', running: [], runningCount: 4, waiting: 1 };
  assert.deepEqual(agents.resumeBenchWaits(), [], 'shared tickets hold the queue: nothing to tell');
  bench = { mode: 'free', running: [], runningCount: 0, waiting: 1 };
  assert.deepEqual(agents.resumeBenchWaits(), [], 'a ticket still waits: it starts by itself');
  bench = { mode: 'free', running: [], runningCount: 0, waiting: 0 };
  assert.deepEqual(agents.resumeBenchWaits(), [['w2', `told ${id} that pc's bench lock is free`]]);
  assert.deepEqual(agents.resumeBenchWaits(), [], 'once per report');
  await until('the bench notice reaches it', () => store.readTranscript(id).some((e) => e.kind === 'user' && /pc's bench lock is free now \(w1841\): carry on with w2/.test((e as { text: string }).text)));
  await until('that turn ends', () => info.status === 'idle');

  // (e) w1818: files another request's worker makes: blocked_on reports is a request gate that clears at that worker's report.
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  assert.match(String(await h.blocked_on!({ reports: ['w1'], what: "w1's Calculations window stills" })), /^Recorded: w2 is Blocked on w1/);
  // w1869: w1's workers are told what w2 waits for and how to mark the report that carries it (w1 has none here).
  assert.doesNotMatch(String(store.work.get('w1')!.log.join('\n')), /w2 waits on its report \([^)]*\): told/);
  const g = store.work.get('w2')!.blocked!;
  assert.deepEqual([g.kind, g.ref, g.on], ['request', 'w1', 'report']);
  assert.match(await live(), /Blocked on w1/);
});

test('w1863: w1789 as it happened: a leg queued for a full m5 beside the request’s own worker on another computer outlives a message to that worker, its report and its PRs merging; it shows Queued, counts in Next timed work, is flagged WRONG when m5 frees, and goes when a worker starts for it there', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, sessions, dispatcher, call, heard } = env;
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1', title: 'Cut UI main-thread cost on the Just Play save' }]);
  // Its own worker (d80ca173 on BEAST, here on pc) codes on; m5 is full.
  const a = await startedFor(env, 'w1');
  assert.equal(store.work.get('w1')!.status, 'active');
  agentsRoomFacts(agents, {});
  const q = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'The m5 leg for the timed before/after runs is queued: m5 is full', needs: ['m5'] });
  assert.equal(q.isError, false, q.text);
  assert.match(q.text, /^w1 active: a leg queued for capacity on m5 \(its worker carries on/);
  const w = () => store.work.get('w1')!;
  assert.equal(w().status, 'active', 'its own worker still has it');
  assert.deepEqual(w().legs?.map((l) => l.needs), [['m5']]);
  const list = async () => (await call(dispatcher().info, 'list_work', { id: 'w1' })).text;
  assert.match(await list(), /Queued \(its leg \(since \d\d:\d\d UTC; its own worker elsewhere\) queued for capacity on m5: no computer that could take it has room\)/);

  // 07:10: the dispatcher passes lothsahn's answer to its worker. That made it active and dropped the queue before w1863.
  const sent = await call(dispatcher().info, 'message_agent', { session_id: a.id, text: 'lothsahn: "Yes, fix it"', work_id: 'w1' });
  assert.equal(sent.isError, false, sent.text);
  // The worker's echo of the message ends its turn: idle alone can be read before that turn starts (w1944: red on CI).
  await until('the turn', () => a.info.status === 'idle' && w().log.some((l) => /Echo: lothsahn/.test(l)));
  // Its worker reports, and its PRs merge: the leg is work left, so the merge does not close it.
  sessions.events.emit('turnEnd', sessions.get(a.id), 'PR merged.\n\nw1: still open: waiting for a sandbox on m5 for the timed runs');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(w().legs?.map((l) => l.needs), [['m5']], 'the leg outlived the message and the report');
  assert.match(afterMergeReason(w(), ['Done.']) ?? '', /^its leg for m5 is queued and not started/);
  assert.match(await list(), /Queued \(its leg/);

  // Next timed work names it, and counts it as m5's queued timed work.
  const m5: Computer = { id: 'm5', online: true, live: 0, midTurn: 0, maxAgents: 3, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, editors: 0, maxEditors: 2, platform: 'darwin', legs: [{ id: 'w1', since: w().legs![0].at }] };
  const big: Computer = { ...m5, id: 'beast', live: 4, sandboxes: 6, maxSandboxes: 6, freeSandboxes: 2, platform: 'win32', legs: undefined };
  const timed = timedLine([m5, big]);
  assert.match(timed ?? '', /Legs the ledger holds for a named computer \(w1863.*\): m5: w1 \(since \d\d:\d\dZ\) \(m5 has ROOM: start it now/);
  assert.doesNotMatch(timed ?? '', /m5 \(timed work goes to the smallest computer with room .*no timed run queued there/);

  // 15:15: m5 has 3 of 3 sandboxes free and nobody started it. Now: Queued [WRONG], and after the grace, flagged.
  agentsRoomFacts(agents, { game: ['m5'] });
  assert.match(await list(), /Queued \[WRONG: m5 has room\] \(its leg .*but m5 has room: the dispatcher should start a worker for it there/);
  const later = Date.now() + 11 * 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(later);
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), ['w1']);
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), [], 'once an hour at most');
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[ledger] WRONG STATE').length > 0);
  assert.match(heard(dispatcher().info.id, '[ledger] WRONG STATE')[0].text, /w1 "Cut UI main-thread cost on the Just Play save" \(Lothsahn, normal; room on m5; its leg there: The m5 leg for the timed/);
  assert.match(w().log.join('\n'), /flagged: its leg for m5 is queued for capacity while m5 has room/);

  // A timing worker starts for it on m5: the leg goes, and the request is not Queued any more.
  o.linkWorker('w1', { id: 'e18e6c17', title: 'w1: m5 timed A/B', machineId: 'm5' }, 'started worker e18e6c17 in m5/slot1');
  assert.equal(w().legs, undefined);
  assert.match(w().log.join('\n'), /its leg for m5 started \(queued \d\d:\d\d UTC\)/);
  assert.doesNotMatch((await list()).split('\n')[0], /Queued/);
});

test('w2415: w2320 as it happened: a timed leg held for lothlaptop, biscuit, beast or lothdesktop, whose notes name m3 only as where its worker ran, is not Mac work; the ledger line agrees with Next timed work, it is flagged WRONG when biscuit has room, and goes when a worker starts there', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, call, heard } = env;
  agentsRoomFacts(agents, { game: ['pc'] });
  // w2320 at 11:58 UTC on 2026-10-27: its brief asks for a timed run; lothsahn's notes name m3 as where worker 8b4357c9 sat.
  putRequests(store, [{
    id: 'w1',
    title: 'Mass Driver FPS drop, part 2',
    brief: 'Measure before and after on the same machine: a timed run through the bench queue.',
    notes: [
      { at: '2026-10-27T03:57:00Z', text: 'Unjam: worker 8b4357c9 stopped waiting. Its tools route the timed run back to m3.' },
      { at: '2026-10-27T11:57:00Z', text: 'Unjam: Worker 8b4357c9 is on m3, which is offline. Dispatcher: please carry on with cut 2 on an online machine.' },
    ],
  } as Partial<WorkItem> & { id: string }]);
  const w = () => store.work.get('w1')!;
  assert.equal(needsTimed(w()), 'any', 'm3 named as where a worker ran names no OS');
  await startedFor(env, 'w1');
  agentsRoomFacts(agents, {});
  const needs = ['lothlaptop', 'biscuit', 'beast', 'lothdesktop'];
  const q = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'Cut 2 leg, held for an online computer that takes timed runs', needs });
  assert.equal(q.isError, false, q.text);
  const list = async () => (await call(dispatcher().info, 'list_work', { id: 'w1' })).text;

  // 11:58: biscuit (Linux) and beast free up. Before w2415: "no computer that could take it has room; beast has room but cannot
  // take it: beast is not on macOS", and never flagged, while Next timed work said "biscuit has ROOM: start them now".
  const fit = { biscuit: { platform: 'linux' }, beast: { platform: 'win32' }, lothdesktop: { platform: 'win32' } };
  const room = { game: ['biscuit', 'beast'], agent: [] as string[], held: [], fit };
  agents.roomNow = () => room.game;
  agents.roomFacts = () => room;
  const line = (await list()).split('\n')[0];
  assert.match(line, /Queued \[WRONG: biscuit, beast have room\]/);
  assert.doesNotMatch(line, /not on macOS|no computer that could take it has room/);
  const biscuit: Computer = { id: 'biscuit', online: true, live: 0, midTurn: 0, maxAgents: 4, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 3, editors: 0, maxEditors: 2, platform: 'linux', legs: [{ id: 'w1', since: w().legs![0].at }] };
  assert.match(timedLine([biscuit, { ...biscuit, id: 'lothlaptop', maxAgents: 1, freeSandboxes: 0, sandboxes: 1, maxSandboxes: 1, platform: 'win32' }]) ?? '', /biscuit: w1 \(since \d\d:\d\dZ\) \(biscuit has ROOM: start it now/);

  // Ten minutes on, the dispatcher hears it at once.
  const later = Date.now() + 11 * 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(later);
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), ['w1']);
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[ledger] WRONG STATE').length > 0);
  assert.match(heard(dispatcher().info.id, '[ledger] WRONG STATE')[0].text, /w1 "Mass Driver FPS drop, part 2" \(Lothsahn, normal; room on biscuit, beast/);

  // The dispatcher starts it on biscuit: the leg goes.
  o.linkWorker('w1', { id: '786d0973', title: 'w1: cut 2 on biscuit', machineId: 'biscuit' }, 'started worker 786d0973 in biscuit/slot2');
  assert.equal(w().legs, undefined);
  assert.doesNotMatch((await list()).split('\n')[0], /Queued/);
});

test('w2415: an OS read from the words never rules out a computer the queue names; a timed leg\'s own platform still does; machine names name no OS', () => {
  const work = (title: string, brief = '', notes: string[] = []) => ({ title, brief, notes: notes.map((text) => ({ text })), needs: 'game' }) as unknown as WorkItem;
  const fit = { biscuit: { platform: 'linux' }, beast: { platform: 'win32' } };
  const mac = work('Timed A/B of the Mac player');
  assert.equal(needsTimed(mac), 'darwin');
  assert.equal(unfitWhy(mac, 'biscuit', fit), 'biscuit is not on macOS, which its timed work names', 'unnamed: the OS still rules');
  assert.equal(unfitWhy(mac, 'biscuit', fit, ['lothlaptop', 'biscuit']), undefined, 'named by the queue: the dispatcher placed it');
  assert.equal(unfitWhy(mac, 'beast', fit, ['biscuit']), 'beast is not on macOS, which its timed work names', 'only the named ones');
  const leg = { ...work('Timed leg for w2: Mac player A/B'), timedLeg: { platform: 'darwin' } } as unknown as WorkItem;
  assert.equal(unfitWhy(leg, 'biscuit', fit, ['biscuit']), 'biscuit is not on macOS, which its timed work names', 'a timed leg\'s platform is the work\'s own');
  const r: RoomNow = { game: ['biscuit', 'beast'], agent: [], held: [], fit };
  assert.deepEqual(roomForWork(r, mac, ['biscuit', 'beast']).ids, ['biscuit', 'beast']);
  // The words that made w2320 and w2336 Mac work, and w2358's brief: computers, not OSes.
  for (const s of ['Worker 8b4357c9 is on m3, which is offline.', 'worker f2b771ec has been on m3/slot1 since 09:39', 'Measured by w2332 on m3.', 'probe run on beast first', 'lothdesktop built both players']) assert.equal(needsTimed(work('Benchmark the belt pass', s)), 'any', s);
  assert.equal(needsTimed(work('Benchmark the belt pass', 'probe_ab_win.sh rounds 3')), 'win32', 'the Windows bench script is the work\'s own OS');
});

test('w1863: a leg is dropped by decide_work queue drop_leg, refused without one; a request with no worker queues as before', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  await startedFor(env, 'w1');
  agentsRoomFacts(agents, {});
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'm5 leg', needs: ['m5'] })).isError, false);
  const dropped = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'measured on LothDesktop instead', needs: ['m5'], drop_leg: true });
  assert.match(dropped.text, /^w1 active: dropped its leg for m5/);
  assert.equal(store.work.get('w1')!.legs, undefined);
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'again', drop_leg: true })).isError, true);
  // No worker: the request itself is Queued, as before.
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'm5 only', needs: ['m5'] })).isError, false);
  assert.equal(store.work.get('w2')!.status, 'queued');
  assert.equal(store.work.get('w2')!.legs, undefined);
});

test('w1872: decide_work queue refuses timed work on m5, even when its worker named m5; other computers and untimed work queue as before', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, call } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1', title: 'Cut UI main-thread cost on the Just Play save', brief: 'Timed A/B: timing runs under an exclusive bench lock.' }, { id: 'w2', title: 'A Mac player build' }]);
  await startedFor(env, 'w1');
  agentsRoomFacts(agents, {});
  const q = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'its worker asked for an m5 sandbox for the timed runs', needs: ['m5'] });
  assert.equal(q.isError, true);
  assert.match(q.text, /m5 takes no timed or exclusive-lock work \(lothsahn, 2026-10-23: .*; w1861\): w1 is timed work, so it does not wait there, even when its worker named it\. Place it by "Next timed work" \(w1872\): start it on the first of lothdesktop, beast with room/);
  assert.equal(store.work.get('w1')!.legs, undefined);
  // Named with another, still refused: the caller picks again (lothsahn: "that should go back to the orchestrator or worker").
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'm5 or lothdesktop', needs: ['m5', 'lothdesktop'] })).isError, true);
  const ok = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'the timed leg waits for LothDesktop', needs: ['lothdesktop'] });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(store.work.get('w1')!.legs?.map((l) => l.needs), [['lothdesktop']]);
  // Untimed work still waits on m5 (it stays open for builds, editors, coding, tests).
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'm5 only', needs: ['m5'] })).isError, false);
  assert.deepEqual(store.work.get('w2')!.queuedFor?.needs, ['m5']);
});

test('w1872: w1789 as it happened: a timed leg and a Queued timed request already waiting on m5 are re-placed by "Next timed work", once, and the dispatcher is told; untimed waits on m5 stay', async (t) => {
  const env = await setupOnMachine(t);
  const { store, o, dispatcher, heard } = env;
  fixTimedFacts(o);
  const at = new Date(Date.now() - 9 * 3_600_000).toISOString();
  putRequests(store, [
    { id: 'w1', status: 'active', title: 'Cut UI main-thread cost on the Just Play save', brief: 'Its timing runs need a quiet machine.', legs: [{ at, needs: ['m5'], what: 'The m5 leg for the timed before/after runs is queued: m5 is full' }] },
    { id: 'w2', status: 'queued', title: 'Perf A/B of the belt renderer', queuedFor: { at, needs: ['m5', 'm3'] } },
    { id: 'w3', status: 'queued', title: 'A Mac player build', queuedFor: { at, needs: ['m5'] } },
  ]);
  dispatcher();
  assert.deepEqual(o.replaceNoTimedWaits().sort(), ['w1', 'w2']);
  const w = (id: string) => store.work.get(id)!;
  assert.deepEqual(w('w1').legs?.map((l) => l.needs), [['lothdesktop', 'beast']], 'a leg left with no computer waits on the ranked ones');
  assert.equal(w('w1').legs?.[0].at, at, 'it keeps its place in the queue');
  assert.deepEqual(w('w2').queuedFor?.needs, ['m3'], 'm5 dropped, the other computer it named kept');
  assert.deepEqual(w('w3').queuedFor?.needs, ['m5'], 'untimed work keeps m5');
  assert.match(w('w1').log.join('\n'), /ledger: its timed work waited on m5, which takes no timed runs \(lothsahn, 2026-10-23: .*\); re-placed by "Next timed work" \(w1872\): it now waits on lothdesktop or beast/);
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[ledger] Re-placed timed work').length > 0);
  assert.match(heard(dispatcher().info.id, '[ledger] Re-placed timed work')[0].text, /"Have the dispatcher replace anything waiting on timing on m5"\): w1 "Cut UI main-thread cost on the Just Play save"; w2 "Perf A\/B of the belt renderer"\. Start each on the first computer "Next timed work" names with room/);
  assert.deepEqual(o.replaceNoTimedWaits(), [], 'nothing left on m5: no second notice');
});

test('w2900: parallel workers on one request each get their own timed leg; a different brief or platform files another; only the same worker repeating the same measurement folds', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1', title: 'FFU engine: fan out every unblocked PLAN.md row to parallel workers', brief: 'Rows D and E, in parallel.' }]);
  const rowE = await startedFor(env, 'w1');
  const rowD = await startedFor(env, 'w1', { override_duplicate: 'row D of the fan-out, a parallel worker' });
  assert.notEqual(rowD.id, rowE.id);
  agents.places = () => askFleet();
  const legs = () => [...store.work.values()].filter((x) => x.timedLeg?.for === 'w1');
  const metal = { what: 'ffu Metal frame times on M3', brief: 'Indirect vs direct at 250k on branch ffu-e, commit aaaa111; report the table.', via: 'leg', platform: 'mac' };
  const windows = { what: 'ffu Windows edit-loop timing', brief: 'Edit-to-running on branch ffu-d, commit bbbb222; report the median of 10.', via: 'leg', platform: 'windows' };
  assert.match(String(await rowE.h.timed_place!(metal)), /Filed w2, the timed leg of w1/);
  // Row D's worker (another worker, another measurement): its own leg, not folded into row E's (w2895 -> w2897).
  assert.match(String(await rowD.h.timed_place!(windows)), /Filed w3, the timed leg of w1/);
  assert.deepEqual(legs().map((x) => [x.id, x.timedLeg?.forSession, x.timedLeg?.platform]), [['w2', rowE.id, 'darwin'], ['w3', rowD.id, 'win32']]);
  assert.match(store.work.get('w3')!.brief, /Edit-to-running on branch ffu-d/, 'the leg carries row D\'s own brief');
  // Each worker waits on its own leg; neither wait replaces the other's (w2153).
  const gates = [store.work.get('w1')!.blocked, ...(store.work.get('w1')!.alsoBlocked ?? [])].map((g) => g?.ref).sort();
  assert.deepEqual(gates, ['w2', 'w3']);
  // A true repeat (the same worker, the same brief up to whitespace and case, the same platform) folds.
  assert.match(String(await rowE.h.timed_place!({ ...metal, brief: '  indirect vs direct at 250k on branch ffu-e,   commit aaaa111; report the table. ' })), /You already have an open timed leg for this measurement on w1, w2 .*nothing new was filed/);
  assert.match(String(await rowD.h.timed_place!(windows)), /You already have an open timed leg for this measurement on w1, w3/);
  assert.equal(legs().length, 2);
  // The same worker, another measurement or another platform: a leg of its own each.
  assert.match(String(await rowE.h.timed_place!({ ...metal, brief: 'Windowed capture check on branch ffu-e, commit aaaa111.' })), /Filed w4, the timed leg of w1/);
  assert.match(String(await rowE.h.timed_place!({ ...metal, platform: 'windows' })), /Filed w5, the timed leg of w1/);
  assert.equal(legs().length, 4);
});

test('w1969: a worker on a big computer asks timed_place; its leg is filed Queued for the small computers, its request waits on the leg\'s report, the guard keeps its ticket off here, and the decision is in the log', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1', title: 'Just Play perf: RoundRobin belt output without Instantiate', brief: 'Fix it, then a timed A/B.' }]);
  const { id, h } = await startedFor(env, 'w1');
  agents.places = () => askFleet();
  // The machine view: pc is big, so its workers ask.
  assert.equal(agents.timedAskFor('pc')?.required, true);
  assert.equal(agents.timedAskFor('m3')?.required, false);
  const out = String(await h.timed_place!({ what: 'RoundRobin belt output A/B on PR #2347', brief: 'Branch w1891-roundrobin: base 1a2b3c4, fix 5d6e7f8; probe_ab_win.sh 4 rounds on the Just Play save; report the table.' }));
  assert.match(out, /^Elsewhere \(w1969\): pc has 6 agent slots \(6 live now\): an exclusive turn there idles all the others; small computers take it: m3 \(medium, 2 agent slots, 1 live, room now\) > lothlaptop \(small, 1 agent slot, 1 live, no room now\)\. Filed w2, the timed leg of w1, Queued for m3 > lothlaptop/);
  const leg = store.work.get('w2')!;
  assert.equal(leg.status, 'queued');
  assert.deepEqual(leg.queuedFor?.needs, ['m3', 'lothlaptop'], 'small ones only: never pc (big) or m5');
  assert.deepEqual(leg.timedLeg, { for: 'w1', forSession: id, from: 'pc', small: ['m3', 'lothlaptop'], ask: 'branch w1891-roundrobin: base 1a2b3c4, fix 5d6e7f8; probe_ab_win.sh 4 rounds on the just play save; report the table.' });
  assert.match(leg.title, /^Timed leg for w1: RoundRobin belt output A\/B on PR #2347$/);
  assert.match(leg.brief, /Build and time BOTH sides of the comparison on the computer you run on, under its exclusive bench ticket/);
  assert.match(leg.brief, /a line "For w1:"/);
  const w1 = store.work.get('w1')!;
  assert.equal(w1.status, 'blocked');
  assert.match(w1.log.join('\n'), /timed leg ask \(w1969\) from worker \w{8} on pc: handed to w2, queued for m3 > lothlaptop: pc has 6 agent slots/);
  assert.match(leg.log.join('\n'), /filed by FF Factory for worker \w+ on w1 \(w1969 timed_place\) from pc: queued for m3 > lothlaptop, the computers of the timing order \(w2055: idle first, then pre-emption, then by priority\): pc has 6 agent slots/);
  // Its machine hears the verdict with the bench priorities: the guard then names the leg.
  assert.deepEqual({ verdict: agents.benchPriorities('pc')[id]?.timed?.verdict, leg: agents.benchPriorities('pc')[id]?.timed?.leg }, { verdict: 'elsewhere', leg: 'w2' });
  // w1829: the verdict is kept with the session, so a portal restart does not drop it (BEAST, 2026-10-24 13:43Z).
  store.flush();
  assert.equal(new Store(env.cfg.dataDir).sessions.get(id)?.timedVerdict?.leg, 'w2', 'kept across a portal restart');
  // Asked again by the same worker for the same measurement (w2900: a true repeat): no second leg.
  assert.match(String(await h.timed_place!({ what: 'the same A/B', brief: 'Branch w1891-roundrobin: base 1a2b3c4,  fix 5d6e7f8; probe_ab_win.sh 4 rounds on the Just Play save; report the table.' })), /You already have an open timed leg for this measurement on w1, w2/);
  assert.equal([...store.work.values()].filter((x) => x.timedLeg).length, 1);

  // w2055: nothing idle (pc runs 6 agents, m3 and lothlaptop one each) and no worker of theirs to move: a normal leg waits
  // Queued on the small computers only (lothlaptop), never on a busy shared one.
  assert.deepEqual(o.timedLegBound(), ['w2'], 're-queued on the smallest class');
  assert.deepEqual(store.work.get('w2')!.queuedFor?.needs, ['lothlaptop']);
  assert.equal(store.work.get('w2')!.timedLeg?.widened, undefined);
  assert.match(store.work.get('w2')!.log.join('\n'), /ledger: timed leg queue \(w2055\): no computer that takes timed runs is idle or can be freed; none can be freed: .*at normal priority it waits Queued on the small computers \(lothlaptop\)/);
  assert.deepEqual(o.timedLegBound(), [], 'unchanged: nothing to do');
  // lothlaptop offline for two hours: the small class is skipped, not waited for; m3 (medium) is next.
  const gone = new Date(Date.now() - 120 * 60_000).toISOString();
  agents.places = () => askFleet().map((c) => (c.id === 'lothlaptop' ? { ...c, online: false, offlineSince: gone } : c));
  assert.deepEqual(o.timedLegBound(), ['w2']);
  assert.deepEqual(store.work.get('w2')!.queuedFor?.needs, ['m3']);
  assert.match(store.work.get('w2')!.log.join('\n'), /every small computer is offline \(lothlaptop\), so the next class is used/);
  // A 30 s drop is a blip: lothlaptop still counts, so the leg goes back to waiting on it.
  const blip = new Date(Date.now() - 30_000).toISOString();
  agents.places = () => askFleet().map((c) => (c.id === 'lothlaptop' ? { ...c, online: false, offlineSince: blip } : c));
  assert.deepEqual(o.timedLegBound(), ['w2']);
  assert.deepEqual(store.work.get('w2')!.queuedFor?.needs, ['lothlaptop']);
  // Every small and medium computer offline: the large class (pc) takes it at once, a big-computer fallback logged on both requests.
  agents.places = () => askFleet().map((c) => (c.id === 'm3' || c.id === 'lothlaptop' ? { ...c, online: false, offlineSince: gone } : c));
  assert.deepEqual(o.timedLegBound(), ['w2']);
  const needs = store.work.get('w2')!.queuedFor?.needs ?? [];
  assert.deepEqual(needs, ['pc'], 'never m5');
  assert.ok(store.work.get('w2')!.timedLeg?.widened);
  assert.match(store.work.get('w2')!.log.join('\n'), /ledger: BIG-COMPUTER FALLBACK \(w2048, w2055\): .*every small computer is offline \(lothlaptop\); every medium computer is offline \(m3\)/);
  assert.match(store.work.get('w1')!.log.join('\n'), /its timed leg w2 may now run on a big computer \(w2048 fallback, w2055\)/);
  assert.deepEqual(o.timedLegBound(), [], 'once');
  // lothlaptop back: re-checked every pass, the leg goes back to waiting on it and is no longer widened.
  agents.places = () => askFleet().map((c) => (c.id === 'm3' ? { ...c, online: false, offlineSince: gone } : c));
  assert.deepEqual(o.timedLegBound(), ['w2']);
  assert.deepEqual(store.work.get('w2')!.queuedFor?.needs, ['lothlaptop']);
  assert.equal(store.work.get('w2')!.timedLeg?.widened, undefined);
});

// w2620 (lothsahn): on LothDesktop worker 2e4db6f1 (w2597) had every exclusive ticket refused "sent to w2607", a timed leg
// that had long finished, for the rest of its verdict's 12 h, until it called timed_place again before each ticket.
test('w2620: once the timed leg a verdict sent the worker to has finished, its next ticket is not refused naming it: it is placed afresh, and a "here" then holds', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1', title: 'Ship Assembler refill timing', brief: 'Time the retry arms.' }]);
  const { id, h } = await startedFor(env, 'w1');
  agents.places = () => askFleet();
  const cmd = 'python scripts/bench/bench_queue.py timed --what "launch-slot arm" --minutes 20';
  const guard = () => checkTimedAsk(cmd, { mark: agents.timedAskFor('pc'), verdict: agents.benchPriorities('pc')[id]?.timed }, Date.now());
  assert.match(String(await h.timed_place!({ what: 'retry arms A/B', brief: 'Branch w1: both arms, 4 rounds; report the table.' })), /^Elsewhere \(w1969\).*Filed w2, the timed leg of w1/);
  assert.match(guard()!, /sent this timed leg to w2/, 'while the leg runs, its ticket here is refused');
  // The leg ran on m3 and reported: closed as done. The verdict still says 12 h.
  const leg = store.work.get('w2')!;
  leg.status = 'done';
  store.putWork(leg);
  assert.equal(store.sessions.get(id)!.timedVerdict?.leg, 'w2');
  assert.equal(agents.benchPriorities('pc')[id].timed, undefined, 'a finished leg holds no verdict');
  assert.equal(agents.benchPriorities('pc')[id].away, undefined, 'nor parks its tickets here as placed elsewhere');
  const refusal = guard()!;
  assert.doesNotMatch(refusal, /w2\b/, 'the finished leg is never named');
  assert.match(refusal, /Call timed_place/, 'it is placed afresh');
  // A stalled leg is not finished: its worker is resumed, and no second leg would be filed beside it.
  leg.status = 'stalled';
  assert.equal(agents.benchPriorities('pc')[id].timed?.leg, 'w2');
  leg.status = 'done';
  // Asked afresh with pc idle but for this worker: "here", and the ticket is granted while it holds.
  agents.places = () => askFleet().map((c) => (c.id === 'pc' ? { ...c, live: 1 } : c));
  assert.match(String(await h.timed_place!({ what: 'launch-slot arm', brief: 'same A/B, the new arm' })), /^Here \(w1969\)/);
  assert.equal(guard(), undefined, 'granted');
  assert.equal(agents.benchPriorities('pc')[id].timed?.verdict, 'here');
});

// w2660 (lothsahn: "Please fix the factory"): on 2026-10-31 worker 1de7e4b5 had closed w2654 as done when lothsahn's
// orchestrator followed up (message_agent) asking it to profile the player pass. timed_place answered "here" twice, yet the
// bench queue refused every exclusive ticket (benchPriorities left out a session with no open request, so the "here" never
// reached the machine), and the hand-off to a small computer was refused "you are on no request in the ledger".
test('w2660: a worker followed up about its closed request takes an exclusive ticket on a "here", and hands a timed run off, which reopens the request', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, chat, call } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1', title: 'Construction assigner: incremental task order' }]);
  const { id, h } = await startedFor(env, 'w1');
  // It finished: closed as done (as w2654 at 17:18Z).
  const w1 = store.work.get('w1')!;
  w1.status = 'done';
  w1.updatedAt = new Date().toISOString();
  store.putWork(w1);
  assert.equal(agents.benchPriorities('pc')[id], undefined, 'no follow-up yet: nothing of it on the bench');
  // The follow-up arrives.
  const sent = await call(chat(LOTH).info, 'message_agent', { session_id: id, text: 'Profile the remaining 0.76 ms of the player pass and recommend cuts.' });
  assert.equal(sent.isError, false, sent.text);
  assert.equal(store.sessions.get(id)!.followUpOn?.id, 'w1');
  assert.match(store.work.get('w1')!.log.join('\n'), /Lothsahn's follow-up reached worker \w{8} with w1 done: its timed work attaches to w1/);
  await until('the follow-up turn ends', () => store.sessions.get(id)!.status === 'idle');
  // "here": the verdict reaches the machine with the request it is for, so the guard grants its exclusive ticket.
  agents.places = () => askFleet().map((c) => (c.id === 'pc' ? { ...c, live: 1 } : c));
  const cmd = 'python scripts/bench/bench_queue.py timed --what "w1 assigner stage profile" --minutes 20';
  const guard = () => checkTimedAsk(cmd, { mark: agents.timedAskFor('pc'), verdict: agents.benchPriorities('pc')[id]?.timed }, Date.now());
  assert.match(guard()!, /Call timed_place/, 'before it asks, refused as for any worker');
  assert.match(String(await h.timed_place!({ what: 'w1 assigner stage profile', same_machine: 'r26 was measured on pc' })), /^Here \(w1969\)/);
  assert.equal(guard(), undefined, 'granted');
  assert.deepEqual(agents.benchPriorities('pc')[id].requests, ['w1'], 'the ticket is tied to w1');
  assert.equal(store.work.get('w1')!.status, 'done', 'a "here" leaves it closed');
  assert.match(store.work.get('w1')!.log.join('\n'), /timed leg ask \(w1969\) from worker \w{8} on pc: here/);
  // pc busy again: the run goes to a small computer, and w1 waits on its report, reopened.
  agents.places = () => askFleet();
  const out = String(await h.timed_place!({ what: 'w1 assigner stage profile', brief: 'Branch w1-stage-profile; AssignerPerfBenchmark by stage, Burst on; report the table.' }));
  assert.match(out, /^Elsewhere \(w1969\).*Filed w2, the timed leg of w1/);
  const again = store.work.get('w1')!;
  assert.equal(again.status, 'blocked');
  assert.match(again.log.join('\n'), /reopened \(its earlier .*DONEs no longer count.*\): worker \w{8}'s timed_place on Lothsahn's follow-up of \d\d:\d\d UTC made it wait, so it is open again until its worker's next DONE \(w2660\)/);
  assert.equal(store.work.get('w2')!.timedLeg?.for, 'w1');
  assert.equal(store.sessions.get(id)!.followUpOn, undefined, 'the request is open: its own work from here');
  assert.deepEqual(agents.benchPriorities('pc')[id].requests, ['w1']);
});

test('w1969: with a reason its numbers must come from here, the leg stays, the verdict lets its ticket through, and the log says why', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1', title: 'Factory info > Mobile Stations: fix the slow open' }]);
  const { id, h } = await startedFor(env, 'w1');
  agents.places = () => askFleet();
  const out = String(await h.timed_place!({ what: 'Mobile Stations open, after', same_machine: 'the before side ran on pc at 01:10Z' }));
  assert.match(out, /^Here \(w1969\): its numbers must come from pc: "the before side ran on pc at 01:10Z" \(both sides of an A\/B stay on one machine\)\. Take your exclusive ticket on pc as before/);
  assert.equal(agents.benchPriorities('pc')[id]?.timed?.verdict, 'here');
  assert.equal(store.work.get('w1')!.status, 'active');
  assert.match(store.work.get('w1')!.log.join('\n'), /timed leg ask \(w1969\) from worker \w{8} on pc: here: its numbers must come from pc/);
  assert.equal([...store.work.values()].filter((x) => x.timedLeg).length, 0);
});

test('w1944: a worker whose still-open line waits on another request, the orchestrator or a worker they start gives up its sandbox at once, as for a declared block; one with its own work left keeps it', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }]);
  const waitOn = (i: SessionInfo) => {
    (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
    return agents.waitOn(i);
  };
  const said = (s: { info: SessionInfo }, line: string) => Object.assign(s.info, { status: 'idle', lastResult: `Done the low-ore pin.\n\n${line}`, lastResultAt: new Date().toISOString() });
  // d558ba14 on w665, 2026-10-23 21:57 UTC: idle on the m3's only sandbox for 29 minutes with this line and no blocked_on.
  const a = await startedFor(env, 'w1');
  said(a, 'w1: still open: waiting on a Windows or Linux pair worker to run `MP-lowore-pin-pair` for PR #2340 (CI is green, the merge is held for that run), and on Ben\'s Intel Mac tester report');
  assert.match(waitOn(a.info) ?? '', /^it waits on w1: a worker the dispatcher starts \(its report: "w1: still open: waiting on a Windows or Linux pair worker/);
  const b = await startedFor(env, 'w2', { override_duplicate: 'another request' });
  said(b, 'w2: still open: waiting for w3 to report its stills');
  assert.match(waitOn(b.info) ?? '', /^it waits on w2: w3 \(its report/);
  const c = await startedFor(env, 'w3', { override_duplicate: 'another request' });
  said(c, 'w3: still open: waiting on the orchestrator to start the Windows client leg');
  assert.match(waitOn(c.info) ?? '', /^it waits on w3: (?:the|Lothsahn's) orchestrator/); // w2870: Waiting on its orchestrator
  // Work of its own left, or no line at all: it keeps the sandbox.
  const d = await startedFor(env, 'w4', { override_duplicate: 'another request' });
  said(d, 'w4: still open: I re-run the scenario after the fix');
  assert.equal(waitOn(d.info), undefined);
  Object.assign(d.info, { lastResult: 'Done for now.' });
  assert.equal(waitOn(d.info), undefined);
});

test('w1944 as it happened: an MP scenario fix is not WRONG beside a free Mac, says why, and may be queued; ordinary work there is flagged, and only once its room has stood', async (t) => {
  const { store, agents, o, dispatcher, call, heard } = setup(t);
  store.putWork(queuedItem('w1', 'Nightly: fix the MP-W1020-camps-settle-join desync', 'urgent'));
  store.putWork(queuedItem('w2', 'Blueprint paste keeps the filter', 'normal'));
  const f: RoomNow = { game: ['m5'], agent: ['m5'], held: [], fit: { m5: { platform: 'darwin', noTimedRuns: "Ben's own Mac" } }, since: { 'game:m5': Date.parse(T0) + 10 * 60_000 } };
  agents.roomNow = () => f.game;
  agents.roomFacts = () => f;
  // 22:13:31: the m5 freed a minute ago. Nothing is WRONG yet: the capacity ping brings it.
  const clock = { at: Date.parse(T0) + 11 * 60_000 };
  (o as unknown as { now: () => Date }).now = () => new Date(clock.at);
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), [], 'room younger than ROOM_STAND_MS');
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w2' })).text, /Queued \(queued for capacity; m5 has room since 1 min ago: the capacity ping brings it to the dispatcher\)/);
  // Five minutes on: w2 is WRONG and flagged; w1 never is, and says why it waits.
  clock.at += 5 * 60_000;
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), ['w2']);
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[ledger] WRONG STATE').length > 0);
  assert.doesNotMatch(heard(dispatcher().info.id, '[ledger] WRONG STATE')[0].text, /w1 "/);
  const w1 = (await call(dispatcher().info, 'list_work', { id: 'w1' })).text;
  assert.doesNotMatch(w1, /WRONG/);
  assert.match(w1, /Queued \(queued for capacity: no computer that could take it has room; m5 has room but cannot take it: m5 is a Mac, which refuses the multiplayer client its MP scenario starts \(w665\)\)/);
  // decide_work queue takes it while only the Mac has room, and says so; it refuses ordinary work.
  store.putWork({ ...store.work.get('w1')!, status: 'new', queuedFor: undefined });
  store.putWork({ ...store.work.get('w2')!, status: 'new', queuedFor: undefined });
  const ok = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'only the m5 is free' });
  assert.equal(ok.isError, false, ok.text);
  assert.match(store.work.get('w1')!.log.at(-1)!, /m5 has room but cannot take it: m5 is a Mac/);
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'later' })).isError, true);
});

test('w1944: the capacity ping names the room a queued request cannot use, lets urgent work that fits past the hourly cap, and is never held past two minutes by a stream of events', async (t) => {
  const { store, agents, o, dispatcher, heard } = setup(t);
  store.putWork(queuedItem('w1', 'Nightly: fix MP-tutorial-e2e-loth', 'urgent'));
  store.putWork(queuedItem('w2', 'Blueprint paste keeps the filter', 'normal'));
  const f: RoomNow = { game: ['m5'], agent: ['m5'], held: [], fit: { m5: { platform: 'darwin' }, biscuit: { platform: 'win32' } } };
  agents.roomNow = () => f.game;
  agents.roomFacts = () => f;
  const clock = { at: Date.parse(T0) };
  (o as unknown as { now: () => Date }).now = () => new Date(clock.at);
  const tick = (ms: number) => {
    clock.at += ms;
    t.mock.timers.tick(ms);
  };
  const pings = () => heard(dispatcher().info.id, '[ledger] Capacity may have freed').map((e) => e.text);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  o.capacityMayHaveFreed('sandbox m5/slot3 released');
  tick(30_000);
  assert.equal(pings().length, 1);
  assert.match(pings()[0], /fitting it, by priority, then started work that runs only on the computers it names, then oldest: w2 "Blueprint paste keeps the filter".*Queued with no room for them now: w1 \(m5 is a Mac, which refuses the multiplayer client its MP scenario starts \(w665\)\)\./);

  // The hourly cap is spent. biscuit (Windows) frees: the urgent MP fix fits it, so the ping goes at the gap, not in an hour.
  const wakes = (o as unknown as { capacityWakes: number[] }).capacityWakes;
  wakes.splice(0, wakes.length, ...Array.from({ length: 20 }, (_, i) => clock.at - 50 * 60_000 + i * 60_000));
  f.game = ['m5', 'biscuit'];
  f.agent = ['m5', 'biscuit'];
  tick(3 * 60_000);
  o.capacityMayHaveFreed('sandbox biscuit/slot1 released');
  tick(30_000);
  assert.equal(pings().length, 2, 'urgent work that fits is not held by the hourly cap');
  assert.match(pings()[1], /fitting it, by priority, then started work that runs only on the computers it names, then oldest: w1 "Nightly: fix MP-tutorial-e2e-loth" \(Lothsahn, urgent\); w2/);

  // Normal work alone waits for the cap, as before.
  store.putWork({ ...store.work.get('w1')!, status: 'active', queuedFor: undefined });
  wakes.splice(0, wakes.length, ...Array.from({ length: 20 }, (_, i) => clock.at - 50 * 60_000 + i * 60_000));
  tick(3 * 60_000);
  o.capacityMayHaveFreed('worker x stopped');
  tick(30_000);
  assert.equal(pings().length, 2, 'the hourly cap holds normal work');
  // Drop the ping the cap holds, and start the next one afresh.
  clearTimeout((o as unknown as { capacityTimer?: NodeJS.Timeout }).capacityTimer);
  wakes.splice(0, wakes.length);
  (o as unknown as { capacityFirstAt?: number }).capacityFirstAt = undefined;

  // A worker finishes a turn every 20 s for 3 minutes: the quiet spell never comes, yet the ping goes two minutes after the first.
  tick(3 * 60_000);
  for (let i = 0; i < 6; i++) {
    o.capacityMayHaveFreed(`worker w${i} finished a turn`);
    tick(20_000);
  }
  // The quiet spell armed by the event 20 s ago would fire in 10 s more; the first event is two minutes old, so it went now.
  assert.equal(pings().length, 3, 'the first event was two minutes old: it went while events still came');
  assert.match(pings()[2], /Capacity may have freed \(worker w1 finished a turn, 2 min ago; .*worker w5 finished a turn, 0 min ago\)/);
  t.mock.timers.reset();
});
