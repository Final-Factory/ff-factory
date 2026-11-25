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
 * The orchestrator tests (docs/orchestrators.md), end to end on a real Agents with the scripted agent: blockers and waits on a person: decide_work block, waiting_on_person, [needs you], question cards, a worker's second request.
 * One of the server/orchestrators*.test.ts files split out of orchestrators.test.ts (w5826); helpers in orchestratorsTestKit.ts.
 */


// ---------------------------------------------------------------- w643: Waiting on input, Queued, Blocked

test('w643: decide_work block records a structured blocker; the request reads Blocked on it; when the blocker clears it unblocks by itself and the dispatcher is told to start it', async (t) => {
  const { store, agents, o, dispatcher, chat, call, heard } = setup(t);
  agentsRoom(agents, ['lothdesktop']);
  await call(chat(LOTH).info, 'request_work', { title: 'Timing table for the nightly lab', brief: 'Measure each scenario.' });
  await call(chat(LOTH).info, 'request_work', { title: 'Speed up the nightly lab', brief: 'Use the timing table.' });
  // w634 is held until w633's table exists: a thing, not capacity. Queueing it is refused while LothDesktop has room.
  const q = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'until w1 reports its table' });
  assert.equal(q.isError, true);
  assert.match(q.text, /queue is for capacity only, and lothdesktop has room for w2 now: start it there .*, or, if it waits for something else, decide_work block/);
  const refusedSelf = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'x', blocker: { kind: 'request', ref: 'w2', what: 'itself' } });
  assert.match(refusedSelf.text, /cannot be blocked on itself/);
  const r = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'It needs w1\'s timing table first.', blocker: { kind: 'request', ref: 'W1', on: 'report', what: "w1's timing table" } });
  assert.equal(r.isError, false, r.text);
  const w2 = store.work.get('w2')!;
  assert.equal(w2.status, 'blocked');
  assert.deepEqual({ ...w2.blocked, at: undefined }, { kind: 'request', ref: 'w1', on: 'report', what: "w1's timing table", at: undefined, by: 'dispatcher' });
  const line = (await call(dispatcher().info, 'list_work', { state: 'blocked' })).text;
  assert.match(line, /^- w2 \[blocked\] Blocked on w1 reporting \(w1's timing table \(since 0 min ago, set by dispatcher\)\): "Speed up the nightly lab"/);
  assert.match((await call(dispatcher().info, 'list_work', { status: 'blocked' })).text, /^- w2 /);
  assert.match((await call(dispatcher().info, 'list_work', {})).text, /Now: 1 working, 1 blocked\./, 'w1 is with the dispatcher; w2 blocked; nothing Queued');
  await until("Lothsahn's orchestrator hears it is blocked", () => heard(chat(LOTH).info.id, '[dispatch] w2').some((e) => /blocked on w1 reporting \(w1's timing table\); it starts by itself when that clears/.test(e.text)));

  const watch = new BlockerWatch({ store, orchestrators: o });
  assert.equal((await watch.tick()).size, 0, 'w1 has not reported: still blocked');
  // w1869: a progress report from w1's worker ("still open") leaves w2 blocked.
  store.putSession({ id: 'k1', kind: 'worker', title: 'w1: timing table', status: 'idle', permissionMode: 'default', createdAt: T0, lastActivityAt: new Date(Date.now() + 1000).toISOString(), turns: 2, costUsd: 1, pendingPermissions: [], lastResult: 'Started the lab runs.\n\nw1: still open: the LothDesktop A/B is running, then the timing table' });
  store.work.get('w1')!.sessionIds = ['k1'];
  assert.equal((await watch.tick()).size, 0, 'a progress report does not unblock it');
  assert.equal(store.work.get('w2')!.status, 'blocked');
  // w1's worker reports the table (a turn ends after the block): w2 unblocks, back to the dispatcher, which is told to start it.
  // w2426: a turn end with no status line is no result any more; the report marked "For w2:" is.
  store.putSession({ ...store.sessions.get('k1')!, lastActivityAt: new Date(Date.now() + 1500).toISOString(), lastResult: 'Timing table in specs/633/timing.md.' });
  assert.equal((await watch.tick()).size, 0, 'an unmarked turn end does not unblock it (w2426)');
  store.putSession({ ...store.sessions.get('k1')!, lastActivityAt: new Date(Date.now() + 2000).toISOString(), lastResult: 'Timing table done.\n\nFor w2: specs/633/timing.md' });
  const did = await watch.tick();
  assert.match(did.get('w2')!, /^clear: w1's worker reported/);
  assert.equal(store.work.get('w2')!.status, 'new');
  assert.equal(store.work.get('w2')!.blocked, undefined);
  assert.match(store.work.get('w2')!.log.join('\n'), /unblocked: w1 reporting cleared \(w1's worker reported/);
  const told = heard(dispatcher().info.id, '[ledger] w2').map((e) => e.text).join('\n');
  assert.match(told, /\[ledger\] w2 "Speed up the nightly lab" \(Lothsahn, normal\) is unblocked: it waited on w1 reporting \(w1's timing table\), and w1's worker reported.*Start it now: start_agent with work_id "w2"/);
  await until("Lothsahn's orchestrator hears it unblocked", () => heard(chat(LOTH).info.id, '[dispatch] w2').some((e) => /unblocked: it waited on w1 reporting/.test(e.text)));
});

test("w1869: a request blocked on another's report: that request's worker is told what it waits for and how to mark it; its progress report leaves it blocked, the marked line unblocks it", async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', by: BEN }, { id: 'w2', by: BEN }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Time A vs A', title: 'w1: timing', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const r = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'It needs the timing.', blocker: { kind: 'request', ref: 'w1', on: 'report', what: "dec9a619's LothDesktop timing of A vs A" } });
  assert.equal(r.isError, false, r.text);
  const notice = () => store.readTranscript(id).filter((e) => e.kind === 'user' && /For w2: <the result, or where it is>/.test((e as { text: string }).text));
  await until("w1's worker is told", () => notice().length === 1);
  assert.match((notice()[0] as { text: string }).text, /w2 \("Request w2"\) is blocked until a report of yours on w1 carries: dec9a619's LothDesktop timing of A vs A\./);
  assert.match(store.work.get('w1')!.log.join('\n'), new RegExp(`w2 waits on its report \\(dec9a619's LothDesktop timing of A vs A\\): told ${id}`));
  await until('that turn ends', () => info.status === 'idle');
  // The same gate again (the dispatcher re-blocks): not told twice.
  await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'Still.', blocker: { kind: 'request', ref: 'w1', on: 'report', what: "dec9a619's LothDesktop timing of A vs A" } });
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(notice().length, 1);

  const watch = new BlockerWatch({ store, orchestrators: o });
  const report = (text: string, ms: number) => store.putSession({ ...store.sessions.get(id)!, status: 'idle', lastActivityAt: new Date(Date.now() + ms).toISOString(), lastResult: text });
  report('B is building.\n\nw1: still open: the LothDesktop A/B is running…', 1000);
  assert.equal((await watch.tick()).size, 0, 'a still-open progress report does not unblock w2');
  assert.equal(store.work.get('w2')!.status, 'blocked');
  report('A vs A on LothDesktop: 41.2 ms and 41.0 ms per frame.\n\nFor w2: the timing is in specs/w1/timing.md (A 41.2 ms, A 41.0 ms)\n\nw1: still open: the transform-walk PR', 2000);
  assert.match((await watch.tick()).get('w2') ?? '', /^clear: w1's worker reported \(dec9a619's LothDesktop timing of A vs A\)/);
  assert.notEqual(store.work.get('w2')!.status, 'blocked');
});

test("w3289: replay of w3245/w3246: a release blocked on another's live-with-notes report, set before that release's worker started, unblocks from its milestone report with nobody stepping in, not at its DONE", async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', by: BEN }, { id: 'w2', by: BEN }]);
  // 22:11: the dispatcher blocks the pre-1.0 release (w2) on the 1.0 release (w1) reporting, before w1 has a worker.
  const what = "w1's report that the 1.0 release is live with its notes posted";
  const r = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'Once the 1.0 release is out.', blocker: { kind: 'request', ref: 'w1', on: 'report', what } });
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(store.work.get('w1')!.log.join('\n'), /w2 waits on its report \([^)]*\): told/, 'nobody to tell yet');
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Cut the 1.0 release', title: 'w1: 1.0 release', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  await until('its first turn', () => store.sessions.get(id)!.status === 'idle');
  // 23:08: w1's worker reports the release live with its notes posted, keeps w1 open for its 24-hour after-check and
  // stops on its check-in. Its report has no "For w2:" line: it was never told.
  const report = (text: string, ms: number, status: SessionInfo['status'] = 'idle') => store.putSession({ ...store.sessions.get(id)!, status, lastActivityAt: new Date(Date.now() + ms).toISOString(), lastResult: text });
  report('1.0.0.40 is live on development; the notes are posted: https://discord.com/channels/1/2/3\n\nw1: still open: the 24-hour check of player reports on 1.0.0.40, due tomorrow 23:00 UTC', 1000, 'stopped');
  const watch = new BlockerWatch({ store, orchestrators: o });
  const notice = () => store.readTranscript(id).filter((e) => e.kind === 'user' && /For w2: <the result, or where it is>/.test((e as { text: string }).text));
  await watch.tick();
  assert.equal(store.work.get('w2')!.status, 'blocked', 'the unmarked report does not clear it');
  await until("the watch tells w1's sleeping worker", () => notice().length === 1);
  const text = (notice()[0] as { text: string }).text;
  assert.match(text, new RegExp(`w2 \\("Request w2"\\) is blocked until a report of yours on w1 carries: ${what}\\.`));
  assert.match(text, /need not wait for your DONE or for an after-check still open on w1/);
  assert.match(text, /If it has happened already, end this turn with that line now/);
  assert.deepEqual(store.work.get('w2')!.blocked!.told, [id]);
  assert.match(store.work.get('w1')!.log.join('\n'), new RegExp(`w2 waits on its report \\(${what}\\): told ${id}`));
  await until('that turn ends', () => store.sessions.get(id)!.status === 'idle');
  await watch.tick();
  assert.equal(notice().length, 1, 'told once');
  // Its answer marks the milestone and keeps the after-check open: w2 unblocks, though w1 stays open.
  report('For w2: 1.0.0.40 is live on development and its notes are posted at 23:01 UTC: https://discord.com/channels/1/2/3\n\nw1: still open: the 24-hour check of player reports on 1.0.0.40', 2000);
  assert.match((await watch.tick()).get('w2') ?? '', /^clear: w1's worker reported/);
  assert.notEqual(store.work.get('w2')!.status, 'blocked');
  assert.ok(isOpen(store.work.get('w1')!), 'w1 stays open for its after-check');
});

test("w5471: replay of w5466/w2895: a request blocked on an active request's report asks only that request's live worker, never its stopped finished legs; with none live the ask is recorded on it once", async (t) => {
  const { store, sessions, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }, { id: 'w2', by: BEN }]);
  // Every send, delivered or not: before w5471 the stopped legs here were each sent the ask (a resume of a real one).
  const sent: string[] = [];
  const send = sessions.send.bind(sessions);
  sessions.send = ((id: string, ...rest: Parameters<typeof send> extends [string, ...infer R] ? R : never) => {
    sent.push(id);
    return send(id, ...rest);
  }) as typeof sessions.send;
  // w1 stands for w2895 (the FFU fan-out): three finished legs, stopped. Two said LEG DONE, the third just stopped with
  // nothing pending on it. At 19:15 UTC on 2026-11-24 each such leg of w2895 was messaged and resumed.
  const legs = ['leg00001', 'leg00002', 'leg00003'];
  for (const [i, id] of legs.entries()) {
    store.putSession({ id, kind: 'worker', title: `w1: row M${i}`, status: 'stopped', permissionMode: 'default', createdAt: T0, lastActivityAt: T0, turns: 3, costUsd: 1, pendingPermissions: [], lastResult: i < 2 ? `Row M${i} merged.\n\nLEG DONE: w1 M${i}` : `Row M${i} merged.` });
  }
  const w1 = store.work.get('w1')!;
  w1.sessionIds = [...legs];
  w1.done = { leg00001: { at: T0, report: 'LEG DONE: w1 M0', leg: true }, leg00002: { at: T0, report: 'LEG DONE: w1 M1', leg: true } };
  store.putWork(w1);
  const asked = (id: string) => store.readTranscript(id).filter((e) => e.kind === 'user' && /For w2: <the result, or where it is>/.test((e as { text: string }).text));
  const what = "w1's row M6.6 merged";
  const r = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'After M6.6.', blocker: { kind: 'request', ref: 'w1', on: 'report', what } });
  assert.equal(r.isError, false, r.text);
  const watch = new BlockerWatch({ store, orchestrators: o });
  await watch.tick();
  await watch.tick();
  await new Promise((res) => setTimeout(res, 200));
  for (const id of legs) {
    assert.ok(!sent.includes(id), `finished leg ${id} is not sent the ask`);
    assert.equal(asked(id).length, 0, `finished leg ${id} is not asked`);
    assert.equal(store.sessions.get(id)!.status, 'stopped', `finished leg ${id} is not resumed`);
  }
  assert.equal(store.work.get('w2')!.blocked!.told, undefined);
  const nobody = store.work.get('w1')!.log.filter((l) => /w2 waits on its report \(w1's row M6\.6 merged\): no worker is on it now, so the next one is told/.test(l));
  assert.equal(nobody.length, 1, 'the ask is recorded on w1 once, not on every look');

  // One live worker joins w1 (the next planning leg): it alone is asked, once, and still no finished leg.
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Plan the next rows', title: 'w1: planning', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const live = /Started agent (\w+)/.exec(started.text)![1];
  await until('its first turn', () => store.sessions.get(live)!.status === 'idle');
  await watch.tick();
  await until('the live worker is asked', () => asked(live).length === 1);
  await watch.tick();
  assert.equal(asked(live).length, 1, 'asked once');
  assert.deepEqual(store.work.get('w2')!.blocked!.told, [live]);
  for (const id of legs) assert.ok(!sent.includes(id) && !asked(id).length, `finished leg ${id} is still not asked`);
});

test('w5471: with no live worker on the awaited request, only its newest stopped worker with work pending is asked; an older leg whose last report still had a still-open line is not resumed', async (t) => {
  const { store, sessions, o, dispatcher, call } = await setupOnMachine(t);
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }, { id: 'w2', by: BEN }]);
  const sent: string[] = [];
  const send = sessions.send.bind(sessions);
  sessions.send = ((id: string, ...rest: Parameters<typeof send> extends [string, ...infer R] ? R : never) => {
    sent.push(id);
    return send(id, ...rest);
  }) as typeof sessions.send;
  for (const id of ['old00001', 'new00001']) {
    store.putSession({ id, kind: 'worker', title: 'w1: leg', status: 'stopped', permissionMode: 'default', createdAt: T0, lastActivityAt: T0, turns: 3, costUsd: 1, pendingPermissions: [], lastResult: 'Pushed.\n\nw1: still open: CI on the PR' });
  }
  const w1 = store.work.get('w1')!;
  w1.sessionIds = ['old00001', 'new00001'];
  w1.links = { old00001: { at: '2026-11-04T10:00:00Z', how: 'sent' }, new00001: { at: '2026-11-24T10:00:00Z', how: 'sent' } };
  store.putWork(w1);
  const r = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'After CI.', blocker: { kind: 'request', ref: 'w1', on: 'report', what: "w1's PR merged" } });
  assert.equal(r.isError, false, r.text);
  await new BlockerWatch({ store, orchestrators: o }).tick();
  assert.ok(sent.includes('new00001'), 'its holder is asked');
  assert.ok(!sent.includes('old00001'), 'the older leg is not');
});

test('w3289: toldOf reads a gate set before `told` was kept from the awaited request\'s log', () => {
  const g = { kind: 'request', ref: 'w1', on: 'report', what: 'x', at: T0, by: 'dispatcher' } as WorkBlocker;
  const x = { log: ['22:11 w2 waits on its report (its timing: A vs A): told abc123, def456 to mark it "For w2:"', '22:12 w3 waits on its report (other): told zzz to mark it "For w3:"'] };
  assert.deepEqual([...toldOf(g, x, 'w2')], ['abc123', 'def456']);
  assert.deepEqual([...toldOf(g, x, 'w4')], []);
  assert.deepEqual([...toldOf({ ...g, told: ['q'] }, x, 'w2')], ['q']);
});

