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
import { BlockerWatch, prHealthOf, compileErrorsIn, COMPILE_READ_MS, ghCompileVerdict, ghMerge, MERGE_TRIES, notMergeableRefusal, remergeJob, REPORTED_WAIT_MS } from './blockerWatch.ts';
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
import { blockerName, gatesOf, ownsPr, partOfPr, type PrHealth } from '../shared/blockers.ts';
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
 * The orchestrator tests (docs/orchestrators.md), end to end on a real Agents with the scripted agent: gates that resume a worker: blocked_on a PR, CI or a deploy, merge on green, the backstop sweep.
 * One of the server/orchestrators*.test.ts files split out of orchestrators.test.ts (w5826); helpers in orchestratorsTestKit.ts.
 */


test("w829: w814 as it happened: the dispatcher blocks a worker on CI and cancels its check-in; the checks can't be read; it is logged, and after 15 minutes the worker gets its check-in back. CI read red clears too", async (t) => {
  const { store, machines, agents, o, dispatcher, call, heard } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Construction bots', title: 'w1: bots', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);

  // 00:16 the worker sets itself an 8-minute check-in to merge #1338 on green; 00:17 the dispatcher blocks it on that CI.
  await h.wake_me!({ minutes: 8, note: 'w1: merge #1338 when Test in editmode is green' });
  const ref = 'Final-Factory/FinalFactory#1338';
  const blocked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'only CI left', blocker: { kind: 'ci', ref, what: 'CI on PR #1338' } });
  assert.equal(blocked.isError, false, blocked.text);
  assert.equal(agents.waker.pending(id), undefined, 'cancelled, as before');
  const w1 = () => store.work.get('w1')!;
  assert.equal(w1().status, 'blocked');
  assert.deepEqual(w1().heldCheckIns?.map((c) => [c.session, c.note]), [[id, 'w1: merge #1338 when Test in editmode is green']], 'but kept on the request');

  // The portal's gh cannot read the checks. Before w829: undefined in silence, for hours. Now: logged once, then cleared.
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(' '));
  t.after(() => {
    console.warn = warn;
  });
  let clock = Date.now();
  let reads = 0;
  let ci: () => { done: boolean; text: string } = () => {
    throw new Error('its checks: GraphQL: Resource not accessible by personal access token; its Actions runs: HTTP 403');
  };
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, ci: async () => (reads++, ci()) });
  assert.equal((await watch.tick()).size, 0);
  assert.deepEqual(warned, [`blocker watch: cannot read CI on ${ref}: its checks: GraphQL: Resource not accessible by personal access token; its Actions runs: HTTP 403`]);
  for (const m of [5, 10]) {
    clock += 5 * 60_000;
    assert.equal((await watch.tick()).size, 0, `still waiting at ${m} min`);
  }
  assert.equal(warned.length, 1, 'logged when it starts failing, not every read');
  assert.equal(reads, 3, 'read on each tick 5 minutes apart');
  clock += 5 * 60_000;
  assert.match((await watch.tick()).get('w1')!, /^clear: FF Factory could not read CI on Final-Factory\/FinalFactory#1338 for 15 min \(its checks: GraphQL: Resource not accessible/);
  // The worker's own check-in is back, due in a minute, and the request is its again.
  assert.equal(w1().status, 'active');
  assert.equal(w1().blocked, undefined);
  const back = agents.waker.pending(id)!;
  assert.ok(Date.parse(back.at) - Date.now() <= 61_000, 'fires within a minute');
  // w1094: the gate's owner is resumed with what to do, its own check-in folded in.
  assert.match(back.note, /^w1 is unblocked: CI on Final-Factory\/FinalFactory#1338 cleared \(FF Factory could not read CI on .* so its worker checks CI itself\)\. Run ff-pr merge now \(Final-Factory\/FinalFactory#1338\): it merges on green, or names the red run to read \(gh run view <run> --log-failed\) and fix\. Carry on from where you left it\. Your own check-in, which the block cancelled, is folded into this message; its note was: w1: merge #1338 when Test in editmode is green$/);
  assert.ok(w1().log.at(-1)!.includes(` unblocked (its worker ${id} resumes within a minute): CI on Final-Factory/FinalFactory#1338 cleared (FF Factory could not read CI`), w1().log.at(-1)!);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(dispatcher().info.id, '[ledger] w1').length, 0);

  // w2: blocked on CI with no worker and no check-in. Its first read fails too; the next reads, and CI finished red (#1328:
  // its editmode run cancelled at its 90-minute limit). Red is finished: it clears, the recovery is logged, and the dispatcher
  // is told to start it.
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'x', blocker: { kind: 'ci', ref: 'Final-Factory/FinalFactory#1328', what: 'CI on PR #1328' } })).isError, false);
  clock += 5 * 60_000;
  assert.equal((await watch.tick()).size, 0);
  assert.equal(warned.length, 2);
  assert.match(warned[1], /^blocker watch: cannot read CI on Final-Factory\/FinalFactory#1328: /);
  ci = () => ({ done: true, text: 'CI on Final-Factory/FinalFactory#1328 finished: 1 of 2 workflow runs failed (Test Runner: cancelled)' });
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(' '));
  try {
    clock += 5 * 60_000;
    assert.match((await watch.tick()).get('w2')!, /^clear: CI on Final-Factory\/FinalFactory#1328 finished: 1 of 2 workflow runs failed \(Test Runner: cancelled\)$/);
  } finally {
    console.log = log;
  }
  assert.ok(logged.includes('blocker watch: CI on Final-Factory/FinalFactory#1328 reads again after 5 min: CI on Final-Factory/FinalFactory#1328 finished: 1 of 2 workflow runs failed (Test Runner: cancelled)'), logged.join(' | '));
  assert.equal(store.work.get('w2')!.status, 'new');
  await until('the dispatcher is told to start w2', () => heard(dispatcher().info.id, '[ledger] w2').some((e) => /is unblocked: it waited on CI on Final-Factory\/FinalFactory#1328 \(CI on PR #1328\), and CI on .*Test Runner: cancelled.*Start it now: start_agent with work_id "w2"/.test(e.text)));
});

test('w846: a worker blocks on its own PR\'s CI (blocked_on prs "ci:…"); while it runs the worker waits on CI (its sandbox may go); when the checks finish, red or green, it is resumed within a minute with no dispatcher round trip', async (t) => {
  const { store, machines, agents, o, dispatcher, call, heard } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  let clock = Date.now();
  let checks: Record<string, { done: boolean; text: string }> = {};
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, ci: async (ref) => checks[ref] ?? { done: false, text: `CI on ${ref} running` } });
  for (const [wid, pr, result] of [
    ['w1', 'Final-Factory/FinalFactory#1354', { done: true, text: 'CI on Final-Factory/FinalFactory#1354 finished: 1 of 9 checks failed (Test in editmode)' }],
    ['w2', 'Final-Factory/FinalFactory#1356', { done: true, text: 'CI on Final-Factory/FinalFactory#1356 finished: all 9 checks passed or skipped' }],
  ] as const) {
    const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: `${wid}: fix`, work_id: wid, ...(wid === 'w2' ? { override_duplicate: 'another request', extra_agent: true } : {}) });
    assert.equal(started.isError, false, started.text);
    const id = /Started agent (\w+)/.exec(started.text)![1];
    const info = store.sessions.get(id)!;
    await firstTurn(info);
    const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
    assert.equal(agents.ciWait(info), undefined, 'working, not waiting on CI');
    // Today's polling (w833: a 10-minute check-in) would hold the sandbox; the gate replaces it (and holds it, w829).
    if (wid === 'w1') await h.wake_me!({ minutes: 10, note: `${wid}: check CI on ${pr}` });
    const said = String(await h.blocked_on!({ prs: [`ci:${pr}`], what: `CI on ${pr}` }));
    assert.match(said, new RegExp(`^Recorded: ${wid} is Blocked on CI on ${pr}\\.`));
    const w = store.work.get(wid)!;
    assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref, w.blocked?.by], ['blocked', 'ci', pr, `worker ${id}`]);
    assert.equal(agents.waker.pending(id), undefined, 'no poll left');
    assert.equal(agents.ciWait(info), `it waits on CI (${wid}: CI on ${pr})`, 'the signal the sandbox release reads');
    // Still running: nothing. Finished (red for w1, green for w2): unblocked, the worker resumed within a minute.
    assert.equal((await watch.tick()).has(wid), false);
    checks = { [pr]: result };
    clock += 5 * 60_000;
    assert.equal((await watch.tick()).get(wid), `clear: ${result.text}`);
    assert.equal(w.status, 'active');
    const wake = agents.waker.pending(id)!;
    assert.ok(Date.parse(wake.at) - Date.now() <= 61_000, 'within a minute');
    // w1 had polled: its own check-in is folded into the resume (w829, w1094). w2 had none: it is resumed all the same (w846).
    if (wid === 'w1') {
      assert.equal(wake.note, `${wid} is unblocked: CI on ${pr} cleared (${result.text}). Run ff-pr merge now (${pr}): it merges on green, or names the red run to read (gh run view <run> --log-failed) and fix. Carry on from where you left it. Your own check-in, which the block cancelled, is folded into this message; its note was: ${wid}: check CI on ${pr}`);
      assert.ok(w.log.at(-1)!.includes(`unblocked (its worker ${id} resumes within a minute): CI on ${pr} cleared`), w.log.at(-1)!);
    } else {
      assert.equal(wake.note, `${wid} is unblocked: CI on ${pr} cleared (${result.text}). Run ff-pr merge now (${pr}): it merges on green, or names the red run to read (gh run view <run> --log-failed) and fix. Carry on from where you left it.`);
      assert.ok(w.log.at(-1)!.includes(`unblocked (its worker ${id} resumes within a minute): CI on ${pr} cleared`), w.log.at(-1)!);
    }
    assert.equal(agents.ciWait(info), undefined);
    agents.waker.cancel(id);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(dispatcher().info.id, '[ledger] w1').length + heard(dispatcher().info.id, '[ledger] w2').length, 0, 'no dispatcher round trip');
});

test('w754: a gate that stalls stalls the request, naming that gate; one closed without delivering asks the requester, with no gate kept through the question', async (t) => {
  const { store, agents, o, dispatcher, call } = setup(t);
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', status: 'active' }, { id: 'w3' }, { id: 'w4' }, { id: 'w5', status: 'active' }]);
  await call(dispatcher().info, 'decide_work', { id: 'w3', action: 'block', note: 'x', blockers: [{ kind: 'request', ref: 'w1', what: 'w1 first' }, { kind: 'request', ref: 'w2', what: 'w2 first' }] });
  await call(dispatcher().info, 'decide_work', { id: 'w4', action: 'block', note: 'x', blockers: [{ kind: 'request', ref: 'w1', what: 'w1 first' }, { kind: 'request', ref: 'w5', what: 'w5 first' }] });
  const watch = new BlockerWatch({ store, orchestrators: o });
  store.work.get('w2')!.status = 'stalled';
  store.work.get('w2')!.stalled = { at: T0, kind: 'idle', reason: 'no activity for 26 hours' };
  await watch.tick();
  assert.equal(store.work.get('w3')!.status, 'stalled');
  assert.match(store.work.get('w3')!.stalled!.reason, /^blocked on w2 finishing \(w2 first\): w2, which it waits on, stalled/);
  assert.equal(store.work.get('w3')!.blocked, undefined, 'a stalled request keeps no gates');
  assert.equal(store.work.get('w4')!.status, 'blocked', 'w4 does not wait on w2');
  // w4: its first gate is cancelled instead.
  store.work.get('w1')!.status = 'cancelled';
  await watch.tick();
  const w4 = store.work.get('w4')!;
  assert.equal(w4.status, 'question');
  assert.match(w4.question!.text, /^It was blocked on w1 finishing \(w1 first\), and w1 was cancelled/);
  assert.deepEqual([w4.blocked, w4.alsoBlocked], [undefined, undefined]);
});

test('w754: a worker whose request waits only on a PR and another request calls blocked_on: Blocked, its check-in cancelled, no polling; cancel_wake and decide_work block cancel check-ins too; the gates clear one by one and resume it', async (t) => {
  const { store, machines, agents, o, dispatcher, call, heard } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2' }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Release it', title: 'w2: release', work_id: 'w2' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const m = store.machines.get('pc')!;
  const h = machines.hooks!.handlersFor(info, m);
  const spec = machines.hooks!.specFor(info, m);
  for (const name of ['blocked_on', 'cancel_wake']) assert.ok(spec.mcp?.tools.find((x) => x.name === name), `a worker has ${name}`);
  assert.match(spec.mcp!.tools.find((x) => x.name === 'blocked_on')!.description, /Never poll for them with wake_me and gh pr view/);
  assert.match(spec.append, /## Waiting on other requests or pull requests[\s\S]*mcp__machine__blocked_on[\s\S]*Do NOT poll for it with `wake_me`/);
  const live = async () => (await call(dispatcher().info, 'list_work', { id: 'w2' })).text;

  // The bug: a worker polling every 20 minutes shows Working.
  await h.wake_me!({ minutes: 20, note: "w2: check PR #1291 and w1's PR" });
  assert.ok(agents.waker.pending(id));
  assert.match(await live(), /Working/);
  // cancel_wake takes the check-in back; a second call says there is none.
  assert.match(String(await h.cancel_wake!({})), /^Cancelled your pending check-in \(\d\d:\d\d UTC: "w2: check PR #1291 and w1's PR"\)/);
  assert.equal(agents.waker.pending(id), undefined);
  assert.equal(String(await h.cancel_wake!({})), 'You had no check-in pending.');

  // Bad calls say what is wrong.
  await assert.rejects(async () => h.blocked_on!({ what: 'x' }), /name what it waits for: requests/);
  await assert.rejects(async () => h.blocked_on!({ prs: ['#1291'], what: 'x' }), /"#1291" is not a pull request/);
  await assert.rejects(async () => h.blocked_on!({ requests: ['w2'], what: 'x' }), /cannot be blocked on itself/);
  await assert.rejects(async () => h.blocked_on!({ requests: ['w99'], what: 'x' }), /no request "w99"/);

  // The real call, with a check-in left over: Blocked on both, the check-in cancelled.
  await h.wake_me!({ minutes: 20, note: 'w2: still polling' });
  const said = String(await h.blocked_on!({ requests: ['w1'], prs: ['https://github.com/Final-Factory/FinalFactory/pull/1291'], what: "w1's work and the Deck PR merged into develop" }));
  assert.match(said, /^Recorded: w2 is Blocked on w1 finishing and PR Final-Factory\/FinalFactory#1291 merging\. Your pending check-in is cancelled\. End your turn now/);
  assert.match(said, /Do NOT set a wake_me to poll for it: when it clears, FF Factory resumes you/);
  assert.equal(agents.waker.pending(id), undefined, 'no polling check-in is left');
  const w2 = store.work.get('w2')!;
  assert.deepEqual([w2.status, w2.blocked?.by, w2.blocked?.kind, w2.alsoBlocked?.[0]?.kind], ['blocked', `worker ${id}`, 'request', 'pr']);
  assert.match(w2.log.join('\n'), new RegExp(`worker ${id}: blocked on w1 finishing and PR Final-Factory/FinalFactory#1291 merging.*cancelled ${id}'s check-in \\(\\d\\d:\\d\\d UTC: "w2: still polling"\\)`));
  const blocked = await live();
  assert.match(blocked, /Blocked on w1 finishing, PR Final-Factory\/FinalFactory#1291 merging/);
  assert.doesNotMatch(blocked, /Working/);
  // A check-in set again (or left by an older worker) shows Blocked all the same, and blocking again from the dispatcher cancels it.
  await h.wake_me!({ minutes: 20, note: 'w2: again' });
  assert.match(await live(), /Blocked on w1 finishing/);
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'keeping both gates' })).isError, false);
  assert.equal(agents.waker.pending(id), undefined, "decide_work block cancelled the worker's check-in");
  assert.match(store.work.get('w2')!.log.join('\n'), new RegExp(`dispatcher: blocked on w1 finishing and PR .*cancelled ${id}'s check-in \\(\\d\\d:\\d\\d UTC: "w2: again"\\)`));

  // The PR merges: that gate goes, it stays Blocked on w1; then w1 closes: unblocked, and the dispatcher resumes the worker.
  const watch = new BlockerWatch({ store, orchestrators: o, pr: async (ref) => ({ state: 'merged', text: `${ref} merged` }) });
  assert.match((await watch.tick()).get('w2')!, /^clear: Final-Factory\/FinalFactory#1291 merged$/);
  assert.deepEqual([store.work.get('w2')!.status, store.work.get('w2')!.blocked?.ref, store.work.get('w2')!.alsoBlocked], ['blocked', 'w1', undefined]);
  assert.match(await live(), /Blocked on w1 finishing/);
  store.work.get('w1')!.status = 'done';
  await watch.tick();
  // w829: the check-in the block cancelled (the latest, "w2: again") is handed back to fire in a minute: the worker resumes
  // itself and the request is its again, with no dispatcher round trip.
  assert.equal(store.work.get('w2')!.status, 'active');
  assert.equal(store.work.get('w2')!.heldCheckIns, undefined);
  assert.equal(agents.waker.pending(id)?.note, 'w2 is unblocked: w1 finishing cleared (w1 closed as done). Carry on from where you left it. Your own check-in, which the block cancelled, is folded into this message; its note was: w2: again');
  assert.ok(store.work.get('w2')!.log.at(-1)!.endsWith(`unblocked (its worker ${id} resumes within a minute): w1 finishing cleared (w1 closed as done)`), store.work.get('w2')!.log.at(-1)!);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(dispatcher().info.id, '[ledger] w2').length, 0, 'the dispatcher is not asked to start it as well');
  // A message to the worker goes through, with no override: nothing is gated any more.
  const resumed = await call(dispatcher().info, 'message_agent', { session_id: id, text: 'w1 and the PR merged: go on.', work_id: 'w2' });
  assert.equal(resumed.isError, false, resumed.text);
  assert.equal(store.work.get('w2')!.status, 'active');
});

