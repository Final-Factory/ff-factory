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
 * The orchestrator tests (docs/orchestrators.md), end to end on a real Agents with the scripted agent: timed legs on big computers, pair legs under way, moves and resumes, reports.
 * One of the server/orchestrators*.test.ts files split out of orchestrators.test.ts (w5826); helpers in orchestratorsTestKit.ts.
 */

// ---------------------------------------------------------------- w2168: timed work follows the timing order at start and while it waits

test('w2168: start_agent refuses timed work on a busy big computer while a small one is idle; a leg waiting there for an exclusive ticket moves to the small one between turns, never mid-turn', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, machines, o, dispatcher, call } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc', 'lap'] });
  const box = (bid: string, maxAgents: number, x: Partial<Computer> = {}): Computer => ({ id: bid, online: true, live: 0, midTurn: 0, maxAgents, sandboxes: 1, maxSandboxes: 3, freeSandboxes: 1, memUsedBytes: 16 * 1024 ** 3, memTotalBytes: 64 * 1024 ** 3, editors: 0, maxEditors: 2, platform: 'win32', ...x });
  // pc: xlarge with three agents at work (LothDesktop at 18:43Z on 10-25); lap: small and idle (LothLaptop).
  let lap: Partial<Computer> = {};
  agents.places = () => [box('pc', 10, { live: 3, midTurn: 2 }), box('lap', 1, lap)];
  putRequests(store, [{ id: 'w3', title: 'Timed A/B of the belt fix', brief: 'Run the benchmark A/B on Windows.' }]);
  const refused = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Run it', title: 'w3: A/B', work_id: 'w3' });
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /w3 is timed work, and lap \(small, 1 agent slot\) is idle.*start_agent with machine "lap"/s);

  // A started leg on pc whose worker waits for an exclusive ticket there (w2157 on BEAST from 18:44).
  putRequests(store, [{ id: 'w2', title: 'Timed leg for w9: belt A/B', status: 'active', needs: 'game', timedLeg: { for: 'w9', forSession: 'nobody', from: 'pc', small: ['lap'] } }]);
  const { id, info } = await startedFor(env, 'w2');
  const stats = machines.statsOf.bind(machines);
  const bench = { mode: 'shared', running: [{ ticket: 't1', mode: 'shared', what: 'other', session: 'someone' }], runningCount: 1, waiting: 1, waiters: [{ ticket: 't1507', mode: 'exclusive', what: 'belt A/B', session: id.slice(0, 8), ahead: 0 }] };
  machines.statsOf = ((mid: string) => ({ ...(stats(mid) ?? {}), ...(mid === 'pc' ? { bench } : {}) })) as typeof machines.statsOf;
  const starts: { w: string; m: string }[] = [];
  agents.startTimedLeg = (w, m) => (starts.push({ w: w.id, m }), true);

  // lap busy: it stays.
  lap = { live: 1, midTurn: 1 };
  assert.deepEqual(o.timedLegBound(), []);
  lap = {};
  // Mid-turn: never interrupted.
  const st = info.status;
  info.status = 'running';
  assert.deepEqual(agents.timedLegRelocateFor(store.work.get('w2')!), { stays: 'it is mid-turn (a worker is never interrupted; it can move after its turn)' });
  assert.deepEqual(o.timedLegBound(), []);
  info.status = st;
  // Between turns, lap idle: it moves.
  assert.deepEqual(o.timedLegBound(), ['w2']);
  assert.deepEqual(starts, [{ w: 'w2', m: 'lap' }]);
  const w2 = store.work.get('w2')!;
  assert.equal(w2.status, 'queued');
  assert.deepEqual(w2.queuedFor?.needs, ['lap']);
  assert.ok(!w2.sessionIds.includes(id), 'the stopped worker is detached');
  assert.match(w2.log.join('\n'), /ledger: MOVED to lap by FF Factory \(w2168\): worker \w{8} on pc\/alpha waited for an exclusive bench ticket and was between turns; lap \(small, 1 agent slot\) became idle/);
  assert.ok(store.sessions.get(id)!.placeReleased, 'its sandbox is released');
});

test('w2277: a timed request (not a leg) waiting on a big computer for a shared ticket moves to an idle small one between turns; a big-computer fallback "here" is withdrawn once a small one is idle; a non-timed start may not take the small one from timed work', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, machines, o, dispatcher, call } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc', 'lap'] });
  const box = (bid: string, maxAgents: number, x: Partial<Computer> = {}): Computer => ({ id: bid, online: true, live: 0, midTurn: 0, maxAgents, sandboxes: 1, maxSandboxes: 3, freeSandboxes: 1, memUsedBytes: 16 * 1024 ** 3, memTotalBytes: 64 * 1024 ** 3, editors: 0, maxEditors: 2, platform: 'win32', ...x });
  // pc: BEAST at 07:23Z on 2026-10-26, three agents at work; lap: LothLaptop, idle once w2222's worker left it.
  let lap: Partial<Computer> = { live: 1, midTurn: 1 };
  agents.places = () => [box('pc', 10, { live: 3, midTurn: 2 }), box('lap', 1, lap)];

  // w2265: a timed request (FPS-drop profiling) started on pc while lap was busy, now waiting for a shared ticket.
  putRequests(store, [{ id: 'w2', title: 'Moving the camera drops FPS 120 to 90 on the big base: profile and fix', status: 'active', needs: 'game' }]);
  assert.equal(needsTimed(store.work.get('w2')!), 'any', 'FPS-drop profiling is timed work (w2277)');
  const { id, info } = await startedFor(env, 'w2');
  const stats = machines.statsOf.bind(machines);
  let bench: Record<string, unknown> = { mode: 'exclusive', running: [{ ticket: 't1948', mode: 'exclusive', what: 'w2257 p99', session: 'other123' }], runningCount: 1, waiting: 1, waiters: [{ ticket: 't1949', mode: 'shared', what: 'player build', session: id.slice(0, 8), ahead: 0 }] };
  machines.statsOf = ((mid: string) => ({ ...(stats(mid) ?? {}), ...(mid === 'pc' ? { bench } : {}) })) as typeof machines.statsOf;

  // lap busy: it stays.
  assert.deepEqual(o.timedLegBound(), []);
  lap = {};
  // Mid-turn: never interrupted.
  const st = info.status;
  info.status = 'running';
  assert.deepEqual(agents.timedLegRelocateFor(store.work.get('w2')!), { stays: 'it is mid-turn (a worker is never interrupted; it can move after its turn)' });
  assert.deepEqual(o.timedLegBound(), []);
  info.status = st;

  // While it waits for lap, a non-timed start (w2228's pair leg at 07:28Z) may not take lap; on pc it may.
  putRequests(store, [{ id: 'w5', title: 'Pair run for w4: MP-check on PR #2575', needs: 'game' }]);
  const pair = await call(dispatcher().info, 'start_agent', { machine: 'lap', prompt: 'Run the leg', title: 'w5: pair leg', work_id: 'w5' });
  assert.equal(pair.isError, true, pair.text);
  assert.match(pair.text, /lap is kept for timed work that waits for it: w2 ".*", which waits for a bench ticket on pc\/alpha\. Start w5, which is not timed work, on another computer/);

  // Between turns, lap idle: it moves as stop_agent move_to moves a worker (w1600), Queued for lap.
  assert.deepEqual(o.timedLegBound(), ['w2']);
  await until('it is moved', () => store.work.get('w2')!.status === 'queued');
  const w2 = store.work.get('w2')!;
  assert.deepEqual(w2.queuedFor?.needs, ['lap']);
  assert.ok(!w2.sessionIds.includes(id), 'taken off the old worker');
  assert.ok(store.sessions.get(id)!.movedAway, 'its waiting ticket on pc holds nobody back');
  assert.match(w2.log.join('\n'), /ledger: MOVED to lap by FF Factory \(w2277\): worker \w{8} on pc\/alpha waited for a bench ticket and was between turns; lap \(small, 1 agent slot\) became idle while it waited on .* for a shared bench ticket/);
  assert.deepEqual(o.timedLegBound(), [], 'once');

  // w2257: a worker told "here" on pc as w2048's fallback (lap paused at 06:27Z) keeps it while its exclusive ticket runs,
  // and loses it once lap is idle and it holds none, before it takes one (07:27Z).
  putRequests(store, [{ id: 'w3', title: 'JustPlay save p99: the slowest systems', status: 'active', needs: 'game' }]);
  const b = await startedFor(env, 'w3');
  const until12h = new Date(Date.now() + 12 * 3600_000).toISOString();
  b.info.timedVerdict = { verdict: 'here', why: 'w2048 fallback: lap is held (paused)', until: until12h, fallback: true };
  store.putSession(b.info);
  bench = { mode: 'exclusive', running: [{ ticket: 't1948', mode: 'exclusive', what: 'w3 p99', session: b.id.slice(0, 8) }], runningCount: 1, waiting: 0, waiters: [] };
  assert.deepEqual(agents.withdrawStaleTimedHere(), [], 'a running measurement is never cut');
  assert.equal(store.sessions.get(b.id)!.timedVerdict?.verdict, 'here');
  lap = { live: 1, midTurn: 1 };
  bench = { mode: 'idle', running: [], runningCount: 0, waiting: 0, waiters: [] };
  assert.deepEqual(agents.withdrawStaleTimedHere(), [], 'lap busy: the fallback stands');
  lap = {};
  // An ordinary "here" (not a fallback) is never withdrawn.
  b.info.timedVerdict = { verdict: 'here', why: 'pc is the right computer', until: until12h };
  assert.deepEqual(agents.withdrawStaleTimedHere(), []);
  b.info.timedVerdict = { verdict: 'here', why: 'w2048 fallback', until: until12h, fallback: true };
  assert.deepEqual(agents.withdrawStaleTimedHere(), ['w3']);
  assert.equal(store.sessions.get(b.id)!.timedVerdict, undefined);
  assert.match(store.work.get('w3')!.log.join('\n'), /timed ask \(w2277\): withdrew worker \w{8}'s big-computer "here" on pc, as lap is idle: its next exclusive ticket there is refused until it asks timed_place again, which sends the leg to lap/);
  assert.deepEqual(agents.withdrawStaleTimedHere(), [], 'once');

  // Nothing timed waits for lap any more: the pair leg may start there.
  b.info.timedVerdict = undefined;
  putRequests(store, [{ id: 'w2', title: 'Moving the camera drops FPS 120 to 90 on the big base: profile and fix', status: 'done', needs: 'game' }]);
  putRequests(store, [{ id: 'w3', title: 'JustPlay save p99: the slowest systems', status: 'done', needs: 'game' }]);
  const ok = await call(dispatcher().info, 'start_agent', { machine: 'lap', prompt: 'Run the leg', title: 'w5: pair leg', work_id: 'w5' });
  assert.doesNotMatch(ok.text, /kept for timed work/, ok.text);
});

test('w2217: a request left undecided past the bound is offered to the dispatcher again, once, then shows Stalled, not Working', async (t) => {
  const { store, o, dispatcher, chat, call, heard } = setup(t);
  await call(chat(BEN).info, 'request_work', { title: 'Pair run for w2090', brief: 'Two legs on computers that are not Macs.' });
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[work request] w1').length === 1);
  const at = (min: number) => {
    const when = Date.now() + min * 60_000;
    (o as unknown as { now: () => Date }).now = () => new Date(when);
  };
  // Inside the bound: nothing is offered again, and it is Working.
  at(5);
  assert.deepEqual(o.undecidedBound(), []);
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w1' })).text, /Working \(the dispatcher has it to decide/);
  // Past it (w2192 sat 3 h so): offered again, once, with the request in full, and its log says so.
  at(16);
  assert.deepEqual(o.undecidedBound(), ['w1']);
  assert.deepEqual(o.undecidedBound(), [], 'once');
  await until('the dispatcher hears it again', () => heard(dispatcher().info.id, '[work request] w1').length === 2);
  assert.match(heard(dispatcher().info.id, '[work request] w1')[1].text, /Offered again by FF Factory \(w2217\): it has sat undecided for 16 min/);
  assert.match(store.work.get('w1')!.log.join('\n'), /undecided for 16 min: offered to the dispatcher again \(w2217\)/);
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w1' })).text, /Working \(the dispatcher has it to decide/, 'the dispatcher has a few minutes to decide it');
  // Still undecided after that: Stalled, with how long.
  at(22);
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w1' })).text, /Stalled \(undecided for 22 min: its \[work request\] went to the dispatcher when it was filed and again 6 min ago/);
  assert.equal(store.work.get('w1')!.status, 'new', 'the live state only; nothing is changed');
  // Decided: the mark goes, so a reopen counts afresh.
  const ok = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'reject', note: 'not needed' });
  assert.equal(ok.isError, false, ok.text);
  o.undecidedBound();
  assert.equal(store.work.get('w1')!.undecided, undefined);
});