test('w643: a blocker that stalls stalls the request with the reason; one closed without delivering asks its requester (Waiting on input); a deploy clears on a new commit', async (t) => {
  const { store, agents, o, dispatcher, chat, call } = setup(t);
  agentsRoom(agents, []);
  // Five requests at once (filing through request_work is capped per message).
  for (const n of [1, 2, 3, 4, 5]) store.putWork({ id: `w${n}`, title: `Request ${n}`, brief: 'Do it.', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'new', createdAt: T0, updatedAt: T0, sessionIds: [], overlaps: [], asks: 0, log: [] });
  store.workSeq = 5;
  assert.ok(chat(BEN));
  const block = (id: string, blocker: Record<string, unknown>) => call(dispatcher().info, 'decide_work', { id, action: 'block', note: 'held', blocker });
  (o as unknown as { d: { deploySha: () => string } }).d.deploySha = () => 'aaa1111';
  const b2 = await block('w2', { kind: 'request', ref: 'w1', what: "w1's fix" });
  assert.equal(b2.isError, false, b2.text);
  assert.equal((await block('w3', { kind: 'request', ref: 'w1', what: "w1's fix" })).isError, false);
  const b4 = await block('w4', { kind: 'deploy', what: 'the next portal deploy' });
  assert.equal(b4.isError, false, b4.text);
  assert.equal(store.work.get('w4')!.blocked!.sha, 'aaa1111', 'what the portal ran when it was blocked');
  assert.equal((await block('w5', { kind: 'ci', ref: 'Final-Factory/ff-factory#205', what: "#205's checks" })).isError, false);
  let sha = 'aaa1111';
  let ci = { done: false, text: '3 of 13 checks on Final-Factory/ff-factory#205 still running' };
  let clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: o, portalSha: () => sha, ci: async () => ci, now: () => clock });
  assert.equal((await watch.tick()).size, 0);

  // w1 stalls: w2 stalls with it, saying so. Then w1 is cancelled: w3 asks Ben whether it is still needed.
  store.work.get('w1')!.status = 'stalled';
  store.work.get('w1')!.stalled = { at: T0, kind: 'idle', reason: 'no activity for 26 hours' };
  await watch.tick();
  assert.equal(store.work.get('w2')!.status, 'stalled');
  assert.deepEqual([store.work.get('w2')!.stalled!.kind, store.work.get('w2')!.stalled!.reason], ['blocked', "blocked on w1 finishing (w1's fix): w1, which it waits on, stalled: no activity for 26 hours"]);
  assert.equal(store.work.get('w3')!.status, 'stalled', 'the same for every request blocked on it');
  // Revived by its person and blocked on w1 again; then w1 is cancelled.
  Object.assign(store.work.get('w3')!, { status: 'blocked', stalled: undefined, blocked: { kind: 'request', ref: 'w1', what: "w1's fix", at: T0, by: 'dispatcher' } });
  store.work.get('w1')!.status = 'cancelled';
  await watch.tick();
  const w3 = store.work.get('w3')!;
  assert.equal(w3.status, 'question');
  assert.match(w3.question!.text, /^It was blocked on w1 finishing \(w1's fix\), and w1 was cancelled without delivering w1's fix\. Is w3 still needed, and what should it wait for now\?/);
  assert.equal(w3.asks, 0, "not one of the dispatcher's three questions");

  // The portal is deployed (another commit runs): w4 goes back to the dispatcher. CI on #205 finishes: w5 too.
  sha = 'bbb2222';
  assert.match((await watch.tick()).get('w4')!, /^clear: the portal runs bbb2222 now \(aaa1111 when it was blocked\)/);
  ci = { done: true, text: 'CI on Final-Factory/ff-factory#205 finished: all 13 checks passed or skipped' };
  assert.equal((await watch.tick()).size, 0, 'the checks are read at most every 2 minutes');
  clock += 5 * 60_000;
  const did = await watch.tick();
  assert.equal(store.work.get('w4')!.status, 'new', 'the deploy cleared it on the tick before');
  assert.match(did.get('w5')!, /^clear: CI on Final-Factory\/ff-factory#205 finished/);
  assert.deepEqual([store.work.get('w4')!.status, store.work.get('w5')!.status], ['new', 'new']);
});

test('w643: Queued only on a real capacity shortage: queue needs no room on a computer that could take it, a request left queued while one has room is flagged loudly, and any other decision ends a block', async (t) => {
  const { store, agents, o, dispatcher, chat, call, heard } = setup(t);
  agentsRoom(agents, ['lothdesktop']);
  await call(chat(BEN).info, 'request_work', { title: 'Mac-only check', brief: 'Run it on the M5.' });
  await call(chat(BEN).info, 'request_work', { title: 'Anything', brief: 'Do it.' });
  // Only the M5 can take w1, and it is busy: queued, with what it needs.
  const ok = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'needs the M5, which is busy', needs: ['M5'] });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(store.work.get('w1')!.queuedFor?.needs, ['m5']);
  assert.match((await call(dispatcher().info, 'list_work', { state: 'queued' })).text, /^- w1 \[queued\] Queued \(queued for capacity on m5: no computer that could take it has room\)/);
  // Any computer can take w2, and LothDesktop has room: refused.
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'later' })).isError, true);
  // The M5 frees and nobody starts w1: after the grace it is flagged, once, to the dispatcher and in its log.
  agentsRoom(agents, ['m5']);
  // w1944: the room is read as it frees (the blocker watch reads it each minute), so it has stood when the clock moves on.
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w1' })).text, /Queued \(queued for capacity on m5; m5 has room since 0 min ago: the capacity ping brings it to the dispatcher\)/);
  const later = Date.now() + 11 * 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(later);
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w1' })).text, /Queued \[WRONG: m5 has room\]/);
  assert.deepEqual(o.flagQueuedWithRoom(['m5']), ['w1']);
  assert.deepEqual(o.flagQueuedWithRoom(['m5']), [], 'once an hour at most');
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[ledger] WRONG STATE').length > 0);
  assert.match(heard(dispatcher().info.id, '[ledger] WRONG STATE')[0].text, /w1 "Mac-only check" \(Ben, normal; room on m5\)\. Queued means no free place\. Start each now/);
  assert.match(store.work.get('w1')!.log.join('\n'), /flagged: queued for capacity while m5 has room/);
  // A block, then a queue for capacity: the blocker goes with the status.
  agentsRoom(agents, []);
  await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'after the nightly run', blocker: { kind: 'time', until: new Date(later + 3_600_000).toISOString(), what: 'after the nightly run' } });
  assert.equal(store.work.get('w2')!.status, 'blocked');
  // A gated request is not waiting for capacity (w754): queueing it is refused, and it stays blocked.
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'every place is busy now' });
  assert.match(refused.text, /w2 is gated on .* It waits for those, not for capacity: leave it blocked/);
  assert.equal(store.work.get('w2')!.status, 'blocked');
  // Ended by a person's own word (override_gate), the block goes with the status.
  await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'every place is busy now', override_gate: 'Ben: forget the nightly run, queue it' });
  assert.deepEqual([store.work.get('w2')!.status, store.work.get('w2')!.blocked], ['queued', undefined]);
});