test('w890: Agents.waitOn names what a worker that ended its turn waits on: a deploy, a person, another request or a PR merging; not CI (its own rule), a time, or any request still being worked', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, ['pc']);
  // The ledger's status question, 3 s after a worker's turn ends without its requests' status: on a loaded machine it
  // reached w1's worker before w3 started, and pc/alpha was busy with it (w5915, 3 of 6 runs at once on BEAST).
  agents.orchestrators.statusAskDelayMs = 3_600_000;
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }, { id: 'w5' }, { id: 'w6', status: 'active' }]);
  // The release pass reads the ledger once per few seconds (Agents.waitLive); the test asks afresh.
  const waitOn = (i: SessionInfo) => {
    (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
    return agents.waitOn(i);
  };
  const decide = (id: string, a: Record<string, unknown>) => call(dispatcher().info, 'decide_work', { id, note: 'because', ...a });

  // Nothing declared: a worker that finished a turn on an active request waits on nothing.
  const a = await startedFor(env, 'w1');
  assert.equal(waitOn(a.info), undefined, 'working on it, nothing is waited for');
  assert.equal(agents.ciWait(a.info), undefined);

  // A deploy the dispatcher blocked it on (the ledger cleanup's w889 case reads the same): a portal deploy.
  assert.equal((await decide('w1', { action: 'block', blocker: { kind: 'deploy', what: 'the portal deploy of 65b1d27' } })).isError, false);
  assert.equal(waitOn(a.info), 'it waits on w1: a portal deploy');
  assert.equal(agents.ciWait(a.info), undefined);

  // The worker's own blocked_on: a deploy by name, another request, a PR merging.
  const b = await startedFor(env, 'w2', { override_duplicate: 'another request' });
  assert.match(String(await b.h.blocked_on!({ deploys: ['portal'], what: 'the portal deploy of #281' })), /^Recorded: w2 is Blocked on a portal deploy\./);
  assert.equal(store.work.get('w2')!.blocked?.kind, 'deploy');
  assert.equal(store.work.get('w2')!.blocked?.by, `worker ${b.id}`);
  assert.equal(waitOn(b.info), 'it waits on w2: a portal deploy');
  await assert.rejects(async () => b.h.blocked_on!({ deploys: ['nowhere'], what: 'x' }), /no machine "nowhere"/);
  assert.match(String(await b.h.blocked_on!({ requests: ['w6'], prs: ['Final-Factory/ff-factory#281'], what: 'w6 and #281' })), /^Recorded: w2 is Blocked on w6 finishing and PR Final-Factory\/ff-factory#281 merging\./);
  assert.equal(waitOn(b.info), 'it waits on w2: w6 finishing and PR Final-Factory/ff-factory#281 merging');

  // A person: its declaration, also with a check-in as a fallback.
  const c = await startedFor(env, 'w3', { override_duplicate: 'another request' });
  assert.match(String(await c.h.waiting_on_person!({ who: 'Ben', what: 'give the go-ahead for the deploy' })), /^Recorded: your requests wait on Ben/);
  assert.equal(waitOn(c.info), 'it waits on Ben: give the go-ahead for the deploy');
  Object.assign(c.info, { wakeAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), wakeNote: 'fallback' });
  assert.equal(waitOn(c.info), 'it waits on Ben: give the go-ahead for the deploy');

  // CI has its own, stricter rule (editor stopped): waitOn leaves it to ciWait.
  const d = await startedFor(env, 'w4', { override_duplicate: 'another request' });
  await d.h.blocked_on!({ prs: ['ci:Final-Factory/ff-factory#282'], what: 'CI on #282' });
  assert.equal(agents.ciWait(d.info), 'it waits on CI (w4: CI on Final-Factory/ff-factory#282)');
  assert.equal(waitOn(d.info), undefined);

  // A time is not a wait that frees a sandbox; nor is one request of two still being worked.
  const e = await startedFor(env, 'w5', { override_duplicate: 'another request' });
  assert.equal((await decide('w5', { action: 'block', blocker: { kind: 'time', until: new Date(Date.now() + 3_600_000).toISOString(), what: 'tomorrow' } })).isError, false);
  assert.equal(waitOn(e.info), undefined, 'a time');
  const store6 = store.work.get('w6')!;
  store6.sessionIds = [...store6.sessionIds, a.id];
  store.work.get('w1')!.sessionIds = [...new Set([...store.work.get('w1')!.sessionIds, a.id])];
  assert.equal(waitOn(a.info), undefined, 'w6 is still being worked: not every request it serves waits');
  // A closed request is not a wait: workOver frees it already.
  store6.status = 'done';
  assert.equal(waitOn(a.info), 'it waits on w1: a portal deploy');
});

test('w890: a deploy gate clearing resumes its worker within a minute, in any free sandbox, with a note to do its check after the deploy; no dispatcher round trip', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, call, heard } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  let sha = 'aaa1111';
  let clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, portalSha: () => sha });
  const a = await startedFor(env, 'w1');
  (o as unknown as { d: { deploySha?: (id?: string) => string | undefined } }).d.deploySha = () => 'aaa1111';
  assert.match(String(await a.h.blocked_on!({ deploys: ['portal'], what: 'the portal deploy of 65b1d27' })), /^Recorded: w1 is Blocked on a portal deploy\./);
  assert.equal((await watch.tick()).has('w1'), false, 'the portal still runs the same commit');
  assert.equal(store.work.get('w1')!.status, 'blocked');
  // The deploy lands: a different commit runs. The block clears and its worker is resumed within a minute.
  sha = 'bbb2222';
  clock += 60_000;
  assert.match((await watch.tick()).get('w1')!, /^clear: the portal runs bbb2222 now \(aaa1111 when it was blocked\)$/);
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'active');
  const wake = agents.waker.pending(a.id)!;
  assert.ok(Date.parse(wake.at) - Date.now() <= 61_000, 'within a minute');
  assert.match(wake.note, /^w1 is unblocked: a portal deploy cleared \(the portal runs bbb2222 now \(aaa1111 when it was blocked\)\)\. The deploy you waited for has happened: do the check that comes after it now/);
  assert.ok(w.log.at(-1)!.includes(`unblocked (its worker ${a.id} resumes within a minute)`), w.log.at(-1)!);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(dispatcher().info.id, '[ledger] w1').length, 0, 'no dispatcher round trip');
  agents.waker.cancel(a.id);
});

// ---------------------------------------------------------------- w907: a ci: wait is checked, and a PR that cannot get CI wakes its worker

test('w907: blocked_on ci: refuses a PR that conflicts or whose head is not the pushed commit, warns without head; a conflict that shows up later clears the gate and resumes the worker with what to do', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  const pr = 'Final-Factory/ff-factory#283';
  let health: PrHealth | undefined = { state: 'open', head: '312570ce0fd425e0', headRef: 'w890', conflict: { base: 'main' } };
  agents.prHealth = async () => health;
  const a = await startedFor(env, 'w1');
  // w890 as it happened: the PR conflicts with main, so no CI will start: nothing is recorded, the worker is told to fix it.
  await assert.rejects(async () => a.h.blocked_on!({ prs: [`ci:${pr}`], head: '312570ce0fd4', what: 'CI on #283' }), /^Error: PR #283 conflicts with main \(CI can't run\): merge main in, resolve, push; then call blocked_on again\. Nothing was recorded\.$/);
  assert.equal(store.work.get('w1')!.status, 'active');
  // The push did not land: its head is another commit than the one the worker pushed.
  health = { state: 'open', head: '1111111aaaa', headRef: 'w890' };
  await assert.rejects(async () => a.h.blocked_on!({ prs: [`ci:${pr}`], head: '312570ce0fd4', what: 'CI on #283' }), /PR #283's head is 1111111aaaa, not 312570ce0fd4, the commit you say you pushed: your push did not land \(check git push's output and git ls-remote origin w890\)/);
  assert.equal(store.work.get('w1')!.status, 'active');
  // Its head is the pushed commit (a short sha is enough): recorded, no warning.
  health = { state: 'open', head: '312570ce0fd425e0', headRef: 'w890' };
  const ok = String(await a.h.blocked_on!({ prs: [`ci:${pr}`], head: '312570c', what: 'CI on #283' }));
  assert.match(ok, /^Recorded: w1 is Blocked on CI on Final-Factory\/ff-factory#283\./);
  assert.doesNotMatch(ok, /WARNING/);
  // w3786: the gate keeps the head waited on, whole, so only CI at that commit clears it.
  assert.equal(gatesOf(store.work.get('w1')!)[0].head, '312570c');
  // No head given: recorded, with a warning that the push was not checked. A PR that cannot be read warns too.
  putRequests(store, [{ id: 'w2' }]);
  const b = await startedFor(env, 'w2', { override_duplicate: 'another request' });
  const warned = String(await b.h.blocked_on!({ prs: ['ci:Final-Factory/ff-factory#284'], what: 'CI on #284' }));
  assert.match(warned, /WARNING: FF Factory did not check that your push landed: pass head \(git rev-parse HEAD\) with a ci: wait/);
  agents.prHealth = async () => undefined;
  putRequests(store, [{ id: 'w3' }]);
  const c = await startedFor(env, 'w3', { override_duplicate: 'another request' });
  assert.match(String(await c.h.blocked_on!({ prs: ['ci:Final-Factory/ff-factory#285'], head: 'abc1234', what: 'CI on #285' })), /WARNING: FF Factory could not read PR #285, so it did not check that your push landed/);
  // A pr: wait is not checked at block time; only ci: ones are.
  // The block clears by itself when a conflict shows up while it waits and no check has started.
  let clock = Date.now();
  let seen: PrHealth | undefined = { state: 'open', head: '312570ce0fd425e0', headRef: 'w890' };
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, ci: async (ref) => ({ done: false, text: `${ref} has no checks yet`, none: true }), prHealth: async () => seen });
  assert.equal((await watch.tick()).has('w1'), false, 'mergeable, young head: it waits');
  seen = { state: 'open', head: '312570ce0fd425e0', headRef: 'w890', conflict: { base: 'main' } };
  clock += 3 * 60_000;
  const did = await watch.tick();
  assert.equal(did.get('w1'), "clear: PR #283 conflicts with main (CI can't run): merge main in, resolve, push, and wait again");
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'active');
  const wake = agents.waker.pending(a.id)!;
  assert.ok(Date.parse(wake.at) - Date.now() <= 61_000, 'resumed within a minute');
  assert.equal(wake.note, "w1 is unblocked: CI on Final-Factory/ff-factory#283 cleared (PR #283 conflicts with main (CI can't run): merge main in, resolve, push, and wait again). Carry on from where you left it.", 'no "read its checks" hint: there are none');
  assert.ok(w.log.at(-1)!.includes("PR #283 conflicts with main (CI can't run): merge main in, resolve, push, and wait again"), w.log.at(-1)!);
  for (const id of [a.id, b.id, c.id]) agents.waker.cancel(id);
});

test('w907: no CI run for a PR head after ten minutes clears the gate too, resuming the worker', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  const pr = 'Final-Factory/ff-factory#283';
  const a = await startedFor(env, 'w1');
  await a.h.blocked_on!({ prs: [`ci:${pr}`], what: 'CI on #283' });
  let clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, ci: async (ref) => ({ done: false, text: `${ref} has no workflow runs yet`, none: true }), prHealth: async () => ({ state: 'open', head: 'deadbeefcafe' }) });
  assert.equal((await watch.tick()).has('w1'), false);
  clock += 9 * 60_000;
  assert.equal((await watch.tick()).has('w1'), false, 'nine minutes: still within CI start-up');
  clock += 2 * 60_000;
  assert.match((await watch.tick()).get('w1')!, /^clear: no CI run exists for PR #283's head deadbee 11 min after it was pushed/);
  assert.equal(store.work.get('w1')!.status, 'active');
  agents.waker.cancel(a.id);
});