test("w3161: a person's hold note outside their turn keeps the dispatcher's question open: Waiting on input on them, never offered again as undecided", async (t) => {
  const { store, sessions, o, dispatcher, chat, call, heard } = setup(t);
  const ben = chat(BEN);
  await call(ben.info, 'request_work', { title: 'Ben checks the dragon sigil on a real Steam Deck', brief: 'Ben plays it on his Deck.' });
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[work request] w1').length === 1);
  const asked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'w1 waits for Ben, who said he cannot check on the Deck yet.', questions: [{ question: 'Is the orange sigil easy to read on your Deck?', options: [{ label: 'Yes, it reads well', recommended: true }, { label: 'No, make it bolder' }] }] });
  assert.equal(asked.isError, false, asked.text);
  // w3155: his orchestrator writes the hold, on the [needs you] line, not in a turn of Ben's.
  sessions.send(ben.info.id, '[needs you] w1: the dispatcher asks Ben', 'system');
  await until('the turn ends', () => ben.info.status === 'idle');
  const hold = await call(ben.info, 'update_work', { id: 'w1', note: "Hold w1 until Ben says he's ready. Don't ask again before then." });
  assert.equal(hold.isError, false, hold.text);
  assert.match(hold.text, /the question stays open: a note outside Ben's own turn answers nothing/);
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'question');
  assert.ok(w.question, 'the question stands');
  const at = (min: number) => {
    const when = Date.now() + min * 60_000;
    (o as unknown as { now: () => Date }).now = () => new Date(when);
  };
  for (const min of [16, 22, 75]) {
    at(min);
    assert.deepEqual(o.undecidedBound(), [], `not offered again at ${min} min`);
    const live = (await call(dispatcher().info, 'list_work', { id: 'w1' })).text;
    assert.match(live, /Waiting on input/, live);
    assert.match(live, /Ben/, live);
    assert.doesNotMatch(live, /Stalled|undecided/, live);
  }
  assert.equal(heard(dispatcher().info.id, '[work request] w1').length, 1, 'the dispatcher heard it once');
  // Ben's own answer, in his turn, answers it: back to the dispatcher to decide.
  sessions.send(ben.info.id, "I'm ready", 'human', undefined, { requestedBy: BEN });
  await until('his turn ends', () => ben.info.status === 'idle');
  const answer = await call(ben.info, 'update_work', { id: 'w1', note: "I'm ready, send the card." });
  assert.equal(answer.isError, false, answer.text);
  assert.equal(store.work.get('w1')!.status, 'new');
  assert.equal(store.work.get('w1')!.question, undefined);
});

test('w2239: a pair run closes on its newest attempt\'s DONEs though a leg of an earlier attempt never said DONE (w2175: stopped waiting for LISTENING; w2224: an earlier host leg still alive)', async (t) => {
  const { store, o } = await setupOnMachine(t);
  const T1 = '2026-09-28T10:00:00.000Z';
  const later = (min: number) => new Date(Date.parse(T1) + min * 60_000).toISOString();
  const worker = (id: string, createdAt: string, status: SessionInfo['status'], lastResult?: string) =>
    store.putSession({ id, kind: 'worker', title: `leg ${id}`, status, permissionMode: 'bypassPermissions', createdAt, lastActivityAt: createdAt, turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: LOTH, ...(lastResult ? { lastResult } : {}) } as unknown as SessionInfo);
  const pairOf = (id: string, sessions: string[], legs: [string, string]) =>
    putRequests(store, [{ id, title: `Pair run for w1: MP-check on PR #2545`, status: 'active', sessionIds: sessions, pair: { legs: 2, for: 'w1', started: { at: T1, legs: [{ session: legs[0], sandbox: 'lothdesktop/slot4' }, { session: legs[1], sandbox: 'biscuit/slot1' }] } } }]);
  const done = (sid: string, id: string, min: number, text: string) =>
    o.workerTurnEnded({ ...store.sessions.get(sid)!, lastActivityAt: later(min) }, `${text}\nDONE: ${id}\nLearned: nothing new`);

  // w2175: the first attempt's client leg 1168453d stopped while waiting for the host's LISTENING, its last report still
  // open; the retry's legs 492fba05 (host) and 5bb89b8d (client) started at T1.
  worker('1168453d', T0, 'stopped', 'w2: still open: waiting for the host leg to say it\'s listening, then the client run and its reports');
  worker('492fba05', T1, 'idle');
  worker('5bb89b8d', T1, 'idle');
  pairOf('w2', ['1168453d', '492fba05', '5bb89b8d'], ['492fba05', '5bb89b8d']);
  done('5bb89b8d', 'w2', 1, 'The client side passed: no desync.');
  assert.equal(store.work.get('w2')!.status, 'active', 'the host leg 492fba05 of the newest attempt is still on it');
  done('492fba05', 'w2', 2, 'For w1: PASS, 422 samples compared, 0 diverged.');
  assert.equal(store.work.get('w2')!.status, 'done', 'the old leg 1168453d was replaced: it no longer holds the request open');

  // w2224: the earlier host leg 1a047a74 is still alive (idle, its last report open); the newest host 8c99712e gives the
  // verdict, then its client baa08a3b says DONE.
  worker('1a047a74', T0, 'idle', 'w3: still open: waiting for the client to join');
  worker('8c99712e', T1, 'idle');
  worker('baa08a3b', T1, 'idle');
  pairOf('w3', ['1a047a74', '8c99712e', 'baa08a3b'], ['8c99712e', 'baa08a3b']);
  done('8c99712e', 'w3', 1, 'For w1: PASS, 539 compared, 0 diverged.');
  assert.equal(store.work.get('w3')!.status, 'active', 'the newest attempt\'s client baa08a3b is still on it');
  done('baa08a3b', 'w3', 2, 'The client reports its part done.');
  assert.equal(store.work.get('w3')!.status, 'done');

  // Until the newest attempt's host leg said DONE, an earlier leg still counts: the verdict is not in yet.
  worker('aa000001', T0, 'stopped', 'w4: still open: waiting for the host leg to say it\'s listening');
  worker('bb000001', T1, 'idle');
  worker('cc000001', T1, 'idle');
  pairOf('w4', ['aa000001', 'bb000001', 'cc000001'], ['bb000001', 'cc000001']);
  done('cc000001', 'w4', 1, 'The client side passed.');
  assert.equal(store.work.get('w4')!.status, 'active');
  assert.match(store.work.get('w4')!.log.join('\n'), /still on it: aa000001, bb000001/);
});

test('w2304: w2276 as it happened: the w1894 player-yield stops the client leg on lothdesktop mid-run, so the pair is re-queued whole: both legs stopped, Queued (never Stalled), and lothdesktop is not avoided for good (w4468)', async (t) => {
  const env = await setupOnMachine(t);
  const { store, machines, o, agents } = env;
  const { id, p } = await livePairFor(env);
  const watch = new BlockerWatch({ store, orchestrators: o });
  assert.equal((await watch.tick()).has(id), false, 'every leg healthy: it runs on');
  // 09:24Z on 2026-10-26: lothsahn starts playing on lothdesktop, where the client leg runs.
  const play = machines.personPlayOf.bind(machines);
  machines.personPlayOf = (m, now) => (m === 'lothdesktop' ? { who: 'lothsahn', pids: [4242], since: '2026-10-26T09:24:00.000Z', graceMinutes: 10, editorsClosed: 0, playersAsked: 1, buildsLowered: 0 } : play(m, now));
  t.after(() => (machines.personPlayOf = play));
  assert.equal((await watch.tick()).get(id), 'requeued: a pair run that lost a leg mid-run');
  assert.equal(p.status, 'queued');
  assert.equal(p.pair!.started, undefined, 'its legs start again, fresh');
  assert.deepEqual(p.sessionIds, [], 'neither old leg carries over');
  // w4468: the play hold keeps lothdesktop out while lothsahn plays; a permanent avoid kept w4460 and w4207 off it for hours after.
  assert.equal(p.pair!.avoid, undefined);
  assert.equal(unfitWhy(p, 'lothdesktop', undefined), undefined);
  assert.equal(p.pair!.requeued?.count, 1);
  const log = p.log.join('\n');
  assert.match(log, /re-queued as a pair run \(w2304, 1 of 3; its 2 legs start fresh together\): lothsahn is playing Final Factory since 09:24Z on lothdesktop \(the w1894 player-yield\), where leg 2 \(client 0de45d46\) runs\. Old legs stopped: 39c87651 \(pc\/alpha\), 0de45d46 \(lothdesktop\/slot6\)$/m);
  assert.equal(agents.workLive().get(id)?.state, 'queued', `Queued for capacity, not Stalled: ${agents.workLive().get(id)?.why}`);
  const w = store.work.get('w2263')!;
  assert.deepEqual([w.status, w.blocked?.ref, w.blocked?.on], ['blocked', id, 'report'], 'its asker still waits on the same run');
  // The next look finds nothing more to do: the run is not under way any more.
  assert.equal((await watch.tick()).has(id), false);
});

test('w2304: a pair run is re-queued by itself at most PAIR_REQUEUE_MAX times; then its log says so once and it is left for a person', async (t) => {
  const env = await setupOnMachine(t);
  const { o } = env;
  const { p } = await livePairFor(env);
  p.pair = { ...p.pair!, requeued: { at: T0, why: 'an earlier break', count: 3 } };
  assert.equal(o.requeuePair(p, 'leg 2 is gone'), undefined);
  assert.equal(p.status, 'active');
  assert.ok(p.pair!.started, 'its legs are left as they are');
  assert.ok(p.pair!.requeued!.gaveUp);
  assert.equal(o.requeuePair(p, 'leg 2 is gone'), undefined);
  assert.equal(p.log.filter((l) => /not re-queued again \(w2304\)/.test(l)).length, 1, 'said once');
});

test('w2304: a leg of a pair run under way keeps its sandbox while the other leg works (not "it waits on" it), and once a leg reported it is released as before', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  const { p } = await livePairFor(env);
  const waitOn = (i: SessionInfo) => {
    (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
    return agents.waitOn(i);
  };
  const client = store.sessions.get('0de45d46')!;
  store.putSession({ ...store.sessions.get('39c87651')!, status: 'running' });
  assert.equal(waitOn(client), undefined, 'w2271 at 09:14Z: released as "it waits on w2271: its worker c4cd09fd works on it", then moved mid-run');
  p.done = { '39c87651': { at: new Date().toISOString(), report: 'For w2263: PASS' } };
  store.putWork(p);
  assert.match(waitOn(client) ?? '', /its worker 39c87651 works on it/, 'the run reported: a leg left waiting is released');
});

test('w2304: w2271 as it happened: the w2046 move never moves a live pair leg alone; its sandbox went to other work, so the whole pair is re-queued instead of a fresh leg starting elsewhere', async (t) => {
  const env = await setupOnMachine(t);
  const { store, machines, sessions } = env;
  const beast = await startTestMachine(machines, { id: 'beast', sandboxes: ['slot1'] });
  env.closers.push(() => beast.stop());
  putRequests(store, [{ id: 'w2271', by: LOTH, status: 'active' }]);
  const a = await startedFor(env, 'w2271');
  beast.repos.git(beast.repos.main, 'push', '-q', 'origin', 'master:refs/heads/w2271-pair-instrument');
  // Leg 2 (the client) is `a` on pc/alpha; leg 1 (the host) works on lothdesktop.
  store.putSession({ id: 'c4cd09fd', kind: 'worker', title: 'host leg', status: 'running', permissionMode: 'bypassPermissions', createdAt: T0, lastActivityAt: T0, turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: LOTH, machineId: 'lothdesktop', machineSandbox: 'slot5' } as SessionInfo);
  const w = store.work.get('w2271')!;
  w.sessionIds = ['c4cd09fd', a.id];
  w.pair = { legs: 2, started: { at: T0, legs: [{ session: 'c4cd09fd', sandbox: 'lothdesktop/slot5' }, { session: a.id, sandbox: 'pc/alpha' }] } };
  store.putWork(w);
  sessions.sessions.get(a.id)!.stop(true);
  await until('its process stopped', () => !sessions.sessions.get(a.id)?.live);
  a.info.placeReleased = { at: new Date().toISOString(), sandbox: 'alpha', branch: 'w2271-pair-instrument', why: 'it waits on w2271: its worker c4cd09fd works on it' };
  store.putSession(a.info);
  const full = sessions as unknown as { placeFull?: (s: { info: SessionInfo }) => string | undefined };
  const placeFull = full.placeFull!.bind(sessions);
  const hold = 'no sandbox on pc is free (its own, alpha, took other work after it was released: it waits on w2271: its worker c4cd09fd works on it); the next one to free there is its, ahead of new work';
  full.placeFull = (s) => (s.info.machineId === 'pc' ? hold : placeFull(s));
  t.after(() => (full.placeFull = placeFull));
  sessions.send(a.id, '[pair] host: GO, join now.');
  sessions.drain(Date.now() + MOVE_AFTER_MS + 1000);
  assert.ok(!sessions.queued().some((q) => q.id === a.id), 'its message is not delivered: the leg is retired');
  assert.equal(w.status, 'queued', 'the pair is Queued whole');
  assert.equal(w.pair!.started, undefined);
  assert.deepEqual(w.sessionIds, []);
  assert.ok(![...store.sessions.values()].some((s) => s.machineId === 'beast'), 'no lone leg started on beast');
  assert.equal(a.info.movedAway, undefined);
  assert.match(w.log.join('\n'), new RegExp(`re-queued as a pair run \\(w2304, 1 of 3; its 2 legs start fresh together\\): leg 2's sandbox on pc went to other work mid-run, and a leg moved alone cuts the run \\(w2046 move refused\\)\\. Old legs stopped: c4cd09fd \\(lothdesktop/slot5\\), ${a.id} \\(pc/alpha\\)$`, 'm'));
});