test('w691: a worker that needs a person declares it (waiting_on_person) and its request reads Waiting on input (on who), also with a check-in pending', async (t) => {
  const { store, machines, dispatcher, chat, call, sessions } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Mac GPU page fault', brief: 'Reproduce it on the m3.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Reproduce it on the m3', title: 'w1: Mac GPU page fault', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const m = store.machines.get('pc')!;
  const info = store.sessions.get(id)!;
  await firstTurn(info);

  // The tool is in its spec and its brief says to use it instead of a check-in.
  const spec = machines.hooks!.specFor(info, m);
  const tool = spec.mcp?.tools.find((x) => x.name === 'waiting_on_person');
  assert.ok(tool, 'a worker has waiting_on_person');
  assert.match(tool!.description, /Do not poll with wake_me for a person/);
  assert.match(spec.append, /## Waiting on a person[\s\S]*mcp__machine__waiting_on_person[\s\S]*Never poll for a person with `wake_me`/);
  // w935: an editor open on a project the worker must change is the worker's to close and reopen, never a question for a person.
  assert.match(spec.append, /Machine steps are yours, not a person's[\s\S]*close cleanly[\s\S]*reopen it if a person was using it[\s\S]*never handed to a person/);
  assert.match(spec.mcp!.tools.find((x) => x.name === 'wake_me')!.description, /Not for waiting on a person: use waiting_on_person/);

  // Before it declares anything, an idle worker with a check-in pending is Working (a machine's job), as before.
  const wake = (await call(dispatcher().info, 'list_work', { id: 'w1' })).text;
  assert.doesNotMatch(wake, /Waiting on input/);
  const h = machines.hooks!.handlersFor(info, m);
  await assert.rejects(h.waiting_on_person!({ who: '', what: 'x' }), /say whose action you wait on/);
  const said = await h.waiting_on_person!({ who: 'Ben', what: 'reboot the m3 and log in (FileVault)', request: 'W1' });
  assert.match(String(said), /Recorded: w1 wait on Ben \(reboot the m3 and log in \(FileVault\)\); the ledger shows Waiting on input\. End your turn now/);
  assert.deepEqual({ who: info.waitingOn?.who, what: info.waitingOn?.what, request: info.waitingOn?.request }, { who: 'Ben', what: 'reboot the m3 and log in (FileVault)', request: 'w1' });
  assert.equal(store.sessions.get(id)?.waitingOn?.who, 'Ben', 'kept with the session');

  // A check-in pending (the w665 case): still Waiting on input, on Ben.
  Object.assign(info, { wakeAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), wakeNote: 'is the m3 back?' });
  const listed = (await call(dispatcher().info, 'list_work', { id: 'w1' })).text;
  assert.match(listed, /Waiting on input[^\n]*"Mac GPU page fault"/);
  assert.match(listed, new RegExp(`${id} waits on Ben: reboot the m3 and log in \\(FileVault\\)`));
  const read = await call(dispatcher().info, 'list_work', { state: 'waiting' });
  assert.match(read.text, /w1/);

  // Its next message ends the declaration.
  sessions.send(id, 'the m3 is up', 'human', undefined, { requestedBy: BEN });
  await until('the next turn', () => info.waitingOn === undefined);
});

test('w2956: the w2895 stall: a planning worker that hands the dispatcher its rows reaches the dispatcher, and a request under its standing "keep N running" is named to it', async (t) => {
  const { store, sessions, agents, dispatcher, chat, call, heard } = await setupOnMachine(t);
  (agents.orchestrators as unknown as { d: { fanOutSettleMs: number } }).d.fanOutSettleMs = 50;
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'FFU engine: fan out every unblocked PLAN.md row', brief: 'One worker per row. Aim for 6–8 rows at once.' });
  // Ben's standing ask on w2895, 2026-11-02 23:26 UTC, as a note.
  const w = store.work.get('w1')!;
  w.notes = [{ at: '2026-11-02T23:26:00Z', by: 'ben', text: 'Keep at least 8 to 10 rows running at once, and start the next row as soon as one merges.' }];
  store.putWork(w);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'List the startable rows', title: 'w1: list startable PLAN.md rows', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const before = heard(dispatcher().info.id, '[work update]').length;

  // 2d1ac9f7's report at 05:14 UTC 2026-11-03, shortened.
  const report =
    'Ten rows can start now at ffu main ebca077: M2.17, M2.19, M2.3, M2.6, M2.11, M1.2c, P0.12, R.F1, R.M1, R.T3.\n\n' +
    "w1: still open: the dispatcher starts the ten rows above, M2.13 (thin bots, PR #107) is rebased, its timed hour runs, and Ben answers M1.7's rate-mode decision";
  sessions.events.emit('turnEnd', sessions.get(id), report);
  await until('the dispatcher hears the rows', () => heard(dispatcher().info.id, '[work update]').some((e) => e.text.includes('handing you legs to start')));
  const ask = heard(dispatcher().info.id, '[work update]').find((e) => e.text.includes('handing you legs to start'))!.text;
  assert.match(ask, new RegExp(`^\\[work update\\] w1 "FFU engine: fan out every unblocked PLAN.md row" \\(Ben, \\w+\\)`));
  assert.match(ask, /M2\.17, M2\.19, M2\.3, M2\.6, M2\.11, M1\.2c, P0\.12, R\.F1, R\.M1, R\.T3/);
  assert.match(ask, /keep at least 8 running/);
  assert.equal(store.work.get('w1')!.dispatcherAsk?.worker, id);

  // The planner is idle with no check-in: no leg runs, under the standing 8. The dispatcher is told once.
  await until('the standing target is checked', () => heard(dispatcher().info.id, '[work update]').some((e) => /runs 0 legs now, under its people's standing ask/.test(e.text)));
  const under = heard(dispatcher().info.id, '[work update]').find((e) => /runs 0 legs now/.test(e.text))!.text;
  assert.match(under, /Start legs up to 8 now/);
  assert.match(under, new RegExp(`its worker ${id} last handed you "w1: still open: the dispatcher starts the ten rows above`));
  assert.deepEqual({ live: store.work.get('w1')!.fanOut?.live, min: store.work.get('w1')!.fanOut?.min }, { live: 0, min: 8 });

  // The same report again, the worker stopping, a daemon connecting: nothing more within the gap.
  sessions.events.emit('turnEnd', sessions.get(id), report);
  agents.orchestrators.capacityMayHaveFreed("pc's daemon connected");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(heard(dispatcher().info.id, '[work update]').length, before + 2, 'one rows notice, one target notice');

  // Past the gap with a leg lost since: told again. A request with no standing ask is never named.
  const later = store.work.get('w1')!;
  later.fanOut = { at: new Date(Date.now() - 31 * 60_000).toISOString(), live: 3, min: 8 };
  store.putWork(later);
  assert.deepEqual(agents.orchestrators.fanOutCheck(), ['w1']);
  later.notes = [];
  later.fanOut = undefined;
  store.putWork(later);
  assert.deepEqual(agents.orchestrators.fanOutCheck(), [], 'no "keep N running": no notice');
});

test('w2870: a worker waiting on its orchestrator for a step workers have no tool for tells that orchestrator once, as [orchestrator step], never [needs you]', async (t) => {
  const { store, sessions, dispatcher, chat, call, heard } = await setupOnMachine(t);
  const loth = chat(LOTH).info;
  await call(loth, 'request_work', { title: 'FFBox run-file view', brief: "Let orchestrators read a run's files." });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: FFBox run-file view', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const handle = sessions.get(id);
  // w2833's a53036df, 05:24 to 05:55 UTC: the same wait, reported four times.
  const report = "PR #797 merged and deployed.\n\nw1: still open: the orchestrator runs the live ffbox_activity demo for conversations 1487 and 1488 and sends the results to worker c6e1d6f2; workers don't have those tools";
  sessions.events.emit('turnEnd', handle, report);
  await until('lothsahn’s orchestrator hears it', () => heard(loth.id, '[orchestrator step]').length === 1);
  const msg = heard(loth.id, '[orchestrator step]')[0].text;
  assert.match(msg, new RegExp(`^\\[orchestrator step\\] w1 "FFBox run-file view"\\nIts worker ${id} ended its turn waiting on you, Lothsahn's orchestrator`));
  assert.match(msg, /the orchestrator runs the live ffbox_activity demo for conversations 1487 and 1488/);
  assert.deepEqual({ worker: store.work.get('w1')!.orchestratorStep?.worker, to: store.work.get('w1')!.orchestratorStep?.to }, { worker: id, to: ['lothsahn'] });
  assert.ok(store.work.get('w1')!.log.some((l) => l.includes("[orchestrator step] sent to Lothsahn's orchestrator")));

  // The same wait re-reported: nothing more; and never a person's [needs you].
  sessions.events.emit('turnEnd', handle, report);
  sessions.events.emit('turnEnd', handle, report.replace('PR #797 merged and deployed.', 'Still waiting.'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(heard(loth.id, '[orchestrator step]').length, 1, 'one message per wait');
  assert.equal(heard(loth.id, '[needs you]').length, 0, 'no question for the person');

  // The step taken, the worker reports on w1 without the wait: it ends; a later wait goes again.
  sessions.events.emit('turnEnd', handle, 'w1: still open: checking the demo output against the brief');
  await until('the wait ends', () => store.work.get('w1')!.orchestratorStep === undefined);
  sessions.events.emit('turnEnd', handle, 'w1: still open: waiting on the orchestrator to send me the summary.md of d1488t1');
  await until('a new wait goes', () => heard(loth.id, '[orchestrator step]').length === 2);
});

test('w2969: the w2194 dragon case: a worker that could not file the approved stages hands them to its person’s orchestrator, and its DONE closes the request only once they are filed', async (t) => {
  const { store, machines, sessions, dispatcher, chat, call, heard } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Ancient Dragon design', brief: 'Design the Ancient Dragon boss and write the build briefs.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Design it', title: 'w1: Ancient Dragon design', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const m = store.machines.get('pc')!;
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const handle = sessions.get(id);
  // The worker has the tool and is told to use it; it has no request_work.
  const spec = machines.hooks!.specFor(info, m);
  assert.ok(spec.mcp?.tools.some((x) => x.name === 'hand_up_requests'), 'a worker has hand_up_requests');
  assert.ok(!spec.mcp?.tools.some((x) => (x.name as string) === 'request_work'), 'a worker has no request_work');
  assert.match(spec.append, /You cannot file a request\. Briefs for new requests .* go to `mcp__machine__hand_up_requests`/);
  // Ben approves on 2026-10-28, in his words; then the worker's 20:27 report: the briefs written, "couldn't file", and DONE.
  await call(ben, 'update_work', { id: 'w1', note: 'Build it in the five stages as designed, numbers tuned in stage 5' });
  sessions.events.emit('turnEnd', handle, "PR #2774 merged: the design and the five build briefs are in specs/w2194-ancient-dragon/build-requests.md. I couldn't file the five build requests myself, because none of my tools can create a request.\n\nDONE: w1\nLearned: nothing new");
  await until('Ben’s orchestrator hears it', () => heard(ben.id, '[follow-ups to file]').length === 1);
  const msg = heard(ben.id, '[follow-ups to file]')[0].text;
  assert.match(msg, new RegExp(`^\\[follow-ups to file\\] w1 "Ancient Dragon design"\\nIts worker ${id} wrote 5 follow-up requests to file`));
  assert.match(msg, /Ben's newest note on w1 \(.*\): "Build it in the five stages as designed, numbers tuned in stage 5"/);
  assert.match(msg, /file each now with request_work, related_ids \["w1"\]/);
  await new Promise((r) => setTimeout(r, 200));
  const w1 = store.work.get('w1')!;
  assert.notEqual(w1.status, 'done', 'its DONE does not close it while the stages are unfiled');
  assert.ok(w1.done?.[id], 'its DONE is kept');
  assert.deepEqual({ count: w1.handedUp?.count, to: w1.handedUp?.to, filed: w1.handedUp?.filed }, { count: 5, to: ['ben'], filed: [] });
  // The same report again sends nothing more.
  sessions.events.emit('turnEnd', handle, "I couldn't file the five build requests myself.\n\nDONE: w1\nLearned: nothing new");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(ben.id, '[follow-ups to file]').length, 1, 'one message per hand-up');

  // w5222: a hand-up read from a report has no briefs to file in one call: file_follow_ups says to file each with request_work
  const none = await call(ben, 'file_follow_ups', { request: 'w1' });
  assert.equal(none.isError, true);
  assert.match(none.text, /named its follow-ups in its report only.*request_work, related_ids \["w1"\]/);
  // Ben's orchestrator files the five stages, related to w1: the last one closes w1 on its worker's DONE.
  for (let n = 1; n <= 5; n++) {
    const filed = await call(ben, 'request_work', { title: `Ancient Dragon stage ${n}`, brief: `Stage ${n} of specs/w2194-ancient-dragon/build-requests.md, as it stands.`, related_ids: ['w1'] });
    assert.equal(filed.isError, false, filed.text);
    if (n < 5) assert.notEqual(store.work.get('w1')!.status, 'done', `still open after ${n}`);
  }
  await until('w1 closes', () => store.work.get('w1')!.status === 'done');
  assert.equal(store.work.get('w1')!.handedUp?.filed.length, 5);
  assert.ok(store.work.get('w1')!.log.some((l) => l.includes('its follow-up requests are filed (w2969)')));

  // The tool path: briefs handed up with hand_up_requests; not wanted, their person closes the request by hand.
  const f2 = await call(ben, 'request_work', { title: 'Boss music design', brief: 'Design the boss music.' });
  const id2 = /Filed (w\d+)/.exec(f2.text)![1];
  const s2 = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Design it', title: `${id2}: Boss music`, work_id: id2, extra_agent: true });
  assert.equal(s2.isError, false, s2.text);
  const wid = /Started agent (\w+)/.exec(s2.text)![1];
  const info2 = store.sessions.get(wid)!;
  await until('its first turn', () => info2.status === 'idle');
  const said = await machines.hooks!.handlersFor(info2, m).hand_up_requests!({ items: [{ title: 'Boss music stage 1', brief: 'Compose the intro.' }, { title: 'Boss music stage 2', brief: 'Compose the loop.' }] });
  assert.match(String(said), new RegExp(`^Handed up 2 follow-up requests for ${id2} to Ben's orchestrator`));
  await until('Ben’s orchestrator hears the briefs', () => heard(ben.id, '[follow-ups to file]').length === 2);
  assert.match(heard(ben.id, '[follow-ups to file]')[1].text, /1\. Boss music stage 1\nCompose the intro\.\n\n2\. Boss music stage 2\nCompose the loop\./);
  // w5222: with briefs, the message says to file them in one call, and to answer a waiting message from the person first
  assert.match(heard(ben.id, '[follow-ups to file]')[1].text, new RegExp(`file them now in one call: file_follow_ups request "${id2}".*Answer a message from Ben waiting in this turn first`));
  const wrong = await call(ben, 'file_follow_ups', { request: id2, items: [3] });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /handed up items 1 to 2; there is no 3/);
  assert.equal((await call(ben, 'file_follow_ups', { request: 'w999' })).isError, true, 'no hand-up there');
  const one = await call(ben, 'file_follow_ups', { request: id2, items: [1] });
  assert.equal(one.isError, false, one.text);
  const filedId = /1\. "Boss music stage 1": Filed (w\d+)/.exec(one.text)![1];
  const stage1 = store.work.get(filedId)!;
  assert.deepEqual({ title: stage1.title, brief: stage1.brief, related: stage1.relatedIds, by: stage1.requestedBy.userId }, { title: 'Boss music stage 1', brief: 'Compose the intro.', related: [id2], by: 'ben' }, 'filed as the worker wrote it');
  assert.deepEqual(store.work.get(id2)!.handedUp?.filed, [filedId]);
  assert.match((await call(ben, 'file_follow_ups', { request: id2, items: [1] })).text, /Already filed as /, 'filing it again is a repeat, not a second request');
  sessions.events.emit('turnEnd', sessions.get(wid), `Design done.\n\nDONE: ${id2}\nLearned: nothing new`);
  await new Promise((r) => setTimeout(r, 200));
  assert.notEqual(store.work.get(id2)!.status, 'done');
  const closed = await call(ben, 'update_work', { id: id2, close: 'done', note: 'Not this month.' });
  assert.equal(closed.isError, false, closed.text);
  assert.equal(store.work.get(id2)!.status, 'done');
});

test('w1378: a worker waiting on a person reaches that person’s orchestrator once, as [needs you] with the question in full; the answer in chat resumes the worker', async (t) => {
  const { store, machines, sessions, agents, dispatcher, chat, call, heard } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Circuit icon button', brief: 'Pills become an icon button.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: Circuit icon button', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const m = store.machines.get('pc')!;
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  assert.equal(heard(ben.id, '[needs you]').length, 0, 'a turn that waits on nobody sends nothing');

  // It stops for Ben's OK of a look (w1360's words, 2026-10-15) and ends its turn saying so.
  const h = machines.hooks!.handlersFor(info, m);
  await h.waiting_on_person!({ who: 'Ben', what: 'OK the circuit button look (stills in /srv/fff/review/w1-icon/w1b-*.png) so PR #1799 can merge on green CI', request: 'w1' });
  const report = 'Stills published: ![main](/srv/fff/review/w1-icon/main.png)\n\nw1: still open: waiting on Ben to OK the look';
  const handle = sessions.get(id);
  sessions.events.emit('turnEnd', handle, report);
  await until('Ben’s orchestrator hears it', () => heard(ben.id, '[needs you]').length === 1);
  const msg = heard(ben.id, '[needs you]')[0].text;
  assert.match(msg, new RegExp(`^\\[needs you\\] w1 "Circuit icon button"\\nQuestion \\(its worker ${id} stopped and waits on Ben\\):\\n\\nOK the circuit button look \\(stills in /srv/fff/review/w1-icon/w1b-\\*\\.png\\) so PR #1799 can merge on green CI\\n`));
  // (This harness has no review root on disk: files are kept as written, a wildcard as code, after them. w1384's test has one.)
  assert.match(msg, /Look at:\n\n- !\[main\.png\]\(<\/srv\/fff\/review\/w1-icon\/main\.png>\)\n- `\/srv\/fff\/review\/w1-icon\/w1b-\*\.png`/);
  assert.match(msg, /Pull requests: #1799/);
  assert.match(msg, /The end of its last report:\n\nStills published/);
  assert.match(msg, new RegExp(`record it with update_work on w1, their answer as the note: FF Factory resumes worker ${id}`));
  const kept = store.work.get('w1')!.needsYou!;
  assert.deepEqual({ kind: kept.kind, worker: kept.worker, to: kept.to }, { kind: 'declared', worker: id, to: ['ben'] });

  // The same wait again: another turn end (a check-in it set), the dispatcher asking for it, the digest: no second message.
  const dispatched = heard(ben.id, '[dispatch]').length;
  sessions.events.emit('turnEnd', handle, report);
  // (decide_work ask is for a request that is not active: one put back to new, as a hold would.)
  Object.assign(store.work.get('w1')!, { status: 'new' });
  const asked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'Ben, is the look OK?', questions: [{ question: 'Is the circuit button look OK?', options: [{ label: 'Yes, merge it', recommended: true }, { label: 'No, change it first' }] }] });
  assert.match(asked.text, /Ben's orchestrator already has this wait as \[needs you\] .*no second message/);
  assert.equal(agents.orchestrators.needsYouDigest(agents.personWaits()), 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(heard(ben.id, '[needs you]').length, 1, 'one message per question');
  assert.equal(heard(ben.id, '[dispatch]').length, dispatched, 'and no [dispatch] question beside it');

  // A note in a turn that is not Ben's (a relayed report) does not answer for him.
  chat(BEN).lastFrom = 'system';
  await call(ben, 'update_work', { id: 'w1', note: 'the worker says it is ready' });
  assert.equal(store.work.get('w1')!.needsYou!.answered, undefined);
  // Ben answers in his own words; his orchestrator records it: the worker resumes with them, and the wait clears.
  chat(BEN).lastFrom = 'human';
  const r = await call(ben, 'update_work', { id: 'w1', note: 'Looks good, merge it' });
  assert.match(r.text, new RegExp(`answers the \\[needs you\\] question: sent to its worker ${id}, which resumes with it`));
  const pending = (agents as unknown as { waker: { pending(id: string): { note: string } | undefined } }).waker.pending(id);
  assert.match(pending!.note, /^\[answer\] Ben answered on w1 "Circuit icon button", in their own words: Looks good, merge it\n\nIt answers what you waited on: "OK the circuit button look/);
  assert.equal(store.work.get('w1')!.needsYou!.answered!.by, 'Ben');
  assert.equal(store.work.get('w1')!.question, undefined, "the dispatcher's question clears with it");
  // w2433: its Latest line was the question; answered, it says so until the worker reports again (w2320 read "waiting on
  // lothsahn to pick the next cut" an hour after lothsahn answered).
  const answered = store.work.get('w1')!;
  assert.equal(answered.needsYou!.answered!.outcome, answered.outcome);
  assert.match(latestLine(answered)!, new RegExp(`^Ben answered at \\d\\d:\\d\\d UTC what it waited on; its worker ${id} resumed on the answer and has not reported since\\.$`));
  const listed = (await call(dispatcher().info, 'list_work', {})).text;
  assert.ok(listed.includes('Latest: Ben answered at ') && !listed.includes(`Latest: ${answered.outcome}`), listed);
  sessions.send(id, pending!.note, 'system');
  await until('its declaration ends with that message', () => info.waitingOn === undefined);
  await until('the resumed turn', () => info.status === 'idle');
  sessions.events.emit('turnEnd', handle, 'Merging it now.');
  assert.equal(latestLine(store.work.get('w1')!), 'Merging it now.', 'its next report is the Latest line again');

  // A new question later (its report's "still open" line names Ben) is a new message.
  sessions.events.emit('turnEnd', handle, 'Merged.\n\nw1: still open: waiting on Ben to pick A or B for the hover colour');
  await until('the second question', () => heard(ben.id, '[needs you]').length === 2);
  assert.match(heard(ben.id, '[needs you]')[1].text, /Question \(its worker \w+ ended its turn saying it needs Ben\):\n\nw1: still open: waiting on Ben to pick A or B for the hover colour/);
  assert.equal(store.work.get('w1')!.needsYou!.kind, 'report');
});

test('w3117: on a request with two workers, a note goes to the worker it names, answers only that one\'s [needs you], and a note that names neither goes to nobody', async (t) => {
  const { store, machines, sessions, agents, dispatcher, chat, call } = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta'] });
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'FFU fan-out', brief: 'Strips and engine trails in parallel.' });
  const start = async (sandbox: string, title: string) => {
    const r = await call(dispatcher().info, 'start_agent', { sandbox, prompt: 'Do it', title, work_id: 'w1', extra_agent: true, override_duplicate: 'a parallel row' });
    assert.equal(r.isError, false, r.text);
    const id = /Started agent (\w+)/.exec(r.text)![1];
    await until(`${title}'s first turn`, () => store.sessions.get(id)!.status === 'idle');
    return id;
  };
  const strips = await start('pc/alpha', 'w1: R.T4 strips');
  const trails = await start('pc/beta', 'w1: R.V3 engine trails');
  const m = store.machines.get('pc')!;
  // The strips worker (w2895's b4440e1e) waits on Ben about ffu #149: its question is the request's open [needs you].
  const h = machines.hooks!.handlersFor(store.sessions.get(strips)!, m);
  await h.waiting_on_person!({ who: 'Ben', what: 'say whether ffu #149 merges without an in-game comparison', request: 'w1' });
  sessions.events.emit('turnEnd', sessions.get(strips), 'w1: still open: waiting on Ben to say whether ffu #149 merges');
  // The trails worker (aa60d124) has ffu #202 open.
  sessions.events.emit('turnEnd', sessions.get(trails), 'Engine trails are up for review on ffu #202.');
  await until('the strips question is the [needs you]', () => store.work.get('w1')!.needsYou?.worker === strips);
  const pending = (id: string) => (agents as unknown as { waker: { pending(id: string): { note: string } | undefined } }).waker.pending(id);
  // Ben's own turn (the [needs you] relayed to his chat opened a turn that was not his).
  await until("Ben's chat ends that turn", () => ben.status === 'idle');
  chat(BEN).lastFrom = 'human';

  // Ben answers the R.V3 card; the note names the trails worker and its PR: it goes there, as a note, and the strips question stays open.
  const v3 = await call(ben, 'update_work', { id: 'w1', note: `For worker ${trails.slice(0, 8)} on ffu #202: keep the long trail` });
  assert.match(v3.text, new RegExp(`not an answer to worker ${strips}'s \\[needs you\\] question, which still waits: the note names ${trails}`));
  assert.match(v3.text, new RegExp(`sent to worker ${trails} as a note`));
  assert.match(pending(trails)!.note, /^\[note\] Ben added a note on w1 "FFU fan-out" that names you, in their own words: For worker \w+ on ffu #202: keep the long trail/);
  assert.equal(pending(strips), undefined, 'the strips worker is not resumed with it');
  assert.equal(store.work.get('w1')!.needsYou!.answered, undefined);

  // A note that names neither worker goes to nobody; the orchestrator hears whose question it would settle.
  const vague = await call(ben, 'update_work', { id: 'w1', note: 'yes, go ahead' });
  assert.match(vague.text, new RegExp(`names none of the 2 workers on w1 .*sent to none of them.*it would settle worker ${strips}'s \\[needs you\\] question "say whether ffu #149 merges`));
  assert.equal(pending(strips), undefined);
  assert.equal(store.work.get('w1')!.needsYou!.answered, undefined);

  // Naming the strips worker's PR answers its question, and only its.
  const t4 = await call(ben, 'update_work', { id: 'w1', note: 'ffu #149: merge it without the comparison' });
  assert.match(t4.text, new RegExp(`answers the \\[needs you\\] question: sent to its worker ${strips}`));
  assert.match(pending(strips)!.note, /^\[answer\] Ben answered on w1 "FFU fan-out", in their own words: ffu #149: merge it/);
  assert.match(pending(trails)!.note, /keep the long trail/, 'the trails worker still has only its own note');
  assert.equal(store.work.get('w1')!.needsYou!.answered!.by, 'Ben');
});

test('w2478: a worker\'s waiting_on_person and decide_work ask on a request with review stills are refused without one inline, accepted with one, and the opt-out is logged', async (t) => {
  const { dir, store, machines, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Circuit button look', brief: 'A new icon.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: Circuit button look', work_id: 'w1' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  const what = 'pick the circuit button look';
  const question = (q: string) => [{ question: q, options: [{ label: 'The blue one', recommended: true }, { label: 'The grey one' }] }];
  // A non-visual request asks as before.
  assert.match(String(await h.waiting_on_person!({ who: 'Ben', what, questions: question('Which look should the button have?'), request: 'w1' })), /buttons on Ben's card/);
  // Its worker publishes stills (here under a topic not named after the request): now the question must show one.
  const topic = path.join(dir, '_review', 'circuit-icon');
  fs.mkdirSync(topic, { recursive: true });
  const still = path.join(topic, 'blue.png');
  fs.writeFileSync(still, 'x');
  store.putWork({ ...store.work.get('w1')!, reviewTopics: ['circuit-icon'] });
  await assert.rejects(h.waiting_on_person!({ who: 'Ben', what, questions: question('Is the button colour right?'), request: 'w1' }), /Not shown: this question is about w1[\s\S]*blue\.png[\s\S]*Nothing was recorded/);
  assert.match(String(await h.waiting_on_person!({ who: 'Ben', what, questions: question(`Is the button colour right? ![the blue one](<${still}>)`), request: 'w1' })), /buttons on Ben's card/);
  // w2664: a pick between designs needs each design's own still; one in the question stands for none.
  await assert.rejects(h.waiting_on_person!({ who: 'Ben', what, questions: question(`Which look should the button have? ![the blue one](<${still}>)`), request: 'w1' }), /picks between designs[\s\S]*"The blue one", "The grey one"/);
  await h.waiting_on_person!({ who: 'Ben', what: 'say when the release goes out', questions: question('Should it ship today?'), request: 'w1', no_previews: 'asks a date; nothing to look at' });
  assert.ok(store.work.get('w1')!.log.some((l) => /waiting_on_person from worker \w+ without previews, though w1 has review media \(no_previews, w2478\): "asks a date; nothing to look at"/.test(l)), store.work.get('w1')!.log.join('\n'));
  // The dispatcher's decide_work ask passes the same check.
  await call(ben, 'request_work', { title: 'Circuit button, second pass', brief: 'Another look.' });
  store.putWork({ ...store.work.get('w2')!, reviewTopics: ['circuit-icon'] });
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'ask', note: 'Ben: which look?', questions: question('Is the button colour right?') });
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /Not shown: this question is about w2/);
  const shown = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'ask', note: 'Ben: which look?', questions: question(`Is the button colour right? ![the blue one](<${still}>)`) });
  assert.equal(shown.isError, false, shown.text);
});

test('w1597: a worker asks with questions: refused with a path, a PR list or no answers; kept on the wait and the record, listed in [needs you]; the answer a click sends, recorded, resumes the worker', async (t) => {
  const { store, machines, agents, sessions, dispatcher, chat, call, heard } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Pre-1.0 release picks', brief: 'Which fixes go in.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: Pre-1.0 release picks', work_id: 'w1' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  const what = 'Decide the go-live moment and the vision speed-up from /srv/fff/review/w1/REPORT.md';
  // Ben, w1597: "I'm never going to look at files at the /srv/ path ... theres so much information like pull request that i dont care about".
  await assert.rejects(h.waiting_on_person!({ who: 'Ben', what, questions: [{ question: 'Decide from /srv/fff/review/w1/REPORT.md', options: [{ label: 'A' }, { label: 'B' }] }] }), /no file paths in the words/);
  await assert.rejects(h.waiting_on_person!({ who: 'Ben', what, questions: [{ question: 'Include #1873, #1880 and #1909?', options: [{ label: 'Yes' }, { label: 'No' }] }] }), /no lists of pull requests/);
  await assert.rejects(h.waiting_on_person!({ who: 'Ben', what, questions: [{ question: 'Go live now?', options: [{ label: 'Yes' }] }] }), /options: 2 to 4/);
  assert.equal(info.waitingOn, undefined, 'nothing recorded by a refused call');
  const questions = [
    { question: 'When should the update go live? ![the release notes draft](</srv/fff/review/w1/notes.png>)', options: [{ label: 'Hold it: I pick the day' }, { label: 'As soon as it is built, with a Steam event', description: 'Ten builds reach players at once.', recommended: true }] },
    { question: 'Should the vision speed-up go in?', options: [{ label: 'Put it in', recommended: true }, { label: 'Leave it out' }] },
  ];
  assert.match(String(await h.waiting_on_person!({ who: 'Ben', what, questions, request: 'w1' })), /with 2 questions as buttons on Ben's card/);
  // The recommended answer first (shared/ask.ts checkAsk), on the declaration.
  assert.deepEqual(info.waitingOn!.asks!.map((a) => a.options[0].label), ['As soon as it is built, with a Steam event', 'Put it in']);
  sessions.events.emit('turnEnd', sessions.get(id), `w1: still open: waiting on Ben to ${what}`);
  await until('Ben’s orchestrator hears it', () => heard(ben.id, '[needs you]').length === 1);
  const r = store.work.get('w1')!.needsYou!;
  assert.equal(r.asks?.length, 2, 'the record carries the questions for the card');
  assert.ok(r.previews.includes('/srv/fff/review/w1/notes.png'), "a question's still is among the previews");
  const msg = heard(ben.id, '[needs you]')[0].text;
  assert.match(msg, /Ask these 2 one at a time with ask_person[\s\S]*Q1\. When should the update go live\?\n1\. As soon as it is built, with a Steam event \(Recommended\) - Ten builds reach players at once\.\n2\. Hold it: I pick the day\n\nQ2\. Should the vision speed-up go in\?\n1\. Put it in \(Recommended\)/);
  // A click on the card sends the answer as typed words would (shared/questionCard.ts answerMessage); the orchestrator records
  // it with update_work in Ben's turn, and the worker resumes with it.
  const answer = answersText(r.asks!, ['As soon as it is built, with a Steam event', 'Put it in']);
  // (The [needs you] message opened a turn of its own in Ben's chat: his answer comes in his next one.)
  await until('that turn ends', () => chat(BEN).info.status === 'idle');
  await new Promise((r) => setTimeout(r, 300));
  chat(BEN).lastFrom = 'human';
  const done = await call(ben, 'update_work', { id: 'w1', note: answer });
  assert.match(done.text, new RegExp(`answers the \\[needs you\\] question: sent to its worker ${id}, which resumes with it`));
  const pending = (agents as unknown as { waker: { pending(id: string): { note: string } | undefined } }).waker.pending(id);
  assert.match(pending!.note, /^\[answer\] Ben answered on w1 "Pre-1\.0 release picks", in their own words: 1\. When should the update go live\?\n   As soon as it is built, with a Steam event\n2\. Should the vision speed-up go in\?\n   Put it in\n/);
  assert.equal(store.work.get('w1')!.needsYou!.answered!.by, 'Ben');
});

test('w1812: one question from one worker on two requests is ONE [needs you]; the answer on either answers both, and nothing asks Ben again', async (t) => {
  const { store, sessions, agents, dispatcher, chat, call, heard, ben, id, h } = await twoRequestsOneWorker(t);
  await h.waiting_on_person!({ who: 'Ben', what: 'Pick a direction for marking circuit structures, and one for the circuit view', questions: CIRCUIT_QUESTIONS });
  const report = 'Mocks published.\n\nw1: still open: waiting on Ben to pick the circuit view direction\nw2: still open: waiting on Ben to pick the circuit view direction';
  sessions.events.emit('turnEnd', sessions.get(id), report);
  await until('Ben hears it', () => heard(ben.id, '[needs you]').length >= 1);
  await sleep(300);
  // One message, on the first, naming the other; the other keeps the same question as shared, sent nowhere.
  assert.equal(heard(ben.id, '[needs you]').length, 1, 'one message for the one question');
  const msg = heard(ben.id, '[needs you]')[0].text;
  assert.match(msg, /^\[needs you\] w1 "Circuit markers in normal view"/);
  assert.match(msg, /The same question, from the same worker, waits on w2 "Circuit alt mode" too: it is ONE question\. Ask it once; the answer recorded on w1 answers it on both/);
  assert.equal(store.work.get('w2')!.needsYou!.sharedWith, 'w1');
  assert.deepEqual(store.work.get('w1')!.needsYou!.also, ['w2']);
  assert.match(store.work.get('w2')!.log.join('\n'), /\[needs you\] not sent again: the same question from worker \w+ is with Ben as w1's \[needs you\]/);
  assert.deepEqual(['w1', 'w2'].map((x) => agents.workLive().get(x)?.state), ['waiting', 'waiting']);

  // Nothing sends it again: not the digest, not another turn end.
  assert.equal(agents.orchestrators.needsYouDigest(agents.personWaits()), 0);
  sessions.events.emit('turnEnd', sessions.get(id), report);
  await sleep(300);
  assert.equal(heard(ben.id, '[needs you]').length, 1);

  // Ben answers on w2 (where he was asked again on 2026-10-22): it answers w1 too, and the worker resumes once.
  await until('that turn ends', () => chat(BEN).info.status === 'idle');
  chat(BEN).lastFrom = 'human';
  const r = await call(ben, 'update_work', { id: 'w2', note: '1. Go with B: the trace, with held-off structures powered down. 2. Use L, and a long press of D-pad up on a pad.' });
  assert.match(r.text, new RegExp(`answers the \\[needs you\\] question \\(the same question on w1: answered there too\\): sent to its worker ${id}, which resumes with it`));
  const a1 = store.work.get('w1')!.needsYou!.answered!;
  assert.deepEqual({ by: a1.by, on: a1.on }, { by: 'Ben', on: 'w2' });
  const pending = (agents as unknown as { waker: { pending(id: string): { note: string } | undefined } }).waker.pending(id);
  assert.match(pending!.note, /which you asked on w2 and w1: it answers it on all of them\. Carry on with it\./);
  assert.ok(['w1', 'w2'].every((x) => agents.workLive().get(x)?.state !== 'waiting'), 'neither waits on input');

  // Ben's orchestrator asks it again anyway (w1182's re-ask): refused once, with his answer; the same call again goes through.
  const again = await call(ben, 'ask_person', CIRCUIT_QUESTIONS[0]);
  assert.equal(again.isError, true);
  assert.match(again.text, /Not asked: Ben already answered this question on w2 \(the same question from the same worker as w1\) at [\d-]+ [\d:]+ UTC, in their words: "1\. Go with B/);
  assert.equal((await call(ben, 'ask_person', CIRCUIT_QUESTIONS[0])).isError, false, 'a new question that only looks the same goes through on a repeat');
  // And the dispatcher's question: refused the same way, nothing recorded.
  Object.assign(store.work.get('w1')!, { status: 'new' });
  const asked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'Ben, which key?', questions: [CIRCUIT_QUESTIONS[1]] });
  assert.equal(asked.isError, true, asked.text);
  assert.match(asked.text, /Not asked: Ben already answered this question on w2/);
  assert.equal(store.work.get('w1')!.question, undefined, 'nothing recorded by the refused ask');
  // The brief says it: look in the request's log and its worker's other requests before asking.
  const brief = (agents as unknown as { personalBrief(r: Requester): string }).personalBrief(BEN);
  assert.match(brief, /\*\*Never re-ask an answered question\*\* \(w1812\): first read the notes of the request and of its worker's other requests/);
});

test('w1868: two questions on one request, the first answered: the second can still be asked, its card stays, and the worker resumes once both are answered', async (t) => {
  const env = await setupOnMachine(t);
  const { store, sessions, agents, dispatcher, chat, call, heard } = env;
  const loth = chat(LOTH).info;
  await call(loth, 'request_work', { title: 'Stacked windows show the back text', brief: 'Fix the see-through frames and the covered Hide button.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: frames', work_id: 'w1' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const h = env.machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  const declared = await h.waiting_on_person!({ who: 'Lothsahn', what: 'Pick the frame look and what comes up over the strip', questions: [FRAME_Q, STRIP_Q], about: 'Stacked game windows let the back window’s text show through.', after: 'I build the picked look and bring you its clips.' });
  assert.match(String(declared), /with 2 questions as buttons/);
  assert.equal(info.waitingOn?.about, 'Stacked game windows let the back window’s text show through.');
  sessions.events.emit('turnEnd', sessions.get(id), 'Stills published.\n\nw1: still open: waiting on Lothsahn to pick the frame look and the strip');
  await until('Lothsahn hears it', () => heard(loth.id, '[needs you]').length >= 1);
  const msg = heard(loth.id, '[needs you]')[0].text;
  assert.match(msg, /What it is: Stacked game windows let the back window’s text show through\./);
  assert.match(msg, /After the answer: I build the picked look and bring you its clips\./);
  assert.equal(store.work.get('w1')!.needsYou!.about, 'Stacked game windows let the back window’s text show through.');

  // He answers the frame look: that question is answered, the strip question still waits on the card, the worker is not woken.
  await until('that turn ends', () => chat(LOTH).info.status === 'idle');
  chat(LOTH).lastFrom = 'human';
  const first = await call(loth, 'update_work', { id: 'w1', note: 'Frame look, verbatim: "Keep frames see-through over space, solid only over a window".' });
  assert.match(first.text, /answers question 1 of the 2 in its \[needs you\] \(w1868\); question 2 still waits on the card/);
  const r = store.work.get('w1')!.needsYou!;
  assert.deepEqual(r.answeredAsks, [0]);
  assert.equal(r.answered, undefined);
  assert.equal(agents.workLive().get('w1')?.state, 'waiting', 'it still waits on input');
  assert.equal(wakeOf(agents, id), undefined, 'the worker waits for both');

  // The strip question goes through (it was refused twice on 2026-10-23); the frame one again is refused, with his words.
  const strip = await call(loth, 'ask_person', STRIP_Q);
  assert.equal(strip.isError, false, strip.text);
  const frame = await call(loth, 'ask_person', FRAME_Q);
  assert.equal(frame.isError, true);
  assert.match(frame.text, /Not asked: Lothsahn already answered this question on w1 .*in their words: "Frame look, verbatim/);

  // The strip answer: both answered, and the worker resumes with both answers.
  chat(LOTH).lastFrom = 'human';
  const second = await call(loth, 'update_work', { id: 'w1', note: 'Station strip: "The whole strip comes up over the window".' });
  assert.match(second.text, /answers the \[needs you\] question/);
  assert.ok(store.work.get('w1')!.needsYou!.answered);
  assert.match(wakeOf(agents, id)!.note, /Frame look, verbatim[\s\S]*Station strip: "The whole strip comes up over the window"/);
  // Nothing of this test fires after it ends.
  agents.cancelWake(id);
});

test('w2051: a person’s list_work list shows their own waiting card brief and another person’s in one line; list_work id and the dispatcher keep the whole card', async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta'] });
  const { store, dispatcher, chat, call, heard } = env;
  const loth = chat(LOTH).info;
  const ben = chat(BEN).info;
  const LONG = 'Keeps the old look for the frames over space and costs one more draw call per window, measured on the Deck at 0.1 ms.';
  const declare = async (who: Requester, title: string, sandbox: string) => {
    await call(chat(who).info, 'request_work', { title, brief: `${title}.` });
    const w = [...store.work.values()].at(-1)!;
    const started = await call(dispatcher().info, 'start_agent', { sandbox, prompt: 'Do it', title: `${w.id}: ${title}`, work_id: w.id });
    const id = /Started agent (\w+)/.exec(started.text)![1];
    const info = store.sessions.get(id)!;
    await firstTurn(info);
    const h = env.machines.hooks!.handlersFor(info, store.machines.get('pc')!);
    const q = { question: FRAME_Q.question, options: FRAME_Q.options.map((o) => ({ ...o, description: LONG })) };
    await h.waiting_on_person!({ who: who.displayName, what: 'Pick the frame look', questions: [q, STRIP_Q], about: 'Stacked game windows let the back window’s text show through.', after: 'I build the picked look and bring you its clips.', request: w.id });
    env.sessions.events.emit('turnEnd', env.sessions.get(id), `${w.id}: still open: waiting on ${who.displayName} to pick the frame look`);
    await until('the person hears it', () => heard(chat(who).info.id, '[needs you]').length >= 1);
    return w.id;
  };
  const mine = await declare(LOTH, 'Stacked windows show the back text', 'pc/alpha');
  const bens = await declare(BEN, 'Circuit icon button', 'pc/beta');

  const list = (await call(loth, 'list_work', { state: 'waiting' })).text;
  // His own move: who, each question and its options by label, the recommended one marked; no reasons, no After.
  assert.match(list, /Who acts: Lothsahn, waiting \d+ min/);
  assert.match(list, /Question 1 of 2: How solid should a window frame be where windows stack\?/);
  assert.match(list, /Options: 1\. Keep frames see-through over space, solid only over a window \(recommended\); 2\. Make every frame fully solid/);
  assert.doesNotMatch(list, /After the answer|draw call/);
  // Ben's move: one line under its request.
  assert.match(list, new RegExp(`- ${bens} [^\\n]*\\n    Waits on Ben, \\d+ min: How solid should a window frame be where windows stack\\? \\(\\+1 more\\)\\n`));
  assert.match(list, /list_work id shows one whole/);
  // The whole card: by id, in the dispatcher's list, and in Ben's own [needs you].
  for (const text of [(await call(loth, 'list_work', { id: mine })).text, (await call(dispatcher().info, 'list_work', { state: 'waiting' })).text]) {
    assert.match(text, /After the answer: I build the picked look and bring you its clips\./);
    assert.ok(text.includes(LONG), 'the option reasons');
  }
  assert.ok((await call(ben, 'list_work', { state: 'waiting' })).text.includes('Waits on Lothsahn'), 'and the same for Ben');
  // w2051's measure: the brief list is well under the whole one (the w1868 card text is most of a waiting list).
  const whole = (await call(dispatcher().info, 'list_work', { state: 'waiting' })).text;
  assert.ok(list.length < whole.length * 0.6, `${list.length} characters against ${whole.length}`);
  for (const s of store.sessions.values()) if (s.kind === 'worker') env.agents.cancelWake(s.id);
});

test('w1868: every ask_person question is an open card until it is answered, asked again, closed or refused', async (t) => {
  const env = setup(t);
  const { store, o, chat, call } = env;
  store.onEvent = (sid, e) => o.observeAsk(sid, e);
  const loth = chat(LOTH);
  const asked = (input: Record<string, unknown>, toolUseId: string, isError = false) => {
    const ev = store.append(loth.info.id, { kind: 'tool_use', toolUseId, name: 'mcp__sandboxes__ask_person', input });
    store.append(loth.info.id, { kind: 'tool_result', toolUseId, isError, text: isError ? 'refused' : 'Shown' });
    return ev.seq;
  };
  const q = (n: number, request: string) => ({ question: `Question ${n} about ${request}: should it go ahead now?`, options: [{ label: `Go ahead with ${request} (${n})`, description: '', recommended: true }, { label: `Hold ${request} (${n})`, description: '' }], request });
  const seqs = [asked(q(1, 'w11'), 'a1'), asked(q(2, 'w12'), 'a2'), asked(q(3, 'w13'), 'a3'), asked(q(4, 'w14'), 'a4'), asked(q(5, 'w14'), 'a5')];
  const open = () => (o.personalOf('lothsahn')!.info.openAsks ?? []).map((a) => a.seq);
  assert.deepEqual(open(), seqs, 'five questions, five cards, two of them about w14');
  assert.equal(o.personalOf('lothsahn')!.info.openAsks![0].request, 'w11');
  // A refused call was never shown: no card.
  asked(q(6, 'w15'), 'a6', true);
  assert.equal(open().length, 5);
  // Asked again: one card, the newer.
  const again = asked(q(2, 'w12'), 'a7');
  assert.deepEqual(open(), [seqs[0], seqs[2], seqs[3], seqs[4], again]);
  // A click (the person's reply quoting it) answers it: the card goes.
  const words = o.answerWords(loth.info.id, seqs[0], 0);
  store.append(loth.info.id, { kind: 'user', from: 'human', text: words, requestedBy: LOTH });
  assert.deepEqual(open(), [seqs[2], seqs[3], seqs[4], again]);
  // The orchestrator closes one that events overtook.
  const closed = await call(loth.info, 'close_question', { seq: seqs[2], why: 'w13 was cancelled' });
  assert.equal(closed.isError, false, closed.text);
  assert.deepEqual(open(), [seqs[3], seqs[4], again]);
  const listed = await call(loth.info, 'close_question', { why: 'list' });
  assert.match(listed.text, new RegExp(`${seqs[3]}: Question 4 about w14`));
});

test('w1955: a card answered in typed words stays open, and request_work and update_work list it so the orchestrator closes it', async (t) => {
  const env = setup(t);
  const { store, o, chat, call } = env;
  store.onEvent = (sid, e) => o.observeAsk(sid, e);
  const loth = chat(LOTH);
  const asked = (question: string, toolUseId: string) => {
    const tag = toolUseId.toUpperCase();
    const ev = store.append(loth.info.id, { kind: 'tool_use', toolUseId, name: 'mcp__sandboxes__ask_person', input: { question, options: [{ label: `Yes, do it that way (${tag})`, description: '', recommended: true }, { label: `No, leave it as it is (${tag})`, description: '' }] } });
    store.append(loth.info.id, { kind: 'tool_result', toolUseId, isError: false, text: 'Shown' });
    return ev.seq;
  };
  const open = () => (o.personalOf('lothsahn')!.info.openAsks ?? []).map((a) => a.seq);
  const timing = asked('Should the 16 GB desktop be a play-only timing machine?', 'a1');
  const cleanup = asked('Should LothLaptop keep its clean-up line?', 'a2');
  // Lothsahn types the answer instead of clicking: no quote, so nothing closes by itself.
  store.append(loth.info.id, { kind: 'user', from: 'human', text: 'Yes, make the 16 GB desktop a play-only timing machine.', requestedBy: LOTH });
  assert.deepEqual(open(), [timing, cleanup], 'typed words close nothing on a guess');
  // A card asked in this turn, after their message, is not an old one.
  const fresh = asked('Which look for the new card?', 'a3');
  const filed = await call(loth.info, 'request_work', { title: 'Play-only timing machine', brief: 'Make the 16 GB desktop a play-only timing machine.' });
  assert.equal(filed.isError, false, filed.text);
  assert.match(filed.text, new RegExp(`open question ${timing} \\(Should the 16 GB desktop be a play-only timing machine\\?\\)`));
  assert.match(filed.text, new RegExp(`open question ${cleanup} `));
  assert.doesNotMatch(filed.text, new RegExp(`open question ${fresh} `));
  assert.match(filed.text, /call close_question with its seq and why in this same turn/);
  assert.deepEqual(open(), [timing, cleanup, fresh], 'listed, not closed');
  // Each card is listed once per turn.
  const wid = /w\d+/.exec(filed.text)![0];
  const second = await call(loth.info, 'update_work', { id: wid, note: 'Also keep it off the render farm.' });
  assert.equal(second.isError, false, second.text);
  assert.doesNotMatch(second.text, /open question/);
  // The orchestrator closes the one the words decided; the other stays, and is listed again in a later turn of theirs.
  const closed = await call(loth.info, 'close_question', { seq: timing, why: 'answered in chat; filed as ' + wid });
  assert.equal(closed.isError, false, closed.text);
  assert.deepEqual(open(), [cleanup, fresh]);
  Object.defineProperty(loth, 'turnId', { value: 'next-turn', configurable: true });
  store.append(loth.info.id, { kind: 'user', from: 'human', text: 'Keep the clean-up line.', requestedBy: LOTH });
  const later = await call(loth.info, 'update_work', { id: wid, note: 'Keep the LothLaptop clean-up line.' });
  assert.match(later.text, new RegExp(`open question ${cleanup} `));
  assert.match(later.text, new RegExp(`open question ${fresh} `), 'asked before this newer message');
  // A turn the harness started (a timer, a relayed report) lists nothing: the person said nothing in it.
  loth.lastFrom = 'system';
  Object.defineProperty(loth, 'turnId', { value: 'timer-turn', configurable: true });
  const quiet = await call(loth.info, 'update_work', { id: wid, note: 'Timer note.' });
  assert.doesNotMatch(quiet.text, /open question/);
  const brief = (env.agents as unknown as { personalBrief(r: Requester): string }).personalBrief(LOTH);
  assert.match(brief, /Answered in typed words: close_question that card that turn \(w1955\)/);
});

test('w1955: a typed message starts its turn with the open cards asked before it, once; a click or a reply quoting a card leaves that card out', async (t) => {
  const { store, o, chat } = setup(t);
  store.onEvent = (sid, e) => o.observeAsk(sid, e);
  const loth = chat(LOTH);
  const asked = (question: string, toolUseId: string) => {
    const tag = toolUseId.toUpperCase();
    const ev = store.append(loth.info.id, { kind: 'tool_use', toolUseId, name: 'mcp__sandboxes__ask_person', input: { question, options: [{ label: `Do it (${tag})`, description: '', recommended: true }, { label: `Leave it (${tag})`, description: '' }] } });
    store.append(loth.info.id, { kind: 'tool_result', toolUseId, isError: false, text: 'Shown' });
    return ev.seq;
  };
  const cleanup = asked('Should LothLaptop keep its clean-up line?', 'c1');
  const timing = asked('Should the 16 GB desktop be a play-only timing machine?', 'c2');
  // No typed message (a click, a harness note): nothing is offered, and nothing is used up.
  assert.equal(o.heldOffer(loth.info.id), '');
  // Typed words that quote no card: both cards are offered, under FF Factory's own mark.
  const typed = 'We already decided on this in a discussion. Reference those decisions.';
  const offer = o.heldOffer(loth.info.id, typed);
  assert.match(offer, /^\n\n\[FF Factory, not your person: your questions still open with them\]\nOpen questions of yours on Lothsahn's Waiting on input tab, asked before this message \(w1955\)/);
  assert.match(offer, new RegExp(`- open question ${cleanup} \\(Should LothLaptop keep its clean-up line\\?\\)`));
  assert.match(offer, new RegExp(`- open question ${timing} `));
  assert.match(offer, /close_question with its seq and why in this same turn/);
  // Offered once: the next typed message lists a card only if it is new.
  assert.equal(o.heldOffer(loth.info.id, 'Ok.'), '');
  const later = asked('Which look for the new panel?', 'c3');
  assert.match(o.heldOffer(loth.info.id, 'Ok.'), new RegExp(`open question ${later} `));
  // A reply quoting a card has answered it: it is left out of the offer.
  const q1 = asked('Should the dispatcher retry?', 'c4');
  const q2 = asked('Should the idle stop be 10 minutes?', 'c5');
  const quoting = o.replyWords(loth.info.id, 'Yes, retry.', q1);
  const reply = o.heldOffer(loth.info.id, quoting);
  assert.doesNotMatch(reply, new RegExp(`open question ${q1} `));
  assert.match(reply, new RegExp(`open question ${q2} `));
  // The reply is sent, so the quoted card closes (observeAsk); nothing is left to offer.
  store.append(loth.info.id, { kind: 'user', from: 'human', text: quoting, requestedBy: LOTH });
  assert.equal(o.heldOffer(loth.info.id, 'Ok.'), '');
  // The typed message the orchestrator receives keeps the person's words ahead of the mark.
  assert.equal(inPersonWords('We already decided on this in a discussion', [typed + offer]), true);
  assert.equal(inPersonWords('call close_question with its seq', [typed + offer]), false, 'the card note is the harness note, not their words');
});

test("w3297: the open-questions note and the held calls reach the orchestrator, each under its own header, and the person's chat shows only their words", async (t) => {
  const { store, o, chat, agents } = setup(t);
  store.onEvent = (sid, e) => o.observeAsk(sid, e);
  const loth = chat(LOTH);
  const asked = (question: string, toolUseId: string) => {
    const ev = store.append(loth.info.id, { kind: 'tool_use', toolUseId, name: 'mcp__sandboxes__ask_person', input: { question, options: [{ label: 'Yes', description: '', recommended: true }, { label: 'No', description: '' }] } });
    store.append(loth.info.id, { kind: 'tool_result', toolUseId, isError: false, text: 'Shown' });
    return ev.seq;
  };
  const sentLast = () => (store.readTranscript(loth.info.id).filter((e) => e.kind === 'user' && e.from === 'human').at(-1) as { text: string }).text;
  const card = asked('Should LothLaptop keep its clean-up line?', 'h1');
  // A typed message while a card is open: the orchestrator receives the card list after the person's words.
  agents.operatorTurn(LOTH, 'When I ask questions, why does it show a huge block?');
  const received = sentLast();
  assert.ok(received.includes(`- open question ${card} (Should LothLaptop keep its clean-up line?)`), 'the orchestrator still gets the list');
  // Lothsahn's chat draws only what he wrote.
  assert.equal(personMessageView(received).words, 'When I ask questions, why does it show a huge block?');
  // The list has its own header: it is not "held from earlier turns" (w830's held calls).
  assert.ok(received.includes(`\n\n${CARDS_MARK}\nOpen questions of yours on Lothsahn's Waiting on input tab`), received);
  assert.ok(!received.includes(HELD_MARK), 'the open questions are not "held from earlier turns"');
  // A reply quoting another card carries the quote and the note: the bubble keeps the quote and the words, never the note.
  const other = asked('Should the idle stop be 10 minutes?', 'h2');
  const third = asked('Which look for the new panel?', 'h3');
  agents.operatorTurn(LOTH, o.replyWords(loth.info.id, 'Yes, 10.', other));
  const reply = personMessageView(sentLast());
  assert.equal(reply.words, 'Yes, 10.');
  assert.equal(reply.quote?.seq, other);
  assert.match(sentLast(), new RegExp(`open question ${third} `));
  // A held call (w830) goes under HELD_MARK, the cards under their own header after it; the chat shows neither.
  (o as unknown as { held: Map<string, unknown[]> }).held.set(loth.info.id, [{ at: new Date().toISOString(), tool: 'update_work', args: { id: 'w4', note: 'move it' }, why: 'the filings limit' }]);
  const fourth = asked('Should the dispatcher retry?', 'h4');
  agents.operatorTurn(LOTH, 'how is it going?');
  const both = sentLast();
  assert.ok(both.startsWith(`how is it going?\n\n${HELD_MARK}\nCalls a gate refused in your earlier turns`), both);
  assert.ok(both.indexOf(CARDS_MARK) > both.indexOf('update_work {"id":"w4"'), both);
  assert.match(both.slice(both.indexOf(CARDS_MARK)), new RegExp(`open question ${fourth} `));
  assert.equal(personMessageView(both).words, 'how is it going?');
  // Held calls alone: only HELD_MARK.
  (o as unknown as { held: Map<string, unknown[]> }).held.set(loth.info.id, [{ at: new Date().toISOString(), tool: 'update_work', args: { id: 'w5' }, why: 'gate' }]);
  const heldOnly = o.heldOffer(loth.info.id, 'ok');
  assert.ok(heldOnly.startsWith(`\n\n${HELD_MARK}\n`) && !heldOnly.includes(CARDS_MARK), heldOnly);
  // Conditional decisions never take words from either note.
  assert.equal(inPersonWords('call close_question with its seq', [received]), false);
  assert.equal(inPersonWords('why does it show a huge block', [received]), true);
});

test('w3253: a [for you] message waits in its person’s bubble until they reply to it, the orchestrator closes it, or they clear it', async (t) => {
  const { store, o, chat, call, dispatcher } = setup(t);
  store.onEvent = (sid, e) => o.observeAsk(sid, e);
  const loth = chat(LOTH);
  const ben = chat(BEN);
  const say = (sid: string, text: string) => store.append(sid, { kind: 'assistant', text }).seq;
  const waiting = (c = loth) => (o.personalOf(c.info.requestedBy!.userId)!.info.forYou ?? []).map((m) => m.seq);
  // A plain message, a relay, waits for nobody; one that starts with the mark does, without it.
  say(loth.info.id, 'w12 started in slot2.');
  const go = say(loth.info.id, '[for you]\nThe release is ready. Say go and I push it to the beta branch.');
  const login = say(loth.info.id, '[For you]: BEAST needs you to log in once at its desk.');
  assert.deepEqual(waiting(), [go, login]);
  const first = o.personalOf('lothsahn')!.info.forYou![0];
  assert.equal(first.id, forYouId(go));
  assert.equal(first.text, 'The release is ready. Say go and I push it to the beta branch.');
  // Each person has their own list; the dispatcher's messages never wait.
  const bens = say(ben.info.id, '[for you] Which look do you want for the ledger?');
  assert.deepEqual(waiting(ben), [bens]);
  assert.deepEqual(waiting(), [go, login]);
  say(dispatcher().info.id, '[for you] nothing');
  assert.equal(dispatcher().info.forYou, undefined);
  // Their next typed message offers the waiting ones to the orchestrator once, so it closes the ones it answers.
  const offer = o.heldOffer(loth.info.id, 'Logged in.');
  assert.match(offer, new RegExp(`- \\[for you\\] ${login} \\(BEAST needs you to log in once at its desk\\.\\)`));
  assert.match(offer, /call close_question with its seq and why/);
  assert.equal(o.heldOffer(loth.info.id, 'Ok.'), '', 'offered once');
  const closed = await call(loth.info, 'close_question', { seq: login, why: 'Lothsahn logged in' });
  assert.equal(closed.isError, false, closed.text);
  assert.match(closed.text, /left the list over your person's message box/);
  assert.deepEqual(waiting(), [go]);
  // A reply quoting it in the chat (the reply mark, w866) takes it off.
  store.append(loth.info.id, { kind: 'user', from: 'human', text: o.replyWords(loth.info.id, 'Go.', go), requestedBy: LOTH });
  assert.deepEqual(waiting(), []);
  assert.equal(o.personalOf('lothsahn')!.info.forYou, undefined);
  // Cleared by hand in the bubble: by its id, beside other people's messages, which the same route clears.
  const again = say(loth.info.id, '[for you] Pick the next request: w20 or w21?');
  const listed = await call(loth.info, 'close_question', { why: 'list' });
  assert.match(listed.text, new RegExp(`Waiting \\[for you\\] messages \\(seq: words\\): ${again}: Pick the next request`));
  assert.equal(o.readPersonMessages(loth.info.id, ['pm-other']), 0, 'an id it does not hold clears nothing');
  assert.equal(o.readPersonMessages(loth.info.id, [forYouId(again)]), 1);
  assert.deepEqual(waiting(), []);
  assert.deepEqual(waiting(ben), [bens], 'Ben’s list is his own');
  // The route without ids clears all of it.
  assert.equal(o.readPersonMessages(ben.info.id), 1);
  assert.deepEqual(waiting(ben), []);
});

test('w3253: splitForYou takes the mark only at the start of a message', () => {
  assert.deepEqual(splitForYou('[for you]\nSay go.'), { forYou: true, text: 'Say go.' });
  assert.deepEqual(splitForYou('  [FOR YOU]: Say go.'), { forYou: true, text: 'Say go.' });
  assert.deepEqual(splitForYou('Done. [for you] was a typo'), { forYou: false, text: 'Done. [for you] was a typo' });
});

test('w1868: waiting_on_person refuses a still on the worker’s own machine; the brief asks every question with ask_person', async (t) => {
  const env = await setupOnMachine(t);
  const { store, dispatcher, chat, call, agents } = env;
  await call(chat(LOTH).info, 'request_work', { title: 'A look', brief: 'Pick a look.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: look', work_id: 'w1' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const h = env.machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  await assert.rejects(
    async () => h.waiting_on_person!({ who: 'Lothsahn', what: 'Pick a look', about: 'A look.', after: 'I build it.', questions: [{ question: 'Which look? ![A](<F:/ffw/tmp/ffa-1/a.png>)', options: [{ label: 'The first look, A', recommended: true }, { label: 'The second look, B' }] }] }),
    /is on your machine, where the card cannot show it .*Publish it with publish_review/,
  );
  assert.equal(info.waitingOn, undefined, 'nothing recorded');
  const brief = (agents as unknown as { personalBrief(r: Requester): string }).personalBrief(LOTH);
  assert.match(brief, /Ask every question to Lothsahn with ask_person, never in text only \(w1868: each is a Waiting-tab card/);
});

test('w1812: no [needs you] when the answer is already logged after the question was raised, on its request or on another its worker holds; a new question still goes', async (t) => {
  const { store, sessions, agents, chat, call, heard, ben, id, h } = await twoRequestsOneWorker(t);
  await h.waiting_on_person!({ who: 'Ben', what: 'Pick a direction for marking circuit structures, and one for the circuit view', questions: CIRCUIT_QUESTIONS });
  await sleep(5);
  // Ben answers on w1 before the worker's turn has ended (he read its report in the Live view): his note is in w1's log.
  chat(BEN).lastFrom = 'human';
  await call(ben, 'update_work', { id: 'w1', note: 'Go with B, and use L' });
  sessions.events.emit('turnEnd', sessions.get(id), 'Mocks published.');
  await until('both recorded as answered', () => !!store.work.get('w1')!.needsYou?.answered && !!store.work.get('w2')!.needsYou?.answered);
  await sleep(300);
  assert.equal(heard(ben.id, '[needs you]').length, 0, 'not asked: the answer is in the log');
  assert.match(store.work.get('w1')!.log.join('\n'), /\[needs you\] not sent: Ben already answered it at [\d:]+ UTC, after the question was raised/);
  assert.match(store.work.get('w2')!.log.join('\n'), /\[needs you\] not sent: Ben already answered it on w1 at [\d:]+ UTC/);
  assert.ok(['w1', 'w2'].every((x) => agents.workLive().get(x)?.state !== 'waiting'), 'neither waits on input');

  // A different question later, for w2 alone, is asked: an answer given before it was raised does not answer it.
  await sleep(5);
  await h.waiting_on_person!({ who: 'Ben', what: 'OK the built-game clip of the circuit view', request: 'w2', questions: [{ question: 'Does the circuit view clip look right?', options: [{ label: 'Yes, build it', recommended: true }, { label: 'No, calmer lines first' }] }] });
  sessions.events.emit('turnEnd', sessions.get(id), 'Clip published.');
  await until('the new question goes', () => heard(ben.id, '[needs you]').length === 1);
  assert.match(heard(ben.id, '[needs you]')[0].text, /^\[needs you\] w2 "Circuit alt mode"/);
  assert.doesNotMatch(heard(ben.id, '[needs you]')[0].text, /The same question, from the same worker/);
});

test('w1378: waits on a person already open when it ships go once, as one [needs you] digest per person', async (t) => {
  const { store, agents, chat, call, heard } = setup(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Comet hit delay', brief: 'Explosions lag.' });
  await call(ben, 'request_work', { title: 'Hint placement', brief: 'Where the yellow hint goes.' });
  await call(chat(LOTH).info, 'request_work', { title: 'Steam Cloud on Mac', brief: 'Path mismatch.' });
  // Questions recorded before w1378 shipped: no [needs you] was sent for them.
  for (const [id, text] of [['w1', 'Which delay did you see: (1), (2) or (3)?'], ['w2', 'Pick A, B or C (PR #1779; stills in /srv/fff/review/w1342-hint/)'], ['w3', 'Did you change the Steamworks override?']]) {
    const w = store.work.get(id)!;
    Object.assign(w, { status: 'question', question: { text, at: T0 } });
    store.putWork(w);
  }
  assert.equal(agents.orchestrators.needsYouDigest(agents.personWaits()), 3);
  await until('one digest each', () => heard(ben.id, '[needs you]').length === 1 && heard(chat(LOTH).info.id, '[needs you]').length === 1);
  const digest = heard(ben.id, '[needs you]')[0].text;
  assert.match(digest, /^\[needs you\] digest: 2 requests wait on Ben's input, sent once/);
  assert.match(digest, /w1 "Comet hit delay"\nQuestion \(the dispatcher asks Ben\):\n\nWhich delay did you see/);
  assert.match(digest, /w2 "Hint placement"[\s\S]*Look at:\n\n- `\/srv\/fff\/review\/w1342-hint\/`\n\nPull requests: #1779/);
  assert.doesNotMatch(digest, /Steam Cloud/, "Lothsahn's question is in his own digest");
  assert.equal(store.work.get('w1')!.needsYou!.digest, true);
  // Never again: not at the next boot, not as a single message.
  assert.equal(agents.orchestrators.needsYouDigest(agents.personWaits()), 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(ben.id, '[needs you]').length, 1);
});

test('w1384: review media reaches the person inline: a [needs you] for a folder lists each clip, and a reply naming it bare gets them', async (t) => {
  const { dir, store, agents, dispatcher, chat, call, heard, sessions } = setup(t);
  // The review root the portal serves (config review.root, here the default <sandboxRoot>/_review), with fog preview v4.
  const topic = path.join(dir, '_review', 'w1-fog-look-v4');
  fs.mkdirSync(path.join(topic, '.preview'), { recursive: true });
  const clip = path.join(topic, 'fog-v4-1920.mp4');
  const still = path.join(topic, 'sheet.png');
  for (const f of [clip, still, path.join(topic, '.preview', 'fog-v4-1920.mp4')]) fs.writeFileSync(f, 'x');
  fs.utimesSync(still, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Fog of war', brief: 'Explored stays explored.' });
  await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'Ben: does fog preview v4 at /srv/fff/review/w1-fog-look-v4/ look right?', questions: [{ question: `Does fog v4 look right? ![fog v4](<${clip}>)`, options: [{ label: 'Yes, ship it', recommended: true }, { label: 'No, change it' }] }] });
  await until('Ben hears it', () => heard(ben.id, '[needs you]').length === 1);
  const msg = heard(ben.id, '[needs you]')[0].text;
  assert.ok(msg.includes(`- ![fog-v4-1920.mp4](<${clip}>)\n- ![sheet.png](<${still}>)`), msg);
  assert.ok(!msg.includes('.preview'));

  // The outgoing check: Ben's orchestrator relays it with the folder bare; what is kept and shown has the clip and the still.
  const reply = store.append(ben.id, { kind: 'assistant', text: 'w1 (fog of war) waits on you: does preview v4 at `/srv/fff/review/w1-fog-look-v4/` look right?' });
  assert.equal(reply.kind === 'assistant' && reply.text, `w1 (fog of war) waits on you: does preview v4 at \`/srv/fff/review/w1-fog-look-v4/\` look right?\n\n![fog-v4-1920.mp4](<${clip}>)\n\n![sheet.png](<${still}>)`);
  // Only a person's own orchestrator: a worker's reply is kept as written.
  const w = sessions.create({ kind: 'worker', title: 'Fog', model: 'opus', permissionMode: 'bypassPermissions', options: () => ({ model: 'opus' }), id: 'wk1', requestedBy: BEN });
  const own = store.append(w.info.id, { kind: 'assistant', text: 'Published /srv/fff/review/w1-fog-look-v4/' });
  assert.equal(own.kind === 'assistant' && own.text, 'Published /srv/fff/review/w1-fog-look-v4/');
  // And the brief says it as a rule, with Ben's words.
  const brief = (agents as unknown as { personalBrief(r: Requester): string }).personalBrief(BEN);
  assert.match(brief, /\*\*Review media goes inline, never a bare path, folder or name\*\*[^\n]*I've reminded you as such like 100 times[^\n]*a folder \(`\/srv\/fff\/review\/<topic>\/`\) is each of its files, newest first, never `\.preview\/`/);
});

test('w694: a delegated request lets its worker merge a clear bug fix or a tests-only PR, keeps a judgement call for a person, and keeps the person-only gates', () => {
  const c = delegationConstraints({ agentName: 'Nightly sentry', model: 'sonnet', effort: 'high' });
  // Merge: an obvious, demonstrated bug (failing-first test or reproduction), or only tests or verdicts, on green CI.
  assert.match(c, /Merge your own pull request into master once its verification is done and CI is green when it fixes a clear, demonstrated bug \(a failing-first test or a reproduction\) or only adds tests or verdicts/);
  // Hold: a design or behaviour change beyond the bug is left open for a person, and the report says so.
  assert.match(c, /changes design or behaviour beyond fixing the bug is a judgement call: leave it open for a person and say so in your report/);
  // No blanket ban on merging, and the other limits stay.
  assert.doesNotMatch(c, /do not merge it yourself|person's merge is the review/i);
  assert.match(c, /never push to master directly and never force-push/);
  assert.match(c, /spends money, publishes or posts outside, changes a live setting, releases or deploys needs a person in their own words/);
  assert.match(c, /Suggested worker: sonnet, high effort/);
});

test('w740: an unrelated request sent to an idle worker on another request starts a NEW session in the same sandbox, with a handover; the old one keeps its request', async (t) => {
  const { store, sessions, o, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Fix the belt splitter', brief: 'Splitters drop items.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix the splitter', title: 'Splitter fix', work_id: 'w1' });
  const old = /Started agent (\w+)/.exec(started.text)![1];
  await until('the first worker idle', () => sessions.get(old).info.status === 'idle');
  const w1 = store.work.get('w1')!;
  w1.prs = [{ repo: 'Final-Factory/FinalFactory', number: 12, state: 'open', via: 'line' }];
  store.putWork(w1);
  await call(ben, 'request_work', { title: 'Rewrite the tutorial text', brief: 'Nothing to do with belts.' });

  const sent = await call(dispatcher().info, 'message_agent', { session_id: old, text: 'Now do w2.', work_id: 'w2', title: 'Tutorial text' });
  assert.equal(sent.isError, false, sent.text);
  const fresh = /Started a NEW session (\w+)/.exec(sent.text)?.[1];
  assert.ok(fresh && fresh !== old, sent.text);
  assert.match(sent.text, /unrelated: nothing ties it to what this worker did/, 'the reply says which way it went and why');
  assert.deepEqual(store.work.get('w2')!.sessionIds, [fresh], 'w2 is on the new session only');
  assert.deepEqual(store.work.get('w1')!.sessionIds, [old], 'w1 stays on its own session');
  assert.match(store.work.get('w2')!.log.join('\n'), /session choice: a NEW session instead of worker \w+'s; unrelated: nothing ties it/, "the request's log says it too");
  // The same sandbox, a different conversation and process.
  assert.equal(sessions.get(fresh).info.machineSandbox, 'alpha');
  assert.equal(sessions.get(fresh).info.machineId, sessions.get(old).info.machineId);
  assert.equal(sessions.get(fresh).info.title, 'w2: Tutorial text');
  assert.equal(store.sessions.get(old)!.title, 'w1: Splitter fix', 'the old session is not retitled');
  assert.ok(!store.readTranscript(old).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('Now do w2.')), 'nothing of w2 went into the old conversation');
  // The first message: the dispatcher's text, the request as filed, the handover with the sandbox and the old session.
  await until('its first message', () => !!firstSaid(store, fresh));
  const first = firstSaid(store, fresh);
  assert.match(first, /^Now do w2\./);
  assert.match(first, /The request as filed \(w2/);
  assert.match(first, /this is a NEW session for w2/);
  assert.match(first, /Sandbox pc\/alpha: /);
  assert.match(first, new RegExp(`last used by session ${old} "w1: Splitter fix", on w1 `));
  assert.match(first, /`Request: w2`/);
  // The old session still has w1 in hand: it keeps running.
  assert.notEqual(sessions.get(old).info.status, 'stopped');
  assert.match(sent.text, new RegExp(`${old} is left running \\(still on w1\\)`));
  assert.equal(o.handsOf(old).map((w) => w.id).join(), 'w1');
});

test("w740: a related request stays in the session that did the earlier work: it names the request, is about its PR or branch, or the dispatcher says so", async (t) => {
  const { store, sessions, o, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Fix the belt splitter', brief: 'Splitters drop items.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix the splitter', title: 'Splitter fix', work_id: 'w1' });
  const old = /Started agent (\w+)/.exec(started.text)![1];
  await until('idle', () => sessions.get(old).info.status === 'idle');
  const w1 = store.work.get('w1')!;
  w1.prs = [{ repo: 'Final-Factory/FinalFactory', number: 12, state: 'merged', head: 'w1-splitter-fix', via: 'line' }];
  store.putWork(w1);
  const workers = () => [...store.sessions.values()].filter((s) => s.kind === 'worker').length;
  const send = (id: string, extra: Record<string, unknown> = {}) => call(dispatcher().info, 'message_agent', { session_id: old, text: `Do ${id}.`, work_id: id, title: `Job ${id}`, ...extra });
  const said = () => store.readTranscript(old).filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text);

  // 1. It names w1 in related_ids: a fix for a regression the worker just shipped.
  await call(ben, 'request_work', { title: 'Splitter regression', brief: 'The merged fix broke the merger.', related_ids: ['w1'] });
  const r2 = await send('w2');
  assert.equal(r2.isError, false, r2.text);
  assert.doesNotMatch(r2.text, /NEW session/);
  assert.match(r2.text, /Same session \(related: it names w1 "Fix the belt splitter" in related_ids\)/);
  assert.equal(workers(), 1, 'no session started');
  assert.deepEqual(store.work.get('w2')!.sessionIds, [old]);
  assert.match(store.work.get('w2')!.log.join('\n'), /session choice: sent to worker \w+'s session; related: it names w1/);
  await until('it reached the session', () => said().some((x) => x.includes('Do w2.')));
  const got = said().find((x) => x.includes('Do w2.'))!;
  assert.match(got, /\[session\] w2 came to this session, not a new one: related: /);
  assert.match(got, /The request as filed \(w2/);
  assert.doesNotMatch(got, /Handover/);

  // 2. It is about the PR of w1, not naming w1.
  await until('idle again', () => sessions.get(old).info.status === 'idle');
  await call(ben, 'request_work', { title: 'Correct the splitter PR description', brief: 'PR #12 lacks its evidence section.' });
  const r3 = await send('w3');
  assert.match(r3.text, /Same session \(related: it is about PR #12, which is w1 "Fix the belt splitter"'s\)/, r3.text);
  assert.equal(workers(), 1);

  // 3. It is about the branch of w1's PR.
  await until('idle again', () => sessions.get(old).info.status === 'idle');
  o.personWrote(ben.id);
  await call(ben, 'request_work', { title: 'Tidy the branch', brief: 'Rebase w1-splitter-fix onto develop.' });
  const r4 = await send('w4');
  assert.match(r4.text, /Same session \(related: it is about the branch w1-splitter-fix, which is w1 "Fix the belt splitter"'s\)/, r4.text);

  // 4. Ambiguous: the dispatcher decides, and must say why. Overruling "unrelated" with 'same'...
  await until('idle again', () => sessions.get(old).info.status === 'idle');
  await call(ben, 'request_work', { title: 'Add a splitter tooltip', brief: 'Show the priority on hover.' });
  const noWhy = await send('w5', { session: 'same' });
  assert.equal(noWhy.isError, true);
  assert.match(noWhy.text, /session "same" overrules the server's reading \(the server read it as unrelated: nothing ties it.*say why in session_reason/);
  const same = await send('w5', { session: 'same', session_reason: 'the tooltip is the next step of the splitter work' });
  assert.equal(same.isError, false, same.text);
  assert.match(same.text, /Same session \(the dispatcher chose the same session: the tooltip is the next step of the splitter work \(the server read it as unrelated: nothing ties it/);
  assert.equal(workers(), 1, 'the dispatcher kept it in the session');
  assert.match(store.work.get('w5')!.log.join('\n'), /session choice: sent to worker \w+'s session; the dispatcher chose the same session: the tooltip/);

  // 5. ... and overruling "related" with 'new': it starts a new session, whose handover lists the request and its PR.
  await until('idle again', () => sessions.get(old).info.status === 'idle');
  o.personWrote(ben.id);
  await call(ben, 'request_work', { title: 'Splitter docs', brief: 'Write the doc page.', related_ids: ['w1'] });
  const fresh = await send('w6', { session: 'new', session_reason: 'a docs job, big enough to want clean context' });
  assert.equal(fresh.isError, false, fresh.text);
  const id = /Started a NEW session (\w+)/.exec(fresh.text)![1];
  assert.match(fresh.text, /the dispatcher chose a new session: a docs job, big enough to want clean context \(the server read it as related: it names w1/);
  await until('its first message', () => !!firstSaid(store, id));
  assert.match(firstSaid(store, id), /- w1 "Fix the belt splitter" \(active; PRs: #12 merged\)/);
  assert.equal(workers(), 2);
});

test('w740: the old session is stopped once it has nothing else in hand: now when idle, at its turn end when mid-turn', async (t) => {
  shortSlowTurns(t);
  const { store, agents, sessions, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Check the tooltips', brief: 'Look at them.' });
  const idle = agents.startWorker({ sandbox: 'pc/alpha', prompt: 'Hello', title: 'Idle', from: 'human', requestedBy: BEN });
  await until('idle', () => idle.info.status === 'idle');
  const a = await call(dispatcher().info, 'message_agent', { session_id: idle.info.id, text: 'Take w1.', work_id: 'w1', title: 'Tooltips' });
  assert.equal(a.isError, false, a.text);
  assert.match(a.text, new RegExp(`${idle.info.id} is stopped \\(nothing else in hand\\)`));
  await until('the idle worker stopped', () => store.sessions.get(idle.info.id)!.status === 'stopped');

  // A worker mid-turn on nothing the ledger holds is left alone, and stopped by the turn end that finds it free.
  await call(ben, 'request_work', { title: 'Check the labels', brief: 'Look at them too.' });
  const busy = agents.startWorker({ sandbox: 'pc/alpha', prompt: '#slow', title: 'Busy', from: 'human', requestedBy: BEN });
  await until('running', () => busy.info.status === 'running');
  const b = await call(dispatcher().info, 'message_agent', { session_id: busy.info.id, text: 'Take w2.', work_id: 'w2', title: 'Labels' });
  assert.equal(b.isError, false, b.text);
  assert.match(b.text, new RegExp(`${busy.info.id} is left running \\(mid-turn\\)`));
  assert.equal(sessions.get(busy.info.id).info.status, 'running', 'its turn goes on');
  await until('the busy worker stopped at its turn end', () => store.sessions.get(busy.info.id)!.status === 'stopped', 8000);
});

test('w740: a new request sent to a worker mid-turn on its own request starts a new session and leaves the busy one running', async (t) => {
  shortSlowTurns(t);
  const { store, sessions, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Slow job', brief: 'Takes a while.' });
  await call(ben, 'request_work', { title: 'Other job', brief: 'Something else.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: '#slow', title: 'Slow', work_id: 'w1' });
  const old = /Started agent (\w+)/.exec(started.text)![1];
  await until('running', () => sessions.get(old).info.status === 'running');
  const sent = await call(dispatcher().info, 'message_agent', { session_id: old, text: 'Do w2.', work_id: 'w2', title: 'Other job' });
  assert.equal(sent.isError, false, sent.text);
  const fresh = /Started a NEW session (\w+)/.exec(sent.text)![1];
  assert.notEqual(fresh, old);
  assert.equal(sessions.get(old).info.status, 'running', 'mid-turn on its own request: left alone');
  assert.equal(store.work.get('w2')!.sessionIds.join(), fresh);
  await until('its first message', () => !!firstSaid(store, fresh));
  assert.match(firstSaid(store, fresh), /^Do w2\./);
  // Nothing of w2 queued behind the old turn.
  assert.equal(store.sessions.get(old)!.queuedSend, undefined);
});

test('w740: updates to a request stay in its session: a message with the same work_id, no new session', async (t) => {
  const { store, sessions, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Fix the belt splitter', brief: 'Splitters drop items.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: 'Splitter fix', work_id: 'w1' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  await until('idle', () => sessions.get(id).info.status === 'idle');
  const before = [...store.sessions.values()].filter((s) => s.kind === 'worker').length;
  const note = await call(dispatcher().info, 'message_agent', { session_id: id, text: 'Ben added a note: also check the merger.', work_id: 'w1' });
  assert.equal(note.isError, false, note.text);
  assert.doesNotMatch(note.text, /NEW session/);
  assert.equal([...store.sessions.values()].filter((s) => s.kind === 'worker').length, before, 'no session started');
  await until('the note reached the session', () => store.readTranscript(id).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('also check the merger')));
  assert.deepEqual(store.work.get('w1')!.sessionIds, [id]);
  // Not handed as a new request: no request-as-filed block, no handover.
  const sent = store.readTranscript(id).filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text).at(-1)!;
  assert.doesNotMatch(sent, /The request as filed|Handover/);
});

test('w740: start_agent into the same sandbox for another request is a second session there, with its own handover', async (t) => {
  const { store, sessions, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'First job', brief: 'One.' });
  await call(ben, 'request_work', { title: 'Second job', brief: 'Two.', related_ids: ['w1'] });
  const one = /Started agent (\w+)/.exec((await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'One', title: 'First', work_id: 'w1' })).text)![1];
  const r2 = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Two', title: 'Second', work_id: 'w2', override_duplicate: 'w2 is the regression test for w1, not a repeat of it', extra_agent: true });
  assert.equal(r2.isError, false, r2.text);
  const two = /Started agent (\w+)/.exec(r2.text)![1];
  assert.notEqual(one, two);
  assert.equal(sessions.get(one).info.machineSandbox, 'alpha');
  assert.equal(sessions.get(two).info.machineSandbox, 'alpha', 'the sandbox is reused when the dispatcher chooses it');
  await until('its first message', () => !!firstSaid(store, two));
  assert.match(firstSaid(store, two), /this is a NEW session for w2/);
  assert.match(firstSaid(store, two), /- w1 "First job"/);
});

test('w740: decide_work link is the same-work mark: refused for an unrelated request on a worker with one in hand, allowed when it names it', async (t) => {
  const { store, sessions, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Fix the belt splitter', brief: 'Splitters drop items.' });
  await call(ben, 'request_work', { title: 'Rewrite the tutorial', brief: 'Nothing to do with belts.' });
  await call(ben, 'request_work', { title: 'Splitter follow-up', brief: 'The direct follow-up.', related_ids: ['w1'] });
  const id = /Started agent (\w+)/.exec((await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix', title: 'Splitter fix', work_id: 'w1' })).text)![1];
  const no = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'link', note: 'Already on it.', session_ids: [id], title: 'Tutorial' });
  assert.equal(no.isError, true);
  assert.match(no.text, /is not related to it: nothing ties it to what this worker did/);
  assert.deepEqual(store.work.get('w2')!.sessionIds, []);
  assert.equal(sessions.get(id).info.title, 'w1: Splitter fix', 'a refused link renames nothing');
  const yes = await call(dispatcher().info, 'decide_work', { id: 'w3', action: 'link', note: 'Direct follow-up.', session_ids: [id], title: 'Splitter follow-up' });
  assert.equal(yes.isError, false, yes.text);
  assert.deepEqual(store.work.get('w3')!.sessionIds, [id]);
  // Linked and never sent: its first message carries the request as filed.
  await until('idle', () => sessions.get(id).info.status === 'idle');
  const sent = await call(dispatcher().info, 'message_agent', { session_id: id, text: 'Go on with w3.', work_id: 'w3' });
  assert.equal(sent.isError, false, sent.text);
  assert.doesNotMatch(sent.text, /NEW session/);
  await until('w3 reached the same session', () => store.readTranscript(id).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('The request as filed (w3')));
});

test("w1076: lothsahn's request sent to Ben's worker starts a NEW session on lothsahn's tokens, whatever the relation or 'same' says; link is refused", async (t) => {
  const { store, sessions, o, dispatcher, call, file, bensWorker } = await setupTwoAccounts(t);
  const a = await bensWorker();
  // w2 names w1 (the server reads it as related) and the dispatcher even says 'same': w1072's 01:36 join.
  file('w2', LOTH, { title: 'Ice lost after starting a ship', relatedIds: ['w1'] });
  const link = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'link', note: 'Same work.', session_ids: [a], title: 'Ice' });
  assert.equal(link.isError, true);
  assert.match(link.text, /w2 runs on Lothsahn's Claude tokens, and worker \w+ is on w1 "Rocket Adapters burn cargo" \(Ben's\), so its process runs on Ben's\. A request runs on its own person's tokens \(w1076\)/);
  assert.deepEqual(store.work.get('w2')!.sessionIds, []);

  const sent = await call(dispatcher().info, 'message_agent', { session_id: a, text: 'Take w2.', work_id: 'w2', title: 'Ice', session: 'same', session_reason: 'the adapters burn ice: the same code' });
  assert.equal(sent.isError, false, sent.text);
  const b = /Started a NEW session (\w+)/.exec(sent.text)?.[1];
  assert.ok(b && b !== a, sent.text);
  assert.match(sent.text, /a request runs on its own person's tokens \(w1076\), so the dispatcher's "same" is overruled \(the server read it as related: it names w1/);
  assert.deepEqual(store.work.get('w2')!.sessionIds, [b]);
  assert.deepEqual(store.work.get('w1')!.sessionIds, [a]);
  assert.match(store.work.get('w2')!.log.join('\n'), /session choice: a NEW session instead of worker \w+'s; w2 runs on Lothsahn's Claude tokens/);
  assert.ok(!store.readTranscript(a).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('Take w2.')), "nothing of w2 went into Ben's conversation");
  // The new session: the same sandbox, its process on lothsahn's token from its first turn; Ben's stays on Ben's.
  assert.equal(sessions.get(b).info.machineSandbox, 'alpha');
  await until("the new session's process on lothsahn's token", () => sessions.get(b).info.ranFor === 'lothsahn');
  assert.equal(sessions.get(a).info.ranFor, 'ben');
  assert.equal(o.sessionPersonOf(a), 'ben');
  assert.equal(o.sessionPersonOf(b), 'lothsahn');

  // Ben's own related request still goes to Ben's worker (w740 unchanged for one person).
  await until('idle', () => sessions.get(a).info.status === 'idle');
  file('w3', BEN, { title: 'Adapter tooltip', relatedIds: ['w1'] });
  const same = await call(dispatcher().info, 'message_agent', { session_id: a, text: 'Take w3.', work_id: 'w3', title: 'Tooltip' });
  assert.match(same.text, /Same session \(related: it names w1/, same.text);
});

test('w1076: a request already in another person\'s session moves out on its next message_agent; session "new" is honoured for a request the worker is on', async (t) => {
  const { store, sessions, o, dispatcher, call, file, bensWorker } = await setupTwoAccounts(t);
  const a = await bensWorker();
  // The state w1072 was left in: lothsahn's w2 sent into Ben's worker before w1076 (and sent last, so it is what it serves).
  file('w2', LOTH, { title: 'Ice lost after starting a ship', status: 'active', sessionIds: [a], links: { [a]: { at: new Date(Date.now() + 1000).toISOString(), how: 'sent' } } });
  // Its next process stays on Ben's tokens (the person it ran for keeps a mixed session), never Ben's w1 on lothsahn's.
  assert.equal(o.sessionPersonOf(a), 'ben');
  assert.equal(o.accountClash(store.work.get('w1')!, a), undefined, "Ben's request stays in Ben's session");
  assert.match(o.accountClash(store.work.get('w2')!, a)!, /w2 runs on Lothsahn's Claude tokens/);

  // The dispatcher restarts w2 with the same session id and no session choice: it moves to a new session (02:03 went to a33e1437).
  const moved = await call(dispatcher().info, 'message_agent', { session_id: a, text: 'Restart w2 on lothsahn\'s account.', work_id: 'w2' });
  assert.equal(moved.isError, false, moved.text);
  const b = /Started a NEW session (\w+)/.exec(moved.text)?.[1];
  assert.ok(b && b !== a, moved.text);
  assert.match(moved.text, new RegExp(`w2 is taken off ${a}`));
  assert.deepEqual(store.work.get('w2')!.sessionIds, [b], 'the old worker no longer has it');
  assert.equal(store.work.get('w2')!.links?.[a], undefined);
  assert.match(store.work.get('w2')!.log.join('\n'), new RegExp(`taken off worker ${a}: it moves to a new session in the same sandbox: w2 runs on Lothsahn's Claude tokens`));
  assert.deepEqual(o.handsOf(a).map((w) => w.id), ['w1']);
  await until("lothsahn's token", () => sessions.get(b).info.ranFor === 'lothsahn');
  assert.ok(!store.readTranscript(a).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('Restart w2')));

  // session "new" on a request the worker is on, one person: it needs a reason, and then moves it.
  await until('idle', () => sessions.get(b).info.status === 'idle');
  const noWhy = await call(dispatcher().info, 'message_agent', { session_id: b, text: 'Go on.', work_id: 'w2', session: 'new' });
  assert.equal(noWhy.isError, true);
  assert.match(noWhy.text, /session "new" moves w2 off \w+, which is on it already: say why in session_reason/);
  const fresh = await call(dispatcher().info, 'message_agent', { session_id: b, text: 'Go on in a clean session.', work_id: 'w2', session: 'new', session_reason: 'its session stopped on a usage limit' });
  assert.equal(fresh.isError, false, fresh.text);
  const c = /Started a NEW session (\w+)/.exec(fresh.text)![1];
  assert.match(fresh.text, /the dispatcher chose a new session: its session stopped on a usage limit/);
  assert.deepEqual(store.work.get('w2')!.sessionIds, [c]);
  assert.equal(sessions.get(c).info.title, 'w2: Ice lost after starting a ship', 'titled from the request when no title is given');
});

test("w1076: a request taken over by another person restarts its worker's process on their tokens at the next turn, in the same conversation", async (t) => {
  const { store, sessions, o, dispatcher, call, bensWorker } = await setupTwoAccounts(t);
  const a = await bensWorker();
  const turnsBefore = sessions.get(a).info.turns;
  // lothsahn acts on Ben's w1 (w1031): it runs for him from now on.
  o.takeOver(store.work.get('w1')!, LOTH, 'Lothsahn added a note');
  assert.equal(o.sessionPersonOf(a), 'lothsahn');
  const r = await call(dispatcher().info, 'message_agent', { session_id: a, text: 'Lothsahn added a note: check the ice too.', work_id: 'w1' });
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(r.text, /NEW session/, 'one person in the session: no new session, the account switches');
  await until("the turn ran on lothsahn's token", () => sessions.get(a).info.ranFor === 'lothsahn' && sessions.get(a).info.status === 'idle' && store.readTranscript(a).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('check the ice too')), 10_000);
  const events = store.readTranscript(a);
  const stop = events.find((e) => e.kind === 'system' && /Its process stops and starts again on another Claude account: its process runs on ben's Claude tokens and its requests are lothsahn's now/.test((e as { text: string }).text));
  const note = events.find((e) => e.kind === 'user' && (e as { text: string }).text.includes('check the ice too'));
  assert.ok(stop && note && note.seq > stop.seq, "the note is a turn of the new process, never of the one on Ben's token");
  assert.equal(events.filter((e) => e.kind === 'system' && /Its process stops and starts again/.test((e as { text: string }).text)).length, 1, 'one restart: the daemon\'s copy does not put it back on ben');
  assert.ok(sessions.get(a).info.turns > turnsBefore, 'the same session went on');
  assert.equal(store.sessions.get(a)!.queuedSend, undefined, 'nothing left waiting');
});

// ---------------------------------------------------------------- w1166: a process carried over by a daemon update

test('w1166: a worker whose process outlived a daemon update restarts on the new FF Factory code before its next turn, and hears so first', async (t) => {
  const { store, sessions, machines, dispatcher, chat, call } = await setupOnMachine(t);
  // On 2026-10-12 the update to ba015be (#359, develop retired) adopted the agent hosts started on 5b129b4 at 21:30-21:37
  // UTC; they kept the old guard and the "develop is the integration branch" prompt and opened game PRs into develop.
  const OLD = '5b129b4662b35a482564f94a70b8bcf6606fb153';
  const NEW = 'ba015be249737669ea7bf47425ba88f6817babf9';
  const hello = (machines as unknown as { hellos: Map<string, { daemon?: string }> }).hellos.get('pc')!;
  hello.daemon = OLD;
  await call(chat(BEN).info, 'request_work', { title: 'Blueprint folder share', brief: 'Share a folder.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Share a blueprint folder', title: 'Folder share', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const w = sessions.get(id);
  await until('idle on the old code', () => w.info.status === 'idle' && w.info.ranOn === OLD);
  assert.ok(w.live, 'its process stays up between turns');
  const firstPrompt = store.readTranscript(id).find((e) => e.kind === 'user') as { text: string };
  assert.doesNotMatch(firstPrompt.text, /\[updated\]/, 'a first process has nothing to compare with');

  // The update: the daemon runs the new commit; the worker's process carried on (adopted), still on the old code.
  hello.daemon = NEW;
  const r = await call(dispatcher().info, 'message_agent', { session_id: id, text: 'Open the PR now.', work_id: 'w1' });
  assert.equal(r.isError, false, r.text);
  await until('the turn ran on a new process', () => w.info.ranOn === NEW && w.info.status === 'idle' && store.readTranscript(id).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('Open the PR now.')), 10_000);
  const events = store.readTranscript(id);
  const stops = events.filter((e) => e.kind === 'system' && /Its process stops and starts again on its machine's FF Factory code: its process started on FF Factory 5b129b4 and pc runs ba015be now, so it restarts on the new code \(its guard and system prompt\) before this turn \(w1166\)/.test((e as { text: string }).text));
  assert.equal(stops.length, 1, 'one restart');
  const turn = events.find((e) => e.kind === 'user' && (e as { text: string }).text.includes('Open the PR now.')) as { seq: number; text: string };
  assert.ok(turn.seq > stops[0].seq, 'the message is a turn of the new process, never of the one on the old code');
  assert.match(turn.text, /^\[updated\] FF Factory was updated since your last process started \(it ran 5b129b4; this machine runs ba015be now\)\. Your process started again on the new code, in the same conversation, so your system prompt and the guard are the current ones\. Where they differ from what you were told or read earlier in this conversation \(the branch to integrate into, a PR's base, a rule\), follow them\./);
  assert.equal(store.sessions.get(id)!.queuedSend, undefined, 'nothing left waiting');

  // On the current code now: the next message goes straight to the same process, with no note.
  await call(dispatcher().info, 'message_agent', { session_id: id, text: 'And merge it on green.', work_id: 'w1' });
  await until('the next turn', () => w.info.status === 'idle' && store.readTranscript(id).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('And merge it on green.')));
  const after = store.readTranscript(id);
  assert.equal(after.filter((e) => e.kind === 'system' && /Its process stops and starts again/.test((e as { text: string }).text)).length, 1, 'no second restart');
  assert.doesNotMatch((after.findLast((e) => e.kind === 'user') as { text: string }).text, /\[updated\]/);

  // Mid-turn or with a background task running, a message reaches the running process (a restart would cut it off).
  hello.daemon = OLD;
  const move = (i: Partial<SessionInfo>, live = true) => (sessions as unknown as { codeMove(s: SessionHandle): string | undefined }).codeMove({ info: { ...w.info, ...i }, live } as unknown as SessionHandle);
  assert.match(move({}) ?? '', /restarts on the new code/);
  assert.equal(move({ status: 'running', turnOpenSince: new Date().toISOString() }), undefined, 'mid-turn');
  assert.equal(move({ backgroundTasks: 1 }), undefined, 'a background task runs');
  assert.equal(move({}, false), undefined, 'no live process: the next one starts on the current code anyway');
  assert.equal(move({ kind: 'orchestrator' }), undefined, 'workers only');
  assert.match(move({ ranOn: undefined }) ?? '', /started on FF Factory from before w1166/, 'a process from before ranOn was recorded counts as other code');
  hello.daemon = undefined;
  assert.equal(move({}), undefined, 'the machine did not say what it runs: nothing to compare');
});

test('w1076: sessionPerson: the person of the requests in hand, never the session\'s starter; a mixed session keeps the person it ran for', () => {
  const cfg = {} as Config;
  const w = (id: string, who: Requester, over: Partial<WorkItem> = {}) => ({ id, requestedBy: who, requesters: [who], ...over }) as WorkItem;
  assert.equal(sessionPerson(cfg, [w('w2', LOTH)], [w('w2', LOTH)]), 'lothsahn');
  assert.equal(sessionPerson(cfg, [], []), undefined);
  const both = [w('w1', BEN), w('w2', LOTH)];
  assert.equal(sessionPerson(cfg, both, [both[1]], 'ben'), 'ben');
  assert.equal(sessionPerson(cfg, both, [both[1]], 'lothsahn'), 'lothsahn');
  assert.equal(sessionPerson(cfg, both, [both[1]]), 'lothsahn', 'never ran: the request it serves');
  const taken = w('w1', BEN, { runsFor: { userId: 'lothsahn', displayName: 'Lothsahn', at: T0, why: 'noted' } });
  assert.equal(sessionPerson(cfg, [taken], [taken], 'ben'), 'lothsahn', 'one person: theirs, whoever it ran for');
  assert.equal(personForWork(cfg, w('w9', BEN, { unattributed: true, source: { kind: 'discord-bug' } as WorkItem['source'] })), 'lothsahn', "the intake's default");
});

test('w754: w750 as it happened: block on A, a hold, the hold lifted with A still open stays blocked; start is refused; gate B joins; each clears in turn and only then does it start', async (t) => {
  const { store, sessions, agents, o, dispatcher, chat, call, heard } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  // w1 stands for w727 (Deck screens), w2 for w752 (the Technology label fix), w3 for w750 (the release), w4 for another release.
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', status: 'active' }, { id: 'w3' }, { id: 'w4' }]);
  const loth = chat(LOTH).info;
  const decide = (id: string, a: Record<string, unknown>) => call(dispatcher().info, 'decide_work', { id, note: 'because', ...a });

  // 06:57 the dispatcher blocks the release on w727.
  assert.equal((await decide('w3', { action: 'block', blocker: { kind: 'request', ref: 'w1', what: 'the Deck screens merged' } })).isError, false);
  assert.equal(store.work.get('w3')!.status, 'blocked');
  // 07:19 a hold (ask), which used to drop the gate: it stays.
  assert.equal((await decide('w3', { action: 'ask', note: 'Held on lothsahn: a potential bug.', questions: [{ question: 'Which one?', options: [{ label: 'The first', recommended: true }, { label: 'The second' }] }] })).isError, false);
  assert.equal(store.work.get('w3')!.status, 'question');
  assert.equal(store.work.get('w3')!.blocked?.ref, 'w1', 'the hold did not drop the gate');
  // 07:27 "You can unblock the release": the hold is lifted and w1 is still open: it goes back to Blocked, not to the dispatcher.
  // w3161: Lothsahn's own words lift it; a note outside a turn of theirs leaves the hold standing.
  sessions.send(loth.id, 'You can unblock the release', 'human', undefined, { requestedBy: LOTH });
  await until('the turn ends', () => loth.status === 'idle');
  const go = await call(loth, 'update_work', { id: 'w3', note: "GO: you can unblock the release. I've verified it's not an issue." });
  assert.equal(go.isError, false, go.text);
  const w3 = store.work.get('w3')!;
  assert.equal(w3.status, 'blocked');
  assert.equal(w3.blocked?.ref, 'w1');
  assert.match(w3.log.join('\n'), /still blocked on w1 finishing: a lifted hold does not lift a gate/);
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w3' })).text, /Blocked on w1 finishing/);
  // The dispatcher starting it anyway (what happened at 07:27) is refused, and nothing started.
  const start = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Release it', title: 'w3: release', work_id: 'w3' });
  assert.equal(start.isError, true);
  assert.match(start.text, /w3 is gated on w1 finishing \(the Deck screens merged\), which has not cleared\. A hold lifted or a "go" does not lift a gate/);
  assert.deepEqual([store.work.get('w3')!.status, store.work.get('w3')!.sessionIds], ['blocked', []]);
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w3', action: 'queue', note: 'x' })).isError, true, 'queueing it would drop the gate too');
  // 07:40 gate B (w752) is added to the same block.
  assert.equal((await decide('w3', { action: 'block', add_blocker: true, blocker: { kind: 'request', ref: 'w2', what: 'the Technology label fix merged' } })).isError, false);
  assert.deepEqual([store.work.get('w3')!.blocked?.ref, store.work.get('w3')!.alsoBlocked?.map((g) => g.ref)], ['w1', ['w2']]);
  const line = (await call(dispatcher().info, 'list_work', { id: 'w3' })).text;
  assert.match(line, /Blocked on w1 finishing, w2 finishing/);
  assert.match(line, /the Deck screens merged; also the Technology label fix merged/);
  // Blocking again with no blocker keeps both (the dispatcher cannot lose a gate by re-blocking).
  assert.equal((await decide('w3', { action: 'block' })).isError, false);
  assert.deepEqual([store.work.get('w3')!.blocked?.ref, store.work.get('w3')!.alsoBlocked?.map((g) => g.ref)], ['w1', ['w2']]);
  // A gate cannot wait on itself.
  assert.match((await decide('w3', { action: 'block', blockers: [{ kind: 'request', ref: 'w3', what: 'itself' }] })).text, /cannot be blocked on itself/);

  // A person's own word lets the dispatcher start a gated request: a different request, so w3 stays gated for the rest.
  assert.equal((await decide('w4', { action: 'block', blocker: { kind: 'request', ref: 'w2', what: 'w2 first' } })).isError, false);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do w4', title: 'w4: do it', work_id: 'w4', override_gate: 'lothsahn: start w4 now, w2 does not matter for it', extra_agent: true });
  assert.equal(started.isError, false, started.text);
  assert.equal(store.work.get('w4')!.status, 'active');
  assert.equal(store.work.get('w4')!.blocked, undefined, 'the start dropped its gates');
  assert.match(store.work.get('w4')!.log.join('\n'), /\(gate overridden: "lothsahn: start w4 now, w2 does not matter for it"\)/);

  // The watch: w1 closes, the first gate goes and it stays Blocked on w2; w2 closes, and only then is it unblocked and the dispatcher told.
  const watch = new BlockerWatch({ store, orchestrators: o });
  assert.equal((await watch.tick()).has('w3'), false, 'both still open');
  store.work.get('w1')!.status = 'done';
  assert.match((await watch.tick()).get('w3')!, /^clear: w1 closed as done/);
  const half = store.work.get('w3')!;
  assert.deepEqual([half.status, half.blocked?.ref, half.alsoBlocked], ['blocked', 'w2', undefined]);
  assert.match(half.log.join('\n'), /w1 finishing cleared \(w1 closed as done\); still blocked on w2 finishing/);
  assert.equal(heard(dispatcher().info.id, '[ledger] w3').length, 0, 'not told to start it while a gate is open');
  store.work.get('w2')!.status = 'done';
  await watch.tick();
  assert.deepEqual([store.work.get('w3')!.status, store.work.get('w3')!.blocked], ['new', undefined]);
  await until('the dispatcher is told to start it', () => heard(dispatcher().info.id, '[ledger] w3').some((e) => /is unblocked: it waited on w2 finishing/.test(e.text)));
  // Now it starts without an override.
  const ok = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Release it', title: 'w3: release', work_id: 'w3', override_duplicate: 'not a repeat of w4', extra_agent: true });
  assert.equal(ok.isError, false, ok.text);
});

test('w3758: ffu#518 (23:39Z) and FinalFactory#3469 (00:00Z) as it happened: CI reads GitHub\'s rate limit refuses hold the wait, paused and logged once, for 40 min; the reads answering again end the pause; a spent budget pauses too', async (t) => {
  const { store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2' }]);
  const ffu = 'Final-Factory/ffu#518';
  const game = 'Final-Factory/FinalFactory#3469';
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'ci', ref: ffu, what: 'CI on PR #518' } })).isError, false);
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'x', blocker: { kind: 'ci', ref: game, what: 'CI on PR #3469' } })).isError, false);
  const warn = console.warn;
  console.warn = () => undefined;
  t.after(() => {
    console.warn = warn;
    resetBudgets();
  });
  let clock = Date.now();
  // The words of the 00:00Z reads: the GraphQL refusal first, the rate limit behind it.
  const limited = (ref: string) => `its checks: GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup); its Actions runs: gh: API rate limit exceeded for user ID 10092359. (HTTP 403) (${ref})`;
  let ci: (ref: string) => { done: boolean; text: string } = (ref) => {
    throw new Error(limited(ref));
  };
  let reads = 0;
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, ci: async (ref) => (reads++, ci(ref)) });
  for (let m = 0; m <= 40; m += 5) {
    assert.equal((await watch.tick()).size, 0, `still waiting at ${m} min`);
    clock += 5 * 60_000;
  }
  for (const [id, ref] of [['w1', ffu], ['w2', game]] as const) {
    const w = store.work.get(id)!;
    assert.equal(w.status, 'blocked', `${id} is never cleared by a rate-limited read`);
    assert.equal(w.log.filter((l) => l.includes(`paused: GitHub's rate limit refused the read of ${ref}`)).length, 1, `${id}: the pause is logged once: ${w.log.join(' | ')}`);
  }
  // The limit refills: the reads answer, the pause ends (logged), and running CI holds the wait as before.
  ci = (ref) => ({ done: false, text: `1 of 1 workflow runs on ${ref} still running` });
  assert.equal((await watch.tick()).size, 0);
  for (const [id, ref] of [['w1', ffu], ['w2', game]] as const) assert.match(store.work.get(id)!.log.at(-1)!, new RegExp(`GitHub answers reads of ${ref.replace(/[/#]/g, '.')} again: the rate-limit pause is over`));

  // A spent budget (its last answer said 0 left) pauses a plain GraphQL refusal too, and no read is made until it refills.
  clock += 5 * 60_000;
  noteBudget(undefined, (n) => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.round(clock / 1000) + 3600) })[n], clock);
  const before = reads;
  for (let m = 0; m <= 20; m += 5) {
    assert.equal((await watch.tick()).size, 0);
    clock += 5 * 60_000;
  }
  assert.equal(reads, before, 'nothing is read while the budget is spent');
  assert.equal(store.work.get('w1')!.status, 'blocked');
  assert.equal(store.work.get('w2')!.status, 'blocked');
});