test("w3572: replay of ffu#397: requests waiting for another request's PR to merge stay Blocked when it conflicts; only its owner is told, once per head", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
  const ref = 'Final-Factory/ffu#397';
  // w1 (w3445) owns #397: its description says "Request: w1". w2 and w3 (w3423, w3416) only wait for it to merge.
  const owner = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2', { override_duplicate: 'another request' });
  const c = await startedFor(env, 'w3', { override_duplicate: 'another request' });
  for (const x of [b, c]) await x.h.blocked_on!({ prs: [ref], what: 'PR Final-Factory/ffu#397 merging' });
  let clock = Date.now();
  let seen: PrHealth = { state: 'open', head: 'aaaaaaa1111', headRef: 'w3445-failover', requests: ['w1'], conflict: { base: 'main' } };
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, pr: async (r) => ({ state: 'open', text: `${r} is still open` }), prHealth: async () => seen });
  const told = () => store.readTranscript(owner.id).filter((e) => e.kind === 'user' && /PR #397 \(Final-Factory\/ffu#397\) conflicts with main/.test((e as { text: string }).text));
  const did = await watch.tick();
  // Before w3572 each waiter was cleared with "PR #397 conflicts with main (CI can't run): merge main in, resolve, push".
  for (const id of ['w2', 'w3']) {
    assert.equal(did.has(id), false, `${id} is not woken`);
    assert.equal(store.work.get(id)!.status, 'blocked', `${id} stays Blocked`);
    assert.doesNotMatch(store.work.get(id)!.log.join('\n'), /merge main in/);
  }
  assert.match(did.get('w1') ?? '', /^told: PR #397 conflicts with main/);
  await until("the owner's worker is told", () => told().length === 1);
  const text = (told()[0] as { text: string }).text;
  assert.match(text, /w2, w3 wait for it to merge\. It is w1's: merge main into its branch, resolve, push, and wait on its CI again/);
  assert.match(store.work.get('w1')!.log.join('\n'), new RegExp(`${ref} conflicts at aaaaaaa: told ${owner.id}`));
  // The next looks (still conflicting, same head): nobody is woken or told again.
  for (let i = 0; i < 3; i++) {
    clock += 3 * 60_000;
    const again = await watch.tick();
    assert.equal(['w1', 'w2', 'w3'].some((id) => again.has(id)), false, 'told once');
  }
  assert.equal(told().length, 1);
  // A new head that conflicts again tells the owner again; the waiters still sleep. Its merge then clears them.
  seen = { ...seen, head: 'bbbbbbb2222' };
  clock += 3 * 60_000;
  assert.match((await watch.tick()).get('w1') ?? '', /^told:/);
  assert.equal(store.work.get('w2')!.status, 'blocked');
  for (const id of [owner.id, b.id, c.id]) agents.waker.cancel(id);
});

test("w5845: replay of ffu#1140 at 21:51Z on 2026-11-25: a PR whose body says Part of: wA but Request: wB conflicts; wB's worker is told, the planner wA is not; wA hears only once wB has no worker", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  // w1 is w2895 (the FFU planner), w2 is w5476 (the row that opened #1140), w3 is w5792 (waits for #1140 to merge).
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2' }, { id: 'w3' }]);
  const ref = 'Final-Factory/ffu#1140';
  const planner = await startedFor(env, 'w1');
  const row = await startedFor(env, 'w2', { override_duplicate: 'another request' });
  const waiter = await startedFor(env, 'w3', { override_duplicate: 'another request' });
  await waiter.h.blocked_on!({ prs: [ref], what: `${ref} merging` });
  // What ffu#1140's description says: "Request: w5476" and "Part of: w2895" (read with gh on 2026-11-25).
  const body = 'M6.13 blueprints\n\nRequest: w2\nPart of: w1\n';
  const parsed = prHealthOf({ state: 'OPEN', mergeable: 'CONFLICTING', baseRefName: 'main', headRefOid: 'ac084ff0aaaa', headRefName: 'w5476-blueprints', body });
  assert.deepEqual([parsed.requests, parsed.partOf], [['w2'], ['w1']]);
  assert.equal(ownsPr(store.work.get('w1'), ref, parsed), false, 'the planner a Part of: line names does not own it');
  assert.equal(partOfPr(store.work.get('w1'), ref, parsed), true);
  assert.equal(ownsPr(store.work.get('w2'), ref, parsed), true, 'the Request: line names its owner');
  // A step PR that names only Part of: (no Request: line at all) is still its request's own.
  assert.equal(ownsPr(store.work.get('w1'), ref, prHealthOf({ state: 'OPEN', body: 'Part of: w1' })), true);
  let clock = Date.now();
  let seen: PrHealth = parsed;
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, pr: async (r) => ({ state: 'open', text: `${r} is still open` }), prHealth: async () => seen });
  const toldTo = (sid: string) => store.readTranscript(sid).filter((e) => e.kind === 'user' && /PR #1140 \(Final-Factory\/ffu#1140\) conflicts with main/.test((e as { text: string }).text));
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(' '));
  let did: Map<string, string>;
  try {
    did = await watch.tick();
  } finally {
    console.log = log;
  }
  assert.match(did.get('w2') ?? '', /^told: PR #1140 conflicts with main/);
  assert.equal(did.has('w1'), false, 'the planner is not told');
  await until("w2's own worker is told", () => toldTo(row.id).length === 1);
  assert.match((toldTo(row.id)[0] as { text: string }).text, /w3 wait for it to merge\. It is w2's: merge main into its branch/);
  assert.equal(toldTo(planner.id).length, 0);
  assert.doesNotMatch(store.work.get('w1')!.log.join('\n'), /conflicts at/);
  assert.ok(logged.some((l) => l.includes(`${ref} conflicts with main; w3 wait for it to merge: telling w2 (w2 owns it (its Request: line) and has worker ${row.id}); not told: w1 (w5845)`)), logged.join(' | '));
  // A new head conflicts again after w2 closed: now the planner its Part of: line names hears it.
  store.work.get('w2')!.status = 'done';
  seen = { ...parsed, head: 'bbbbbbb2222' };
  clock += 3 * 60_000;
  assert.match((await watch.tick()).get('w1') ?? '', /^told: PR #1140 conflicts with main/);
  await until("the planner's worker is told", () => toldTo(planner.id).length === 1);
  assert.match((toldTo(planner.id)[0] as { text: string }).text, /one step of w1 \(its Part of: line\), so it is yours: merge main into its branch/);
  for (const id of [planner.id, row.id, waiter.id]) agents.waker.cancel(id);
});

test('w5845: replay of ffu#1097: the row and the planner both wait on its CI; when it finishes only the row (its Request: line) is woken, and the planner waits for the merge, logged', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  // w1 is w2895 (the planner, whose worker d9f4e2ce merged main into #1097), w2 is w5472 (the row that opened it).
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }]);
  const ref = 'Final-Factory/ffu#1097';
  const row = await startedFor(env, 'w2');
  const planner = await startedFor(env, 'w1', { override_duplicate: 'another request' });
  await row.h.blocked_on!({ prs: [`ci:${ref}`], what: `CI on ${ref}` });
  await planner.h.blocked_on!({ prs: [`ci:${ref}`], what: `CI on ${ref}` });
  let clock = Date.now();
  const seen: PrHealth = { state: 'open', head: 'dddcef41aaaa', headRef: 'w5472-turrets-shields', requests: ['w2'], partOf: ['w1'] };
  let checks: Record<string, { done: boolean; text: string }> = {};
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, ci: async (r) => checks[r] ?? { done: false, text: `CI on ${r} running` }, pr: async (r) => ({ state: 'open', text: `${r} is still open` }), prHealth: async () => seen });
  assert.equal((await watch.tick()).size, 0);
  checks = { [ref]: { done: true, text: `CI on ${ref} finished: 1 of 1 workflow runs failed (ci: failure)` } };
  clock += 3 * 60_000;
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(' '));
  let did: Map<string, string>;
  try {
    did = await watch.tick();
  } finally {
    console.log = log;
  }
  assert.match(did.get('w2') ?? '', /^clear: CI on Final-Factory\/ffu#1097 finished/);
  assert.equal(store.work.get('w2')!.status, 'active');
  assert.equal(did.get('w1'), 'waits for PR #1097 to merge: w2 works on it (w5845)');
  const w1 = store.work.get('w1')!;
  assert.deepEqual([w1.status, w1.blocked?.kind, w1.blocked?.ref, w1.blocked?.by], ['blocked', 'pr', ref, 'blocker watch']);
  assert.match(w1.log.join('\n'), /Final-Factory\/ffu#1097 is w2's to act on, not w1's \(w2 owns it \(its Request: line, ledger link or branch\)\); w1 now waits for it to merge \(w5845\)/);
  assert.ok(logged.some((l) => l.includes(`blocker watch: ${ref}: w2, w1 would all be woken; only w2 is (w2 owns it`) || l.includes(`blocker watch: ${ref}: w1, w2 would all be woken; only w2 is (w2 owns it`)), logged.join(' | '));
  // Neither owns it (two requests that only wait on its CI): the one whose worker called blocked_on last is woken.
  const other = 'Final-Factory/ffu#2000';
  const x = await startedFor(env, 'w3', { override_duplicate: 'another request' });
  const y = await startedFor(env, 'w4', { override_duplicate: 'another request' });
  await x.h.blocked_on!({ prs: [`ci:${other}`], what: `CI on ${other}` });
  clock += 1000;
  await new Promise((r) => setTimeout(r, 5));
  await y.h.blocked_on!({ prs: [`ci:${other}`], what: `CI on ${other}` });
  checks = { ...checks, [other]: { done: true, text: `CI on ${other} finished: all 1 workflow runs passed or skipped` } };
  clock += 3 * 60_000;
  const again = await watch.tick();
  assert.match(again.get('w4') ?? '', /^clear:/);
  assert.equal(again.get('w3'), 'waits for PR #2000 to merge: w4 works on it (w5845)');
  for (const id of [planner.id, row.id, x.id, y.id]) agents.waker.cancel(id);
});

test("w890 (found live): a worker's own waiting_on_person counts for every request it is the latest worker on, also one it moved on from, so a worker on two requests that ends its turn waiting on a person frees its sandbox", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2', status: 'active' }]);
  const waitOn = (i: SessionInfo) => {
    (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
    return agents.waitOn(i);
  };
  const a = await startedFor(env, 'w1');
  // w890 at 19:34Z on the live portal: the worker was started for w1, then sent w2 (the ledger reads it as working on w2
  // only), and ended its turn declaring that it waits on Lothsahn for w1. w1 read "its worker moved on", not Waiting, so
  // "every request waits" failed and the sandbox was held.
  const w2 = store.work.get('w2')!;
  w2.sessionIds = [a.id];
  w2.links = { [a.id]: { at: new Date(Date.now() + 60_000).toISOString(), how: 'sent' } };
  assert.equal(waitOn(a.info), undefined, 'nothing declared: both requests are the worker\'s and none waits');
  await a.h.waiting_on_person!({ who: 'Lothsahn', what: 'run the next portal deploy', request: 'w1' });
  assert.equal(waitOn(a.info), 'it waits on Lothsahn: run the next portal deploy');
  // Its next message ends the declaration, and with it the wait.
  a.info.waitingOn = undefined;
  assert.equal(waitOn(a.info), undefined);
  // A declaration with no open request it is the latest worker on is the cleanup's to handle (workOver), not this.
  store.work.get('w1')!.status = 'done';
  store.work.get('w2')!.status = 'done';
  a.info.waitingOn = { who: 'Ben', what: 'x', at: new Date().toISOString() };
  assert.equal(waitOn(a.info), undefined);
});

test("w936: main_clone grants a machine's main clone to a request's workers: its person's own orchestrator, in a turn of theirs, never from the intake; the spec carries it", async (t) => {
  const { store, sessions, machines, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN);
  const loth = chat(LOTH);
  // The dispatcher's notices open harness turns on an orchestrator; a turn of the person's own starts clean.
  const turn = (c: ReturnType<typeof chat>, from: 'human' | 'system') => {
    (c as unknown as { turnStarter?: unknown }).turnStarter = undefined;
    c.lastFrom = from;
  };
  await call(ben.info, 'request_work', { title: 'Connector branch on the m5 main clone', brief: 'Check the connector branch out in the main clone.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Connector branch', title: 'w1: connector branch', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const info = store.sessions.get(/Started agent (\w+)/.exec(started.text)![1])!;
  const m = store.machines.get('pc')!;
  const specNow = () => machines.hooks!.specFor(info, m);

  // No grant: the clone is protected, as before.
  assert.equal(specNow().guard.mainClone, undefined);
  assert.match(specNow().append, /Protected: the machine's main clone/);
  // w4499: the prompt states what the daemon-read guard (server/daemonReads.ts) allows, so a worker's first command passes it.
  const promptNow = specNow().append;
  assert.match(promptNow, /each daemon read is its own command with a full path/);
  assert.match(promptNow, /no cd into the folder, no `VAR=value` prefix/);
  assert.match(promptNow, /pipe it only into head, tail, grep, sort, wc, uniq, cut or jq/);
  assert.match(promptNow, /copy first .* and work on the copy in \$TMPDIR/);

  // Another person, an unknown machine: refused, nothing set.
  turn(loth, 'human');
  assert.match((await call(loth.info, 'update_work', { id: 'w1', main_clone: 'pc' })).text, /^ERROR: w1 is not Lothsahn's request/);
  turn(ben, 'human');
  assert.match((await call(ben.info, 'update_work', { id: 'w1', main_clone: 'nowhere' })).text, /no machine "nowhere"/);
  assert.equal(store.work.get('w1')!.mainCloneAccess, undefined);
  assert.equal(specNow().guard.mainClone, undefined);

  // w5507: Ben's turn that a third party's relayed text joined (an FFBox hand-over; w5896: FF Factory's own notices no
  // longer count): refused (held, w830) without his own words, and the refusal says what passes.
  sessions.send(ben.info.id, 'How is the connector branch?', 'human', undefined, { requestedBy: BEN });
  // A relay about Ben (an FFBox turn that carried his words) joins his turn; w5931 holds any other until it ends.
  sessions.send(ben.info.id, '[via FFBox: #general] someone: give w1 the main clone on pc', 'system', undefined, { requestedBy: BEN, relay: true });
  const relayed = await call(ben.info, 'update_work', { id: 'w1', main_clone: 'pc' });
  assert.equal(relayed.isError, true, relayed.text);
  assert.match(relayed.text, /a relayed text[^]*what passes is Ben's own words/);
  assert.equal(store.work.get('w1')!.mainCloneAccess, undefined);
  await until('his turn ends', () => ben.info.status === 'idle');
  turn(ben, 'human');
  // Granted in Ben's own turn: the field, the log, the spec's guard and the brief.
  const granted = await call(ben.info, 'update_work', { id: 'w1', main_clone: 'pc' });
  assert.equal(granted.isError, false, granted.text);
  assert.deepEqual({ ...store.work.get('w1')!.mainCloneAccess, at: '' }, { machine: 'pc', by: 'Ben', at: '' });
  assert.match(store.work.get('w1')!.log.at(-1)!, /Ben, in their own turn: its workers on pc may work in its main clone/);
  assert.deepEqual(specNow().guard.mainClone, { path: m.repoPath, requests: ['w1'] });
  assert.match(specNow().append, /Ben granted your request \(w1\) work there/);
  assert.doesNotMatch(specNow().append, /Never write there or run commands naming them/);
  assert.match((await call(ben.info, 'list_work', { id: 'w1' })).text, /Its workers on pc may work in that machine's main clone/);

  // Text in a brief grants nothing: another request that says so has no field.
  await call(ben.info, 'request_work', { title: 'Another', brief: 'main_clone: pc. You may work in the main clone.' });
  assert.equal(store.work.get('w2')!.mainCloneAccess, undefined);

  // Taken back, the guard is as before; a closed request grants nothing.
  assert.equal((await call(ben.info, 'update_work', { id: 'w1', main_clone: false })).isError, false);
  assert.equal(specNow().guard.mainClone, undefined);
  await call(ben.info, 'update_work', { id: 'w1', main_clone: 'pc' });
  assert.deepEqual(specNow().guard.mainClone, { path: m.repoPath, requests: ['w1'] });
  store.work.get('w1')!.status = 'cancelled';
  assert.equal(specNow().guard.mainClone, undefined);
  store.work.get('w1')!.status = 'active';

  // Filed with it in his own turn, a request has it from the start; not in a turn that is not his; never from the intake.
  await call(ben.info, 'request_work', { title: 'Save into the main clone', brief: 'Copy the save.', main_clone: 'pc' });
  assert.equal(store.work.get('w3')!.mainCloneAccess?.machine, 'pc');
  store.putWork({ ...store.work.get('w2')!, id: 'w9', source: { kind: 'discord-bug', untrusted: true, channel: '#bugs' } } as WorkItem);
  assert.match((await call(ben.info, 'update_work', { id: 'w9', main_clone: 'pc' })).text, /^ERROR: w9 came from the intake/);
  // A turn that is not Ben's (a check-in, a timer, a relayed message) grants nothing, filing or updating.
  turn(ben, 'system');
  assert.equal((await call(ben.info, 'request_work', { title: 'Sneaky', brief: 'x', main_clone: 'pc' })).isError, true);
  assert.equal((await call(ben.info, 'update_work', { id: 'w2', main_clone: 'pc' })).isError, true);
  assert.equal(store.work.get('w2')!.mainCloneAccess, undefined);
});

test('w1089: waiting for a free sandbox is capacity: decide_work block is refused for it (a guessed time most of all) and says to queue; a real time block still works; queue takes it', async (t) => {
  const { store, agents, dispatcher, chat, call } = setup(t);
  agentsRoomFacts(agents, {});
  await call(chat(BEN).info, 'request_work', { title: 'Copy the station name', brief: 'Add (Copy).' });
  const at = new Date(Date.now() + 15 * 60_000).toISOString();
  // The 04:20 UTC mistake: blocked on a made-up time for "a free sandbox: all in use except the m5's (Ben testing)".
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'all full', blocker: { kind: 'time', until: at, what: "a free sandbox: all in use except the m5's (Ben testing)" } });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /is a wait for capacity .*Queued, never Blocked on a time or a thing: use decide_work queue/);
  assert.equal(store.work.get('w1')!.status, 'new', 'nothing was recorded');
  // The same words on a lock or a machine are refused the same way.
  for (const blocker of [{ kind: 'lock', ref: 'lab.lock', what: 'no free editor' }, { kind: 'machine', ref: 'pc', what: 'waiting for a free slot' }]) {
    assert.match((await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker })).text, /decide_work queue/);
  }
  // A time that is a time still blocks.
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'after the nightly', blocker: { kind: 'time', until: at, what: 'after the nightly run' } })).isError, false);
  // Queued is what the capacity wait gets: back to new, then queued with the held computer named in the note.
  store.work.get('w1')!.status = 'new';
  store.work.get('w1')!.blocked = undefined;
  agentsRoomFacts(agents, { held: [{ id: 'm5', why: "Ben's testing", for: ['game', 'agent'] }] });
  const queued = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'every sandbox is in use' });
  assert.equal(queued.isError, false, queued.text);
  assert.match(store.work.get('w1')!.log.join('\n'), /dispatcher: queued for capacity; m5 has room but is held \(Ben's testing\)/);
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w1' })).text, /Queued \(queued for capacity: no computer that could take it has room; m5 has room but is held \(Ben's testing\)\)/);
});