test('w2305: w2298 as it happened: the host leg, stopped with its check-in at the run\'s end, keeps its sandbox; its client is the same work, not "another worker", so nothing is released or re-queued', async (t) => {
  const wake = new Date(Date.now() + 14 * 60_000).toISOString();
  const env = await heldLegFor(t, 'w2262', 1, '7d3bf3b8', 'e33e6f40', { wakeAt: wake });
  const { store, agents, id, p, pass, watch } = env;
  const host = store.sessions.get('7d3bf3b8')!;
  // 12:50Z on 2026-10-26: "stopped 7d3bf3b8 (its check-in at 13:06 UTC is for work that is over: its request is with another
  // worker now (w2298: e33e6f40))", then the release of biscuit/slot1 and w2304's re-queue.
  assert.equal(agents.workOver(host), undefined, 'the bug: "its request is with another worker now (w2298: e33e6f40)"');
  assert.match(agents.pairHold(host) ?? '', new RegExp(`^it is leg 1 of pair run ${id} under way, with e33e6f40 in lothdesktop/slot3`));
  for (let i = 0; i < 3; i++) assert.deepEqual(pass().filter((x) => x.includes('7d3bf3b8')), [], 'no stop, no release');
  assert.equal(host.placeReleased, undefined);
  assert.equal((await watch.tick()).has(id), false, 'no re-queue');
  assert.equal(p.status, 'active');
  assert.ok(p.pair!.started);
  assert.ok(!p.log.some((l) => /re-queued as a pair run/.test(l)));
  // The run over (its client said DONE with the verdict): the host's check-in is for work that is over, as before.
  p.done = { e33e6f40: { at: new Date().toISOString(), report: 'For w2262: PASS, 0 mismatches' } };
  store.putWork(p);
  assert.match(agents.workOver(host) ?? '', /with another worker now/);
  await until('alpha released once the run is over', () => (pass(), !!store.sessions.get('7d3bf3b8')!.placeReleased));
});

test('w2305: w2276 as it happened: the client leg waiting for its own host\'s address keeps its sandbox (not "it waits on w2276: its worker 9a4452ce works on it"), so nothing is released or re-queued', async (t) => {
  const env = await heldLegFor(t, 'w2263', 2, 'e5dcf0d3', '9a4452ce');
  const { store, agents, id, p, pass, watch } = env;
  const client = store.sessions.get('e5dcf0d3')!;
  // 12:39Z on 2026-10-26: "stopped e5dcf0d3 (it waits on w2276: its worker 9a4452ce works on it in beast/slot1)", then the
  // release of lothdesktop/slot6 and, at 12:44Z, w2304's re-queue.
  assert.equal(agents.waitOn(client), undefined, 'the bug: "it waits on w2276: its worker 9a4452ce works on it"');
  for (let i = 0; i < 3; i++) assert.deepEqual(pass().filter((x) => x.includes('e5dcf0d3')), [], 'no stop, no release');
  assert.equal(client.placeReleased, undefined);
  assert.equal((await watch.tick()).has(id), false, 'no re-queue');
  assert.equal(p.status, 'active');
  // A DONE from a leg of an earlier attempt does not end this one (w2276 was a retry): still held.
  p.done = { '1a2b3c4d': { at: new Date().toISOString(), report: 'needs a new client machine' } };
  store.putWork(p);
  assert.ok(agents.pairHold(client), 'an earlier attempt\'s DONE is not this run\'s');
  assert.deepEqual(pass().filter((x) => x.includes('e5dcf0d3')), []);
  // This attempt's host reported: the client is released as before.
  p.done = { ...p.done, '9a4452ce': { at: new Date().toISOString(), report: 'For w2263: PASS' } };
  store.putWork(p);
  assert.equal(agents.pairHold(client), undefined);
  await until('alpha released once the run is over', () => (pass(), !!store.sessions.get('e5dcf0d3')!.placeReleased));
});

test('w2305: a re-queue stops its old legs at once, not at their turn\'s end (w2276\'s host 9a4452ce kept working after "Old legs stopped")', async (t) => {
  const env = await setupOnMachine(t);
  const { store, sessions, o } = env;
  putRequests(store, [{ id: 'w2276', by: LOTH, status: 'active' }]);
  const a = await startedFor(env, 'w2276');
  store.putSession({ id: '9a4452ce', kind: 'worker', title: 'host leg', status: 'running', permissionMode: 'bypassPermissions', createdAt: T0, lastActivityAt: T0, turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: LOTH, machineId: 'beast', machineSandbox: 'slot1' } as SessionInfo);
  const w = store.work.get('w2276')!;
  w.sessionIds = ['9a4452ce', a.id];
  w.pair = { legs: 2, started: { at: T0, legs: [{ session: '9a4452ce', sandbox: 'beast/slot1' }, { session: a.id, sandbox: 'pc/alpha' }] } };
  store.putWork(w);
  assert.ok(sessions.sessions.get(a.id)?.live, 'its leg on pc/alpha has a process');
  assert.match(o.requeuePair(w, 'leg 1 is gone') ?? '', /Old legs stopped/);
  await until('the old leg stopped', () => !sessions.sessions.get(a.id)?.live);
  assert.equal(w.status, 'queued');
});

test("w2357: w2335 and its timed leg w2338 as it happened: the parent Blocked on the leg's report, the leg reporting that it waits for the parent's commit; the parent resumes with that partial report", async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  // w1 stands for w2335 (the Leech fix), w2 for w2338 (its timed leg, already filed and running on another computer).
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', title: 'Timed leg for w1: Leech stack probe', status: 'active', needs: 'game', timedLeg: { for: 'w1', forSession: 'x', from: 'pc', small: ['biscuit'] } }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix the Leech slowness', title: 'w1: Leech', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  Object.assign(store.work.get('w2')!.timedLeg!, { forSession: id, ask: 'time master and the fix.' }); // w2900: the leg this worker filed for this ask, so asking again folds
  await until('its first turn', () => store.sessions.get(id)!.status === 'idle');
  // The parent hands its measurement to the leg (timed_place): Blocked on w2 reporting, by its own worker.
  const filed = o.fileTimedLeg(id, { what: 'Leech stack probe', brief: 'Time master and the fix.', from: 'pc', needs: ['biscuit'], why: 'pc is big' });
  assert.equal(filed.id, 'w2');
  assert.match(filed.text, /perhaps in another sandbox, a partial one too/);
  const gate = store.work.get('w1')!.blocked!;
  assert.deepEqual([store.work.get('w1')!.status, gate.kind, gate.ref, gate.on], ['blocked', 'request', 'w2', 'report']);
  const watch = new BlockerWatch({ store, orchestrators: o });
  assert.equal((await watch.tick()).get('w1'), undefined, 'the leg has not reported: still blocked');
  // The leg times the master side and reports, word for word as edc18110 did, that the other side waits for the parent's
  // commit. Before w2357 that was a progress report only: w1 stayed Blocked, w2's worker idle, and nothing woke either.
  putReport(store, 'w2', 'leg2338', "Master side on biscuit: 41.2 ms per frame (specs/w2/master.md).\n\nw2: still open: waiting for w1's worker 9524a4bc to send its fix commit on sandbox/slot3-w1, then the fix-side legs on biscuit");
  const did = await watch.tick();
  assert.match(did.get('w1') ?? '', /^clear: w2's worker reported/);
  assert.notEqual(store.work.get('w1')!.status, 'blocked');
  const note = agents.waker.pending(id)?.note ?? '';
  assert.match(note, /^w1 is unblocked: w2 reporting cleared \(w2's worker reported/);
  assert.match(note, /Timed leg w2's report: "Master side on biscuit: 41\.2 ms per frame .*w2: still open: waiting for w1's worker 9524a4bc to send its fix commit/s);
  assert.match(note, /put a line "For w2: <the branch and commit>" in your report: that resumes w2's worker/);
});

test("w2377: a timed leg's status-only turns leave its parent Blocked (w2338's \"queued for biscuit's bench ticket\" and \"understood\" woke w2335 four times); its For line clears it", async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', status: 'active', timedLeg: { for: 'w1', forSession: 'x', from: 'pc', small: ['biscuit'] } }]);
  const r = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'request', ref: 'w2', on: 'report', what: "w2's fix-side numbers" } });
  assert.equal(r.isError, false, r.text);
  const watch = new BlockerWatch({ store, orchestrators: o });
  const turns = [
    "Understood: I hold until biscuit's bench ticket is granted.",
    "Ticket still queued.\n\nw2: still open: fix-side legs at e947f566c4 on sandbox/slot3-w1 queued for biscuit's bench ticket",
  ];
  for (const [i, text] of turns.entries()) {
    putReport(store, 'w2', `k${i}`, text, 1000 * (i + 1));
    assert.equal((await watch.tick()).get('w1'), undefined, `turn ${i}: no result in it`);
    assert.equal(store.work.get('w1')!.status, 'blocked');
  }
  putReport(store, 'w2', 'k9', "Fix side timed.\n\nFor w1: master 41.2 ms, fix 30.1 ms on biscuit at e947f566c4 (specs/w2/ab.md).\n\nw2: still open: the second run", 5000);
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: w2's worker reported/);
  assert.notEqual(store.work.get('w1')!.status, 'blocked');
});

test('w2357: the blocker watch finds a wait cycle that no report clears (a gate on done, a worker that says it waits back) and resumes the side that can act, logging it', async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', status: 'active' }]);
  // A direct gate each way is refused (blockerProblem), so the cycle is a gate and a worker's words, as w2335's was.
  const b1 = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'request', ref: 'w2', what: "w2's fix" } });
  assert.equal(b1.isError, false, b1.text);
  const watch = new BlockerWatch({ store, orchestrators: o });
  assert.equal((await watch.tick()).get('w1'), undefined, 'no cycle yet');
  putReport(store, 'w2', 'k2', "Half done.\n\nw2: still open: waiting for w1's commit on its branch");
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(' '));
  let did: Map<string, string>;
  try {
    did = await watch.tick();
  } finally {
    console.warn = warn;
  }
  assert.match(did.get('w1') ?? '', /^cycle: a wait cycle \(w1 -> w2 -> w1\): w2's worker reported since w1 was blocked on it, and waits on w1 in turn, so w1 acts on that report/);
  assert.notEqual(store.work.get('w1')!.status, 'blocked');
  assert.ok(warned.some((l) => /blocker watch: CYCLE: w1 -> w2 -> w1: resuming w1/.test(l)), warned.join('\n'));
  assert.match(store.work.get('w1')!.log.join('\n'), /unblocked: .*a wait cycle \(w1 -> w2 -> w1\)/);
});

test("w2405 as it happened: a timed leg queued behind other requests' bench tickets, whose report will go \"For\" its parent, is no wait on the parent: no cycle, no resume", async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  // w1 stands for w2396 (the master batch fix), w2 for w2401 (its timed leg), w3 and w4 for w2383 and w2355, whose shared
  // bench tickets on lothdesktop the leg's exclusive one queues behind.
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', title: 'Timed leg for w1: held-blueprint frametime', status: 'active', needs: 'game', timedLeg: { for: 'w1', forSession: 'x', from: 'pc', small: ['biscuit'] } }, { id: 'w3', status: 'active' }, { id: 'w4', status: 'active' }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix the master batch', title: 'w1: batch', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  Object.assign(store.work.get('w2')!.timedLeg!, { forSession: id, ask: 'time 2b2b2cd7af and master.' }); // w2900: the leg this worker filed for this ask, so asking again folds
  await until('its first turn', () => store.sessions.get(id)!.status === 'idle');
  const filed = o.fileTimedLeg(id, { what: 'held-blueprint frametime', brief: 'Time 2b2b2cd7af and master.', from: 'pc', needs: ['biscuit'], why: 'pc is big' });
  assert.equal(filed.id, 'w2');
  const watch = new BlockerWatch({ store, orchestrators: o });
  // The leg's worker, word for word as b8061486 wrote at 13:21, 13:24 and 13:27 UTC.
  const lines = [
    'w2: still open: the four timed runs (waiting for lothdesktop\'s exclusive bench ticket), then the "For w1:" report',
    'w2: still open: four timed runs waiting for lothdesktop\'s exclusive bench ticket, then the "For w1:" report',
  ];
  for (const [i, line] of lines.entries()) {
    assert.equal(requestWaitOf(line, 'w2'), undefined, line);
    putReport(store, 'w2', `b${i}`, `Ticket t00001972 queued behind w3's and w4's shared tickets.\n\n${line}`, 1000 * (i + 1));
    assert.equal((await watch.tick()).get('w1'), undefined, `turn ${i}: no cycle, no clear`);
    assert.equal(store.work.get('w1')!.status, 'blocked');
    assert.equal(agents.waker.pending(id), undefined, `turn ${i}: w1's worker is not resumed`);
  }
  assert.doesNotMatch(store.work.get('w1')!.log.join('\n'), /wait cycle|unblocked/);
  // Its real report clears the parent's gate as before.
  putReport(store, 'w2', 'b9', 'Both sides timed.\n\nFor w1: A 3.49/5.38 ms, B 3.51/5.40 ms on lothdesktop.\n\nw2: still open: the last run', 5000);
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: w2's worker reported/);
});

// ---------------------------------------------------------------- w2358: room start_agent refuses is no room for queue

test('w2358 as it happened: a sandbox held for an older pair run, and the m5 for work timed by the dispatcher brief, are no room for decide_work queue', async (t) => {
  const { store, agents, o, dispatcher, call } = setup(t);
  const f: RoomNow = { game: ['beast', 'm5'], agent: ['beast', 'm5'], held: [], fit: { beast: { platform: 'win32' }, m5: { platform: 'darwin', noTimedRuns: "Ben's own Mac" } } };
  (agents as unknown as { roomNow: () => RoomNow }).roomNow = () => f;
  agents.roomFacts = () => f;
  // 08:45Z: beast/slot1, beast's last free sandbox, was held for w2360's pair run; start_agent refused w2362 there.
  const hold = "beast's last free sandbox is held for w2360 \"knock pair run\" (normal, Queued since 08:28 UTC), a pair run of 2 legs, which starts only when that many computers have room at once (w1945)";
  (agents as unknown as { pairHoldProblem: (m: string) => string | undefined }).pairHoldProblem = (m) => (m === 'beast' ? hold : undefined);
  store.putWork({ ...queuedItem('w2362', 'Right-size Unity job worker count (idle spin CPU)', 'normal'), status: 'new', queuedFor: undefined });
  const before = await call(dispatcher().info, 'decide_work', { id: 'w2362', action: 'queue', note: 'beast is held for the pair' });
  // The m5 still has room for it (untimed game work): refused, naming m5 alone, not beast.
  assert.equal(before.isError, true);
  assert.match(before.text, /queue is for capacity only, and m5 has room for w2362 now/);
  f.game = ['beast'];
  f.agent = ['beast'];
  const ok = await call(dispatcher().info, 'decide_work', { id: 'w2362', action: 'queue', note: 'beast is held for the pair' });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(store.work.get('w2362')!.status, 'queued');
  assert.ok(store.work.get('w2362')!.log.at(-1)!.includes(hold), String(store.work.get('w2362')!.log.at(-1)));
  // Nor is it flagged WRONG beside that held room.
  (o as unknown as { now: () => Date }).now = () => new Date(Date.now() + 3_600_000);
  assert.deepEqual(o.flagQueuedWithRoom(f), []);

  // Case 3: a request whose own text names no timing, timed by the brief start_agent got (a refused pin on the m5).
  f.game = ['m5'];
  f.agent = ['m5'];
  const w = { ...queuedItem('w2366', 'Startup cost fixes', 'normal'), status: 'new' as const, queuedFor: undefined };
  store.putWork(w);
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2366', action: 'queue', note: 'm5 takes no timed runs' })).isError, true, 'untimed, the m5 is room');
  store.putWork({ ...store.work.get('w2366')!, timedBrief: { at: T0, text: 'Benchmark the startup before and after on the Mac.' } });
  assert.equal(needsTimed(store.work.get('w2366')), 'darwin', 'the brief start_agent was refused for reads as a note');
  assert.equal(needsTimed({ ...store.work.get('w2366')!, notes: [{ at: '2026-10-27T09:00:00.000Z', by: 'lothsahn', text: 'Any OS.' }] }), 'any', 'a later note wins');
  const timed = await call(dispatcher().info, 'decide_work', { id: 'w2366', action: 'queue', note: 'm5 takes no timed runs' });
  assert.equal(timed.isError, false, timed.text);
  assert.match(store.work.get('w2366')!.log.at(-1)!, /m5 has room but cannot take it: m5 takes no timed runs/);
  // A timed leg (w1969) is timed work too, whatever its title says.
  assert.equal(unfitWhy({ ...queuedItem('w2365', 'w2351 leg', 'normal'), timedLeg: { for: 'w2351', forSession: 's', from: 'beast', small: ['lothlaptop'] } }, 'm5', f.fit), "m5 takes no timed runs (Ben's own Mac)");
});

test("w2371: a timed leg's past wait on its parent is no cycle once the parent's worker finished a turn after it: the parent stays Blocked on the leg", async (t) => {
  const { store, o, dispatcher, call } = await w2371Setup(t);
  // The parent's worker read that report and pushed its commit in a turn that ended after it, then blocked again.
  store.putSession({ id: 'p1', kind: 'worker', title: 'w1: Leech', status: 'idle', permissionMode: 'default', createdAt: T0, lastActivityAt: new Date().toISOString(), lastResultAt: new Date(Date.now() - 1000).toISOString(), turns: 5, costUsd: 1, pendingPermissions: [], lastResult: 'Pushed e947f566c4.\n\nw1: still open: blocked on w2 reporting' });
  store.putWork({ ...store.work.get('w1')!, sessionIds: ['p1'] });
  const b = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'request', ref: 'w2', on: 'report', what: 'w2 reporting' } });
  assert.equal(b.isError, false, b.text);
  const watch = new BlockerWatch({ store, orchestrators: o });
  for (let i = 0; i < 3; i++) assert.equal((await watch.tick()).get('w1'), undefined, `tick ${i}: no cycle`);
  assert.equal(store.work.get('w1')!.status, 'blocked');
  assert.doesNotMatch(store.work.get('w1')!.log.join('\n'), /wait cycle/);
});

test('w2371: a timed leg whose worker has a message waiting for a sandbox waits for capacity, not on its parent: no cycle', async (t) => {
  const { store, o, dispatcher, call } = await w2371Setup(t);
  store.putSession({ ...store.sessions.get('k2')!, queuedSend: 'no sandbox on biscuit is free' });
  const b = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'request', ref: 'w2', on: 'report', what: 'w2 reporting' } });
  assert.equal(b.isError, false, b.text);
  const watch = new BlockerWatch({ store, orchestrators: o });
  assert.equal((await watch.tick()).get('w1'), undefined);
  assert.equal(store.work.get('w1')!.status, 'blocked');
  // Control: the same leg with no message waiting and a parent that has not run since its report is a cycle (w2357).
  store.putSession({ ...store.sessions.get('k2')!, queuedSend: undefined });
  assert.match((await watch.tick()).get('w1') ?? '', /^cycle: a wait cycle \(w1 -> w2 -> w1\): w1 filed the timed leg in it/);
});

test('w2358: the holds read the computers and the room once per pass, not once per queued request and computer', (t) => {
  // After #720 went live on 2026-10-27 workLive asked pairHoldProblem and timedHoldProblem for every queued request and every
  // computer with room, each reading places() and roomFacts() afresh: the event loop blocked 46.8 s at 10:02:11Z.
  const { store, agents, o } = setup(t);
  const ids = ['beast', 'biscuit', 'm3', 'lothlaptop', 'lothdesktop'];
  const f: RoomNow = { game: ids, agent: ids, held: [], fit: Object.fromEntries(ids.map((id) => [id, { platform: 'win32' }])) };
  (agents as unknown as { roomNow: () => string[] }).roomNow = () => ids;
  let places = 0;
  let facts = 0;
  (agents as unknown as { places: () => unknown[] }).places = () => (places++, ids.map((id) => ({ id, freeSandboxes: 1 })));
  agents.roomFacts = () => (facts++, f);
  for (let i = 0; i < 20; i++) store.putWork(queuedItem(`w${3000 + i}`, `queued game work ${i}`, 'normal'));
  agents.workLive();
  assert.ok(places <= 2 && facts <= 2, `places() ${places}, roomFacts() ${facts} for 20 queued requests on 5 computers`);
  // Nor the ping's and the WRONG flag's reads, in the same run of code.
  o.flagQueuedWithRoom(f);
  assert.ok(places <= 2 && facts <= 3, `places() ${places}, roomFacts() ${facts} after the WRONG flag`);
});

test('w2358: one workLive pass computes the computers once, for the room, the room facts and the holds alike', (t) => {
  // After #722 the portal still spent 10-21 s a minute in places() (stall profile, 2026-10-27 11:04-11:11Z) against 4.4-9.8 s
  // before #720: workLive read places() five times a pass (roomExtras > roomFacts > roomNow, roomNow, the holds' memo).
  const { store, agents } = setup(t);
  let n = 0;
  (agents as unknown as { placesNow: () => unknown[] }).placesNow = () => (n++, []);
  for (let i = 0; i < 5; i++) store.putWork(queuedItem(`w${3100 + i}`, `queued game work ${i}`, 'normal'));
  agents.workLive();
  assert.equal(n, 1, `placesNow ran ${n} times in one workLive`);
  // Outside a pass each read is fresh again (start_agent's checks).
  agents.places();
  agents.places();
  assert.equal(n, 3);
});

test('w2358: a timed-leg pass reads the computers once, and afresh only after a leg changed', (t) => {
  // On 2026-10-27 11:48-11:56Z (stall profile) timedLegBound took 6.1-10.4 s of a minute, nearly all in places(): every queued
  // timed leg's step and every move read it afresh.
  const { store, agents, o } = setup(t);
  let n = 0;
  (agents as unknown as { placesNow: () => unknown[] }).placesNow = () => (n++, []);
  const at = new Date().toISOString();
  putRequests(store, Array.from({ length: 6 }, (_, i) => ({ id: `w${3200 + i}`, title: `Timed leg for w9: belt ${i}`, status: 'queued' as const, needs: 'game' as const, queuedFor: { at, needs: ['pc'] }, timedLeg: { for: 'w9', forSession: 'nobody', from: 'beast', small: ['pc'] } })));
  const first = o.timedLegBound();
  const firstReads = n;
  // Each leg the first pass re-queued is a change: the next reads afresh, so at most one read per change and one more.
  assert.ok(firstReads <= first.length + 1, `places() ${firstReads} for ${first.length} changes`);
  n = 0;
  assert.deepEqual(o.timedLegBound(), [], 'unchanged: nothing to do');
  assert.equal(n, 1, `places() ran ${n} times in a pass over 6 unchanged timed legs`);
});