test('w1089: a worker whose sandbox was given away does not block on capacity: blocked_on refuses it and says the queue places it', async (t) => {
  const { store, machines, agents, dispatcher, call } = await setupOnMachine(t);
  agentsRoomFacts(agents, { agent: ['pc'] });
  putRequests(store, [{ id: 'w2' }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w2: do it', work_id: 'w2' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  await assert.rejects(async () => h.blocked_on!({ requests: ['w1'], what: 'waiting for a free sandbox: mine was given away' }), /is a wait for capacity .* That is Queued, not Blocked, and FF Factory queues it by itself/);
  assert.equal(store.work.get('w2')!.status, 'active', 'nothing was recorded');
});

test('w1089: a request already Blocked on a capacity wait (w1084 to w1088) becomes Queued by itself, keeping its place and notes; a block on a thing, or the cleanup\'s, stays', async (t) => {
  const { store, o, agents } = setup(t);
  agentsRoomFacts(agents, {});
  const gate = (what: string, by = 'dispatcher', kind: 'time' | 'request' = 'time') => ({ kind, at: T0, by, what, ...(kind === 'time' ? { until: '2026-10-12T04:35:00Z' } : { ref: 'w1' }) });
  putRequests(store, [
    { id: 'w1', status: 'active' },
    { id: 'w2', status: 'blocked', blocked: gate('a free sandbox: all in use except the m5\'s (Ben testing)'), priority: 'high', notes: [{ at: T0, by: 'Lothsahn', text: 'keep my notes' }] },
    { id: 'w3', status: 'blocked', blocked: gate("w1's fix", 'dispatcher', 'request') },
    { id: 'w4', status: 'blocked', blocked: gate('after the nightly run') },
    { id: 'w5', status: 'blocked', blocked: gate('no free sandbox', 'ledger cleanup') },
    { id: 'w6', status: 'blocked', blocked: gate('waiting for a free slot'), alsoBlocked: [gate("w1's fix", 'dispatcher', 'request')] },
  ]);
  assert.deepEqual(o.requeueCapacityBlocks(), ['w2']);
  const w2 = store.work.get('w2')!;
  assert.deepEqual([w2.status, w2.blocked, w2.alsoBlocked, w2.queuedFor, w2.priority, w2.notes?.[0].text], ['queued', undefined, undefined, { at: T0 }, 'high', 'keep my notes']);
  assert.match(w2.log.join('\n'), /ledger: was blocked on .* \(a free sandbox: all in use except the m5's \(Ben testing\)\), set by dispatcher; that is a wait for capacity, so it is Queued/);
  assert.deepEqual(['w3', 'w4', 'w5', 'w6'].map((id) => store.work.get(id)!.status), ['blocked', 'blocked', 'blocked', 'blocked'], 'a thing it also waits on, a real time and the cleanup\'s gate stay');
  assert.deepEqual(o.requeueCapacityBlocks(), [], 'once');
  // The blocker watch does it every minute.
  Object.assign(store.work.get('w4')!, { blocked: gate('no free editor') });
  const watch = new BlockerWatch({ store, orchestrators: o });
  assert.match((await watch.tick()).get('w4') ?? '', /^requeued: a block that waited only for capacity/);
  assert.equal(store.work.get('w4')!.status, 'queued');
});

test('w1098: a request on a repo that is not the game\'s needs an agent slot only: decide_work queue is refused while one has a slot, the WRONG flag counts agent slots, and the live state says so', async (t) => {
  const { store, agents, o, dispatcher, chat, call, heard } = setup(t);
  // Game room is none (RAM, no sandbox), LothDesktop has an agent slot, the m5 is held for Ben.
  agentsRoomFacts(agents, { agent: ['lothdesktop'], held: [{ id: 'm5', why: "Ben's testing", for: ['game', 'agent'] }] });
  await call(chat(BEN).info, 'request_work', { title: 'Queued waits show as Queued', brief: 'Change the dispatcher.', repo: 'Final-Factory/ff-factory' });
  await call(chat(BEN).info, 'request_work', { title: 'Fix the belt splitter desync', brief: 'In Final-Factory/FinalFactory, spec 098.', repo: 'Final-Factory/FinalFactory' });
  await call(chat(BEN).info, 'request_work', { title: 'Another FFBox change', brief: 'Only ffbox.' });
  const needs = (id: string) => store.work.get(id)!.needs;
  assert.deepEqual([needs('w1'), needs('w2'), needs('w3')], ['agent', 'game', 'agent'], 'the repo decides, once, at filing; w3 was guessed from its words');
  assert.match(store.work.get('w1')!.log.join('\n'), /filed by Ben; needs an agent slot only \(no editor, no game sandbox\) \(repo Final-Factory\/ff-factory, not the game's\)/);
  assert.match(store.work.get('w3')!.log.join('\n'), /needs an agent slot only .*guessed from its title and brief/);
  // The non-game request cannot be queued while LothDesktop has an agent slot; the game one can (no game room).
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'everything is full' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /queue is for capacity only, and lothdesktop has an agent slot \(it needs no editor and no game sandbox, w1098\) for w1 now: start it there/);
  const game = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'game work: no sandbox, RAM high' });
  assert.equal(game.isError, false, game.text);
  assert.match(store.work.get('w2')!.log.join('\n'), /queued for capacity; m5 has room but is held \(Ben's testing\)/);
  // Queued while an allowed computer has an agent slot is flagged like game work, after the grace.
  const w3 = store.work.get('w3')!;
  w3.status = 'queued';
  w3.queuedFor = { at: T0 };
  (o as unknown as { now: () => Date }).now = () => new Date(Date.parse(T0) + 11 * 60_000);
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w3' })).text, /Queued \[WRONG: lothdesktop has room\] \(queued for capacity, but lothdesktop has an agent slot/);
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), ['w3'], 'the game request is not flagged: no game room');
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[ledger] WRONG STATE').length > 0);
  assert.match(store.work.get('w3')!.log.join('\n'), /flagged: queued for capacity while lothdesktop has an agent slot \(lothdesktop: .* at this time\)|flagged: queued for capacity while lothdesktop has an agent slot \(lothdesktop: room at this time\)/);
});

test("w1089: start_agent refuses a request's worker into a sandbox another request's agent occupies; extra_agent puts it beside on purpose, never past max_agents_per_sandbox", async (t) => {
  shortSlowTurns(t);
  const { store, sessions, agents, machines, dispatcher, call } = await setupOnMachine(t, {}, { maxAgentsPerSandbox: 2 });
  agentsRoom(agents, ['pc']);
  // w2 and w3 need only an agent slot: game work never goes beside a mid-turn worker (w1607).
  putRequests(store, [{ id: 'w1' }, { id: 'w2', needs: 'agent' }, { id: 'w3', needs: 'agent' }, { id: 'w4' }, { id: 'w5', needs: 'agent' }]);
  // w5924: where the daemon makes light agent folders, agent-only work named to a full sandbox starts in a new one instead.
  const lightOn = machines.offersLight.bind(machines);
  const start = (wid: string, extra: Record<string, unknown> = {}) => call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: `#slow ${wid}`, title: `${wid}: job`, work_id: wid, ...extra });
  const first = await start('w1');
  assert.equal(first.isError, false, first.text);
  const a = /Started agent (\w+)/.exec(first.text)![1];
  await until('a is mid-turn', () => sessions.get(a).info.status === 'running');
  assert.equal(lightOn('pc'), true, 'the test daemon makes light folders');
  const light = await start('w5');
  assert.equal(light.isError, false, light.text);
  assert.match(light.text, /in sandbox pc\/agent1/);
  // Without light folders (an older daemon), the w1089 refusal stands.
  machines.offersLight = () => false;
  // 2026-10-12 ~05:50 UTC: a request's worker was started in slot5 where two agents were Working, and only queued there.
  const refused = await start('w2');
  assert.equal(refused.isError, true);
  assert.match(refused.text, /sandbox pc\/alpha is not free: \w+ "w1: job" \(Working\)\. A request's worker goes into a FREE sandbox .*pass extra_agent: true/);
  assert.equal(store.work.get('w2')!.status, 'new', 'nothing was started or linked');
  assert.equal([...sessions.sessions.values()].filter((s) => s.info.kind === 'worker').length, 2, 'no worker was made beside w1 (w5 is in its light folder)');
  // On purpose: a second agent beside it (one seat is left).
  const second = await start('w2', { extra_agent: true });
  assert.equal(second.isError, false, second.text);
  const b = /Started agent (\w+)/.exec(second.text)![1];
  await until('b is mid-turn', () => sessions.get(b).info.status === 'running');
  // Never a third: the sandbox is full (2 mid-turn of 2), and a worker started there could only wait in the send queue.
  const full = await start('w3', { extra_agent: true });
  assert.equal(full.isError, true);
  assert.match(full.text, /sandbox pc\/alpha is full: .*2 agents mid-turn there \(max_agents_per_sandbox 2\), so a worker started there would only wait in the send queue/);
  assert.equal(store.work.get('w3')!.status, 'new');
  assert.equal([...sessions.sessions.values()].filter((s) => s.info.kind === 'worker').length, 3);
});

test('w1607: a request that needs only an agent slot, started with extra_agent beside a worker with a background build, sits beside it and never switches the sandbox branch', async (t) => {
  const { agents, start, switches, branch, sessions, store } = await busySandbox(t);
  const b = await start('w2', { extra_agent: true });
  assert.equal(b.isError, false, b.text);
  assert.match(b.text, new RegExp(`Not handed over: pc/alpha stays on the branch ${branch}, which worker r80b00fe released; this worker needs only an agent seat and works in its own clone, so the sandbox's branch was not switched\\.`));
  assert.deepEqual(switches, [], 'the worktree under the build was not switched');
  const bs = sessions.get(/Started agent (\w+)/.exec(b.text)![1]);
  assert.equal(bs.info.machineSandbox, 'alpha', 'B sits beside A');
  assert.equal(store.work.get('w2')!.sessionIds.includes(bs.info.id), true);
  // The same request in a FREE sandbox on a released worker's branch is not switched either (needs: agent alone).
  const prep = await agents.prepareForNewWork('pc/alpha', undefined, 'w2', undefined, true);
  assert.equal(prep.branch, undefined);
  assert.deepEqual(switches, []);
});

test('w1607: game work is refused beside a worker with a background build, extra_agent or not, and the hand-over never switches a sandbox a live worker is in', async (t) => {
  const { agents, machines, start, switches, a, store, alpha } = await busySandbox(t);
  const plain = await start('w3');
  assert.equal(plain.isError, true);
  assert.match(plain.text, /sandbox pc\/alpha is not free: \w+ "w1: job" \(Working: Unity batch build bench-sl1\)/);
  const extra = await start('w3', { extra_agent: true });
  assert.equal(extra.isError, true);
  assert.match(extra.text, /sandbox pc\/alpha is busy: \w+ "w1: job" is between turns with Unity batch build bench-sl1 running\. Game work never goes beside a busy worker, extra_agent or not/);
  assert.equal(store.work.get('w3')!.status, 'new', 'nothing was started or linked');
  // Any other way in (a fresh session, the page's own start): the released worker's branch is A's now, so no switch.
  const prep = await agents.prepareForNewWork('pc/alpha', undefined, 'w3');
  assert.equal(prep.branch, undefined);
  assert.match(prep.note, /Not handed over: pc\/alpha stays on the branch .*, but \w+ "w1: job" is between turns with Unity batch build bench-sl1 running, so it was not switched under them\./);
  assert.deepEqual(switches, []);
  // A's build ends; a timed run from the sandbox's folder still holds the machine's bench lock: busy all the same.
  Object.assign(a.info, { backgroundTasks: 0, backgroundJobs: [] });
  const stats = machines.statsOf.bind(machines);
  const lock = { owner: `pc pid 4242 ben 22:34:00 bench-sl1 (${alpha})`, since: new Date().toISOString() };
  machines.statsOf = ((id: string) => ({ ...(stats(id) ?? {}), benchLock: lock })) as typeof machines.statsOf;
  const locked = await start('w3', { extra_agent: true });
  assert.equal(locked.isError, true);
  assert.match(locked.text, /sandbox pc\/alpha is busy: a timed run there holds pc's bench lock \(pc pid 4242/);
  assert.deepEqual(switches, []);
});

test("w1607: a bench lock belongs to the sandbox its run's folder is in, Git Bash's /f/... spelling included", () => {
  const lock = (dir: string) => ({ owner: `beast pid 812 ben 22:34:00 bench-sl1 (${dir})`, since: T0 });
  assert.equal(benchLockIn(lock('/f/ffw/sandboxes/slot1'), 'F:\\ffw\\sandboxes\\slot1'), true);
  assert.equal(benchLockIn(lock('/f/ffw/sandboxes/slot1/scripts/bench'), 'F:/ffw/sandboxes/slot1/'), true);
  assert.equal(benchLockIn(lock('/f/ffw/sandboxes/slot10'), 'F:\\ffw\\sandboxes\\slot1'), false);
  assert.equal(benchLockIn(lock('/Users/ben/ffw/sandboxes/slot2'), '/Users/ben/ffw/sandboxes/slot2'), true);
  assert.equal(benchLockIn({ owner: 'its owner line is not written yet', since: T0 }, '/Users/ben/ffw/sandboxes/slot2'), false);
  assert.equal(benchLockIn(undefined, '/Users/ben/ffw/sandboxes/slot2'), false);
});

test('w1099: the capacity ping and the queued-with-room flag list queued requests by priority, then oldest', async (t) => {
  const { store, agents, o, dispatcher, chat, call, heard } = setup(t);
  agentsRoom(agents, []);
  await call(chat(BEN).info, 'request_work', { title: 'Old normal', brief: 'First.' });
  await call(chat(BEN).info, 'request_work', { title: 'Newer normal', brief: 'Second.' });
  await call(chat(BEN).info, 'request_work', { title: 'Nightly e2e run', brief: 'Third.', priority: 'high' });
  await call(chat(LOTH).info, 'request_work', { title: 'Someday', brief: 'Fourth.', priority: 'low' });
  const at = ['2026-10-12T01:00:00.000Z', '2026-10-12T02:00:00.000Z', '2026-10-12T03:00:00.000Z', '2026-10-12T00:00:00.000Z'];
  ['w1', 'w2', 'w3', 'w4'].forEach((id, i) => {
    const w = store.work.get(id)!;
    w.createdAt = at[i];
    store.putWork(w);
  });
  for (const id of ['w2', 'w4', 'w1', 'w3']) {
    const r = await call(dispatcher().info, 'decide_work', { id, action: 'queue', note: 'every place is busy' });
    assert.equal(r.isError, false, r.text);
  }
  // w1089: the ping is sent when a computer has room at the moment it fires; here one does (and nobody has started the requests).
  agentsRoom(agents, ['lothdesktop']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  o.capacityMayHaveFreed('worker x stopped');
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  const ping = heard(dispatcher().info.id, '[ledger] Capacity may have freed').at(-1)!.text;
  const order = ['w3', 'w1', 'w2', 'w4'].map((id) => ping.indexOf(`${id} "`));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), `high first, then the normal ones oldest first, then low: ${ping}`);
  assert.match(ping, /Queued for capacity and fitting it, by priority, then started work that runs only on the computers it names, then oldest: w3 "Nightly e2e run"/);
  // The flag for requests left queued while a computer has room, in the same order.
  agentsRoom(agents, ['lothdesktop']);
  const later = Date.now() + 11 * 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(later);
  assert.deepEqual(o.flagQueuedWithRoom(['lothdesktop']), ['w3', 'w1', 'w2', 'w4']);
  // Released workers waiting for a sandbox resume in the same order (placeAgain claims, Agents.resumeOrder); one with no
  // open request last.
  ['w1', 'w2', 'w3', 'w4'].forEach((id, i) => {
    store.work.get(id)!.sessionIds = [`s${i + 1}`];
  });
  const ids = ['s5', 's2', 's4', 's1', 's3'].map((id) => ({ id }) as SessionInfo).sort((a, b) => agents.resumeOrder(a, b)).map((x) => x.id);
  assert.deepEqual(ids, ['s3', 's1', 's2', 's4', 's5']);
});

test('w3120: w2895 as it happened: two workers on one request, one running a 24 h soak with a check-in for its end; the dispatcher blocks the request on another request\'s merge: the soak keeps its check-in, the named worker\'s is held', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2' }, { id: 'w2x' }]);
  // a (738652d6) runs the soak as a background job; b (aa60d124) waits on CI of its own row and polls.
  const a = await startedFor(env, 'w2');
  const b = await secondWorkerOn(env, 'w2');
  await a.h.wake_me!({ minutes: 12 * 60, note: 'w2: the 24 h soak should have ended' });
  await b.h.wake_me!({ minutes: 20, note: "w2: check w1's PR" });
  const pr = { kind: 'pr', ref: 'Final-Factory/ffu#247', what: "w1's CI fix merging" };
  // A stranger in session_ids is refused, and nothing changes.
  const bad = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', blocker: pr, session_ids: ['deadbeef'], note: 'x' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /deadbeef is not a worker of w2/);
  // The block is about b's row: a keeps its soak's check-in; b's is held on the request, to come back when the block ends.
  const r = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', blocker: pr, session_ids: [b.id.slice(0, 8)], note: "b's row waits on w1's CI fix" });
  assert.equal(r.isError, false, r.text);
  assert.equal(agents.waker.pending(a.id)?.note, 'w2: the 24 h soak should have ended', 'the bug: "cancelled 738652d6\'s check-in"');
  assert.equal(agents.waker.pending(b.id), undefined);
  const w = store.work.get('w2')!;
  assert.equal(w.status, 'blocked');
  assert.deepEqual(w.heldCheckIns?.map((h) => h.session), [b.id]);
  assert.match(w.log.at(-1)!, new RegExp(`cancelled ${b.id}'s check-in .*; kept ${a.id}'s check-in \\(\\d\\d:\\d\\d UTC\\): the block is not about that worker`));
  // Blocking again with no session_ids holds nobody else's: a request with several workers cancels only the ones named.
  await b.h.wake_me!({ minutes: 20, note: 'w2: again' });
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'keeping the gate' })).isError, false);
  assert.equal(agents.waker.pending(a.id)?.note, 'w2: the 24 h soak should have ended');
  assert.equal(agents.waker.pending(b.id)?.note, 'w2: again');
  // One worker alone: the block holds its check-in as before (w754).
  putRequests(store, [{ id: 'w3' }]);
  const c = await startedFor(env, 'w3');
  await c.h.wake_me!({ minutes: 20, note: 'w3: poll' });
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w3', action: 'block', blocker: pr, note: 'waits on the fix' })).isError, false);
  assert.equal(agents.waker.pending(c.id), undefined);
  agents.waker.cancel(a.id);
  agents.waker.cancel(b.id);
});