// w2417: w2402 published three zips and w2403 one; each waiting worker got a report cut before the ids (reportClip, the
// 2000-character leg quote) and had to ask a person for them.
test("w2417: a timed leg's report longer than every cut, with files published: the waiting worker's resume lists every attachment id, and read_work of the leg shows them", async (t) => {
  const { dir, store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  const files = new AttachmentStore(path.join(dir, 'att'));
  agents.attachments = files;
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', title: 'Timed leg for w1: startup A/B', status: 'active', needs: 'game', timedLeg: { for: 'w1', forSession: 'x', from: 'pc', small: ['biscuit'] } }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Speed up startup', title: 'w1: startup', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  Object.assign(store.work.get('w2')!.timedLeg!, { forSession: id, ask: 'time a and b.' }); // w2900: the leg this worker filed for this ask, so asking again folds
  await until('its first turn', () => store.sessions.get(id)!.status === 'idle');
  o.fileTimedLeg(id, { what: 'startup A/B', brief: 'Time A and B.', from: 'pc', needs: ['biscuit'], why: 'pc is big' });
  assert.equal(store.work.get('w1')!.blocked?.ref, 'w2');
  // The leg's worker publishes three zips (as w2402 did) and one other worker an unrelated file.
  const ids: string[] = [];
  for (const name of ['A-runs.zip', 'B-runs.zip', 'profile.zip']) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `bytes of ${name}`);
    ids.push((await files.addFile(f, { source: 'worker "w2: leg" (leg2402 on biscuit)', session: 'leg2402' })).id);
  }
  const other = path.join(dir, 'other.zip');
  fs.writeFileSync(other, 'not the leg');
  const stranger = (await files.addFile(other, { source: 'worker "w9" (someone)', session: 'someone' })).id;
  // A report far longer than every cut, its ids in the middle (where reportClip drops them) and done with a For line.
  const middle = `Zips: ${ids.join(', ')}.`;
  putReport(store, 'w2', 'leg2402', `${'A: 7.975 s, B: 7.762 s. '.repeat(120)}${middle}${' More detail.'.repeat(300)}\n\nFor w1: done, numbers above.`);
  const watch = new BlockerWatch({ store, orchestrators: o });
  const did = await watch.tick();
  assert.match(did.get('w1') ?? '', /^clear: w2's worker reported/);
  const note = agents.waker.pending(id)?.note ?? '';
  assert.match(note, /Timed leg w2's report: "/);
  assert.match(note, /Published files of w2's workers \(publish_attachment; hand one on with attachments: \[id\], or get your own copy with fetch_attachment\): A-runs\.zip \(/);
  for (const a of ids) assert.ok(note.includes(a), `${a} reaches the waiting worker`);
  assert.ok(!note.includes(stranger), "another worker's file is not listed");
  assert.ok(note.indexOf(ids[2]) > note.indexOf('Timed leg w2\'s report: "') + 2000, 'the files come after the cut report, outside it');
  // The waiting worker reads the leg it waited on, gate cleared, with no ledger-read grant: the files lead the entry.
  const read = agents.readWorkFor(id, { id: 'w2' });
  for (const a of ids) assert.ok(read.includes(a), `read_work w2 lists ${a}`);
  // The ledger's report entry of the leg carries the ids on a line of their own, once while they stay the same.
  o.workerTurnEnded(store.sessions.get('leg2402')!, 'Numbers above.');
  o.workerTurnEnded(store.sessions.get('leg2402')!, 'Numbers above, again.');
  const lines = store.work.get('w2')!.log.filter((l) => l.includes('files its workers published'));
  assert.equal(lines.length, 1, lines.join(' | '));
  assert.ok(lines[0].endsWith(`files its workers published (publish_attachment): ${ids.join(', ')}`), lines[0]);
});

// w3105: w3094's ~7 KB DONE report (a run table and eight JSON lines) reached w2895's waiting worker as "5795 chars left
// out": lastResult keeps 1200 characters (reportClip) and the resume quoted that. The ledger had only its TL;DR.
test("w3105: a timed leg's 7 KB report, over every cut, reaches the waiting worker's resume whole, and read_work of the leg shows it whole; an ordinary report keeps the cut", async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', title: 'Timed leg for w1: M1.8 per-tick budget', status: 'active', needs: 'game', timedLeg: { for: 'w1', forSession: 'x', from: 'pc', small: ['biscuit'] } }, { id: 'w3', status: 'active' }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Time the camps', title: 'w1: camps', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  Object.assign(store.work.get('w2')!.timedLeg!, { forSession: id, ask: 'time 4000 and 20000 camps.' });
  await until('its first turn', () => store.sessions.get(id)!.status === 'idle');
  o.fileTimedLeg(id, { what: 'M1.8 per-tick budget', brief: 'Time 4000 and 20000 camps.', from: 'pc', needs: ['biscuit'], why: 'pc is big' });
  assert.equal(store.work.get('w1')!.blocked?.ref, 'w2');
  // The leg's report as w3094's was: a TL;DR, the For line, a run table and eight whole JSON lines, then DONE.
  const rows = Array.from({ length: 100 }, (_, i) => `| run ${i + 1} | ${i % 2 ? 20000 : 4000} camps | ${(100 + i * 1.7).toFixed(1)} µs/proj | final_hash 0x${(0xabc000 + i).toString(16)} |`);
  const json = Array.from({ length: 8 }, (_, i) => JSON.stringify({ cmd: 'phases', camps: i < 4 ? 4000 : 20000, threads: 1, run: i, ns_per_tick: 1_234_567 + i, final_hash: `0x${(0xdead00 + i).toString(16)}` }));
  const full = `**TL;DR:** the reduced timing plan is finished on pc; final_hash agreed on all runs.\n\nFor w1:\n\n| run | camps | time | hash |\n|---|---|---|---|\n${rows.join('\n')}\n\n${json.join('\n')}\n\nLogs: swept when this request closes.\n\nDONE: w2`;
  assert.ok(full.length > 7000 && reportClip(full).includes('chars left out'), `the report (${full.length} chars) is over the cut`);
  putReport(store, 'w2', 'leg3094', reportClip(full)); // what the session keeps of it, as sessions.ts stores lastResult
  o.workerTurnEnded(store.sessions.get('leg3094')!, full); // the turn's end, with the whole text
  assert.equal(store.work.get('w2')!.handoff?.text, full.trim(), 'the ledger keeps the hand-off report whole');
  const watch = new BlockerWatch({ store, orchestrators: o });
  await watch.tick();
  const note = agents.waker.pending(id)?.note ?? '';
  assert.match(note, /Timed leg w2's report: "/, note.slice(0, 300));
  assert.ok(!note.includes('chars left out'), 'no cut copy in the resume');
  for (const line of [...json, rows[0], rows.at(-1)!, 'For w1:']) assert.ok(note.includes(line), `the resume holds ${line.slice(0, 60)}`);
  // The waiting worker can read it again, whole, from the leg's entry.
  const read = agents.readWorkFor(id, { id: 'w2' });
  assert.match(read, /Last report in full \(worker leg3094/);
  for (const line of json) assert.ok(read.includes(line), `read_work w2 holds ${line.slice(0, 60)}`);
  // An ordinary worker's long report, nobody waiting on it and no For line, keeps only the session's cut and no copy.
  const plain = `Did some work. ${'More detail. '.repeat(600)}\n\nw3: still open: more to do`;
  putReport(store, 'w3', 'plain1', reportClip(plain));
  o.workerTurnEnded(store.sessions.get('plain1')!, plain);
  assert.equal(store.work.get('w3')!.handoff, undefined, 'an ordinary report is not kept whole');
});

test('w2422: a stopped worker whose report says it is blocked on another request, with no blocked_on recorded (the portal was unreachable), is gated on it by the ledger, and resumed once when that request closes as done', async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  const clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, checkInPending: (id) => agents.waker.pending(id) !== undefined });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: 'w1: fix', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  // w2335 on 2026-10-27: its blocked_on failed while the portal restarted, and the turn ended on this line.
  Object.assign(info, { status: 'stopped', lastResult: 'Pushed the fix.\n\nw1: still open: blocked on w2 reporting (the ledger may not show the block because the portal was unreachable)', lastResultAt: new Date(clock - 60_000).toISOString() });
  const w = store.work.get('w1')!;
  assert.equal(w.blocked, undefined, 'no gate: the blocked_on was lost');
  assert.match((await watch.tick()).get('w1') ?? '', /^recorded: the wait on w2 its worker \w+'s report names \(w2422\)/);
  const g = store.work.get('w1');
  assert.deepEqual([w.status, g!.blocked?.kind, g!.blocked?.ref, g!.blocked?.on, g!.blocked?.by], ['blocked', 'request', 'w2', 'report', `worker ${id}`]);
  assert.match(w.log.at(-1)!, /the ledger recorded the wait its worker \w+'s report names, which no blocked_on recorded \(w2422/);
  // w2 still open: it stays Blocked (not Stalled), and nobody is resumed.
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(agents.waker.pending(id), undefined);
  // w2 closes as done: the worker is resumed within a minute, as if its own blocked_on had been recorded.
  store.work.get('w2')!.status = 'done';
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: w2 closed as done/);
  assert.equal(w.status, 'active');
  const wake = agents.waker.pending(id)!;
  assert.ok(wake && Date.parse(wake.at) - Date.now() <= 61_000, 'resumed within a minute');
  assert.ok(w.log.at(-1)!.includes(`unblocked (its worker ${id} resumes within a minute)`), w.log.at(-1)!);
  // The same report is never recorded again, even once the resume has fired and the worker shows stopped on it still.
  agents.waker.cancel(id);
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(w.status, 'active');
  // A worker mid-turn, or one whose report is too old, is left be.
  Object.assign(info, { lastResult: 'w1: still open: blocked on w2 again', lastResultAt: new Date(clock - REPORTED_WAIT_MS - 60_000).toISOString() });
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(w.blocked, undefined);
});

test('w2457: a stopped worker whose report says it waits on an FF Factory change (w2434: "blocked on FF Factory letting lothdesktop grant …") is gated on the next portal deploy and resumed when it lands; a request waiting on it meanwhile is flagged once', async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2', status: 'done' }, { id: 'w3', status: 'active' }]);
  let sha = 'aaa1111';
  (o as unknown as { d: { deploySha: () => string } }).d.deploySha = () => sha;
  let clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, portalSha: () => sha, checkInPending: (id) => agents.waker.pending(id) !== undefined });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Time it', title: 'w1: A/B', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const w = store.work.get('w1')!;
  // w3 (w2446) waits on w1's report, as blocked_on reports recorded it, while w1's worker sat idle.
  Object.assign(store.work.get('w3')!, { status: 'blocked', blocked: { kind: 'request', ref: 'w1', on: 'report', what: "w1's worker reporting", at: new Date(clock).toISOString(), by: 'worker zz' } });
  // w2434 at 03:44 UTC: the line names no open request (w2, closed, is quoted), only FF Factory.
  Object.assign(info, { status: 'stopped', lastActivityAt: new Date(clock - 60_000).toISOString(), lastResult: 'w1: still open: blocked on FF Factory letting lothdesktop grant the exclusive ticket to timed runs (the w2 gate refused two), or lothsahn naming another timing machine', lastResultAt: new Date(clock - 60_000).toISOString() });
  assert.match((await watch.tick()).get('w1') ?? '', /^recorded: the wait on a portal deploy its worker \w+'s report names \(w2457\)/);
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref, w.blocked?.sha, w.blocked?.by], ['blocked', 'deploy', undefined, 'aaa1111', `worker ${id}`]);
  assert.equal(store.work.get('w3')!.log.some((l) => /flagged/.test(l)), false, 'w1 waits on something now: no dead wait');
  // Hours pass with no deploy: it stays Blocked, nobody is resumed.
  clock += 3 * 3600_000;
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(agents.waker.pending(id), undefined);
  // The fix deploys (the portal runs another commit): the worker is resumed within a minute, with no person's nudge.
  sha = 'bbb2222';
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: the portal runs bbb2222 now \(aaa1111 when it was blocked\)/);
  assert.equal(w.status, 'active');
  const wake = agents.waker.pending(id)!;
  assert.ok(wake && Date.parse(wake.at) - Date.now() <= 61_000, 'resumed within a minute');
  // The same report is not recorded again.
  agents.waker.cancel(id);
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(w.blocked, undefined);
  // Nor the report its worker wrote after a blocked_on, before that wait cleared (w2457 live: its own "blocked on a portal
  // deploy" line, read while its resume was still being placed, became a wait on the next deploy).
  Object.assign(info, { lastResult: 'w1: still open: blocked on a portal deploy', lastResultAt: new Date((w.gateEndedAt ?? 0) - 5_000).toISOString() });
  assert.equal((await watch.tick()).has('w1'), false, 'a report from before the deploy that woke it');
  assert.equal(w.blocked, undefined);
  // Before this change the line recorded nothing: w1 idle with no wait, w3 Blocked on its report. That dead wait is flagged
  // once, 30 minutes on, in w3's log.
  Object.assign(info, { lastActivityAt: new Date(clock - 31 * 60_000).toISOString() });
  assert.match((await watch.tick()).get('w3') ?? '', /^flagged: w1, which it waits on, has nothing to wake it: its worker \w+ stopped 31 min ago/);
  assert.match(store.work.get('w3')!.log.at(-1)!, /flagged \(w2457\): w1, which it waits on, has nothing to wake it/);
  assert.equal((await watch.tick()).has('w3'), false, 'once');
  // Not a wait on CI or a pull request in the ff-factory repo, nor a line about FF Factory that waits on nothing.
  assert.equal(portalWaitIn('w1: still open: blocked on CI on Final-Factory/ff-factory#743'), false);
  assert.equal(portalWaitIn('w1: still open: waiting for CI on the FF Factory PR'), false);
  assert.equal(portalWaitIn('w1: still open: the FF Factory fix is merged; next the timing run'), false);
  assert.equal(portalWaitIn('w1: still open: waiting for the portal deploy, then the rerun'), true);
  assert.equal(portalWaitIn('w1: still open: waiting on ff-factory #742 to deploy'), true);
});

test("w2495: a report that waits on a person (w2443: \"waiting on lothsahn to click Pause in FF Factory's tray\") is the person's wait, never a deploy's; the person's answer resumes its worker through a gate the ledger read from its report, and keeps a real gate", async (t) => {
  const { store, sessions, agents, o, dispatcher, chat, call, heard } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  let sha = 'aaa1111';
  (o as unknown as { d: { deploySha: () => string } }).d.deploySha = () => sha;
  const clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, portalSha: () => sha, checkInPending: (id) => agents.waker.pending(id) !== undefined });
  const loth = chat(LOTH).info;
  chat(LOTH).lastFrom = 'human';
  await call(loth, 'request_work', { title: 'Machine pause', brief: 'Pausing a machine stops every run on it.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Test it live', title: 'w1: Machine pause', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const w = store.work.get('w1')!;
  // w2443's worker 4812780c at 00:50 UTC on 2026-10-29, word for word.
  const line = "w1: still open: waiting on lothsahn to click Pause in FF Factory's tray on LothLaptop for the live test";
  sessions.events.emit('turnEnd', sessions.get(id), `Ready for the live test.\n\n${line}`);
  await until('Lothsahn hears it', () => heard(loth.id, '[needs you]').length === 1);
  Object.assign(info, { status: 'stopped', lastActivityAt: new Date(clock - 60_000).toISOString(), lastResult: `Ready for the live test.\n\n${line}`, lastResultAt: new Date(clock - 60_000).toISOString() });
  // 1. The person's wait wins: no deploy gate (it was "blocked on a portal deploy (FF Factory change)").
  assert.equal((await watch.tick()).has('w1'), false);
  assert.deepEqual([w.status, w.blocked], ['active', undefined]);
  assert.equal(portalWaitIn(line, ['lothsahn']), false);
  assert.equal(portalWaitIn(line), false, 'a "<who> to <do>" before the product name, with no people known');
  assert.equal(portalWaitIn('w1: still open: waiting on a person to restart the FF Factory tray'), false);
  // A real wait on a deploy still is one.
  assert.equal(portalWaitIn('w1: still open: blocked on the portal deploy of PR #752', ['lothsahn']), true);
  assert.equal(portalWaitIn('w1: still open: waiting for the portal fix to deploy', ['lothsahn']), true);

  // 2. The gate the ledger read from this report before the fix (as it stood on w2443), beside a real gate the dispatcher set.
  const key = `${id}@${clock - 60_000}`;
  const inferred = { kind: 'deploy' as const, what: 'a portal deploy (FF Factory change)', at: new Date(clock - 60_000).toISOString(), by: `worker ${id}`, sha, reported: key };
  const real = { kind: 'request' as const, ref: 'w2', what: 'w2 finishing', at: new Date(clock).toISOString(), by: 'dispatcher' };
  putRequests(store, [{ id: 'w2', status: 'active' }]);
  Object.assign(w, { status: 'blocked', blocked: inferred, alsoBlocked: [real], waitRecorded: key });
  await until('Lothsahn’s turn ends', () => chat(LOTH).info.status === 'idle');
  chat(LOTH).lastFrom = 'human';
  const r = await call(loth, 'update_work', { id: 'w1', note: 'Paused. Go ahead.' });
  assert.match(r.text, new RegExp(`answers the \\[needs you\\] question: sent to its worker ${id}, which resumes with it .*; the wait on a portal deploy the ledger read from that worker's report is cleared by the answer \\(w2495\\), and it stays blocked on w2`));
  assert.deepEqual([w.status, w.blocked?.ref, w.alsoBlocked], ['blocked', 'w2', undefined], 'the real gate stays (w754)');
  const pending = agents.waker.pending(id)!;
  assert.match(pending.note, /^\[answer\] Lothsahn answered on w1 "Machine pause", in their own words: Paused\. Go ahead\./);
  // Its resume is delivered though the request is Blocked on w2 ("kept for when that clears" held it on w2443); another
  // resume still waits for the gate.
  assert.equal(o.staleResume('w1', id, pending.note), undefined);
  assert.match(o.staleResume('w1', id, 'w1: CI finished') ?? '', /blocked again on w2 finishing; the resume is kept/);

  // 3. With only the inferred gate, the answer leaves it Working.
  Object.assign(w, { status: 'blocked', blocked: { ...inferred }, alsoBlocked: undefined, needsYou: { ...w.needsYou!, answered: undefined } });
  agents.waker.cancel(id);
  await until('Lothsahn’s turn ends', () => chat(LOTH).info.status === 'idle');
  chat(LOTH).lastFrom = 'human';
  await call(loth, 'update_work', { id: 'w1', note: 'Unpaused now.' });
  assert.deepEqual([w.status, w.blocked], ['active', undefined]);
  assert.ok(agents.waker.pending(id));
});

test("w2476: a stopped worker whose report waits on another worker of the same request (w2448: \"waiting for worker 17cae99a's LothLaptop leg\") is Blocked on it, not Stalled, and resumed with that worker's report when it says DONE for its part", async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', title: 'Wittlebase uncapped judder', status: 'active' }]);
  // B stands for b9cd085e (w2448's BEAST worker, a live session so it can be resumed); 17cae99a is its LothLaptop worker.
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix the judder', title: 'w1: judder', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const B = /Started agent (\w+)/.exec(started.text)![1];
  await until('its first turn', () => store.sessions.get(B)!.status === 'idle');
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const worker = (id: string, machineId: string, report: string, ms: number) =>
    store.putSession({ ...store.sessions.get(id), id, kind: 'worker', title: 'w1: judder', status: 'stopped', permissionMode: 'default', createdAt: T0, lastActivityAt: at(ms), lastResultAt: at(ms), machineId, turns: 2, costUsd: 1, pendingPermissions: [], lastResult: report });
  worker(B, 'beast', '', -120_000);
  worker('17cae99a', 'lothlaptop', '', -120_000);
  Object.assign(store.sessions.get('17cae99a')!, { status: 'running' });
  store.putWork({ ...store.work.get('w1')!, sessionIds: [B, '17cae99a'] });
  const watch = new BlockerWatch({ store, orchestrators: o });
  // 10:22: b9cd085e's report, as w2448's log has it.
  worker(B, 'beast', "The BEAST side is done.\n\nw1: still open: waiting for worker 17cae99a's LothLaptop leg (G-SYNC check, uncapped judder before/after); PR #2756 (adaptive vSync) is held until the laptop shows smooth uncapped movement", -60_000);
  assert.match((await watch.tick()).get('w1') ?? '', /^recorded: the wait on worker 17cae99a its worker \w+'s report names \(w2476\)/);
  const w = store.work.get('w1')!;
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref, w.blocked?.by], ['blocked', 'worker', '17cae99a', `worker ${B}`]);
  assert.equal(w.stalled, undefined, 'Blocked on that worker, not Stalled');
  // 17cae99a still on its leg: it stays Blocked, nobody is resumed.
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(agents.waker.pending(B), undefined);
  // 10:43: 17cae99a says DONE for its part ("still on it: b9cd085e"): b9cd085e is resumed, with 17cae99a's report.
  const done = 'LothLaptop: uncapped movement is smooth with G-SYNC on (before: 41 ms spikes; after: none).\n\nDONE: w1\nLearned: nothing new';
  worker('17cae99a', 'lothlaptop', done, 0);
  o.workerTurnEnded(store.sessions.get('17cae99a')!, done);
  assert.match(w.log.join('\n'), /worker 17cae99a said DONE for its part; still on it: \w+$/m);
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: worker 17cae99a said DONE for its part/);
  assert.equal(store.work.get('w1')!.status, 'active', store.work.get('w1')!.log.slice(-3).join(' | '));
  const wake = agents.waker.pending(B);
  assert.ok(wake, 'b9cd085e is resumed');
  assert.match(wake!.note, /Worker 17cae99a's report: "LothLaptop: uncapped movement is smooth/);
  // A final report with no still-open line clears it as well; a still-open one does not.
  w.status = 'active';
  agents.waker.cancel(B);
  w.waitRecorded = undefined;
  w.gateEndedAt = undefined;
  w.done = undefined;
  worker('17cae99a', 'lothlaptop', 'Measuring.\n\nw1: still open: the after leg', -30_000);
  worker(B, 'beast', 'w1: still open: waiting on the LothLaptop leg', -20_000);
  assert.match((await watch.tick()).get('w1') ?? '', /^recorded: the wait on worker 17cae99a/);
  assert.equal((await watch.tick()).has('w1'), false, 'its earlier still-open report');
  worker('17cae99a', 'lothlaptop', 'The after leg is measured: no spikes.', 0);
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: worker 17cae99a stopped with its final report: The after leg is measured/);
  // The parser: by id or by the leg's machine, never the worker itself or one not on the request.
  const sibs = [{ id: '17cae99a', names: ['lothlaptop', 'lothlaptop/slot1'] }];
  assert.equal(siblingWaitOf('w1: still open: blocked on the lothlaptop leg reporting', sibs), '17cae99a');
  assert.equal(siblingWaitOf('w1: still open: waiting for the other leg', sibs), '17cae99a');
  assert.equal(siblingWaitOf('w1: still open: waiting for worker 0badf00d', sibs), undefined);
  assert.equal(siblingWaitOf('w1: still open: 17cae99a measured; next the PR', sibs), undefined);
});

test("w2426: a request Blocked on a pair run's report stays Blocked through its client leg's mid-run turns (w2425's client woke w2419 twice), and clears on the host leg's For line with DONE", async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, []);
  // w1 stands for w2419 (the PR's worker), w2 for w2425 (its pair run): leg 1 (the host) h, leg 2 (the client) c.
  const pair = { legs: 2, for: 'w1', started: { at: T0, legs: [{ session: 'h', sandbox: 'beast/slot4' }, { session: 'c', sandbox: 'lothdesktop/slot1' }] } };
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', title: 'Pair run for w1: determinism check on PR #2725', status: 'active', pair }]);
  const r = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'request', ref: 'w2', on: 'report', what: 'w2 host leg\'s "For w1:" PASS/FAIL on PR #2725' } });
  assert.equal(r.isError, false, r.text);
  const leg = (sid: string, report: string, ms: number, status: 'idle' | 'running' = 'idle') =>
    store.putSession({ id: sid, kind: 'worker', title: `w2: leg`, status, permissionMode: 'default', createdAt: T0, lastActivityAt: new Date(Date.now() + ms).toISOString(), turns: 2, costUsd: 1, pendingPermissions: [], lastResult: report });
  store.putWork({ ...store.work.get('w2')!, sessionIds: ['h', 'c'] });
  const watch = new BlockerWatch({ store, orchestrators: o });
  leg('h', '', 500, 'running');
  const client = [
    'My client player of 7dd91b2c6c is built (manifest confirms the commit). I\'ve told the host I\'m ready and am now waiting for its "listening" message with the port and seed. That message will resume me.',
    'Nothing has changed: my client player of 7dd91b2c6c is built and I\'m still waiting for the host leg (beast/slot4) to say it is listening. The "For w1:" result line will come from the host leg\'s report once the run is over.',
    'Client connected; the run is going.\n\nw2: still open: the run, then my DONE',
  ];
  for (const [i, text] of client.entries()) {
    leg('c', text, 1000 * (i + 1));
    assert.equal((await watch.tick()).get('w1'), undefined, `client turn ${i}: the host has not reported`);
    assert.equal(store.work.get('w1')!.status, 'blocked');
  }
  leg('h', 'Host built and listening.\n\nw2: still open: running the game for 5 minutes', 5000);
  assert.equal((await watch.tick()).get('w1'), undefined, 'the host mid-run');
  assert.equal(store.work.get('w1')!.status, 'blocked');
  leg('h', 'For w1: PASS on 7dd91b2c6c, 4800 heartbeats, desync hashes match, no errors.\n\nDONE: w2', 6000);
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: w2's worker reported/);
  assert.notEqual(store.work.get('w1')!.status, 'blocked');
});