test('w1696: w665 as it happened: a request whose title names another request, sent once to that request’s live worker for a side job and then again to its own, stays with its own worker; the release pass does not call its work over', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [
    { id: 'w663', title: "Ben's m5 froze on a multiplayer join" },
    { id: 'w665', title: "Mac: GPU page fault joining MP as client, freezing Ben's m5 (w663)", relatedIds: ['w663'] },
  ]);
  // dc19eb45 (b) diagnosed w663; d558ba14 (a) works w665.
  const b = await startedFor(env, 'w663');
  const a = await startedFor(env, 'w665');
  let clock = Date.now() + 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(clock);
  // 2026-10-07: the dispatcher sends w665 to b for the m5's logs: that is a real give, and w665 is b's for now.
  o.linkWorker('w665', b.info, `sent to worker ${b.id}`);
  assert.deepEqual(store.work.get('w665')!.sessionIds, [a.id, b.id]);
  assert.ok(agents.workOver(a.info)?.includes(`with another worker now (w665: ${b.id})`), String(agents.workOver(a.info)));
  // 2026-10-21: the dispatcher sends w665 to a again ("already on it"). a keeps its place in the list, b stays last.
  clock += 14 * 24 * 3_600_000;
  o.linkWorker('w665', a.info, `sent to worker ${a.id}, already on it`);
  assert.equal(store.work.get('w665')!.sessionIds.at(-1), b.id, 'the list order is the trap');
  assert.equal(agents.workOver(a.info), undefined, `the bug: "its request is with another worker now (w665: ${b.id})", and a was stopped and its temp folder swept`);
  // b still has w663, which names nobody else: its own work is not over either.
  assert.equal(agents.workOver(b.info), undefined);
});

test('w1094: w1049 as it happened: the worker that set a ci: gate keeps its request while another, newer worker waits on Ben; CI finishing resumes the setter, not the newer one, whose own check-in stays its', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w1x' }]);
  const pr = 'Final-Factory/FinalFactory#1507';
  let checks: { done: boolean; text: string } = { done: false, text: `1 of 1 workflow runs on ${pr} still running (Test Runner)` };
  let clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, ci: async () => checks });
  // 0b5f813d (a) works bug 5 on w1049; 39772f0c (b) is linked after it for bug 6 and waits on Ben with a check-in.
  const a = await startedFor(env, 'w1');
  const b = await secondWorkerOn(env, 'w1');
  assert.equal(store.work.get('w1')!.sessionIds.at(-1), b.id, 'b is the newest worker on it');
  await b.h.wake_me!({ minutes: 120, note: 'w1: ask Ben again about bug 6' });
  assert.match(String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], what: 'CI on PR #1507 (bug 5)' })), /^Recorded: w1 is Blocked on CI on/);
  assert.equal(agents.waker.pending(b.id)?.note, 'w1: ask Ben again about bug 6', "a's gate does not cancel b's own check-in");
  // The release pass: a waits on CI (its sandbox may go and it is placed again); its work is not "with another worker now".
  assert.equal(agents.workOver(a.info), undefined, 'the bug: "its request is with another worker now (w1049: 39772f0c)"');
  assert.equal(agents.ciWait(a.info), `it waits on CI (w1: CI on ${pr})`);
  assert.equal(agents.ciWait(b.info), undefined, "a's CI is not b's wait");
  // While it runs, the ledger says what the checks say.
  await watch.tick();
  assert.equal(store.work.get('w1')!.blocked!.read!.text, checks.text);
  assert.match(agents.workLive().get('w1')!.why, /last read: 1 of 1 workflow runs on Final-Factory\/FinalFactory#1507 still running \(Test Runner\) \(0 min ago\)$/);
  // CI finishes: a is resumed with the hint, b keeps its own check-in.
  checks = { done: true, text: `CI on ${pr} finished: all 1 workflow runs passed or skipped` };
  clock += 3 * 60_000;
  assert.equal((await watch.tick()).get('w1'), `clear: ${checks.text}`);
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'active');
  assert.equal(agents.waker.pending(a.id)?.note, `w1 is unblocked: CI on ${pr} cleared (${checks.text}). Run ff-pr merge now (${pr}): it merges on green, or names the red run to read (gh run view <run> --log-failed) and fix. Carry on from where you left it.`);
  assert.equal(agents.waker.pending(b.id)?.note, 'w1: ask Ben again about bug 6');
  assert.ok(w.log.at(-1)!.includes(`unblocked (its worker ${a.id} resumes within a minute)`), w.log.at(-1)!);
  assert.deepEqual(w.gateResumes?.map((r) => r.session), [a.id], 'recorded for the sweep');
  agents.waker.cancel(a.id);
  agents.waker.cancel(b.id);
});

test('w1094: the worker that set a ci: gate is gone: the newest worker is resumed and told the merge is its now', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w1x' }]);
  const pr = 'Final-Factory/FinalFactory#1507';
  let checks = { done: false, text: 'running' };
  const watch = new BlockerWatch({ store, orchestrators: o, ci: async () => checks });
  const a = await startedFor(env, 'w1');
  const b = await secondWorkerOn(env, 'w1');
  await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], what: 'CI on PR #1507' });
  await watch.tick();
  store.sessions.delete(a.id);
  checks = { done: true, text: `CI on ${pr} finished: all 1 workflow runs passed or skipped` };
  (watch as unknown as { ciSeen: Map<string, unknown> }).ciSeen.clear();
  await watch.tick();
  assert.equal(store.work.get('w1')!.status, 'active');
  assert.equal(agents.waker.pending(b.id)?.note, `w1 is unblocked: CI on ${pr} cleared (${checks.text}). Worker ${a.id} set this gate and is gone, so the merge of ${pr} is yours now: you own it (merge on green, fix on red). Run ff-pr merge now (${pr}): it merges on green, or names the red run to read (gh run view <run> --log-failed) and fix. Carry on from where you left it.`);
  agents.waker.cancel(b.id);
});

test('w2045: merge on green: a worker in the arm is told it may leave its report; on green CI FF Factory merges at its head and files the report, which closes the request with no turn of the worker', async (t) => {
  const own = ownPrs('abc1234def5678');
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  mergeOnGreenArm(o, (id) => id === 'w1');
  const pr = 'Final-Factory/FinalFactory#2045';
  const head = 'abc1234def5678';
  let checks: { done: boolean; text: string; green?: true } = { done: false, text: `1 of 1 checks on ${pr} still running` };
  const merges: string[][] = [];
  const watch = new BlockerWatch({ store, orchestrators: o, prHealth: own, ci: async () => checks, merge: async (ref, h) => void merges.push([ref, h]) });
  env.agents.prHealth = own;
  const a = await startedFor(env, 'w1');
  const told = String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on PR #2045' }));
  assert.match(told, /^w1 is in the merge-on-green pilot \(w2045\): .*merge_on_green: the report you would write after the merge/);
  assert.match(told, /Recorded: w1 is Blocked on CI on/);
  assert.equal(store.work.get('w1')!.blocked!.mergeOnGreen, undefined, 'not until it leaves its report');
  const report = 'TL;DR: the fix is in.\n\nDONE: w1\nLearned: nothing new';
  const set = String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on PR #2045', merge_on_green: report }));
  assert.match(set, /^Recorded: w1 is Blocked on CI on .*, merge on green \(w2045\)\. .*no DONE line now/);
  assert.deepEqual(store.work.get('w1')!.blocked!.mergeOnGreen, { head, report, session: a.id, headRef: 'w1-fix' });
  // A DONE in the turn that ends now is the report's, filed after the merge: it does not close the request yet.
  o.workerTurnEnded(a.info, 'DONE: w1\nLearned: nothing new');
  assert.equal(store.work.get('w1')!.status, 'blocked');
  await watch.tick();
  assert.deepEqual(merges, [], 'nothing merged while CI runs');
  checks = { done: true, green: true, text: `CI on ${pr} finished: all 1 checks passed or skipped` };
  (watch as unknown as { ciSeen: Map<string, unknown> }).ciSeen.clear();
  await watch.tick();
  assert.deepEqual(merges, [[pr, head]]);
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'done', w.log.slice(-3).join(' | '));
  assert.ok(w.log.some((l) => l.includes(`merge-on-green pilot (w2045): FF Factory merged ${pr} at abc1234def56 on green CI with no model turn`)));
  assert.equal(agents.waker.pending(a.id), undefined, 'the worker is not resumed');
});