test('w2433: a worker its machine stopped mid-turn holds its request Blocked on that machine (not Stalled), resumed once in its own sandbox when the machine is back; a long time offline is named to the dispatcher with its sandbox state', async (t) => {
  const { store, sessions, agents, o, dispatcher, call, heard } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', title: 'Mass Driver FPS part 2' }]);
  let online = false;
  (o as unknown as { d: { machineOnline: (id: string) => boolean | undefined } }).d.machineOnline = (id) => (id === 'pc' ? online : undefined);
  const watch = new BlockerWatch({ store, orchestrators: o, online: (id) => (id === 'pc' ? online : undefined) });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: 'w1: fix', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  // Its turnEnd signal too, not only the idle status (firstTurn): under load the signal came after the drop below, so the
  // portal took it for a turn ended after the drop and lifted the gate (dropCutOffGates, w3759).
  await firstTurn(info);
  // Mid-turn when biscuit's link dropped (w2320's 786d0973, 2026-10-26 23:38Z).
  const handle = sessions.get(id) as unknown as { liveFlag: boolean; seenLive: boolean };
  Object.assign(info, { status: 'running', turnOpenSince: new Date().toISOString(), lastActivityAt: new Date().toISOString() });
  handle.liveFlag = true;
  handle.seenLive = true;
  const machines = agents.machines as unknown as { detach(id: string): void; cutOff: Map<string, { sessions: string[] }> };
  machines.detach('pc');
  const w = store.work.get('w1')!;
  assert.equal(info.status, 'stopped');
  assert.match(info.statusDetail ?? '', /machine pc went offline/);
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref, w.blocked?.by, w.stalled], ['blocked', 'machine', 'pc', `worker ${id}`, undefined]);
  assert.match(w.log.at(-1)!, new RegExp(`blocked on pc coming back online: its worker ${id} was stopped mid-turn when pc went offline \\(w2433\\)`));
  assert.ok(!(machines.cutOff.get('pc')?.sessions ?? []).includes(id), "the gate's clearing resumes it, not the daemon's hello as well");
  // Offline: it stays Blocked, nobody is resumed, and before the notice's hour nothing is said.
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(agents.waker.pending(id), undefined);
  assert.equal(heard(dispatcher().info.id, '[ledger] pc has been offline').length, 0);
  // An hour on (ledger.offlineNoticeMinutes, default 60), the dispatcher hears which requests wait and what their sandboxes hold.
  w.blocked!.at = new Date(Date.now() - OFFLINE_NOTICE_MS - 60_000).toISOString();
  const alpha = store.machines.get('pc')!.sandboxes!.find((b) => b.id === 'alpha')!;
  alpha.git = { branch: 'w1-fps', upstream: 'origin/w1-fps', ahead: 2, behind: 0, dirty: 0, untracked: 0, at: '2026-10-26T23:37:00.000Z' };
  assert.match((await watch.tick()).get('w1') ?? '', /named to the dispatcher/);
  await until('the notice', () => heard(dispatcher().info.id, '[ledger] pc has been offline').length === 1);
  const notice = heard(dispatcher().info.id, '[ledger] pc has been offline')[0].text;
  assert.match(notice, /^\[ledger\] pc has been offline 61 min \(since \d\d:\d\d UTC\)\. These requests are Blocked on it coming back/);
  assert.ok(notice.includes(`- w1 "Mass Driver FPS part 2" (Lothsahn's): worker ${id} in pc/alpha: UNPUSHED WORK: w1-fps is 2 commits ahead of origin/w1-fps (as last seen at 23:37 UTC)`), notice);
  assert.match(notice, /start one again elsewhere from its pushed branch/);
  assert.match(w.log.at(-1)!, /the dispatcher was told pc has been offline 61 min/);
  // Once per gate.
  assert.equal((await watch.tick()).has('w1'), false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(dispatcher().info.id, '[ledger] pc has been offline').length, 1);
  // Back online: the gate clears and its own worker resumes within a minute, told why its turn stopped.
  online = true;
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: pc is online/);
  assert.equal(w.status, 'active');
  const wake = agents.waker.pending(id)!;
  assert.ok(wake && Date.parse(wake.at) - Date.now() <= 61_000, 'resumed within a minute');
  assert.match(wake.note, /^w1 is unblocked: pc coming back online cleared \(pc is online\)\. Your turn stopped when pc went offline at \d\d:\d\d UTC, and this is your resume in your own sandbox: your folder is as you left it\. Check git status/);
  // Only once.
  agents.waker.cancel(id);
  assert.equal((await watch.tick()).has('w1'), false);
  assert.equal(agents.waker.pending(id), undefined);
});

test('w2433: a worker whose process lived through a short drop is not resumed again, and its first turn end lifts the wait on its machine; one waiting on a person is left as it was', async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: 'w1: fix', work_id: 'w1' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  assert.deepEqual(o.workersCutOff('pc', [id]), [id]);
  const w = store.work.get('w1')!;
  assert.equal(w.blocked?.kind, 'machine');
  // Its process ran on (a network blip): the daemon's hello shows it running.
  info.status = 'running';
  const watch = new BlockerWatch({ store, orchestrators: o, online: (m) => (m === 'pc' ? true : undefined) });
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: pc is online/);
  assert.equal(w.status, 'active');
  assert.equal(agents.waker.pending(id), undefined, 'a running worker gets no resume message');
  // Its turn end before the watch looked lifts the gate itself.
  info.status = 'idle';
  assert.deepEqual(o.workersCutOff('pc', [id]), [id]);
  o.workerTurnEnded(info, 'Pushed it.\n\nw1: still open: CI next');
  assert.deepEqual([w.status, w.blocked], ['active', undefined]);
  assert.ok(w.log.some((l) => l.includes(`its worker ${id} ended a turn after its machine's drop, so the wait on its machine is over (w2433)`)));
  // A worker waiting on a person keeps that wait: no machine gate.
  info.waitingOn = { who: 'Lothsahn', what: 'pick the next cut', at: new Date().toISOString(), request: 'w1' };
  assert.deepEqual(o.workersCutOff('pc', [id]), []);
  assert.equal(w.status, 'active');
});

test("w2474: a worker whose process ran on through its machine's drop is not Blocked once its daemon says hello, and the watch never resumes it mid-turn; one that did not run on stays Blocked", async (t) => {
  // 2026-10-28: biscuit dropped five times (a heartbeat miss, an update, the portal VM's Tailscale restarting) while
  // cc1ab138 (w2466) ran on; each drop marked w2466 "stopped mid-turn" and Blocked, and the gate cleared on the socket
  // opening, before the daemon's hello said the worker was running.
  const { store, agents, sessions, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: 'w1: fix', work_id: 'w1' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const m = agents.machines as unknown as { detach(id: string): void; onMessage(id: string, msg: unknown): void; hasHello(id: string): boolean };
  const midTurn = () => {
    const h = sessions.sessions.get(id) as unknown as RemoteSession;
    h.liveFlag = true;
    h.seenLive = true;
    info.status = 'running';
  };
  midTurn();
  m.detach('pc');
  const w = store.work.get('w1')!;
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.by], ['blocked', 'machine', `worker ${id}`]);
  // Back with its process running: the hello lifts the wait at once, with no message to the worker.
  m.onMessage('pc', { type: 'hello', protocol: 1, live: [id] });
  assert.deepEqual([w.status, w.blocked], ['active', undefined]);
  assert.ok(w.log.some((l) => l.includes(`its worker ${id} ran on through pc's drop (its daemon reports it running), so the wait on pc is over (w2474)`)), w.log.join('\n'));
  assert.equal(agents.waker.pending(id), undefined, 'a running worker gets no resume message');
  // Dropped again, and back without it (its process ended): Blocked until the hello, then resumed in its own sandbox.
  midTurn();
  m.detach('pc');
  assert.equal(w.status, 'blocked');
  m.onMessage('pc', { type: 'hello', protocol: 1, live: [] });
  assert.equal(w.status, 'blocked', 'not running: the wait stays for the watch to resume it');
  const watch = new BlockerWatch({ store, orchestrators: o, online: (x) => (x === 'pc' ? true : undefined) });
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: pc is online/);
  assert.match(agents.waker.pending(id)?.note ?? '', /Your turn stopped when pc went offline/);
});

test('w2433: what a sandbox holds, for the long-offline notice', () => {
  const at = '2026-10-26T23:37:00.000Z';
  assert.match(unpushedText(undefined), /unknown .*may hold unpushed work/);
  assert.equal(unpushedText({ branch: 'b', upstream: 'origin/b', ahead: 0, dirty: 2, untracked: 1, at }), 'UNPUSHED WORK: 2 changed and 1 untracked file on b, not committed (as last seen at 23:37 UTC)');
  assert.equal(unpushedText({ branch: 'b', dirty: 0, untracked: 0, at }), 'UNPUSHED WORK: b has no upstream, so its commits are not pushed (as last seen at 23:37 UTC)');
  assert.equal(unpushedText({ branch: 'b', upstream: 'origin/b', ahead: 0, dirty: 0, untracked: 0, at, head: { sha: '0123456789abcdef', subject: 's', date: at } }), 'nothing unpushed: b is clean and pushed at 0123456789ab (as last seen at 23:37 UTC)');
  assert.equal(offlineNoticeMs({}), 60 * 60_000);
  assert.equal(offlineNoticeMs({ ledger: { offlineNoticeMinutes: 90 } }), 90 * 60_000);
  assert.equal(offlineNoticeMs({ ledger: { offlineNoticeMinutes: 1 } }), 5 * 60_000, 'at least 5 minutes');
});

// ---------------------------------------------------------------- w2443: a paused machine's work waits Blocked on its pause

test('w2443: a worker a pause stopped holds its request Blocked on the pause (online is not enough), and is resumed in its own sandbox when the machine runs again', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  putRequests(store, [{ id: 'w1', by: LOTH, status: 'active', title: 'Mass Driver FPS part 2' }]);
  const id = (await startedFor(env, 'w1')).id;
  const info = store.sessions.get(id)!;
  const w = store.work.get('w1')!;
  o.pausedOff(w, info, { machine: 'pc', sandbox: 'alpha', branch: 'w1-fps', why: 'paused from its tray app: paused by hand (w1532)', note: 'w1: still open: paused on pc; branch w1-fps pushed; the shader is half done', how: 'by its worker', saved: 'its sandbox had no uncommitted work on w1-fps' });
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref, w.blocked?.by, w.blocked?.pause], ['blocked', 'machine', 'pc', `worker ${id}`, true]);
  assert.match(w.log.at(-1)!, new RegExp(`blocked on pc's pause \\(w2443\\): paused from its tray app: paused by hand \\(w1532\\); its worker ${id} in pc/alpha stopped \\(by its worker\\), branch w1-fps`));
  assert.equal(blockerName(w.blocked!), 'pc running again (its pause)');
  // Its turn end does not lift a pause's gate (w2433 lifts a drop's).
  o.workerTurnEnded(info, 'w1: still open: paused on pc; branch w1-fps pushed');
  assert.equal(w.blocked?.pause, true);
  let paused = true;
  const watch = new BlockerWatch({ store, orchestrators: o, online: (m) => (m === 'pc' ? true : undefined), paused: (m) => m === 'pc' && paused });
  assert.equal((await watch.tick()).has('w1'), false, 'online but paused: it waits');
  assert.equal(w.status, 'blocked');
  assert.equal(agents.waker.pending(id), undefined);
  paused = false;
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: pc is online and runs again/);
  assert.equal(w.status, 'active');
  const wake = agents.waker.pending(id)!;
  assert.ok(wake && Date.parse(wake.at) - Date.now() <= 61_000, 'resumed within a minute, in its own sandbox');
  assert.match(wake.note, /FF Factory stopped your turn when pc was paused from its tray app at \d\d:\d\d UTC \(w2443\); it runs again, and this is your resume in your own sandbox/);
  assert.match(wake.note, /never reset it away or force-push/);
});