test("w5549: merge_on_green arms only on the worker's own pull request, read from GitHub: another worker's or a fork's is refused with why, and a head renamed after arming is not merged", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  mergeOnGreenArm(o, () => true);
  const head = 'abc1234def5678';
  const report = 'DONE: w1\nLearned: nothing new';
  const heads = new Map<string, PrHealth>([
    ['Final-Factory/FinalFactory#10', { state: 'open', head, headRef: 'w1-fix', headRepo: 'Final-Factory/FinalFactory' }],
    ['Final-Factory/FinalFactory#11', { state: 'open', head, headRef: 'sandbox/slot1-w5480', headRepo: 'Final-Factory/FinalFactory' }],
    ['Final-Factory/FinalFactory#12', { state: 'open', head, headRef: 'w1-fix', headRepo: 'someone/FinalFactory', crossRepo: true }],
  ]);
  agents.prHealth = async (ref) => heads.get(ref);
  const merges: string[] = [];
  const checks = { done: true, green: true as const, text: 'CI finished: all 1 checks passed or skipped' };
  const watch = new BlockerWatch({ store, orchestrators: o, ci: async () => checks, merge: async (ref) => void merges.push(ref), prHealth: async (ref) => heads.get(ref) });
  const a = await startedFor(env, 'w1');
  const arm = (n: number) => a.h.blocked_on!({ request: 'w1', prs: [`ci:Final-Factory/FinalFactory#${n}`], head, what: `CI on #${n}`, merge_on_green: report });
  // Another worker's pull request (w5480's sandbox branch): refused, saying why, and nothing recorded.
  await assert.rejects(arm(11), /merge_on_green refused: FF Factory merges on green only your own pull request \(w5549\), and Final-Factory\/FinalFactory#11 is not yours: its head branch is sandbox\/slot1-w5480, which is not (your sandbox's branch \(.*\) or )?a branch named for w1 \(w1-<what>\): it is not your request's pull request\. .*Nothing was recorded\./);
  // A fork's head, though its branch is named for w1: refused.
  await assert.rejects(arm(12), /Final-Factory\/FinalFactory#12 is not yours: its head is someone\/FinalFactory:w1-fix, a branch of another repository \(a fork\)/);
  // A pull request FF Factory cannot read: refused, never a guess.
  await assert.rejects(arm(13), /#13 is not yours: FF Factory could not read/);
  assert.equal(store.work.get('w1')!.blocked, undefined, 'nothing recorded by a refusal');
  // Its own: armed, with the head branch GitHub named.
  const set = String(await arm(10));
  assert.doesNotMatch(set, /ignored|refused/, set);
  assert.equal(store.work.get('w1')!.blocked!.mergeOnGreen!.headRef, 'w1-fix');
  o.workerTurnEnded(a.info, 'w1: still open: blocked on CI on #10');
  // The head is renamed (another branch pushed in its place) before CI is green: not merged, and the worker is told why.
  heads.set('Final-Factory/FinalFactory#10', { state: 'open', head, headRef: 'w5480-other', headRepo: 'Final-Factory/FinalFactory' });
  await watch.tick();
  assert.deepEqual(merges, []);
  assert.match(agents.waker.pending(a.id)?.note ?? '', /Final-Factory\/FinalFactory#10's head is Final-Factory\/FinalFactory:w5480-other, not Final-Factory\/FinalFactory:w1-fix/);
  agents.waker.cancel(a.id);
});

test('w5316: a merge-on-green gate survives a close, a reopen and the dispatcher re-blocking on the same PR merging, and still merges on green', async (t) => {
  const own = ownPrs('d4c4fa3d857e2053e3a6adf63acb8cb5db0c6bba');
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, chat, call } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  mergeOnGreenArm(o, (id) => id === 'w1');
  const pr = 'Final-Factory/ffu#998';
  const head = 'd4c4fa3d857e2053e3a6adf63acb8cb5db0c6bba';
  let checks: { done: boolean; text: string; green?: true } = { done: false, text: `1 of 1 checks on ${pr} still running` };
  const merges: string[][] = [];
  const watch = new BlockerWatch({ store, orchestrators: o, prHealth: own, ci: async () => checks, merge: async (ref, h) => void merges.push([ref, h]) });
  env.agents.prHealth = own;
  const a = await startedFor(env, 'w1');
  const report = 'The fix merged.\n\nDONE: w1\nLearned: nothing new';
  await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on ffu#998', merge_on_green: report });
  o.workerTurnEnded(a.info, 'w1: still open: blocked on CI on Final-Factory/ffu#998');
  // w5234 at 14:10: lothsahn closed it as done, then reopened it while CI ran.
  const loth = chat(LOTH);
  loth.lastFrom = 'human';
  assert.equal((await call(loth.info, 'update_work', { id: 'w1', close: 'done', note: 'Its follow-up is covered.' })).isError, false);
  const r = await call(loth.info, 'update_work', { id: 'w1', reopen: true, note: 'Reopened: I closed this too early, #998 has not merged.' });
  assert.equal(r.isError, false, r.text);
  let w = store.work.get('w1')!;
  assert.equal(w.status, 'blocked', `a reopen keeps the gates it had: ${w.log.slice(-2).join(' | ')}`);
  assert.equal(w.blocked!.mergeOnGreen?.head, head);
  assert.match(w.log.at(-1)!, /reopened \(.*\); blocked again on CI on Final-Factory\/ffu#998, the gate its close dropped \(w5316\), merge on green/);
  // Then the dispatcher blocked it on the PR merging: that wait ends in the merge FF Factory makes, so the gate stays.
  const b = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'Reopened: waits for #998 to merge.', blocker: { kind: 'pr', ref: pr, what: 'ffu PR #998 merging' } });
  assert.equal(b.isError, false, b.text);
  w = store.work.get('w1')!;
  assert.equal(w.status, 'blocked');
  assert.equal(w.blocked!.kind, 'ci');
  assert.equal(w.blocked!.mergeOnGreen?.head, head, 'the merge-on-green intent is kept');
  assert.equal(w.alsoBlocked, undefined);
  checks = { done: true, green: true, text: `CI on ${pr} finished: all 1 checks passed or skipped` };
  await watch.tick();
  assert.deepEqual(merges, [[pr, head]]);
});

test('w4498: arming merge on green checks the PR at once: a draft is refused with gh pr ready, a failing Evidence check with the section to add; a passing PR still arms', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  mergeOnGreenArm(o, () => true);
  const pr = 'Final-Factory/FinalFactory#3741';
  const head = 'abc1234def5678';
  const report = 'TL;DR: in.\n\nDONE: w1\nLearned: nothing new';
  let health: PrHealth = { state: 'open', head, headRef: 'w1-draft', headRepo: 'Final-Factory/FinalFactory', draft: true };
  let evidence: string | undefined;
  const asked: string[] = [];
  agents.prHealth = async () => health;
  agents.prEvidence = async (ref) => (asked.push(ref), evidence);
  const a = await startedFor(env, 'w1');
  // #3741 as it happened: still a draft. Refused now, with the command that fixes it; nothing recorded.
  await assert.rejects(
    async () => a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on #3741', merge_on_green: report }),
    /merge_on_green refused: PR #3741 is still a draft, and GitHub will not merge a draft\. Run gh pr ready 3741 -R Final-Factory\/FinalFactory, then call blocked_on again with merge_on_green\. Nothing was recorded\./,
  );
  assert.equal(store.work.get('w1')!.status, 'active');
  // #3748 and #3760 as they happened: no Evidence section. Refused now, with the check's lines and the section to add.
  health = { state: 'open', head, headRef: 'w1-draft', headRepo: 'Final-Factory/FinalFactory' };
  evidence = 'the Evidence check refused it (pr_evidence.py --repo Final-Factory/FinalFactory --pr 3741, exit 1):\n  - no "## Evidence" section';
  await assert.rejects(
    async () => a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on #3741', merge_on_green: report }),
    (e: Error) => {
      assert.match(e.message, /^merge_on_green refused: PR #3741 would not merge on green, because the Evidence check refused it .*\n {2}- no "## Evidence" section\n/);
      assert.match(e.message, /gh pr edit 3741 --body-file <f>\): a "## Evidence" section with a "Kind:" line \(Kind: other/);
      assert.match(e.message, /a claims table .* and a "Not verified:" line/);
      assert.match(e.message, /Nothing was recorded\.$/);
      return true;
    },
  );
  assert.equal(store.work.get('w1')!.status, 'active');
  assert.equal(store.work.get('w1')!.blocked, undefined);
  // A wait without merge_on_green is not checked for evidence, and a draft may wait on CI.
  health = { state: 'open', head, headRef: 'w1-draft', headRepo: 'Final-Factory/FinalFactory', draft: true };
  asked.length = 0;
  assert.match(String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on #3741' })), /Recorded: w1 is Blocked on CI on/);
  assert.deepEqual(asked, []);
  // Ready, and the Evidence check passes: it arms.
  health = { state: 'open', head, headRef: 'w1-draft', headRepo: 'Final-Factory/FinalFactory' };
  evidence = undefined;
  const set = String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on #3741', merge_on_green: report }));
  assert.match(set, /^Recorded: w1 is Blocked on CI on .*, merge on green \(w2045\)/);
  assert.deepEqual(asked, [pr]);
  assert.deepEqual(store.work.get('w1')!.blocked!.mergeOnGreen, { head, report, session: a.id, headRef: 'w1-draft' });
});

test('w3021: merge on green with a short head: blocked_on records the PR head whole, and a head recorded short still merges at the full sha and files the report', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  mergeOnGreenArm(o, () => true);
  const full = '3e14de3aa5160f0e8d2c7b9a4f1e6d3c2b1a0f9e';
  const short = full.slice(0, 12);
  const report = (id: string) => `TL;DR: merged.\n\nDONE: ${id}\nLearned: nothing new`;
  const ffu = 'Final-Factory/ffu#200';
  const other = 'Final-Factory/ffu#201';
  // w1: the PR is read at blocked_on (w907), and its head starts with the short sha: the full one is recorded.
  agents.prHealth = async (ref) => ({ state: 'open', head: full, headRef: 'w1-w3016', headRepo: ref.split('#')[0] });
  const a = await startedFor(env, 'w1');
  await a.h.blocked_on!({ request: 'w1', prs: [`ci:${ffu}`], head: short, what: 'CI on ffu#200', merge_on_green: report('w1') });
  assert.equal(store.work.get('w1')!.blocked!.mergeOnGreen!.head, full);
  // w2: the PR could not be read then (ffu#200 as it happened): since w5549 that is refused, since FF Factory cannot tell
  // it is w2's own; a gate recorded short before then still merges at the full sha.
  agents.prHealth = async () => undefined;
  const b = await startedFor(env, 'w2');
  await assert.rejects(
    async () => b.h.blocked_on!({ request: 'w2', prs: [`ci:${other}`], head: short, what: 'CI on ffu#201', merge_on_green: report('w2') }),
    /merge_on_green refused: FF Factory merges on green only your own pull request \(w5549\), and Final-Factory\/ffu#201 is not yours: FF Factory could not read Final-Factory\/ffu#201's head branch from GitHub/,
  );
  agents.prHealth = async (ref) => ({ state: 'open', head: short, headRef: 'w2-w3016', headRepo: ref.split('#')[0] });
  await b.h.blocked_on!({ request: 'w2', prs: [`ci:${other}`], head: short, what: 'CI on ffu#201', merge_on_green: report('w2') });
  assert.equal(store.work.get('w2')!.blocked!.mergeOnGreen!.head, short);
  // The merge runs through the real ghMerge against a gh that, as GitHub does, refuses any expectedHeadOid but a full sha.
  const gh: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    // w3098: ffu's merges run the Evidence check first; it passes here.
    if (cmd !== 'gh') return { code: 0, stdout: 'evidence-gate: PASS', stderr: '' } as never;
    gh.push(args);
    if (args[1] === 'view') return { code: 0, stdout: JSON.stringify({ headRefOid: full }), stderr: '' } as never;
    const oid = args[args.indexOf('--match-head-commit') + 1];
    return (oid === full ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: `GraphQL: Could not coerce value "${oid}" to GitObjectID` }) as never;
  };
  const green = (ref: string) => ({ done: true, green: true as const, text: `CI on ${ref} finished: all 1 checks passed or skipped` });
  const watch = new BlockerWatch({ store, orchestrators: o, ci: async (ref) => green(ref), merge: (ref, h) => ghMerge(ref, h, run, () => 'pe.py'), prHealth: async (ref) => ({ state: 'open', head: full, headRef: ref.endsWith('#200') ? 'w1-w3016' : 'w2-w3016', headRepo: ref.split('#')[0] }) });
  await watch.tick();
  assert.deepEqual(
    gh.filter((x) => x[1] === 'merge').map((x) => x[x.indexOf('--match-head-commit') + 1]),
    [full, full],
    'both merged at the full sha',
  );
  for (const id of ['w1', 'w2']) {
    const w = store.work.get(id)!;
    assert.equal(w.status, 'done', `${id}: the report left with merge_on_green was filed: ${w.log.slice(-3).join(' | ')}`);
    assert.ok(w.log.some((l) => l.includes(`FF Factory merged Final-Factory/ffu#20`) && l.includes(`at ${short} on green CI`)));
  }
});

test('w2045: merge on green: red CI, or a merge GitHub refuses, resumes the worker as without it, saying the report was not filed', async (t) => {
  const own = ownPrs('abc1234def5678', (ref) => (ref.endsWith('#1') ? 'w1' : 'w2'));
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  mergeOnGreenArm(o, () => true);
  const head = 'abc1234def5678';
  const checks = new Map<string, { done: boolean; text: string; green?: true }>();
  const merges: string[] = [];
  const watch = new BlockerWatch({
    store,
    orchestrators: o,
    prHealth: own,
    ci: async (ref) => checks.get(ref),
    merge: async (ref) => {
      merges.push(ref);
      throw new Error(`gh pr merge ${ref}: Head branch was modified. Review and try the merge again.`);
    },
  });
  const report = 'DONE: w1\nLearned: nothing new';
  const red = 'Final-Factory/FinalFactory#1';
  const refused = 'Final-Factory/FinalFactory#2';
  env.agents.prHealth = own;
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  await a.h.blocked_on!({ request: 'w1', prs: [`ci:${red}`], head, what: 'CI', merge_on_green: report });
  await b.h.blocked_on!({ request: 'w2', prs: [`ci:${refused}`], head, what: 'CI', merge_on_green: report.replace('w1', 'w2') });
  checks.set(red, { done: true, text: `CI on ${red} finished: 1 of 1 checks failed (Test in editmode)` });
  checks.set(refused, { done: true, green: true, text: `CI on ${refused} finished: all 1 checks passed or skipped` });
  await watch.tick();
  assert.deepEqual(merges, [refused], 'red is never merged');
  assert.equal(store.work.get('w1')!.status, 'active');
  assert.match(agents.waker.pending(a.id)!.note, /1 of 1 checks failed \(Test in editmode\); FF Factory did not merge it \(the checks are not all green\), and the report you left with merge_on_green was not filed\)\. Run ff-pr merge now/);
  assert.equal(store.work.get('w2')!.status, 'active');
  assert.match(agents.waker.pending(b.id)!.note, /FF Factory tried to merge it: gh pr merge Final-Factory\/FinalFactory#2: Head branch was modified\. .*Merge it yourself \(ff-pr merge\)/);
  agents.waker.cancel(a.id);
  agents.waker.cancel(b.id);
});

test('w4531: merge on green, a transient GitHub error (502, GraphQL) is tried again next tick, not handed to the worker; it resumes only after MERGE_TRIES', async (t) => {
  const own = ownPrs('abc1234def5678', (ref) => (ref.endsWith('#1') ? 'w1' : 'w2'));
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  mergeOnGreenArm(o, () => true);
  const head = 'abc1234def5678';
  const checks = new Map<string, { done: boolean; text: string; green?: true }>();
  const merges: string[] = [];
  const passes = 'Final-Factory/ffu#1';
  const down = 'Final-Factory/ffu#2';
  const watch = new BlockerWatch({
    store,
    orchestrators: o,
    prHealth: own,
    ci: async (ref) => checks.get(ref),
    merge: async (ref) => {
      merges.push(ref);
      if (ref === down || merges.filter((r) => r === ref).length < 3) {
        throw new Error(ref === down ? `gh pr merge ${ref}: non-200 OK status code: 502 Bad Gateway body: "<html>"` : `gh pr merge ${ref}: GraphQL: Something went wrong while executing your query on 2026-11-16T10:27:02Z.`);
      }
    },
  });
  env.agents.prHealth = own;
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  await a.h.blocked_on!({ request: 'w1', prs: [`ci:${passes}`], head, what: 'CI', merge_on_green: 'DONE: w1\nLearned: nothing new' });
  await b.h.blocked_on!({ request: 'w2', prs: [`ci:${down}`], head, what: 'CI', merge_on_green: 'DONE: w2\nLearned: nothing new' });
  for (const ref of [passes, down]) checks.set(ref, { done: true, green: true, text: `CI on ${ref} finished: all 1 checks passed or skipped` });
  await watch.tick();
  await watch.tick();
  assert.equal(store.work.get('w1')!.status, 'blocked', 'two transient failures: still waiting, nobody resumed');
  assert.equal(agents.waker.pending(a.id), undefined);
  await watch.tick();
  assert.equal(store.work.get('w1')!.status, 'done', 'merged on the third try and its report filed');
  for (let i = 3; i < MERGE_TRIES; i++) await watch.tick();
  assert.equal(merges.filter((r) => r === down).length, MERGE_TRIES);
  assert.equal(store.work.get('w2')!.status, 'active', 'still failing after MERGE_TRIES: the worker is resumed to merge it');
  assert.match(agents.waker.pending(b.id)!.note, /FF Factory tried to merge it: gh pr merge Final-Factory\/ffu#2: non-200 OK status code: 502 Bad Gateway.*Merge it yourself \(ff-pr merge\)/);
  agents.waker.cancel(b.id);
});

test('w3906: merge on green, CI green but GitHub refuses the merge as not mergeable: the report is kept, the worker gets the remerge job, and its next blocked_on re-arms the merge with that report', async (t) => {
  let cur = 'abc1234def5678';
  const own = ownPrs(() => cur);
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  mergeOnGreenArm(o, () => true);
  const pr = 'Final-Factory/ffu#593';
  const head = 'abc1234def5678';
  const after = 'fed9876cba5432';
  const report = 'TL;DR: M1.34 is in.\n\nDONE: w1\nLearned: nothing new';
  let checks: { done: boolean; text: string; green?: true } = { done: true, green: true, text: `CI on ${pr} finished: all 6 checks passed or skipped` };
  const merges: string[][] = [];
  let refuse = true;
  const watch = new BlockerWatch({
    store,
    orchestrators: o,
    prHealth: own,
    ci: async () => checks,
    merge: async (ref, h) => {
      merges.push([ref, h]);
      // ffu #593 on 2026-11-09, as gh said it.
      if (refuse) throw new Error(`gh pr merge ${ref}: Pull request Final-Factory/ffu#593 is not mergeable: the merge commit cannot be cleanly created.`);
    },
  });
  env.agents.prHealth = own;
  const a = await startedFor(env, 'w1');
  await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on ffu#593', merge_on_green: report });
  await watch.tick();
  assert.deepEqual(merges, [[pr, head]]);
  let w = store.work.get('w1')!;
  assert.equal(w.status, 'active');
  assert.deepEqual({ ref: w.keptMergeReport?.ref, head: w.keptMergeReport?.head, report: w.keptMergeReport?.report, session: w.keptMergeReport?.session }, { ref: pr, head, report, session: a.id }, 'the report survives');
  assert.ok(w.log.some((l) => l.includes(`refused the merge of ${pr}`) && l.includes('report is kept')));
  assert.ok(!w.log.some((l) => l.includes('was not filed')));
  const note = agents.waker.pending(a.id)!.note;
  assert.match(note, /not mergeable as it stands at abc1234def56: its base moved under it and conflicts\. FF Factory kept the report you left with merge_on_green/);
  assert.match(note, /run ff-pr push, which merges the base in.*tools\/keep_sorted\.py --remerge.*call blocked_on with the same prs, the new head, and no merge_on_green/);
  assert.doesNotMatch(note, /not filed|Run ff-pr merge now/);
  agents.waker.cancel(a.id);
  // The worker merged main in and pushed: it blocks again with the new head and no report, and the merge is re-armed with the kept one.
  cur = after;
  const told = String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head: after, what: 'CI on ffu#593 after the remerge' }));
  assert.match(told, /merge on green \(w2045\), re-armed with the report you left before \(w3906\)/);
  w = store.work.get('w1')!;
  assert.deepEqual(w.blocked!.mergeOnGreen, { head: after, report, session: a.id, headRef: 'w1-fix' });
  assert.equal(w.keptMergeReport, undefined);
  // Green CI again (never rerun to get it: the same green-only rule holds), and this time it merges, filing the kept report.
  refuse = false;
  checks = { done: true, green: true, text: `CI on ${pr} finished: all 6 checks passed or skipped` };
  (watch as unknown as { ciSeen: Map<string, unknown> }).ciSeen.clear();
  await watch.tick();
  assert.deepEqual(merges[1], [pr, after]);
  w = store.work.get('w1')!;
  assert.equal(w.status, 'done', w.log.slice(-3).join(' | '));
  assert.equal(agents.waker.pending(a.id), undefined, 'the worker is not resumed');
});

test('w3906: a not-mergeable refusal is told apart from the other refusals, which still say merge it yourself', () => {
  assert.ok(notMergeableRefusal('gh pr merge Final-Factory/ffu#606: Pull request Final-Factory/ffu#606 is not mergeable: the merge commit cannot be cleanly created.'));
  assert.ok(notMergeableRefusal('GraphQL: Head branch is not up to date with the base branch (mergePullRequest)'));
  assert.ok(!notMergeableRefusal('gh pr merge Final-Factory/FinalFactory#2: Head branch was modified. Review and try the merge again.'));
  assert.ok(!notMergeableRefusal('not merged: the Evidence check failed'));
  assert.doesNotMatch(remergeJob('Final-Factory/FinalFactory#9'), /keep_sorted/, 'the ffu helper only for ffu');
});

test("w2153: w2146 as it happened: two legs each wait on their own PR's CI with merge on green; the second leg's blocked_on keeps the first's gate, the first leg is not stopped as idle when the second merges and says DONE, and it is merged when its own CI is green", async (t) => {
  const own = ownPrs((ref) => (ref.endsWith('#2524') ? 'aaaa1111bbbb' : 'cccc2222dddd'));
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w1x' }]);
  mergeOnGreenArm(o, (id) => id === 'w1');
  const host = 'Final-Factory/FinalFactory#2524';
  const client = 'Final-Factory/FinalFactory#2525';
  const running = (ref: string) => ({ done: false, text: `1 of 1 checks on ${ref} still running` });
  const green = (ref: string) => ({ done: true, green: true as const, text: `CI on ${ref} finished: all 1 workflow runs passed or skipped` });
  const checks = new Map<string, { done: boolean; text: string; green?: true }>([
    [host, running(host)],
    [client, running(client)],
  ]);
  const merges: string[] = [];
  const watch = new BlockerWatch({ store, orchestrators: o, prHealth: own, ci: async (ref) => checks.get(ref), merge: async (ref) => void merges.push(ref) });
  const tick = async () => {
    (watch as unknown as { ciSeen: Map<string, unknown> }).ciSeen.clear();
    return watch.tick();
  };
  env.agents.prHealth = own;
  const a = await startedFor(env, 'w1');
  const b = await secondWorkerOn(env, 'w1');
  // 14:20: the host leg (a4d94148) waits on #2524 and leaves its report; 14:22: the client leg (26258346) on #2525.
  await a.h.blocked_on!({ request: 'w1', prs: [`ci:${host}`], head: 'aaaa1111bbbb', what: 'CI on PR #2524, then merge', merge_on_green: 'Host leg: all six steps passed.\n\nDONE: w1\nLearned: nothing new' });
  await b.h.blocked_on!({ request: 'w1', prs: [`ci:${client}`], head: 'cccc2222dddd', what: 'CI on PR #2525, then merge', merge_on_green: 'Client leg finished.\n\nDONE: w1\nLearned: nothing new' });
  assert.deepEqual(gateRefs(store.work.get('w1')!), [`worker ${a.id}: ci ${host}`, `worker ${b.id}: ci ${client}`].sort(), "the client leg's wait does not drop the host leg's");
  assert.equal(agents.workOver(a.info), undefined, 'the host leg is still with its request');
  // #2525 is green first: FF Factory merges it and files the client leg's DONE for its part.
  checks.set(client, green(client));
  await tick();
  assert.deepEqual(merges, [client]);
  let w = store.work.get('w1')!;
  assert.ok(w.done?.[b.id], `the client leg's report is filed: ${w.log.slice(-3).join(' | ')}`);
  assert.equal(w.status, 'blocked', w.log.slice(-3).join(' | '));
  assert.deepEqual(gateRefs(w), [`worker ${a.id}: ci ${host}`]);
  // 14:23:20Z: the release pass stopped a4d94148 as "its request is with another worker now". Not any more.
  assert.equal(agents.workOver(a.info), undefined, 'not "with another worker now" while its gate waits');
  assert.equal(agents.workLive().get('w1')!.state, 'blocked', 'Blocked on its CI, never Stalled');
  // #2524 is green: merged on green, and the host leg's report closes the request.
  checks.set(host, green(host));
  await tick();
  assert.deepEqual(merges, [client, host]);
  w = store.work.get('w1')!;
  assert.equal(w.status, 'done', w.log.slice(-3).join(' | '));
});

test("w2153: w2137 as it happened: one leg waits on another PR merging and on its own CI; the other leg's later blocked_on and DONE keep that wait, each leg is resumed when its own gates clear, and the request stays Blocked on the rest meanwhile", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w1x' }]);
  const tests = 'Final-Factory/FinalFactory#2511';
  const docs = 'Final-Factory/FinalFactory#2516';
  const hostPr = 'Final-Factory/FinalFactory#2514';
  const checks = new Map<string, { done: boolean; text: string; green?: true }>([
    [docs, { done: false, text: 'running' }],
    [hostPr, { done: false, text: 'running' }],
  ]);
  const prs = new Map<string, { state: 'open' | 'merged' | 'closed'; text: string }>([[tests, { state: 'open', text: `${tests} is open` }]]);
  const watch = new BlockerWatch({ store, orchestrators: o, ci: async (ref) => checks.get(ref), pr: async (ref) => prs.get(ref) });
  const tick = async () => {
    (watch as unknown as { ciSeen: Map<string, unknown> }).ciSeen.clear();
    (watch as unknown as { prSeen: Map<string, unknown> }).prSeen.clear();
    return watch.tick();
  };
  const host = await startedFor(env, 'w1');
  const client = await secondWorkerOn(env, 'w1');
  // 12:27: the client leg (6ebd3483) waits on #2511 merging and CI on its docs PR #2516; then the host leg (6e664be4) on #2514.
  await client.h.blocked_on!({ request: 'w1', prs: [tests, `ci:${docs}`], what: '#2511 to merge first, then CI on #2516' });
  await host.h.blocked_on!({ request: 'w1', prs: [`ci:${hostPr}`], what: 'CI on PR #2514' });
  assert.deepEqual(gateRefs(store.work.get('w1')!), [`worker ${client.id}: ci ${docs}`, `worker ${client.id}: pr ${tests}`, `worker ${host.id}: ci ${hostPr}`].sort());
  // The host's CI finishes: the host leg is resumed; the client leg's wait stays.
  checks.set(hostPr, { done: true, green: true, text: `CI on ${hostPr} finished: all 2 workflow runs passed or skipped` });
  await tick();
  let w = store.work.get('w1')!;
  assert.equal(w.status, 'blocked', w.log.slice(-3).join(' | '));
  assert.deepEqual(gateRefs(w), [`worker ${client.id}: ci ${docs}`, `worker ${client.id}: pr ${tests}`]);
  assert.ok((agents.waker.pending(host.id)?.note ?? '').includes(`Run ff-pr merge now (${hostPr})`), String(agents.waker.pending(host.id)?.note));
  assert.equal(agents.waker.pending(client.id), undefined, 'the client leg waits on');
  agents.waker.cancel(host.id);
  // 12:35: the host leg says DONE for its part. The client leg is still with the request, and it is not Stalled.
  o.workerTurnEnded(host.info, 'Host leg finished.\n\nDONE: w1\nLearned: nothing new');
  w = store.work.get('w1')!;
  assert.equal(w.status, 'blocked', w.log.slice(-3).join(' | '));
  assert.equal(agents.workOver(client.info), undefined);
  assert.equal(agents.workLive().get('w1')!.state, 'blocked');
  // 12:38: #2511 merges, and CI on #2516 finishes: the client leg is resumed to merge its PR.
  prs.set(tests, { state: 'merged', text: `${tests} merged` });
  checks.set(docs, { done: true, green: true, text: `CI on ${docs} finished: all 1 workflow runs passed or skipped` });
  await tick();
  w = store.work.get('w1')!;
  assert.equal(w.status, 'active', w.log.slice(-3).join(' | '));
  assert.ok((agents.waker.pending(client.id)?.note ?? '').includes(`Run ff-pr merge now (${docs})`), String(agents.waker.pending(client.id)?.note));
  agents.waker.cancel(client.id);
});