test('w2443: a leg of a pair run on a paused machine starts the whole run again off that machine; its other leg is stopped, not left hanging', async (t) => {
  const env = await setupOnMachine(t);
  const { store, sessions, o } = env;
  putRequests(store, [{ id: 'w2276', by: LOTH, status: 'active' }]);
  const a = await startedFor(env, 'w2276');
  store.putSession({ id: '9a4452ce', kind: 'worker', title: 'host leg', status: 'running', permissionMode: 'bypassPermissions', createdAt: T0, lastActivityAt: T0, turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: LOTH, machineId: 'beast', machineSandbox: 'slot1' } as SessionInfo);
  const w = store.work.get('w2276')!;
  w.sessionIds = ['9a4452ce', a.id];
  w.pair = { legs: 2, started: { at: T0, legs: [{ session: '9a4452ce', sandbox: 'beast/slot1' }, { session: a.id, sandbox: 'pc/alpha' }] } };
  store.putWork(w);
  o.pausedOff(w, store.sessions.get(a.id)!, { machine: 'pc', sandbox: 'alpha', why: 'paused from its tray app: someone is using it (w1532)', note: 'no note', how: 'forced (stopped)' });
  await until('the old leg stopped', () => !sessions.sessions.get(a.id)?.live);
  assert.equal(w.status, 'queued', 'Queued again as a whole run, not Blocked');
  assert.equal(w.blocked, undefined);
  assert.ok(w.log.some((l) => /its leg \w+'s computer pc is paused from its tray app: someone is using it \(w1532\) \(w2443\)/.test(l)), w.log.join('\n'));
});

test('w2446: a report naming a request already closed records no wait (w2434 quoted "gave up: w1995: …" and was unblocked at once, twice)', async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2', status: 'done' }, { id: 'w3' }]);
  let clock = Date.now();
  let pending = false;
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, checkInPending: (id) => pending || agents.waker.pending(id) !== undefined });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Time it', title: 'w1: A/B', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const w = store.work.get('w1')!;
  for (const n of [1, 2]) {
    Object.assign(info, { status: 'stopped', lastResult: `Run ${n} failed.\n\nw1: still open: waiting on the bench queue, which "gave up: w2: an exclusive timing ticket here waits for the dispatcher's answer"`, lastResultAt: new Date(clock - 60_000).toISOString() });
    assert.equal((await watch.tick()).has('w1'), false, `report ${n}: nothing recorded`);
    assert.deepEqual([w.status, w.blocked], ['active', undefined]);
    clock += 120_000;
  }
  assert.ok(!w.log.some((l) => /unblocked|recorded the wait/.test(l)), w.log.join(' | '));
  // an open request named the same way is still a wait (w2422)
  Object.assign(info, { lastResult: 'w1: still open: blocked on w3 reporting', lastResultAt: new Date(clock - 60_000).toISOString() });
  assert.match((await watch.tick()).get('w1') ?? '', /^recorded: the wait on w3/);
  // the lock holder's turn ended with a check-in pending: no report that it let go (BlockerWatch facts reportedSince)
  const facts = (watch as unknown as { facts(a: Map<string, never>, b: Map<string, never>, c: Map<string, never>): { reportedSince(w: WorkItem, since: number, o?: { notCheckIn?: boolean }): boolean } }).facts(new Map<string, never>(), new Map<string, never>(), new Map<string, never>());
  pending = true;
  assert.equal(facts.reportedSince(w, 0, { notCheckIn: true }), false);
  assert.equal(facts.reportedSince(w, 0), true, 'any other gate still reads the turn end');
  pending = false;
  agents.waker.cancel(id);
  assert.equal(facts.reportedSince(w, 0, { notCheckIn: true }), true);
});

test('w2459: a pair run that needs Steam is Blocked while too few computers are signed in to different Steam accounts, and clears when they are', async (t) => {
  const env = await twoComputers(t);
  const { store } = env;
  const o = env.agents.orchestrators;
  const steam = (id: string, s: Machine['steam']) => store.putMachine({ ...store.machines.get(id)!, steam: s });
  const signedIn = (accountId: number, persona: string) => ({ checkedAt: T0, installed: true, running: true, accountId, persona });
  steam('pc', signedIn(7155839, 'Lothsahn'));
  // w2458's case: the client computer has no Steam client (biscuit), here beast before its daemon reports one.
  putRequests(store, [{ id: 'w2757', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w2757');
  const out = String(await a.h.request_pair!({ what: 'lobby browser on PR #2757', brief: 'Host a Steam lobby on leg 1; leg 2 sees it in the lobby browser and joins.' }));
  const id = /^Filed (w\d+)/.exec(out)![1];
  const p = () => store.work.get(id)!;
  assert.match(p().pair!.steam ?? '', /^read from its words/, 'inferred from "Steam lobby"');
  assert.deepEqual([p().status, p().blocked?.kind], ['blocked', 'steam'], out);
  assert.match(p().blocked!.what, /only pc \("Lothsahn"\) is: beast's daemon has not reported its Steam client yet/);
  assert.match(out, /needs Steam and is blocked on computers signed in to Steam/);
  const watch = new BlockerWatch({ store, orchestrators: o });
  // One account on both computers: still short, and the reason says which computer takes it.
  steam('beast', signedIn(7155839, 'Lothsahn'));
  await watch.tick();
  assert.equal(p().status, 'blocked');
  steam('beast', { checkedAt: T0, installed: true, running: true });
  await watch.tick();
  assert.equal(p().status, 'blocked');
  // Signed in to another account: the gate clears and the dispatcher gets it back to start.
  steam('beast', signedIn(1234567, 'slims'));
  await watch.tick();
  assert.equal(p().status, 'new');
});

test("w2459: start_agent never puts a Steam pair run's leg on a computer without signed-in Steam, nor two legs on one Steam account", async (t) => {
  const env = await twoComputers(t);
  const { store, dispatcher, call } = env;
  const steam = (id: string, s: Machine['steam']) => store.putMachine({ ...store.machines.get(id)!, steam: s });
  const signedIn = (accountId: number, persona: string) => ({ checkedAt: T0, installed: true, running: true, accountId, persona });
  steam('pc', signedIn(7155839, 'Lothsahn'));
  putRequests(store, [{ id: 'w2', by: BEN, status: 'new', pair: { legs: 2, steam: 'a Steam lobby join' } }]);
  const id = 'w2';
  const p = () => store.work.get(id)!;
  const start = () => call(dispatcher().info, 'start_agent', { work_id: id, prompt: 'Run the lobby check.', title: 'lobby pair', sandbox: 'pc/alpha', pair_sandboxes: ['beast/slot1'] });
  steam('beast', { checkedAt: T0, installed: false, running: false });
  const none = await start();
  assert.equal(none.isError, true);
  assert.match(none.text, /leg 2 on beast\/slot1: beast has no Steam client installed, and w\d+ needs Steam .*Nothing was started\./);
  steam('beast', signedIn(7155839, 'Lothsahn'));
  const same = await start();
  assert.equal(same.isError, true);
  assert.match(same.text, /legs 1 \(pc\) and 2 \(beast\) are both signed in to Steam as Lothsahn \(signed in\), and w\d+ needs a different Steam account on each leg.*Nothing was started\./);
  assert.deepEqual(p().sessionIds, [], 'nothing was started');
  steam('beast', signedIn(1234567, 'slims'));
  const ok = await start();
  assert.equal(ok.isError, false, ok.text);
  assert.equal(p().sessionIds.length, 2);
});

// w2459 (lothsahn, 2026-10-28): w2460's rerun 2 put its host leg on m5, signed in to Steam but with its screen locked, where
// the game's menus take no clicks, so neither check ran.
test("w2459: start_agent never puts a leg that clicks the game's menus on a computer whose screen is locked", async (t) => {
  const env = await twoComputers(t);
  const { store, dispatcher, call } = env;
  const set = (id: string, m: Partial<Machine>) => store.putMachine({ ...store.machines.get(id)!, ...m });
  const signedIn = (accountId: number, persona: string) => ({ checkedAt: T0, installed: true, running: true, accountId, persona });
  set('pc', { steam: signedIn(7155839, 'Lothsahn'), desktop: { checkedAt: T0 } });
  set('beast', { steam: signedIn(1234567, 'slims'), desktop: { checkedAt: T0, locked: true } });
  putRequests(store, [
    { id: 'w2', by: BEN, status: 'new', pair: { legs: 2, steam: 'a Steam lobby join' } },
    { id: 'w3', by: BEN, status: 'new', pair: { legs: 2, menus: 'the title menu and the load dialog' } },
    { id: 'w4', by: BEN, status: 'new', pair: { legs: 2 } },
  ]);
  const start = (id: string, title: string) => call(dispatcher().info, 'start_agent', { work_id: id, prompt: 'Run the check.', title, sandbox: 'pc/alpha', pair_sandboxes: ['beast/slot1'] });
  for (const id of ['w2', 'w3']) {
    const r = await start(id, `menus pair ${id}`);
    assert.equal(r.isError, true, id);
    assert.match(r.text, /leg 2 on beast\/slot1: beast's screen is locked, and w\d+'s legs click the game's menus, which take no clicks there.*Nothing was started\./, id);
    assert.deepEqual(store.work.get(id)!.sessionIds, [], `${id}: nothing was started`);
  }
  set('beast', { desktop: { checkedAt: T0 } });
  const ok = await start('w2', 'lobby pair');
  assert.equal(ok.isError, false, ok.text);
  assert.equal(store.work.get('w2')!.sessionIds.length, 2);
});

test('w2459: request_pair marks a pair that names a menu or a click as clicking menus; a Steam pair needs no mark; menus "none" clears it', async (t) => {
  const env = await twoComputers(t);
  const { store } = env;
  putRequests(store, ['w2760', 'w2761', 'w2762'].map((id) => ({ id, by: BEN, status: 'active' as const })));
  let n = 2760;
  const file = async (x: Record<string, unknown>) => {
    const a = await startedFor(env, `w${n++}`);
    const out = String(await a.h.request_pair!(x));
    if (!/^Filed /.test(out)) throw new Error(out.slice(0, 400));
    return store.work.get(/^Filed (w\d+)/.exec(out)![1])!.pair!;
  };
  const menus = await file({ what: 'load a save on PR #2760', brief: 'Host and client click Load in the title menu.' });
  assert.match(menus.menus ?? '', /read from its words/);
  assert.match(pairText(menus), /only on computers whose screen is unlocked/);
  assert.equal((await file({ what: 'determinism on PR #2761', brief: 'Both legs run the headless soak with -ffSoloQuitAfterSeconds.' })).menus, undefined);
  assert.equal((await file({ what: 'load a save on PR #2762', brief: 'Click Load in the title menu.', menus: 'none' })).menus, undefined);
});

test('w2459: request_pair steam "none" files a pair with no Steam mark, whatever its words; a run with no Steam words needs none', async (t) => {
  const env = await twoComputers(t);
  const { store } = env;
  putRequests(store, [{ id: 'w2758', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w2758');
  const out = String(await a.h.request_pair!({ what: 'lobby code sync on PR #2758', brief: 'Join over the direct address; the lobby code is not used.', steam: 'none' }));
  const id = /^Filed (w\d+)/.exec(out)![1];
  assert.equal(store.work.get(id)!.pair!.steam, undefined);
  assert.equal(store.work.get(id)!.status, 'new');
});

// ---------------------------------------------------------------- w2521: work that must run on one named computer

test('w2521: a request whose constraints say "Must run on LothLaptop" is refused on another computer by start_agent, queued only for lothlaptop, and its timed_place leg is pinned there', async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  store.putMachine({ ...store.machines.get('pc')!, platform: 'win32' });
  store.putMachine({ ...store.machines.get('pc')!, id: 'lothlaptop', name: 'LothLaptop', platform: 'win32', sandboxes: [] });
  agentsRoom(agents, ['pc']);
  putRequests(store, [
    { id: 'w1', title: 'LothLaptop leg 2: adaptive vSync step-up', constraints: 'Must run on LothLaptop (its RTX 4070 and the 240 Hz panel); no other machine.' },
    { id: 'w2', title: 'G-SYNC detection', status: 'active' },
  ]);
  // Case 2 (w2499 at 02:48Z on 2026-10-29): placed on another computer with room. Now refused, saying where it must go.
  const refused = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Run the leg', title: 'w1: leg', work_id: 'w1' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /w1 must run on lothlaptop only \(w2521: its constraints: "Must run on LothLaptop/);
  // Queued with no machines: queued for lothlaptop alone; with another machine: refused.
  const wrong = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'busy', needs: ['pc'] });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /queue it for lothlaptop, not pc/);
  agentsRoom(agents, []);
  const queued = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'LothLaptop is busy' });
  assert.equal(queued.isError, false, queued.text);
  assert.deepEqual([store.work.get('w1')!.status, store.work.get('w1')!.queuedFor?.needs], ['queued', ['lothlaptop']]);

  // Case 1 (w2501's worker 9bdafcfe at 05:49Z): a worker on pc asks timed_place for a leg that needs LothLaptop's panel.
  agentsRoom(agents, ['pc']);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'G-SYNC work', title: 'w2: G-SYNC', work_id: 'w2' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  await until('its first turn', () => store.sessions.get(id)!.status === 'idle');
  const place = (agents as unknown as { timedPlaceTool: (m: string, i: SessionInfo, a: Record<string, unknown>) => string }).timedPlaceTool.bind(agents);
  const text = place('pc', store.sessions.get(id)!, { what: "w2501 G-SYNC A/B on PR #2795: needs LothLaptop's G-SYNC panel (BEAST is 60 Hz, …", brief: 'Time base and head on the G-SYNC panel.', platform: 'windows' });
  assert.match(text, /^Elsewhere \(w1969\): it must run on lothlaptop only \(its what: .*\): the leg waits on lothlaptop/);
  const leg = [...store.work.values()].find((w) => w.timedLeg?.for === 'w2')!;
  assert.deepEqual(leg.queuedFor?.needs, ['lothlaptop']);
  assert.deepEqual(leg.machinePin?.ids, ['lothlaptop']);
  assert.match(leg.constraints ?? '', /^Must run on lothlaptop only \(w2521/);
  assert.deepEqual(agents.pinOf(leg)?.ids, ['lothlaptop'], 'its own constraints pin it again when read back');
  // An unknown machine name is refused.
  assert.throws(() => place('pc', store.sessions.get(id)!, { what: 'x', machine: 'gsyncbox' }), /machine "gsyncbox" is no computer FF Factory knows/);
  void o;
});