test("w2153: a leg moved to another sandbox (w2046) while the other leg waits on its own CI keeps that wait: the request stays Blocked on it and the move is not refused", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w1x' }]);
  const ref = 'Final-Factory/FinalFactory#2525';
  const a = await startedFor(env, 'w1');
  const b = await secondWorkerOn(env, 'w1');
  await b.h.blocked_on!({ request: 'w1', prs: [`ci:${ref}`], what: 'CI on PR #2525' });
  const w = store.work.get('w1')!;
  o.movedForRoom(w, a.info, { machine: 'pc', sandbox: 'slot1', branch: 'w1-host', why: 'room', note: '', how: 'moved', to: 'pc/slot2' } as Parameters<Orchestrators['movedForRoom']>[2]);
  const moved = { ...a.info, id: 'feed0001', machineSandbox: 'slot2' };
  store.putSession(moved);
  o.linkWorker('w1', moved, 'started worker feed0001 in pc/slot2: moved from worker a (w2046)', { moved: true });
  const after = store.work.get('w1')!;
  assert.deepEqual(gateRefs(after), [`worker ${b.id}: ci ${ref}`], after.log.slice(-2).join(' | '));
  assert.equal(after.status, 'blocked');
  assert.equal(agents.workOver(b.info), undefined);
});

test("w3152: w2895 as it happened: a start with a gate override keeps the gates other still-linked workers set for their own PRs' CI (merge on green), and drops the starting worker's own, a person's and the dispatcher's", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, call } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w1x' }]);
  const a = await startedFor(env, 'w1');
  const b = await secondWorkerOn(env, 'w1');
  const gate = (n: number, by: string, extra: Partial<WorkBlocker> = {}): WorkBlocker => ({ kind: 'ci', ref: `Final-Factory/ffu#${n}`, what: `CI on PR #${n}`, at: T0, by, ...extra });
  const gatesIn = (...gs: WorkBlocker[]) => {
    const w = store.work.get('w1')!;
    w.blocked = gs[0];
    w.alsoBlocked = gs.length > 1 ? gs.slice(1) : undefined;
    w.status = 'blocked';
    store.putWork(w);
  };
  const aGate = gate(1, `worker ${a.id}`, { mergeOnGreen: { head: 'abc', report: 'DONE', session: a.id } });
  const bGate = gate(2, `worker ${b.id}`);
  const personGate = gate(3, 'Ben');
  gatesIn(aGate, bGate, personGate, gate(4, 'dispatcher'));
  const sans = { sandbox: 'pc/alpha', prompt: 'Fix it', title: 'w1: fix', work_id: 'w1', extra_agent: true, override_duplicate: 'another row of the same request' };

  // Without an override the start is refused, as before.
  const refused = await call(dispatcher().info, 'start_agent', sans);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /w1 is gated on /);

  // A new worker started over them with a person's override: the two workers' own waits stay, the other two go.
  const started = await call(dispatcher().info, 'start_agent', { ...sans, override_gate: 'Ben: start another worker on w1 now' });
  assert.equal(started.isError, false, started.text);
  const c = /Started agent (\w+)/.exec(started.text)![1];
  const w = store.work.get('w1')!;
  assert.ok(w.sessionIds.includes(c), 'the new worker is linked');
  assert.deepEqual(gateRefs(w), [`worker ${a.id}: ci Final-Factory/ffu#1`, `worker ${b.id}: ci Final-Factory/ffu#2`].sort(), w.log.slice(-2).join(' | '));
  assert.deepEqual(gatesOf(w).find((g) => g.by === `worker ${a.id}`)?.mergeOnGreen, aGate.mergeOnGreen);
  assert.equal(w.status, 'blocked');

  // A worker already on the request started again with an override drops its own gate, a person's and the dispatcher's.
  gatesIn(aGate, bGate, personGate, gate(4, 'dispatcher'));
  o.linkWorker('w1', b.info, `sent to worker ${b.id}`, { overrideGate: 'Ben: go' });
  assert.deepEqual(gateRefs(store.work.get('w1')!), [`worker ${a.id}: ci Final-Factory/ffu#1`]);
  assert.equal(store.work.get('w1')!.status, 'blocked');

  // When nothing is another worker's, the override leaves it active as before.
  gatesIn(bGate, personGate);
  o.linkWorker('w1', b.info, `sent to worker ${b.id}`, { overrideGate: 'Ben: go' });
  assert.equal(store.work.get('w1')!.blocked, undefined);
  assert.equal(store.work.get('w1')!.status, 'active');
});

test('w2438: a request moved to another computer (w2046) while Blocked on another request is linked to its new session, stays Blocked on that request, and the clear resumes the new worker', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }, { id: 'w1x' }]);
  const a = await startedFor(env, 'w1');
  // w2434 on 2026-10-28 01:00Z: its worker blocked on the pair run w2437 reporting, then the timed preempt moved it to m3.
  await a.h.blocked_on!({ request: 'w1', requests: ['w2'], what: 'w2 (the pair run) reporting' });
  assert.equal(store.work.get('w1')!.status, 'blocked');
  o.movedForRoom(store.work.get('w1')!, a.info, { machine: 'pc', sandbox: 'slot1', branch: 'w1-branch', why: 'room', note: '', how: 'moved', to: 'pc' } as Parameters<Orchestrators['movedForRoom']>[2]);
  // The new session on the computer it moved to (a real one, so the clear can resume it); its own start request is done.
  const b = await startedFor(env, 'w1x', { override_duplicate: 'the moved session of w1' });
  store.work.get('w1x')!.status = 'done';
  const moved = b.info;
  // Before the fix this threw "w1 is gated on w2 finishing", after the new session had already started: it ran unlinked.
  o.linkWorker('w1', moved, `started worker ${moved.id}: moved from worker ${a.id} (w2046)`, { moved: true });
  const w = store.work.get('w1')!;
  assert.ok(w.sessionIds.includes(moved.id), 'the new session is linked');
  assert.ok(!w.sessionIds.includes(a.id), 'the worker it left is not');
  assert.equal(w.status, 'blocked', w.log.slice(-2).join(' | '));
  assert.deepEqual([w.blocked?.kind, w.blocked?.ref, w.blocked?.by], ['request', 'w2', `worker ${moved.id}`]);
  assert.equal(w.alsoBlocked, undefined);
  assert.equal(agents.workLive().get('w1')!.state, 'blocked');
  assert.equal(agents.workOver(moved), undefined);
  // w2 closes: w1 is unblocked and its new worker, not the one it left, is resumed.
  o.unblock('w1', 'w2 finished');
  const after = store.work.get('w1')!;
  assert.equal(after.status, 'active', after.log.slice(-2).join(' | '));
  assert.match(after.log.at(-1)!, new RegExp(`its worker ${moved.id} resumes`));
});

test('w2045: merge_on_green is ignored, the wait set as usual, out of the arm, without head, or with a report that has no DONE line for the request', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  mergeOnGreenArm(o, (id) => id === 'w1');
  const pr = 'Final-Factory/FinalFactory#3';
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  const out = String(await b.h.blocked_on!({ request: 'w2', prs: [`ci:${pr}`], head: 'abc1234', what: 'CI', merge_on_green: 'DONE: w2\nLearned: nothing new' }));
  assert.match(out, /^merge_on_green ignored: w2 is not in the merge-on-green pilot; you are resumed when CI finishes, as usual\. Recorded: w2 is Blocked/);
  assert.equal(store.work.get('w2')!.blocked!.mergeOnGreen, undefined);
  const plain = String(await b.h.blocked_on!({ request: 'w2', prs: [`ci:${pr}`], head: 'abc1234', what: 'CI' }));
  assert.match(plain, /^Recorded: w2 is Blocked/, 'the control arm hears nothing of the pilot');
  assert.match(String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], what: 'CI', merge_on_green: 'DONE: w1' })), /^merge_on_green ignored: it needs head/);
  assert.match(String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head: 'abc1234', what: 'CI', merge_on_green: 'w1: still open: the deploy check' })), /^merge_on_green ignored: the report has no "DONE: w1" line/);
  assert.equal(store.work.get('w1')!.blocked!.mergeOnGreen, undefined);
});

test('w1094: a worker sent a second request still registers a wait for the first (7d8eebb0: w1078 after w1095); without request it blocks the one it serves now', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  const a = await startedFor(env, 'w1');
  // The dispatcher sends it w2 (as message_agent does when it keeps the session), a moment later.
  await new Promise((r) => setTimeout(r, 5));
  env.o.linkWorker('w2', a.info, 'sent to worker, already in its sandbox');
  const pr = 'Final-Factory/ff-factory#335';
  assert.match(String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], what: 'CI on #335' })), /^Recorded: w1 is Blocked on CI on Final-Factory\/ff-factory#335\./);
  assert.deepEqual([store.work.get('w1')!.status, store.work.get('w1')!.blocked?.by], ['blocked', `worker ${a.id}`]);
  assert.equal(store.work.get('w2')!.status, 'active');
  await assert.rejects(async () => a.h.blocked_on!({ request: 'w9', prs: [`ci:${pr}`], what: 'x' }), /you are not on w9 \(you hold w1, w2\)/);
  assert.match(String(await a.h.blocked_on!({ prs: ['Final-Factory/ff-factory#336'], what: 'the flake fix merged' })), /^Recorded: w2 is Blocked on PR/);
});

test('w1094: the sweep resumes again, loudly, a worker whose resume was lost (no check-in pending, no message queued, nothing in its transcript), and stops once its transcript shows it', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  const pr = 'Final-Factory/FinalFactory#1526';
  const watch = new BlockerWatch({ store, orchestrators: o, ci: async () => ({ done: true, text: `CI on ${pr} finished: all 1 workflow runs passed or skipped` }), queued: () => false });
  const a = await startedFor(env, 'w1');
  await a.h.blocked_on!({ prs: [`ci:${pr}`], what: 'CI on #1526' });
  await watch.tick();
  const note = agents.waker.pending(a.id)!.note;
  // Lost: the check-in that carries it is gone (a restart that dropped it, a delivery that gave up).
  agents.waker.cancel(a.id);
  assert.equal((await watch.tick()).has('w1'), false, 'within 5 minutes nothing is done');
  const w = store.work.get('w1')!;
  w.gateResumes = w.gateResumes!.map((r) => ({ ...r, at: new Date(Date.now() - 6 * 60_000).toISOString() }));
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...x: unknown[]) => void warned.push(x.join(' '));
  try {
    assert.equal((await watch.tick()).get('w1'), `sweep: resumed ${a.id} again`);
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some((l) => l.startsWith(`ledger: SWEEP: w1: worker ${a.id} was resumed 6 min ago when its gate cleared and has not taken it`)), warned.join(' | '));
  assert.equal(agents.waker.pending(a.id)?.note, note);
  assert.equal(store.work.get('w1')!.gateResumes![0].tries, 2);
  // A check-in pending or a message queued for it is on its way: left alone.
  store.work.get('w1')!.gateResumes = store.work.get('w1')!.gateResumes!.map((r) => ({ ...r, at: new Date(Date.now() - 6 * 60_000).toISOString() }));
  assert.equal((await watch.tick()).has('w1'), false, 'its check-in is pending');
  // Delivered (as the waker sends it, through the machine's daemon): its transcript has it, and the record goes.
  agents.waker.cancel(a.id);
  env.sessions.send(a.id, `[wake_me] Time is up. Your note: ${note}`, 'system');
  await until('the resume in its transcript', () => store.readTranscript(a.id).some((e) => e.kind === 'user' && e.text.includes(note)));
  await until('its turn ends', () => a.info.status === 'idle');
  await watch.tick();
  assert.equal(store.work.get('w1')!.gateResumes, undefined);
});

test('w1094: a block that ends by stalling or by a question hands back the check-ins it held', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, call } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2', status: 'active' }]);
  const a = await startedFor(env, 'w1');
  await a.h.wake_me!({ minutes: 30, note: 'w1: look at the nightly' });
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'request', ref: 'w2', what: 'w2 first' } })).isError, false);
  assert.equal(agents.waker.pending(a.id), undefined);
  store.work.get('w2')!.status = 'cancelled';
  await new BlockerWatch({ store, orchestrators: o }).tick();
  assert.equal(store.work.get('w1')!.status, 'question');
  assert.match(agents.waker.pending(a.id)!.note, /^w1's block ended \(blocker closed without delivering: .*\)\. This is your own check-in, which the block cancelled; carry on from it\. Its note was: w1: look at the nightly$/);
  agents.waker.cancel(a.id);
});

test('w1094: one request that throws does not hold up the others, and the first look waits for the server to finish loading', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const item = (id: string) => ({ id, status: 'blocked', blocked: { kind: 'time', until: past, what: 'a time', at: past, by: 'dispatcher' } }) as unknown as WorkItem;
  const work = new Map([['w1', item('w1')], ['w2', item('w2')]]);
  const unblocked: string[] = [];
  const orchestrators = {
    unblock: (id: string) => {
      if (id === 'w1') throw new Error('boom');
      unblocked.push(id);
    },
  } as unknown as ConstructorParameters<typeof BlockerWatch>[0]['orchestrators'];
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...x: unknown[]) => void warned.push(x.join(' '));
  try {
    const did = await new BlockerWatch({ store: { work } as unknown as Store, orchestrators }).tick();
    assert.deepEqual(unblocked, ['w2']);
    assert.equal(did.get('w2'), 'clear: it is past ' + `${past.slice(11, 16)} UTC`);
    assert.ok(warned.includes('blocker watch: w1: boom'), warned.join(' | '));
  } finally {
    console.warn = warn;
  }
  // start(): nothing is read before the module that starts it has finished (index.ts declares the usage meters later).
  let read = false;
  const lazy = { get work() {
    read = true;
    return new Map();
  } } as unknown as Store;
  const watch = new BlockerWatch({ store: lazy, orchestrators }).start();
  assert.equal(read, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(read, true);
  watch.close();
});

test('w1094: the backstop: a request still Blocked on CI that finished over 5 minutes ago (its clearing threw) is said loudly, once, and cleared again', async () => {
  const at = new Date().toISOString();
  const pr = 'Final-Factory/ff-factory#335';
  const w = { id: 'w1', status: 'blocked', blocked: { kind: 'ci', ref: pr, what: 'CI on #335', at, by: 'worker a' } } as unknown as WorkItem;
  const work = new Map([['w1', w]]);
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
  const text = `CI on ${pr} finished: all 3 workflow runs passed or skipped`;
  const watch = new BlockerWatch({ store: { work } as unknown as Store, orchestrators, now: () => clock, ci: async () => ({ done: true, text }) });
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...x: unknown[]) => void warned.push(x.join(' '));
  try {
    await watch.tick();
    clock += 3 * 60_000;
    await watch.tick();
    assert.equal(warned.filter((l) => l.includes('SWEEP')).length, 0, 'not yet 5 minutes');
    clock += 3 * 60_000;
    await watch.tick();
    clock += 60_000;
    await watch.tick();
    assert.equal(warned.filter((l) => l.startsWith('blocker watch: SWEEP: w1 is still Blocked on CI on Final-Factory/ff-factory#335, which finished 6 min ago')).length, 1, warned.join(' | '));
    fail = false;
    clock += 60_000;
    assert.equal((await watch.tick()).get('w1'), `clear: ${text}`);
    assert.deepEqual(cleared, [`w1: ${text}`]);
  } finally {
    console.warn = warn;
  }
});
