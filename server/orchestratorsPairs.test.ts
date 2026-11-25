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
 * The orchestrator tests (docs/orchestrators.md), end to end on a real Agents with the scripted agent: room for queued requests and pair runs: request_pair, its legs, retries.
 * One of the server/orchestrators*.test.ts files split out of orchestrators.test.ts (w5826); helpers in orchestratorsTestKit.ts.
 */


test('w1944: one free sandbox is room for the first queued request that fits it: decide_work queue takes a newer request, says who the room goes to, and only the first in line is flagged WRONG', async (t) => {
  const { store, agents, o, dispatcher, call } = setup(t);
  // biscuit at 01:16Z: slot3 free since 01:15:09, its one free sandbox; w1917 (20:21) queued ahead of w1961 (01:15).
  const f = { game: ['biscuit'], agent: [] as string[], held: [], slots: { 'game:biscuit': 1 } as Record<string, number>, since: { 'game:biscuit': Date.parse(T0) - 60_000 } };
  agents.roomNow = () => f.game;
  agents.roomFacts = () => f;
  putRequests(store, [
    { id: 'w1917', status: 'queued', queuedFor: { at: '2026-09-28T07:00:00.000Z' }, createdAt: '2026-09-28T07:00:00.000Z' },
    { id: 'w1918', status: 'queued', queuedFor: { at: '2026-09-28T07:30:00.000Z' }, createdAt: '2026-09-28T07:30:00.000Z' },
    { id: 'w1961' },
  ]);
  (o as unknown as { now: () => Date }).now = () => new Date(T0);
  const queued = await call(dispatcher().info, 'decide_work', { id: 'w1961', action: 'queue', note: "biscuit's last free one goes to an older request" });
  assert.equal(queued.isError, false, queued.text);
  assert.match(store.work.get('w1961')!.log.join('\n'), /queued for capacity; biscuit has room, but it goes first to w1917, ahead in the queue \(urgent first, then the oldest\)/);
  // After the grace, only w1917 is WRONG; w1918 and w1961 wait rightly.
  (o as unknown as { now: () => Date }).now = () => new Date(Date.parse(T0) + 11 * 60_000);
  assert.deepEqual(o.flagQueuedWithRoom(agents.roomFacts()), ['w1917']);
  const list = (await call(dispatcher().info, 'list_work', { id: 'w1918' })).text;
  assert.doesNotMatch(list, /WRONG/);
  assert.match(list, /biscuit has room, but it goes first to w1917/);
  // Two free sandboxes: room for w1917 and w1918, still none for a third; five: room for w1963, behind four queued.
  f.slots = { 'game:biscuit': 2 };
  putRequests(store, [{ id: 'w1962' }]);
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w1962', action: 'queue', note: 'room is spoken for' })).isError, false);
  f.slots = { 'game:biscuit': 5 };
  putRequests(store, [{ id: 'w1963' }]);
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w1963', action: 'queue', note: 'no room' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /queue is for capacity only, and biscuit has room for w1963 now/);
});

// ---------------------------------------------------------------- w1945: pair runs placed as one unit

// lothsahn, 2026-10-23: "Can we make the dispatcher smart enough so it queues work properly that requires running together
// across multiple machines and doesn't waste slots?" w665's worker d558ba14 held m3's only sandbox while the two-machine run
// of its PR #2340 (w1936) sat Queued; w1940's client leg on biscuit waited on w1898's host leg placed separately.

test('w1945: request_pair files one pair request and blocks the asking worker on its report, so its sandbox is released at once (w890 waitOn); asked again, it waits on the same one', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w665', by: BEN }]);
  const a = await startedFor(env, 'w665');
  await assert.rejects(async () => a.h.request_pair!({ what: 'x', brief: 'y', legs: 0 }), /legs is 1 to 4: the computers it needs at once \(1: one computer runs host and client side by side, ffnightly\.py's default lab\)/);
  await assert.rejects(async () => a.h.request_pair!({ what: 'x', brief: 'y', legs: 1, cross_os: 'Burst codegen' }), /cross_os needs legs of 2 or more/);
  const out = String(await a.h.request_pair!({ what: 'MP-lowore-pin-pair on PR #2340', brief: 'Run MP-lowore-pin-pair on branch w665-lowore-pin-no-collider; pass: 400 heartbeats compared, none diverged.', legs: 2 }));
  // w3697: its legs each run MP-lowore-pin-pair alone (no pair lab named), so no leg goes on a Mac, and the answer and brief say so.
  assert.match(out, /^Filed (w\d+), a pair run of 2 legs, on any computers, any OS \(a Mac only as the host, leg 1\), no leg on a Mac \(each leg starts MP-lowore-pin-pair's host and client on its own computer; w3697\), for w665\. The dispatcher starts its legs together/);
  assert.match(out, /Recorded: w665 is Blocked on /);
  assert.match(out, /your sandbox is then released at once for other work/);
  const id = /^Filed (w\d+)/.exec(out)![1];
  const p = store.work.get(id)!;
  assert.deepEqual(p.pair, { legs: 2, legsSaid: true, for: 'w665', forSession: a.id, pr: 'Final-Factory/FinalFactory#2340' });
  assert.equal(p.needs, 'game');
  assert.equal(p.priority, 'normal');
  assert.deepEqual(p.requesters, [BEN]);
  assert.deepEqual(p.relatedIds, ['w665']);
  assert.equal(p.title, 'Pair run for w665: MP-lowore-pin-pair on PR #2340');
  assert.match(p.brief, /the host leg \(leg 1\) reports the result with a line "For w665:"/);
  assert.match(p.brief, /No leg goes on a Mac \(w3697\): each leg starts MP-lowore-pin-pair's host and its client on its own computer, and a Mac refuses a multiplayer client/);
  assert.equal(p.overlaps.some((o) => o.ref === 'w665'), false, 'the request it is for is no repeat of it');
  const w = store.work.get('w665')!;
  assert.equal(w.status, 'blocked');
  assert.equal(w.blocked?.kind, 'request');
  assert.equal(w.blocked?.ref, id);
  assert.equal(w.blocked?.on, 'report');
  // The w890 release reads this: its sandbox frees at once (server/placeAgain.test.ts, "w890: a worker that ends its turn
  // waiting on request frees its sandbox at once").
  (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
  assert.match(agents.waitOn(a.info) ?? '', new RegExp(`^it waits on w665: ${id}`));
  const again = String(await a.h.request_pair!({ what: 'MP-lowore-pin-pair again', brief: 'Same.' }));
  assert.ok(again.startsWith(`w665 already has an open pair run, ${id} (new: `), again);
  assert.equal([...store.work.values()].filter((x) => x.pair).length, 1);
});

test('w2041: w1976 as it happened: a retry of a spent pair run cancels it and files a fresh one off the failed computer; only the fresh run resumes the asker, never an old leg', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w1904', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w1904');
  const ask = async (extra: Record<string, unknown> = {}) => String(await a.h.request_pair!({ what: 'MP-W1904-connector-filter-list on PR #2364', brief: 'Run MP-W1904-connector-filter-list at c7891d5; pass: 0 diverged.', ...extra }));
  const first = /^Filed (w\d+)/.exec(await ask())![1];
  // Its legs started: the host on pc, the client on lothlaptop (a computer this portal knows, not connected: offline).
  const worker = (id: string) => store.putSession({ id, kind: 'worker', title: `leg ${id}`, status: 'idle', permissionMode: 'bypassPermissions', createdAt: T0, lastActivityAt: T0, turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: BEN } as unknown as SessionInfo);
  worker('f09cb847');
  worker('92fef195');
  const p = store.work.get(first)!;
  p.status = 'active';
  p.sessionIds = ['f09cb847', '92fef195'];
  p.pair = { ...p.pair!, started: { at: T0, legs: [{ session: 'f09cb847', sandbox: 'pc/slot5' }, { session: '92fef195', sandbox: 'lothlaptop/slot1' }] } };
  store.putWork(p);

  // Running with every leg healthy (lothlaptop not known yet: not offline) and nothing reported: asked again, it waits on it.
  const again = await ask();
  assert.ok(again.startsWith(`w1904 already has an open pair run, ${first} (active: `), again);
  assert.match(again, /ask again with retry: true and avoid naming that computer/);

  // lothlaptop goes offline; the host leg says DONE with the check not run (w1976, 12:46Z).
  store.putMachine({ ...store.machines.get('pc')!, id: 'lothlaptop' });
  o.workerTurnEnded(store.sessions.get('f09cb847')!, 'For w1904: NOT RUN: the client on lothlaptop never joined (Tailscale stuck).\nDONE: ' + first + '\nLearned: nothing new');
  assert.equal(store.work.get(first)!.status, 'active', 'the client leg 92fef195 is still on it');

  // "retry": the spent run is cancelled, a fresh one filed with new legs, not on lothlaptop.
  const retry = await ask({ what: 'MP-W1904-connector-filter-list on PR #2364 (retry)' });
  const fresh = /filed (w\d+), a retry/.exec(retry)?.[1];
  assert.ok(fresh && fresh !== first, retry);
  assert.match(retry, new RegExp(`^${first} \\(its legs f09cb847 already reported\\) is cancelled`));
  assert.match(retry, new RegExp(`Only ${fresh}'s report resumes you, never one from ${first}'s legs`));
  const old = store.work.get(first)!;
  assert.equal(old.status, 'cancelled');
  assert.match(old.outcome ?? '', new RegExp(`^superseded by ${fresh}, a retry`));
  const n = store.work.get(fresh!)!;
  assert.equal(n.status, 'new');
  assert.deepEqual(n.sessionIds, [], 'fresh legs: none of the old run carries over');
  assert.equal(n.pair!.retryOf, first);
  assert.deepEqual(n.pair!.avoid, ['lothlaptop'], 'the offline client computer; the host computer pc is fine');
  assert.match(n.constraints ?? '', /not on lothlaptop$/);
  assert.match(n.brief, new RegExp(`This is a retry of ${first}.*no leg goes on lothlaptop`));
  assert.match(unfitWhy(n, 'lothlaptop', undefined) ?? '', /^lothlaptop is where an earlier leg of this pair run failed/);
  assert.equal(unfitWhy(n, 'pc', undefined), undefined);
  const w = store.work.get('w1904')!;
  assert.deepEqual([w.status, w.blocked?.ref, w.blocked?.on], ['blocked', fresh, 'report']);

  // The old host leg reports again (DONE: <old>, "For w1904:"): the asker stays blocked on the fresh run.
  o.workerTurnEnded({ ...store.sessions.get('f09cb847')!, lastActivityAt: new Date(Date.now() + 60_000).toISOString() }, `For w1904: nothing has changed.\nDONE: ${first}\nLearned: nothing new`);
  const watch = new BlockerWatch({ store, orchestrators: o });
  assert.equal((await watch.tick()).has('w1904'), false, 'no report of the old run clears it');
  assert.deepEqual([store.work.get('w1904')!.status, store.work.get('w1904')!.blocked?.ref], ['blocked', fresh]);
  // A worker that asks once more while the fresh run is Queued waits on it: no third run.
  const third = await ask();
  assert.ok(third.startsWith(`w1904 already has an open pair run, ${fresh} (new: `), third);
  assert.equal([...store.work.values()].filter((x) => x.pair && isOpen(x)).length, 1);
});

test('w2041: retry: true replaces a running pair run that cannot deliver; avoid keeps the named computer off its legs, and start_agent refuses a leg there', async (t) => {
  const env = await twoComputers(t);
  const { store, dispatcher, call } = env;
  putRequests(store, [{ id: 'w665', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w665');
  const ask = async (extra: Record<string, unknown> = {}) => String(await a.h.request_pair!({ what: 'MP-lowore-pin-pair on PR #2340', brief: 'Run it.', legs: 2, ...extra }));
  const first = /^Filed (w\d+)/.exec(await ask())![1];
  const p = store.work.get(first)!;
  p.status = 'active';
  p.pair = { ...p.pair!, started: { at: T0, legs: [{ session: 'h1', sandbox: 'pc/slot9' }, { session: 'c1', sandbox: 'beast/slot2' }] } };
  store.putWork(p);
  // Both computers online, no leg reported: only the asker's retry: true replaces it; avoid names the computer it saw fail.
  const retry = await ask({ retry: true, avoid: ['Beast'] });
  const fresh = /filed (w\d+), a retry/.exec(retry)![1];
  assert.ok(retry.startsWith(`${first} (retried by its asker) is cancelled`), retry);
  assert.equal(store.work.get(first)!.status, 'cancelled');
  const n = store.work.get(fresh)!;
  assert.deepEqual(n.pair!.avoid, ['beast']);
  assert.deepEqual(roomForWork({ game: ['pc', 'beast'], agent: [], held: [] }, n).ids, [], 'one computer left is no room for two legs');
  const leg = await call(dispatcher().info, 'start_agent', { work_id: fresh, prompt: 'Run it.', title: 'pair', sandbox: 'beast/slot1', pair_sandboxes: ['pc/alpha'] });
  assert.equal(leg.isError, true);
  assert.ok(leg.text.includes(`leg 1 (the host) on beast/slot1: ${fresh} is a retry of ${first}, whose leg failed on beast: its legs go on other computers (w2041). Nothing was started.`), leg.text);
  assert.deepEqual(store.work.get(fresh)!.sessionIds, []);
});

test('w1945: a pair request starts both legs together, each on its own computer, never one leg alone; a Mac is no client; message_pair reaches the other leg', async (t) => {
  const env = await twoComputers(t);
  const { store, machines, dispatcher, call } = env;
  putRequests(store, [{ id: 'w2', by: BEN, status: 'queued', queuedFor: { at: T0 }, pair: { legs: 2 } }]);
  const start = (extra: Record<string, unknown>) => call(dispatcher().info, 'start_agent', { work_id: 'w2', prompt: 'Run MP-lowore-pin-pair on branch w665-lowore-pin-no-collider.', title: 'MP-lowore-pin-pair', sandbox: 'pc/alpha', ...extra });
  const nothing = () => assert.deepEqual(store.work.get('w2')!.sessionIds, [], 'nothing was started');
  const one = await start({});
  assert.equal(one.isError, true);
  assert.match(one.text, /w2 is a pair run of 2 legs, on any computers, any OS \(a Mac only as the host, leg 1\): start every leg together, sandbox for leg 1 \(the host\) and pair_sandboxes for the others/);
  nothing();
  assert.match((await start({ pair_sandboxes: ['pc/alpha'] })).text, /two legs on pc: each leg of a pair run goes on its own computer/);
  store.putMachine({ ...store.machines.get('beast')!, platform: 'darwin' });
  assert.match((await start({ pair_sandboxes: ['beast/slot1'] })).text, /leg 2 on beast\/slot1: beast is a Mac, and a Mac refuses a multiplayer client \(w665\).*Nothing was started\./);
  nothing();
  store.putMachine({ ...store.machines.get('beast')!, platform: 'win32' });

  // w2282: a Mac hosts (leg 1) a pair that needs no cross-OS pair.
  store.putMachine({ ...store.machines.get('pc')!, platform: 'darwin' });
  const ok = await start({ pair_sandboxes: ['beast/slot1'] });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /^Started w2's 2 legs together, requested by Ben: leg 1 \(host\): agent \w+ in pc\/alpha.*; leg 2: agent \w+ in beast\/slot1/);
  const w = store.work.get('w2')!;
  assert.equal(w.status, 'active');
  assert.equal(w.sessionIds.length, 2);
  assert.deepEqual(w.pair!.started!.legs.map((l) => l.sandbox), ['pc/alpha', 'beast/slot1']);
  assert.match(w.log.join('\n'), /its 2 legs started together \(w1945\): leg 1 \(host\) \w+ in pc\/alpha, leg 2 \w+ in beast\/slot1/);
  const [l1, l2] = w.pair!.started!.legs.map((l) => store.sessions.get(l.session)!);
  assert.equal(l1.machineId, 'pc');
  assert.equal(l2.machineId, 'beast');
  await until('both legs end their first turn', () => l1.status === 'idle' && l2.status === 'idle');
  const said = (id: string) => JSON.stringify(store.readTranscript(id));
  assert.match(said(l1.id), /You are leg 1 of 2, the host/);
  assert.match(said(l2.id), /You are leg 2 of 2, a client/);
  const h1 = machines.hooks!.handlersFor(l1, store.machines.get('pc')!);
  assert.equal(String(await h1.message_pair!({ text: 'host listens at 100.74.97.12:7890 on 1a2b3c4' })), `Sent to leg 2 ${l2.id}.`);
  await until('leg 2 hears it', () => said(l2.id).includes('[pair w2, from leg 1 (host)'));
  // A worker that is no leg of a pair has no one to tell.
  putRequests(store, [{ id: 'w3', by: BEN }]);
  const other = await call(dispatcher().info, 'start_agent', { work_id: 'w3', prompt: 'Fix it', title: 'fix', sandbox: 'pc/alpha', extra_agent: true });
  const o = store.sessions.get(/Started agent (\w+)/.exec(other.text)![1])!;
  await assert.rejects(async () => machines.hooks!.handlersFor(o, store.machines.get('pc')!).message_pair!({ text: 'hi' }), /you are no leg of an open pair run/);
});


test('w4601: a pair leg started on a computer whose player cache holds the pair\'s commit is told the player\'s path and to skip the build; the other leg is not', async (t) => {
  const env = await twoComputers(t);
  const { store, machines, dispatcher, call } = env;
  const sha = '670a034960aa11bb22cc33dd44ee55ff66778899';
  putRequests(store, [{ id: 'w2', by: BEN, status: 'queued', queuedFor: { at: T0 }, pair: { legs: 2, commit: sha } }]);
  const stats = (machines as unknown as { stats: Map<string, MachineStats> }).stats;
  stats.set('beast', { ...(stats.get('beast') ?? ({} as MachineStats)), playerCache: { root: 'D:\\work\\ffw\\player-cache', entries: [{ key: `${sha}-win`, at: '2026-11-17T16:00:00Z' }] }, at: new Date().toISOString() });
  const ok = await call(dispatcher().info, 'start_agent', { work_id: 'w2', prompt: 'Run the MP determinism pair.', title: 'MP pair', sandbox: 'beast/slot1', pair_sandboxes: ['pc/alpha'] });
  assert.equal(ok.isError, false, ok.text);
  const [l1, l2] = store.work.get('w2')!.pair!.started!.legs.map((l) => store.sessions.get(l.session)!);
  await until('both legs end their first turn', () => l1.status === 'idle' && l2.status === 'idle');
  const said = (id: string) => JSON.stringify(store.readTranscript(id));
  assert.ok(said(l1.id).includes(`--player D:\\\\work\\\\ffw\\\\player-cache\\\\${sha}-win\\\\player`), 'leg 1 on beast names the cached player (JSON-escaped)');
  assert.match(said(l1.id), /A player of this commit is already built here \(w4601\)/);
  assert.doesNotMatch(said(l2.id), /already built here/, 'pc holds no player of it');
});

test('w4596: request_pair legs 1 files a pair run of 1 leg that no Mac takes, and start_agent starts it with sandbox alone: one worker runs host and client', async (t) => {
  const env = await twoComputers(t);
  const { store, machines, dispatcher, call } = env;
  putRequests(store, [{ id: 'w665', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w665');
  const out = String(await a.h.request_pair!({ what: 'MP-lowore-pin-pair on PR #2340', brief: 'Run MP-lowore-pin-pair on branch w665-lowore-pin-no-collider with ffnightly.py on the default lab; pass: 400 heartbeats compared, none diverged.', legs: 1 }));
  assert.match(out, /^Filed (w\d+), a pair run of 1 leg, on any computers, any OS \(a Mac only as the host, leg 1\), no leg on a Mac \(each leg starts MP-lowore-pin-pair's host and client on its own computer; w3697\), for w665\. The dispatcher starts its one leg, a new worker that runs the host and the client on its own computer, as soon as one computer has room\./);
  const id = /^Filed (w\d+)/.exec(out)![1];
  assert.equal(store.work.get(id)!.pair!.legs, 1);
  const start = (extra: Record<string, unknown>) => call(dispatcher().info, 'start_agent', { work_id: id, prompt: 'Run MP-lowore-pin-pair.', title: 'MP-lowore-pin-pair', sandbox: 'beast/slot1', ...extra });
  assert.match((await start({ pair_sandboxes: ['pc/alpha'] })).text, new RegExp(`${id} is a pair run of 1 leg, .*: give 1 sandboxes \\(sandbox and 0 in pair_sandboxes\\), not 2`));
  store.putMachine({ ...store.machines.get('beast')!, platform: 'darwin' });
  assert.match((await start({})).text, /beast is a Mac, and each leg of w\d+ starts MP-lowore-pin-pair's host and its client on its own computer.*Nothing was started\./);
  assert.deepEqual(store.work.get(id)!.sessionIds, [], 'a Mac took no leg');
  store.putMachine({ ...store.machines.get('beast')!, platform: 'win32' });
  const ok = await start({});
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /^Started w\d+'s one leg, requested by Ben: leg 1 \(host\): agent \w+ in beast\/slot1/);
  const w = store.work.get(id)!;
  assert.equal(w.sessionIds.length, 1);
  assert.deepEqual(w.pair!.started!.legs.map((l) => l.sandbox), ['beast/slot1']);
  const leg = store.sessions.get(w.pair!.started!.legs[0].session)!;
  await until('the leg ends its first turn', () => leg.status === 'idle');
  const said = JSON.stringify(store.readTranscript(leg.id));
  assert.match(said, /You are the only leg of this pair run, in beast\/slot1: run the host and the client on this computer/);
  assert.doesNotMatch(said, /the others are on|You are leg 1 of 1/);
  // w4614 (w4609's leg): the leg builds with the real script into the shared player cache and leaves it there (w4601 places
  // later legs by it), and runs ffnightly.py from its checkout, not a copy in $TMPDIR.
  // w4669: bash in front (Windows starts no .sh: spawn EFTYPE) and the project folder first; ffnightly.py run with --sha and --out.
  assert.match(said, /unity-slot run -- bash scripts\/nightly\/build_player\.sh \\"\$PWD\\" <40-hex sha> <win\|mac\|linux>/);
  assert.match(said, /ffnightly\.py run --player <the printed path> --sha <40-hex sha> --scenario <id> --out /);
  assert.match(said, /shared player cache \(<worker root>\/player-cache\/<sha>-<os>, outside the tree\).*leave the player there/);
  assert.match(said, /Run ffnightly\.py from your sandbox's checkout, never a copy in \$TMPDIR/);
  assert.doesNotMatch(said, /move the player out of the tree|[^/]scripts\/build_player\.sh/);
});

test('w4618: request_pair without legs files one leg on the default lab, and two when it names a reason to need computers at once (cross_os, steam, timed, split, a pair lab, pair_relay); a count passed outright stands', async (t) => {
  const env = await twoComputers(t);
  const { store } = env;
  const ids = ['w4571', 'w4701', 'w4702', 'w4703', 'w4704', 'w4705', 'w4706', 'w4707', 'w4708'];
  putRequests(store, ids.map((id) => ({ id, by: BEN, status: 'active' as const })));
  const file = async (id: string, extra: Record<string, unknown>) => {
    const a = await startedFor(env, id);
    const out = String(await a.h.request_pair!({ what: `MP scenarios for ${id}`, brief: 'Play MP-station-drive-join host + client with ffnightly.py run on the default lab; pass: 0 diverged.', ...extra }));
    const p = /^Filed (w\d+)/.exec(out);
    assert.ok(p, out);
    return store.work.get(p![1])!.pair!;
  };
  // w4595's shape: ffnightly MP scenarios on the default lab, no legs passed.
  const one = await file('w4571', { what: 'w4571 determinism pair: #3814 + #3823 combined at f20e095502', brief: W4595_BRIEF.split('\n\nFF Factory filed')[0] });
  assert.equal(one.legs, 1, 'one computer runs host and client side by side');
  assert.equal(one.legsSaid, undefined);
  assert.equal((await file('w4701', { cross_os: 'Burst codegen differs by platform' })).legs, 2, 'cross_os');
  assert.equal((await file('w4702', { steam: 'a Steam lobby join' })).legs, 2, 'steam');
  assert.equal((await file('w4703', { timed: true })).legs, 2, 'timed');
  assert.equal((await file('w4704', { split: 'a Mac may host leg 1' })).legs, 2, 'split');
  assert.equal((await file('w4705', { brief: 'Run MP-station-drive-join on lab.pair-m5-beast.json, leg 1 hosts; pass: 0 diverged.' })).legs, 2, 'a pair lab in the brief');
  assert.equal((await file('w4706', { brief: 'Run MP-station-drive-join through pair_relay.py, a Linux relay client; pass: 0 diverged.' })).legs, 2, 'pair_relay in the brief');
  const said = await file('w4707', { legs: 2 });
  assert.deepEqual([said.legs, said.legsSaid], [2, true], 'a count passed outright stands, and is never cut');
  const three = await file('w4708', { legs: 3, cross_os: 'the desync hash' });
  assert.deepEqual([three.legs, three.legsSaid], [3, true]);
});

test('w4618: a Queued pair run shaped like w4595 (two legs of ffnightly MP scenarios on the default lab, filed before w4618) is cut to one leg once, and its log says so; runs with a reason, a count asked for, or legs started are not', async (t) => {
  const env = await setupOnMachine(t);
  const { store, o } = env;
  const run = (id: string, pair: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, by: LOTH, status: 'queued' as const, title: `Pair run for w4571: w4571 determinism pair (${id})`, brief: W4595_BRIEF, constraints: 'a pair run of 2 legs, on any computers, any OS (a Mac only as the host, leg 1)', pair: { legs: 2, for: 'w4571', ...pair } as WorkItem['pair'], ...extra });
  putRequests(store, [
    { id: 'w4571', by: LOTH, status: 'blocked' },
    run('w4595', {}),
    run('w4801', { legsSaid: true }),
    run('w4802', { crossOs: 'Burst codegen' }),
    run('w4803', { timed: true }),
    run('w4804', { steam: 'a Steam lobby' }),
    run('w4805', { split: 'a Mac may host leg 1' }),
    run('w4806', {}, { brief: `${W4595_BRIEF}\nRun it on lab.pair-m5-beast.json.` }),
    run('w4807', {}, { brief: `${W4595_BRIEF}\nThe client runs through pair_relay.py.` }),
    run('w4808', { started: { at: T0, legs: [{ session: 's1', sandbox: 'pc/alpha' }, { session: 's2', sandbox: 'beast/slot1' }] } }),
    run('w4809', {}, { status: 'active' }),
  ]);
  assert.deepEqual(o.cutDefaultPairs(), ['w4595']);
  const w = store.work.get('w4595')!;
  assert.equal(w.pair!.legs, 1);
  assert.equal(w.status, 'queued', 'still Queued, now for one computer');
  assert.equal(w.constraints, 'a pair run of 1 leg, on any computers, any OS (a Mac only as the host, leg 1)');
  assert.match(w.log.join('\n'), /cut to one leg \(w4618\): it was a pair run of 2 legs, on any computers, any OS \(a Mac only as the host, leg 1\), and it names no reason to need computers at once/);
  assert.match(w.brief, /FF Factory cut this to one leg \(w4618\)/);
  for (const id of ['w4801', 'w4802', 'w4803', 'w4804', 'w4805', 'w4806', 'w4807', 'w4808', 'w4809']) {
    assert.equal(store.work.get(id)!.pair!.legs, 2, `${id} keeps its two legs`);
  }
  // Once: the next pass finds nothing to cut, and the log has one line.
  assert.deepEqual(o.cutDefaultPairs(), []);
  assert.equal(w.log.filter((l) => /cut to one leg \(w4618\)/.test(l)).length, 1);
  // The blocker watch runs it on each pass.
  putRequests(store, [run('w4810', {})]);
  const did = await new BlockerWatch({ store, orchestrators: o }).tick();
  assert.equal(did.get('w4810'), 'cut to one leg: a pair run with no reason to need computers at once (w4618)');
  assert.equal(store.work.get('w4810')!.pair!.legs, 1);
});

test('w3720: w3705 as it happened: a determinism pair run whose notes quote another computer\'s timed run starts with its host on a computer that takes no timed runs; decide_work timed marks a request outright', async (t) => {
  const env = await twoComputers(t);
  const { store, dispatcher, call } = env;
  store.putMachine({ ...store.machines.get('pc')!, noTimedRuns: 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"' });
  const notes = [
    { at: '2026-11-08T20:03:00.000Z', by: 'orchestrator', text: "Orchestrator, for the dispatcher: this pair run doesn't need exclusive use of a machine; it's a determinism check, not a timing run. But its client leg is on LothLaptop, whose bench lock is held by w3639's vSync timed run (tr_dadec6ac06, started about 19:50 UTC, about 106 min). The client launch waits out that lock with --bench-wait (up to 30 min), then fails. Don't break the timed run." },
    { at: '2026-11-08T20:30:00.000Z', by: 'orchestrator', text: 'w3705 is a determinism pair, not a timing run. It needs no bench lock and isn\'t timed work. m5 also has room (2/3 in use) and may be the host as a Mac; m5 refuses only timing runs.' },
  ];
  putRequests(store, [
    { id: 'w2', by: BEN, status: 'queued', queuedFor: { at: T0 }, title: 'Pair run for w3511: MP Sprawl determinism pair on PR #3451 (w3511)', pair: { legs: 2, for: 'w3511' }, notes },
    { id: 'w3', by: BEN, title: 'Benchmark-free playtest of the planner', brief: 'Play it and check the planner keeps its routes; a benchmark would be nice later.' },
  ]);
  assert.equal(needsTimed(store.work.get('w2')!), false, 'until w3720: timed on darwin');
  const ok = await call(dispatcher().info, 'start_agent', { work_id: 'w2', prompt: "Run the MP Sprawl determinism pair. LothLaptop's bench lock is held by a timed run.", title: 'w3705 pair', sandbox: 'pc/alpha', pair_sandboxes: ['beast/slot1'] });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /^Started w2's 2 legs together/);

  // decide_work timed false: a request whose words read as timed is not, and its log says so; true marks it back.
  assert.equal(needsTimed(store.work.get('w3')!), 'any');
  const no = await call(dispatcher().info, 'decide_work', { id: 'w3', action: 'block', blocker: { kind: 'request', ref: 'w2', what: 'the pair run first' }, note: 'a playtest: it times nothing', timed: false });
  assert.equal(no.isError, false, no.text);
  assert.match(no.text, /w3 is not timed work now \(w3720\)/);
  assert.equal(needsTimed(store.work.get('w3')!), false);
  assert.match(store.work.get('w3')!.log.join('\n'), /not timed work, said outright \(w3720; it read as timed\): a playtest: it times nothing/);
  await call(dispatcher().info, 'decide_work', { id: 'w3', action: 'block', blocker: { kind: 'request', ref: 'w2', what: 'the pair run first' }, note: 'it benchmarks the planner after all', timed: true });
  assert.equal(needsTimed(store.work.get('w3')!), 'any');
});

test('w1945: an older Queued pair run holds a computer’s last free sandbox from newer single work of no higher priority; urgent work goes first', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, dispatcher, call } = env;
  putRequests(store, [{ id: 'w2', by: BEN, status: 'queued', queuedFor: { at: T0 }, pair: { legs: 2 } }, { id: 'w3', by: BEN }]);
  const start = (extra: Record<string, unknown> = {}) => call(dispatcher().info, 'start_agent', { work_id: 'w3', prompt: 'Fix it', title: 'fix', sandbox: 'pc/alpha', ...extra });
  const held = await start();
  assert.equal(held.isError, true);
  assert.match(held.text, /pc's last free sandbox is held for w2 "Request w2" \(normal, Queued since 09:00 UTC\), a pair run of 2 legs, on any computers, any OS \(a Mac only as the host, leg 1\), which starts only when that many computers have room at once \(w1945\): it can start now, start its legs first\. Start w3 on another computer; work of higher priority than the pair/);
  assert.deepEqual(store.work.get('w3')!.sessionIds, []);
  // Urgent single work goes first; so does work on a computer the pair does not fit.
  store.work.get('w3')!.priority = 'urgent';
  assert.equal(agents.pairHoldProblem('pc', store.work.get('w3')), undefined);
  store.work.get('w3')!.priority = 'normal';
  store.putMachine({ ...store.machines.get('pc')!, platform: 'darwin' });
  assert.match(agents.pairHoldProblem('pc', store.work.get('w3')) ?? '', /held for w2/, 'w2282: a Mac may host this pair, so its last free sandbox is held for it');
  store.putMachine({ ...store.machines.get('pc')!, platform: 'win32' });
  store.work.get('w2')!.pair = { legs: 2, avoid: ['pc'] };
  assert.equal(agents.pairHoldProblem('pc', store.work.get('w3')), undefined, 'a computer the pair avoids holds nothing for it');
  store.work.get('w2')!.pair = { legs: 2 };
  // A person's "Start now" makes it urgent: it starts.
  store.work.get('w3')!.priority = 'urgent';
  const ok = await start();
  assert.equal(ok.isError, false, ok.text);
});

test('w1983: a worker its request was moved off has its work over, so the check-in it set before the move no longer pins its sandbox', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1789', title: 'Steam Input A/B' }]);
  const a = await startedFor(env, 'w1789');
  assert.equal(agents.workOver(a.info), undefined);
  // 03:49Z on 2026-10-24: stop_agent move_to took w1789 off 2e29f29e (lothdesktop/slot5) for LothLaptop; its 04:14 check-in held slot5.
  o.moveOff(store.work.get('w1789')!, a.id, 'moved: it moves to lothlaptop');
  assert.ok(store.work.get('w1789')!.movedOff?.[a.id]);
  assert.equal(agents.workOver(a.info), 'its request is with another worker now (w1789: moved off it, not placed yet)');
  const wake = { wakeAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  assert.equal(releaseWhy(wake, Date.now()), undefined, 'a near check-in alone keeps a sandbox');
  assert.match(releaseWhy(wake, Date.now(), agents.workOver(a.info)) ?? '', /is for work that is over: its request is with another worker now \(w1789: moved off it/);
  // Its next worker takes it: still over for a.
  const b = await startedFor(env, 'w1789');
  assert.equal(agents.workOver(a.info), `its request is with another worker now (w1789: ${b.id})`);
});

test('w1983: a worker whose request another of its workers runs in another sandbox waits (Agents.waitOn), so its idle sandbox goes to the queue', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, o } = env;
  putRequests(store, [{ id: 'w1853', title: 'Nightly regressions' }, { id: 'w2' }]);
  const a = await startedFor(env, 'w1853');
  const b = await startedFor(env, 'w2', { sandbox: 'beast/slot1' });
  // 03:58Z on 2026-10-24: w1853's timing A/B went to a worker on m3 (aa20f433); 33bc6316 sat idle in lothdesktop/slot3.
  // The stored sessions, which the checks read, with their status set: not left to when the fake agents' turns end.
  const sa = () => store.sessions.get(a.id)!;
  const sb = () => store.sessions.get(b.id)!;
  o.linkWorker('w1853', sb(), `sent to worker ${b.id}`);
  // A later link, by the clock: two in one millisecond tie on which is the latest worker (isWith).
  await new Promise((r) => setTimeout(r, 5));
  o.linkWorker('w1853', sa(), `sent to worker ${a.id}, already on it`);
  sa().status = 'idle';
  sb().status = 'idle';
  const fresh = () => ((agents as unknown as { waitLive?: unknown }).waitLive = undefined);
  fresh();
  assert.equal(agents.waitOn(sa()), undefined, 'nobody works on it elsewhere: its work is its own');
  sb().status = 'running';
  fresh();
  assert.equal(agents.waitOn(sa()), `it waits on w1853: its worker ${b.id} works on it in beast/slot1`);
});

test('w1983: message_agent never starts a request\'s new session in a sandbox that is not the old worker\'s any more', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', title: 'Fix the belt splitter' }, { id: 'w2', title: 'Rewrite the tutorial text' }, { id: 'w3', title: 'Another thing' }]);
  const old = await startedFor(env, 'w1');
  const send = () => call(dispatcher().info, 'message_agent', { session_id: old.id, text: 'Now do w2.', work_id: 'w2', title: 'Tutorial text', session: 'new', session_reason: 'unrelated' });
  // A worker that released its sandbox while it waited (w640) has none to start a session in.
  old.info.placeReleased = { at: '2026-10-24T04:00:00.000Z', sandbox: 'alpha', branch: 'w1-splitter', why: 'it waits on CI' };
  const released = await send();
  assert.equal(released.isError, true);
  assert.match(released.text, new RegExp(`pc/alpha is not ${old.id}'s any more \\(it released it at 04:00 UTC while it waited\\): a new session for w2 never goes beside other work\\. start_agent with work_id "w2" in a FREE sandbox on a computer with room \\(list_sandboxes\\), switched to its branch w1-splitter\\.`));
  assert.deepEqual(store.work.get('w2')!.sessionIds, []);
  delete old.info.placeReleased;
  // 04:15Z on 2026-10-24: w1440 sent to its stopped worker 9c38a500 started feed4032 in beast/slot1, beside c7bfc9f0 (w1829).
  const other = await startedFor(env, 'w3');
  old.info.status = 'stopped';
  const beside = await send();
  assert.equal(beside.isError, true);
  assert.match(beside.text, new RegExp(`pc/alpha is not ${old.id}'s any more \\(agent ${other.id} is there\\)`));
  assert.deepEqual(store.work.get('w2')!.sessionIds, []);
});

test('w1983: a pair hold is bounded: work pinned to that computer goes, and the hold lapses PAIR_HOLD_MS after its room began while the pair still cannot start', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, o } = env;
  // Only pc has room: the pair is a computer short (lothlaptop/slot1 on 2026-10-24, held for w1970 and then w1981 for an hour).
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w2', by: BEN, status: 'queued', queuedFor: { at: T0 }, pair: { legs: 2 } }, { id: 'w3', by: BEN }]);
  const w3 = store.work.get('w3')!;
  assert.match(agents.pairHoldProblem('pc', w3) ?? '', /^pc's last free sandbox is held for w2 .*\(w1945\): .*; the hold lapses at \d\d:\d\d UTC \(w1983\)\. Start w3 on another computer/);
  // Work whose needs name pc alone (lothsahn's "Move one timed run to LothLaptop", w1789) is not sent elsewhere.
  w3.queuedFor = { at: T0, needs: ['PC'] };
  assert.equal(agents.pairHoldProblem('pc', w3), undefined);
  w3.queuedFor = { at: T0, needs: ['pc', 'beast'] };
  assert.ok(agents.pairHoldProblem('pc', w3), 'work that may also go elsewhere is still held off');
  delete w3.queuedFor;
  // PAIR_HOLD_MS after pc's room began, with the pair still short: the hold lapses and single work takes the sandbox.
  const later = Date.now() + PAIR_HOLD_MS + 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(later);
  assert.equal(agents.pairHoldProblem('pc', w3), undefined);
  // A pair that can start now is held for whatever the time: start its legs first.
  agentsRoom(agents, ['pc', 'beast']);
  assert.match(agents.pairHoldProblem('pc', w3) ?? '', /it can start now, start its legs first/);
});

test('w3530: a Queued pair run gets its legs while single work arrives as sandboxes free: one pair holds, its hold outlasts the gap to the next free computer, and a pair that can start takes what it needs', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, o, dispatcher, call } = env;
  const third = await startTestMachine(env.machines, { id: 'm5', sandboxes: ['slot2'] });
  env.closers.push(() => third.stop());
  store.putMachine({ ...store.machines.get('m5')!, platform: 'win32' });
  // 2026-11-08: about ten pairs Queued (w3347 17 h, w3392 13 h), single work Queued behind them, sandboxes freeing one at a time.
  putRequests(store, [
    { id: 'w2', by: BEN, status: 'queued', queuedFor: { at: T0 }, pair: { legs: 2, avoid: ['beast'] } },
    { id: 'w5', by: BEN, status: 'queued', queuedFor: { at: '2026-09-28T09:30:00.000Z' }, pair: { legs: 2 } },
    { id: 'w3', by: BEN, status: 'queued', queuedFor: { at: '2026-09-28T10:00:00.000Z' } },
    { id: 'w4', by: BEN, status: 'queued', queuedFor: { at: '2026-09-28T10:00:00.000Z' } },
  ]);
  const w = (id: string) => store.work.get(id)!;
  const clock = (ms: number) => ((o as unknown as { now: () => Date }).now = () => new Date(ms));
  const t0 = Date.now();
  clock(t0);
  // pc frees first: held for w2, the oldest pair, whatever single work comes for it.
  agentsRoom(agents, ['pc']);
  assert.match(agents.pairHoldProblem('pc', w('w3')) ?? '', /^pc's last free sandbox is held for w2 .*the hold lapses at/);
  const single = await call(dispatcher().info, 'start_agent', { work_id: 'w3', prompt: 'Fix it', title: 'fix', sandbox: 'pc/alpha' });
  assert.equal(single.isError, true, single.text);
  assert.deepEqual(w('w3').sessionIds, []);
  // 30 min later the next computer has not freed yet: the hold stands (before w3530 it lapsed at 20 min, and single work took pc).
  clock(t0 + 30 * 60_000);
  assert.match(agents.pairHoldProblem('pc', w('w3')) ?? '', /held for w2/);
  // m5 frees: w2 (which avoids beast) can start on pc and m5, so both are its, and w4 is held off m5 too.
  agentsRoom(agents, ['pc', 'm5']);
  assert.match(agents.pairHoldProblem('m5', w('w4')) ?? '', /^m5's last free sandbox is held for w2 .*it can start now, start its legs first/);
  // A younger pair is no way round it: w5's legs are refused on w2's computers.
  const younger = await call(dispatcher().info, 'start_agent', { work_id: 'w5', prompt: 'Run the pair.', title: 'pair', sandbox: 'pc/alpha', pair_sandboxes: ['m5/slot2'] });
  assert.equal(younger.isError, true, younger.text);
  assert.match(younger.text, /leg 1 \(the host\) on pc\/alpha: pc's last free sandbox is held for w2 .*Nothing was started\./);
  assert.deepEqual(w('w5').sessionIds, []);
  const ok = await call(dispatcher().info, 'start_agent', { work_id: 'w2', prompt: 'Run the pair.', title: 'pair', sandbox: 'pc/alpha', pair_sandboxes: ['m5/slot2'] });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(w('w2').sessionIds.length, 2);

  // One pair never holds room another could complete with: w2 back in the queue, waiting on pc alone (beast it avoids),
  // and beast frees: w5 can start on pc and beast now, so it takes both, not w2's hold on pc.
  w('w2').status = 'queued';
  delete w('w2').pair!.started;
  clock(t0 + 40 * 60_000);
  agentsRoom(agents, ['pc', 'beast']);
  assert.match(agents.pairHoldProblem('pc', w('w3')) ?? '', /held for w5 .*it can start now/);
  assert.match(agents.pairHoldProblem('beast', w('w3')) ?? '', /held for w5 .*it can start now/);
  // Only one waiting pair holds: with room on pc alone, w2 holds it and w5 holds nothing anywhere.
  agentsRoom(agents, ['pc']);
  assert.equal(agents.pairPlan(agents.roomFacts()).size, 1);
  assert.equal(agents.pairPlan(agents.roomFacts()).get('pc')?.pair.id, 'w2');
  // Bounded: PAIR_HOLD_MS after pc's room began (or the pair was Queued, if later), single work takes it.
  clock(Date.now() + PAIR_HOLD_MS + 60_000);
  assert.equal(agents.pairHoldProblem('pc', w('w3')), undefined);
  // Urgent single work beats a normal pair at once (a person's "Start now").
  clock(t0);
  w('w3').priority = 'urgent';
  assert.equal(agents.pairHoldProblem('pc', w('w3')), undefined);
  w('w3').priority = 'normal';
  // A pair the computers that are up could never complete holds nothing (live, 2026-11-08 03:17-04:09Z: biscuit held for
  // w3347, whose only other computers were m3, offline, and lothlaptop, paused): with m5 offline w2 (which avoids beast) has
  // no second computer, so w5 waits holding pc instead; with m5 paused from its tray app, the same.
  const places = agents.places.bind(agents);
  agents.places = () => places().map((p) => (p.id === 'm5' ? { ...p, online: false } : p));
  assert.equal(agents.pairPlan(agents.roomFacts()).get('pc')?.pair.id, 'w5');
  assert.match(agents.pairHoldProblem('pc', w('w3')) ?? '', /held for w5 /);
  agents.places = places;
  assert.equal(agents.pairPlan(agents.roomFacts()).get('pc')?.pair.id, 'w2');
  const placement = agents.placement.bind(agents);
  agents.placement = (b?: boolean) => ({ ...placement(b), hold: { m5: 'paused from its tray app: paused by hand (w1532)' } });
  assert.equal(agents.pairPlan(agents.roomFacts()).get('pc')?.pair.id, 'w5');
  agents.placement = placement;
});

test('w3588: pairWants names each computer where one free sandbox starts a Queued pair run, for placeAgain to yield it to the pair', async (t) => {
  const env = await twoComputers(t);
  const { store, agents } = env;
  // 2026-11-08 05:34:53Z: w3562 (high) held biscuit for one leg; beast/slot1 freed for the other, and a check-in took it back.
  putRequests(store, [{ id: 'w2', by: BEN, status: 'queued', priority: 'high', queuedFor: { at: T0 }, pair: { legs: 2 } }]);
  const places = agents.places.bind(agents);
  // beast has room and holds the pair's first leg; pc is full: a sandbox freed on pc starts the pair.
  agents.places = () => places().map((p) => (p.id === 'pc' ? { ...p, freeSandboxes: 0, sandboxes: p.maxSandboxes } : p));
  assert.deepEqual(agents.pairWants(), [{ work: 'w2', priority: 'high', machines: ['pc'] }]);
  // A pair the computers that are up could never complete wants nothing (pairCanFinish, w3530).
  agents.places = () => places().map((p) => (p.id === 'pc' ? { ...p, freeSandboxes: 0, sandboxes: p.maxSandboxes, online: false } : p));
  assert.deepEqual(agents.pairWants(), []);
  // Started, or no pair Queued: nothing.
  agents.places = () => places().map((p) => (p.id === 'pc' ? { ...p, freeSandboxes: 0, sandboxes: p.maxSandboxes } : p));
  store.work.get('w2')!.status = 'active';
  assert.deepEqual(agents.pairWants(), []);
});

test('w1995: a small computer\'s last free sandbox is held for the timed work Queued for it: other work starts elsewhere, a pair leg only when no other computers hold the pair', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, o, dispatcher, call } = env;
  // pc stands for LothLaptop (1 agent slot), beast for BEAST.
  const places = agents.places.bind(agents);
  agents.places = () => places().map((p) => (p.id === 'pc' ? { ...p, maxAgents: 1 } : p));
  // 2026-10-24: w1985, w1440's timed leg, Queued for lothlaptop from 04:27Z; at 04:59Z w1981's pair leg 2 took lothlaptop/slot1.
  putRequests(store, [
    { id: 'w5', title: 'Timed leg for w1440: belt A/B', status: 'queued', queuedFor: { at: T0, needs: ['pc'] }, timedLeg: { for: 'w1440', forSession: 'abc', from: 'beast', small: ['pc'] } },
    { id: 'w3' },
    { id: 'w2', pair: { legs: 2 } },
  ]);
  const w3 = store.work.get('w3')!;
  const held = await call(dispatcher().info, 'start_agent', { work_id: 'w3', prompt: 'Fix it', title: 'fix', sandbox: 'pc/alpha' });
  assert.equal(held.isError, true);
  assert.match(held.text, /pc's last free sandbox is held for timed work: w5 "Timed leg for w1440: belt A\/B" \(the timed leg of w1440, normal, Queued since 09:00 UTC\) starts there first, as pc is a small computer \(1 agent slot\) ranked for timed and exclusive-lock work \(w1872, w1995\).*Start w5 there, and w3 on another computer with room \(beast\)/);
  assert.deepEqual(w3.sessionIds, []);
  // Timed work itself takes it; so does work that can run only there, or urgent work.
  assert.equal(agents.timedHoldProblem('pc', w3, true), undefined);
  w3.queuedFor = { at: T0, needs: ['pc'] };
  assert.equal(agents.timedHoldProblem('pc', w3, false), undefined);
  delete w3.queuedFor;
  w3.priority = 'urgent';
  assert.equal(agents.timedHoldProblem('pc', w3, false), undefined);
  w3.priority = 'normal';
  // A big computer is never held; nor a small one with two free sandboxes.
  assert.equal(agents.timedHoldProblem('beast', w3, false), undefined);
  // A pair run's leg: held off pc only while other computers hold all its legs.
  Object.assign(store.work.get('w2')!, { status: 'queued', queuedFor: { at: T0 } });
  assert.equal(agents.timedHoldProblem('pc', store.work.get('w2'), false), undefined, 'pc and beast are the only pair: the leg may go there');
  agentsRoom(agents, ['pc', 'beast', 'm3']);
  assert.match(agents.timedHoldProblem('pc', store.work.get('w2'), false) ?? '', /^pc's last free sandbox is held for timed work: w5/);
  // With no other computer with room, single work takes it.
  agentsRoom(agents, ['pc']);
  assert.equal(agents.timedHoldProblem('pc', w3, false), undefined);
  agentsRoom(agents, ['pc', 'beast']);
  assert.ok(agents.timedHoldProblem('pc', w3, false));
  // A timed request (not a leg) on its platform holds it too; on another platform it does not.
  store.work.get('w5')!.status = 'done';
  putRequests(store, [{ id: 'w6', title: 'Timed A/B of PR #2156 on macOS', status: 'queued', queuedFor: { at: T0 } }]);
  assert.equal(agents.timedHoldProblem('pc', w3, false), undefined, 'a Mac timed run does not fit pc (Windows)');
  store.work.get('w6')!.title = 'Timed A/B of PR #2156';
  assert.match(agents.timedHoldProblem('pc', w3, false) ?? '', /held for timed work: w6 .*\(timed work, normal/);
  // TIMED_HOLD_MS after pc's room began, nobody started it: the hold lapses.
  const later = Date.now() + TIMED_HOLD_MS + 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(later);
  assert.equal(agents.timedHoldProblem('pc', w3, false), undefined);
});

test('w1945: the WRONG flag and decide_work queue count a pair as room only with a computer per leg', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, o, dispatcher, call } = env;
  putRequests(store, [{ id: 'w2', by: BEN, status: 'new', pair: { legs: 2 } }]);
  const fit = { pc: { platform: 'win32' }, beast: { platform: 'win32' } };
  const one: RoomNow = { game: ['pc'], agent: ['pc'], held: [], fit };
  const both: RoomNow = { ...one, game: ['pc', 'beast'] };
  const facts = (r: RoomNow) => {
    agents.roomNow = () => r.game;
    agents.roomFacts = () => r;
  };
  facts(one);
  const q = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'one computer has room' });
  assert.equal(q.isError, false, q.text);
  assert.match(store.work.get('w2')!.log.join('\n'), /queued for capacity; a pair run of 2 legs needs 2 computers with room at once, at most one of them a Mac \(the host\), and only pc has room it fits/);
  store.work.get('w2')!.queuedFor = { at: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(o.flagQueuedWithRoom(one), [], 'one free computer is no room for two legs');
  assert.deepEqual(o.flagQueuedWithRoom(both), ['w2']);
  store.work.get('w2')!.status = 'new';
  facts(both);
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'two have room' });
  assert.match(refused.text, /start its 2 legs together \(start_agent with work_id "w2", sandbox for leg 1, the host, and pair_sandboxes for the others/);
});

test('w1945: a two-machine run filed by hand is marked a pair as the dispatcher queues it (decide_work pair_legs), so one free computer no longer flags it WRONG', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, o, dispatcher, call } = env;
  // w1936 as filed (2026-10-23, Ben): a two-machine sync run with no pair mark, flagged WRONG for one free computer five times.
  putRequests(store, [{ id: 'w3', by: BEN, status: 'new' }]);
  const fit = { pc: { platform: 'win32' }, beast: { platform: 'win32' } };
  const one: RoomNow = { game: ['pc'], agent: ['pc'], held: [], fit };
  const both: RoomNow = { ...one, game: ['pc', 'beast'] };
  const facts = (r: RoomNow) => {
    agents.roomNow = () => r.game;
    agents.roomFacts = () => r;
  };
  facts(both);
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w3', action: 'queue', note: 'two have room', pair_legs: 2 });
  assert.match(refused.text, /start its 2 legs together/);
  assert.equal(store.work.get('w3')!.pair, undefined, 'a refused queue marks nothing');
  facts(one);
  const q = await call(dispatcher().info, 'decide_work', { id: 'w3', action: 'queue', note: 'one computer has room', pair_legs: 2 });
  assert.equal(q.isError, false, q.text);
  assert.deepEqual(store.work.get('w3')!.pair, { legs: 2, legsSaid: true });
  assert.match(store.work.get('w3')!.log.join('\n'), /queued for capacity \(marked a pair run of 2 legs, on any computers, any OS \(a Mac only as the host, leg 1\)\); a pair run of 2 legs needs 2 computers with room at once, at most one of them a Mac \(the host\), and only pc has room it fits/);
  store.work.get('w3')!.queuedFor = { at: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(o.flagQueuedWithRoom(one), [], 'one free computer is no room for two legs');
  assert.deepEqual(o.flagQueuedWithRoom(both), ['w3']);
});

// ---------------------------------------------------------------- w2007: a coordinator's turn passed the per-turn budget

test("w2007: two budget hits of one orchestrator within 6 h file one request on FF Factory's repo for its person and push one notice; the second adds a log line; 6 h later it files again", async (t) => {
  const { o, store, sessions, chat, heard, dispatcher } = setup(t);
  const pushed: { session: string; users: string[]; what: string }[] = [];
  o.onTurnBudget = (s, users, what) => pushed.push({ session: s.id, users, what });
  const loth = chat(LOTH);
  const hit = { calls: 151, tokensRead: 3_400_000, cap: 'calls' as const, since: '2026-10-24T09:00:00.000Z', starter: { from: 'system' as const, text: '[timer t-1] close finished requests\nand unjam the rest' } };
  sessions.events.emit('turnBudget', loth, hit);
  const budget = () => [...store.work.values()].filter((w) => w.title.includes('per-turn budget'));
  assert.equal(budget().length, 1);
  const w = budget()[0];
  assert.equal(w.title, "Investigate: Lothsahn's orchestrator passed the per-turn budget (151 calls, 3.4M tokens)");
  assert.deepEqual([w.requestedBy.userId, w.repo, w.needs, w.humanAsked, w.status], ['lothsahn', 'Final-Factory/ff-factory', 'agent', false, 'new']);
  assert.match(w.brief, new RegExp(`session ${loth.info.id}: /#/session/${loth.info.id}\\) passed the per-turn budget of a coordinator, 150 calls / 25M tokens`));
  assert.match(w.brief, /made 151 model calls \(subagents' included\) and read 3,400,000 tokens .* over the calls cap\. The turn was open since 2026-10-24T09:00:00\.000Z/);
  assert.match(w.brief, /started by a harness message .*: "\[timer t-1\] close finished requests"\./);
  assert.match(w.brief, /Find out why \(a loop, polling, a retry\) from the transcript .* Say whether the cap should move/);
  assert.match(w.log.at(-1)!, /filed by FF Factory for Lothsahn \(w2007\).*counts against no limit/);
  assert.equal(pushed.length, 1);
  assert.deepEqual([pushed[0].session, pushed[0].users], [loth.info.id, ['lothsahn']]);
  assert.match(pushed[0].what, new RegExp(`^FF Factory stopped a turn of Lothsahn's orchestrator: it made 151 model calls and read 3\\.4M tokens, over the per-turn budget \\(150 calls / 25M tokens\\)\\. ${w.id} looks into why\\.$`));
  // The dispatcher hears of the request as of any; nothing is sent into the stopped orchestrator itself.
  await until('the dispatcher hears of the request', () => heard(dispatcher().info.id, '[work request]').some((e) => e.text.includes(`${w.id} `)));
  assert.equal(heard(loth.info.id, '[').length, 0);
  // Another hit of the same session within 6 h: a line on the open request, no second request, no second notice.
  sessions.events.emit('turnBudget', loth, { ...hit, calls: 160, tokensRead: 5_000_000 });
  assert.equal(budget().length, 1);
  assert.equal(pushed.length, 1);
  assert.match(w.log.at(-1)!, /another turn of the same session passed the budget \(w2007\): 160 calls, 5\.0M tokens, over the calls cap/);
  // Another orchestrator is its own session.
  sessions.events.emit('turnBudget', chat(BEN), { ...hit, cap: 'tokens' as const });
  assert.equal(budget().length, 2);
  assert.deepEqual(pushed.at(-1)!.users, ['ben']);
  // 6 h later the same session files again.
  (o as unknown as { now: () => Date }).now = () => new Date(Date.now() + 6 * 3_600_000 + 60_000);
  sessions.events.emit('turnBudget', loth, hit);
  assert.equal(budget().length, 3);
  assert.equal(pushed.length, 3);
});

test('w2007: the dispatcher passing the budget files its request for the system payer and the notice goes to the owners', async (t) => {
  const { o, store, sessions, dispatcher } = setup(t);
  const pushed: { users: string[]; what: string }[] = [];
  o.onTurnBudget = (_s, users, what) => pushed.push({ users, what });
  const d = dispatcher();
  sessions.events.emit('turnBudget', d, { calls: 12, tokensRead: 26_000_000, cap: 'tokens' as const });
  const [w] = [...store.work.values()].filter((x) => x.title.includes('per-turn budget'));
  assert.equal(w.title, 'Investigate: the dispatcher passed the per-turn budget (12 calls, 26.0M tokens)');
  assert.equal(w.requestedBy.userId, 'ben', 'the system payer: the owner here');
  assert.match(w.brief, /started by a message that is not known any more\./);
  assert.match(w.brief, /over the tokens cap/);
  assert.deepEqual(pushed.map((p) => p.users), [['ben']]);
});

test('w2049: a free slot with a normal and a low request queued takes the normal one', async (t) => {
  const { store, agents, o, dispatcher, heard } = setup(t);
  const q = (at: string) => ({ at });
  // The low one is older: priority still comes first.
  putRequests(store, [
    { id: 'w1', status: 'queued', priority: 'low', createdAt: '2026-10-24T01:00:00.000Z', queuedFor: q('2026-10-24T01:00:00.000Z') },
    { id: 'w2', status: 'queued', priority: 'normal', createdAt: '2026-10-24T02:00:00.000Z', queuedFor: q('2026-10-24T02:00:00.000Z') },
  ]);
  agentsRoom(agents, ['lothdesktop']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  o.capacityMayHaveFreed('worker x stopped');
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  const ping = heard(dispatcher().info.id, '[ledger] Capacity may have freed').at(-1)!.text;
  assert.deepEqual(pingOrder(ping), ['w2', 'w1'], ping);
  assert.match(ping, /w1 "Request w1" \(Lothsahn, low\)/);
});

test('w2049: low alone with a free slot is room for it: the ping names it (low never leaves a slot idle)', async (t) => {
  const { store, agents, o, dispatcher, heard } = setup(t);
  putRequests(store, [{ id: 'w1', status: 'queued', priority: 'low', queuedFor: { at: T0 } }]);
  agentsRoom(agents, ['lothdesktop']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  o.capacityMayHaveFreed('worker y stopped');
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  const ping = heard(dispatcher().info.id, '[ledger] Capacity may have freed').at(-1)!.text;
  assert.deepEqual(pingOrder(ping), ['w1'], ping);
});

test('w2049: within one priority, started work that runs only on the computers it names goes before general work; never ahead of a higher priority', async (t) => {
  const { store, agents, o, dispatcher, heard } = setup(t);
  const at = (h: number) => `2026-10-24T0${h}:00:00.000Z`;
  putRequests(store, [
    // General normal work, the oldest.
    { id: 'w1', status: 'queued', createdAt: at(1), queuedFor: { at: at(1) } },
    // Normal, newer, already had a worker, and waits for lothdesktop alone (a requeued request pinned there).
    { id: 'w2', status: 'queued', createdAt: at(2), queuedFor: { at: at(2), needs: ['lothdesktop'] }, sessionIds: ['s2'] },
    // Normal, newest: a leg held for lothdesktop while its own worker carries on elsewhere (w1863).
    { id: 'w3', status: 'active', createdAt: at(3), legs: [{ at: at(3), needs: ['lothdesktop'], what: 'timing on lothdesktop' }], sessionIds: ['s3'] },
    // High general work: still first.
    { id: 'w4', status: 'queued', priority: 'high', createdAt: at(4), queuedFor: { at: at(4) } },
    // Low pinned work: after every normal one.
    { id: 'w5', status: 'queued', priority: 'low', createdAt: at(0), queuedFor: { at: at(0), needs: ['lothdesktop'] }, sessionIds: ['s5'] },
    // Pinned but never started (no worker yet): general, by age.
    { id: 'w6', status: 'queued', createdAt: at(5), queuedFor: { at: at(5), needs: ['lothdesktop'] } },
  ]);
  agentsRoom(agents, ['lothdesktop']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  o.capacityMayHaveFreed('sandbox lothdesktop/slot2 released');
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  const ping = heard(dispatcher().info.id, '[ledger] Capacity may have freed').at(-1)!.text;
  assert.deepEqual(pingOrder(ping), ['w4', 'w2', 'w3', 'w1', 'w6', 'w5'], ping);
  assert.match(ping, /by priority, then started work that runs only on the computers it names, then oldest/);
  assert.match(ping, /w2 "Request w2" \([^)]*started, runs only there/);
  assert.doesNotMatch(ping, /w6 "Request w6" \([^)]*started/);
  assert.match(ping, /higher work that fits another computer with room starts there/);
});

test('w2049: the dashboard sets a request\'s priority: its people, a reviewer or an owner; open requests only; a queued one wakes the capacity ping', (t) => {
  const { store, o } = setup(t);
  putRequests(store, [{ id: 'w1', status: 'queued', queuedFor: { at: T0 } }, { id: 'w2', status: 'done', by: BEN }, { id: 'w3', by: BEN }]);
  let woke = '';
  (o as unknown as { capacityMayHaveFreed: (what: string) => void }).capacityMayHaveFreed = (what) => (woke = what);
  assert.equal(o.setPriority('w1', LOTH, 'low').priority, 'low');
  assert.equal(woke, "w1's priority changed to low");
  assert.match(store.work.get('w1')!.log.at(-1)!, /priority normal → low, by Lothsahn on the dashboard/);
  assert.throws(() => o.setPriority('w2', BEN, 'low'), /w2 is done/);
  assert.equal(o.setPriority('w3', LOTH, 'high', true).priority, 'high', 'an owner sets anyone\'s');
  assert.throws(() => o.setPriority('w1', { userId: 'someone', displayName: 'Someone' }, 'urgent'), /not Someone's request/);
  assert.throws(() => o.setPriority('w1', LOTH, 'medium' as never), /priority is one of/);
});

test('w2046: a released worker whose resume waits for room on its full computer moves to a computer with room: a fresh session there on its branch, with the hand-off and the waiting message; its old slot is released', async (t) => {
  const env = await setupOnMachine(t);
  const { store, machines, sessions } = env;
  const beast = await startTestMachine(machines, { id: 'beast', sandboxes: ['slot1'] });
  env.closers.push(() => beast.stop());
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w1');
  // Its branch is pushed (each test machine has an origin of its own: put it in beast's).
  beast.repos.git(beast.repos.main, 'push', '-q', 'origin', 'master:refs/heads/w1-move');
  // w1891 at 14:05Z on 2026-10-24: its worker released its sandbox while it waited, and its computer is full now.
  sessions.sessions.get(a.id)!.stop(true);
  await until('its process stopped', () => !sessions.sessions.get(a.id)?.live);
  a.info.placeReleased = { at: new Date().toISOString(), sandbox: 'alpha', branch: 'w1-move', why: 'it waits on w2006 reporting' };
  store.putSession(a.info);
  const full = sessions as unknown as { placeFull?: (s: { info: SessionInfo }) => string | undefined };
  const placeFull = full.placeFull!.bind(sessions);
  const hold = 'no sandbox on pc is free (its own, alpha, took other work after it was released: it waits on w2006 reporting); the next one to free there is its, ahead of new work';
  full.placeFull = (s) => (s.info.machineId === 'pc' ? hold : placeFull(s));
  sessions.send(a.id, 'w2006 reported: carry on and merge PR #2347.');
  sessions.drain();
  assert.ok(sessions.queued().some((q) => q.id === a.id), 'it waits a moment first: a turn ending there now frees it');
  sessions.drain(Date.now() + MOVE_AFTER_MS + 1000);
  assert.ok(!sessions.queued().some((q) => q.id === a.id), 'the message went with its work');
  await until('its fresh session on beast', () => store.work.get('w1')!.sessionIds.some((id) => store.sessions.get(id)?.machineId === 'beast'));
  const w = store.work.get('w1')!;
  const b = store.sessions.get(w.sessionIds.find((id) => store.sessions.get(id)?.machineId === 'beast')!)!;
  assert.equal(b.machineSandbox, 'slot1');
  assert.ok(!w.sessionIds.includes(a.id), 'taken off the old worker');
  assert.equal(w.status, 'active', 'not Queued: FF Factory started it itself');
  assert.equal(beast.repos.git(beast.path('slot1'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'w1-move', 'its sandbox there is on its branch');
  await until('its brief', () => store.readTranscript(b.id).some((e) => e.kind === 'user'));
  const first = store.readTranscript(b.id).find((e) => e.kind === 'user');
  const text = first && 'text' in first ? first.text : '';
  assert.match(text, /^\[moved, w2046\] FF Factory moved w1 to this computer: its worker \w+ on pc\/alpha was about to resume, but no sandbox on pc is free/);
  assert.match(text, /The brief its worker started from[^]*Fix it/);
  assert.match(text, /Moved \(w2046\): w1 was taken off worker \w+ on pc\/alpha/);
  assert.match(text, /The message that was waiting for it when it was handed back, now yours:\n~~~text\nw2006 reported: carry on and merge PR #2347\./);
  // Its old slot is released at once, and it is marked moved away.
  assert.equal(a.info.movedAway?.to, 'beast');
  assert.ok(a.info.placeReleased);
  assert.match(w.log.join('\n'), /moved from pc\/alpha to beast \(w2046\), from branch w1-move/);
  full.placeFull = placeFull;
});

test('w2043: a pilot worker whose PR merged goes on in a fresh session at its next message; its check-in moves there, the old session ends', async (t) => {
  const { store, sessions, agents, cfg, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  cfg.worker = { ...cfg.worker, freshAfterMergePilotPercent: 100 } as typeof cfg.worker;
  await call(ben, 'request_work', { title: 'Fix the belt splitter', brief: 'Splitters drop items.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix the splitter', title: 'Splitter fix', work_id: 'w1' });
  const old = /Started agent (\w+)/.exec(started.text)![1];
  await until('the first worker idle', () => sessions.get(old).info.status === 'idle');
  // Before its PR merges, a message resumes it as always.
  sessions.send(old, 'CI on PR #12 finished: green.', 'system');
  await until('it took the message', () => store.readTranscript(old).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('CI on PR #12')));
  await until('idle again', () => sessions.get(old).info.status === 'idle');
  const w1 = store.work.get('w1')!;
  w1.prs = [{ repo: 'Final-Factory/FinalFactory', number: 12, title: 'w1: splitter', state: 'merged', at: new Date().toISOString(), sha: '0123456789abcdef', via: 'line' }];
  store.putWork(w1);
  (agents as unknown as { waker: { schedule(id: string, m: number, n: string): string } }).waker.schedule(old, 90, 'check the deploy');

  assert.equal(sessions.send(old, 'Deploy check: the portal runs the merge.', 'system'), '', 'taken for a fresh session');
  await until('a fresh session on w1', () => store.work.get('w1')!.sessionIds.length === 1 && store.work.get('w1')!.sessionIds[0] !== old);
  const fresh = store.work.get('w1')!.sessionIds[0];
  await until('its first message', () => !!firstSaid(store, fresh));
  const first = firstSaid(store, fresh);
  assert.match(first, /^\[FF Factory\] Fresh session after a merge \(pilot w2043\): w1 /);
  assert.match(first, /Merged: Final-Factory\/FinalFactory#12 "w1: splitter"/);
  assert.match(first, /~~~text\nDeploy check: the portal runs the merge\.\n~~~/);
  assert.match(first, /The request as filed \(w1/);
  assert.equal(sessions.get(fresh).info.machineSandbox, 'alpha', 'the same sandbox');
  assert.ok(!store.readTranscript(old).some((e) => e.kind === 'user' && (e as { text: string }).text.includes('Deploy check')), 'nothing went into the old conversation');
  assert.equal(wakeOf(agents, old), undefined, 'the old check-in is gone');
  assert.equal(wakeOf(agents, fresh)?.note, 'check the deploy', 'and moved to the fresh session');
  await until('the old session ends', () => sessions.get(old).info.status === 'stopped');
  // The fresh session's own next message is not turned again: nothing merged during it.
  await until('fresh idle', () => sessions.get(fresh).info.status === 'idle');
  sessions.send(fresh, 'Go on.', 'system');
  await until('it took it', () => store.readTranscript(fresh).some((e) => e.kind === 'user' && (e as { text: string }).text === 'Go on.'));
  assert.deepEqual(store.work.get('w1')!.sessionIds, [fresh]);
});

test('w2043: with the pilot off (or the request in the control arm) a worker whose PR merged is resumed in its own session', async (t) => {
  const { store, sessions, cfg, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  cfg.worker = { ...cfg.worker, freshAfterMergePilotPercent: 0 } as typeof cfg.worker;
  await call(ben, 'request_work', { title: 'Fix the belt splitter', brief: 'Splitters drop items.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix the splitter', title: 'Splitter fix', work_id: 'w1' });
  const old = /Started agent (\w+)/.exec(started.text)![1];
  await until('the first worker idle', () => sessions.get(old).info.status === 'idle');
  const w1 = store.work.get('w1')!;
  w1.prs = [{ repo: 'Final-Factory/FinalFactory', number: 12, state: 'merged', at: new Date().toISOString(), via: 'line' }];
  store.putWork(w1);
  sessions.send(old, 'Deploy check.', 'system');
  await until('it took the message', () => store.readTranscript(old).some((e) => e.kind === 'user' && (e as { text: string }).text === 'Deploy check.'));
  assert.deepEqual(store.work.get('w1')!.sessionIds, [old]);
});

// w2055: a Queued timed leg pre-empts a small computer whose worker can move, and waits when it cannot. lothsahn, 2026-10-24:
// "If timing runs arrive and small machines (single slot) are working on non timing work, the dispatcher should pre-empt
// their existing work and move it to make space for the timing work if it's possible for the existing worker to push their
// work and swap to a new machine"; "This is much better than just adding the work to an open slot on a busy large machine".
test('w2055: a timed leg pre-empts a small computer whose worker is between turns with everything pushed, not a busy big one with a free slot; dirty work, a build in flight, mid-turn or no room elsewhere keeps it waiting', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  fixTimedFacts(o);
  agentsRoomFacts(agents, { game: ['pc'] });
  putRequests(store, [{ id: 'w1', title: 'Belt tooltip', brief: 'Fix it.' }]);
  const { id, info } = await startedFor(env, 'w1');
  const fleet = (o2: { big?: Partial<Computer> } = {}): Computer[] => {
    const box = (bid: string, maxAgents: number, x: Partial<Computer> = {}): Computer => ({ id: bid, online: true, live: 0, midTurn: 0, maxAgents, sandboxes: 1, maxSandboxes: 3, freeSandboxes: 1, memUsedBytes: 16 * 1024 ** 3, memTotalBytes: 64 * 1024 ** 3, editors: 0, maxEditors: 2, platform: 'win32', ...x });
    // pc: a small computer (1 agent slot) running w1's worker; big: xlarge, an empty slot but three agents at work.
    return [box('pc', 1, { live: 1, freeSandboxes: 0, sandboxes: 1, maxSandboxes: 1 }), box('big', 10, { live: 3, editors: 2, maxEditors: 4, ...o2.big })];
  };
  agents.places = () => fleet();
  const sb = store.machines.get('pc')!.sandboxes!.find((x) => x.id === info.machineSandbox)!;
  const clean = { branch: 'w1-belt', upstream: 'origin/w1-belt', ahead: 0, behind: 0, dirty: 0, untracked: 0 };
  sb.git = { ...clean } as typeof sb.git;
  putRequests(store, [{ id: 'w2', title: 'Timed leg for w9: belt A/B', status: 'queued', needs: 'game', queuedFor: { at: new Date().toISOString(), needs: ['pc'] }, timedLeg: { for: 'w9', forSession: 'nobody', from: 'beast', small: ['pc'] } }]);
  const starts: { w: string; m: string; moves: readonly Occupant[] }[] = [];
  agents.startTimedLeg = (w, m, _why, moves = []) => (starts.push({ w: w.id, m, moves }), true);

  // Movable: between turns, clean, pushed, w1 has room on big. Pre-empt pc, never the free slot on big.
  const s1 = agents.timedLegStepFor(store.work.get('w2')!)!;
  assert.ok('preempt' in s1.step, JSON.stringify(s1.step));
  assert.deepEqual(o.timedLegBound(), ['w2']);
  assert.deepEqual(starts.map((x) => [x.w, x.m, x.moves.map((m) => [m.session, m.move])]), [['w2', 'pc', [[id, 'big']]]]);
  assert.match(store.work.get('w2')!.log.join('\n'), /ledger: PRE-EMPTED on pc by FF Factory \(w2055\): no computer on Windows that takes timed runs is idle; pc \(small, 1 agent slot\) is the first small one whose work can move: worker \w{8} \(w1\) moves to big/);
  starts.length = 0;

  const stays = () => {
    const r = agents.timedLegStepFor(store.work.get('w2')!)!.step;
    assert.ok('wait' in r, JSON.stringify(r));
    assert.deepEqual(r.wait, ['pc'], 'a normal leg waits on the small computer, not on big');
    return r.why;
  };
  // Not movable: uncommitted work.
  sb.git = { ...clean, dirty: 2 } as typeof sb.git;
  assert.match(stays(), /worker \w{8} on pc \(w1\) stays: its sandbox has uncommitted work \(2 file\(s\)\)/);
  // Not movable: commits not pushed.
  sb.git = { ...clean, ahead: 1 } as typeof sb.git;
  assert.match(stays(), /stays: 1 commit\(s\) on w1-belt are not pushed/);
  sb.git = { ...clean } as typeof sb.git;
  // Not movable: a check-in set with its editor up (a build, an import or a test run in flight).
  info.wakeAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const was = sb.unity.state;
  sb.unity.state = 'running';
  assert.match(stays(), /stays: its check-in is set and its editor runs: a build, import or test run may be in flight/);
  sb.unity.state = was;
  delete info.wakeAt;
  // Not movable: mid-turn (never interrupted).
  const st = info.status;
  info.status = 'running';
  assert.match(stays(), /stays: it is mid-turn/);
  info.status = st;
  // No room: big has no free sandbox, so w1 has nowhere to go.
  agents.places = () => fleet({ big: { freeSandboxes: 0, sandboxes: 3 } });
  assert.match(stays(), /stays: no other computer that could take it has room now/);
  assert.deepEqual(o.timedLegBound(), [], 'nothing started, its queue unchanged');
  assert.equal(starts.length, 0);
  // High priority with nothing freeable: the big computers' fallback at once.
  agents.places = () => fleet({ big: { freeSandboxes: 0, sandboxes: 3 } });
  store.work.get('w2')!.priority = 'high';
  const hi = agents.timedLegStepFor(store.work.get('w2')!)!;
  assert.ok('widen' in hi.step && hi.big, JSON.stringify(hi.step));
  assert.deepEqual(hi.step.widen, ['pc', 'big']);
});

test('w2057: request_pair records the pull request and commit; for a pull request whose pair run is open (one filed by hand included) it joins that run and files nothing', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w665', by: BEN, prs: [PR2340] }, { id: 'w700', by: BEN }, { ...W1936, status: 'queued', pair: { legs: 2 } }]);
  const a = await startedFor(env, 'w665');
  await assert.rejects(async () => a.h.request_pair!({ what: 'x', brief: 'y', commit: 'HEAD' }), /commit is the head commit the legs run/);
  // No PR in what or brief: w665's one open pull request is the one, and the open hand-filed w1936 of it is joined.
  const out = String(await a.h.request_pair!({ what: 'MP-lowore-pin-pair', brief: 'Run it on two non-Mac machines; pass: 0 diverged.', commit: '1a2b3c4d5e' }));
  assert.ok(out.startsWith('Final-Factory/FinalFactory#2340 already has an open pair run, w1936 (queued: '), out);
  assert.match(out, /filed by hand; you wait on it, and nothing new was filed \(w2057\)/);
  assert.deepEqual([...store.work.values()].filter((x) => x.pair).map((x) => x.id), ['w1936']);
  const w = store.work.get('w665')!;
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref, w.blocked?.on], ['blocked', 'request', 'w1936', 'report']);
  assert.match(store.work.get('w1936')!.log.join('\n'), /asked for a pair run of Final-Factory\/FinalFactory#2340 \(request_pair\) and waits on this one/);
  // Its own filing, for another pull request: recorded with it.
  const b = await startedFor(env, 'w700');
  const own = String(await b.h.request_pair!({ what: 'MP-W700-2p', brief: 'Run MP-W700-2p.', pr: '#2400', commit: 'ABC1234DEF', legs: 2 }));
  const id = /^Filed (w\d+)/.exec(own)?.[1];
  assert.ok(id, own);
  assert.deepEqual(store.work.get(id!)!.pair, { legs: 2, legsSaid: true, for: 'w700', forSession: b.id, pr: 'Final-Factory/FinalFactory#2400', commit: 'abc1234def' });
});

test('w2057: a filing for a pull request whose pair run already finished on that commit is answered with its result and files nothing; without a commit it asks for one; another commit files a fresh run', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  agentsRoom(agents, []);
  const passed = 'For w665: PASS: MP-lowore-pin-pair on 1a2b3c4d, 400 heartbeats compared, 0 diverged (lothdesktop host, beast client).';
  putRequests(store, [{ id: 'w665', by: BEN, prs: [PR2340] }, { ...W1936, status: 'done', pair: { legs: 2 }, outcome: passed }]);
  const a = await startedFor(env, 'w665');
  const ask = async (extra: Record<string, unknown>) => String(await a.h.request_pair!({ what: 'MP-lowore-pin-pair on PR #2340', brief: 'Run it; pass: 0 diverged.', ...extra }));
  const same = await ask({ commit: '1a2b3c4d9f' });
  assert.ok(same.startsWith('Nothing filed: w1936 "Sync run: MP-lowore-pin-pair for PR #2340'), same);
  assert.ok(same.includes(`Its result: "${passed}"`), same);
  assert.notEqual(store.work.get('w665')!.status, 'blocked', 'not blocked: nothing runs');
  assert.equal([...store.work.values()].filter((x) => x.pair).length, 1);
  await assert.rejects(async () => ask({}), /w1936 "Sync run.*already finished \(it ran 1a2b3c4d\): pass commit/);
  const fresh = await ask({ commit: 'f0e1d2c3b4' });
  const id = /^Filed (w\d+)/.exec(fresh)?.[1];
  assert.ok(id && id !== 'w1936', fresh);
  assert.equal(store.work.get(id!)!.pair!.commit, 'f0e1d2c3b4');
  assert.equal(store.work.get('w665')!.blocked?.ref, id);
});

test('w2057: w665 as it happened: a hand-filed pair run of its PR passes, and its waiting worker, which filed nothing, is resumed with the result, once', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w665', by: BEN, status: 'active', prs: [PR2340] }, { ...W1936, status: 'active', pair: { legs: 2 } }]);
  const a = await startedFor(env, 'w665');
  legsStarted(store, 'w1936', 'host1936', 'client1936');
  assert.equal(o.pairFiledFor('w665'), true, 'its PR has a pair run: the turn-end check does not nudge it');
  o.workerTurnEnded(store.sessions.get('client1936')!, 'Client leg joined and stayed in sync.\nDONE: w1936\nLearned: nothing new');
  o.workerTurnEnded(store.sessions.get('host1936')!, 'Ran MP-lowore-pin-pair.\n\nFor w665: PASS on 1a2b3c4d: 400 heartbeats compared, 0 diverged.\nDONE: w1936\nLearned: nothing new');
  assert.equal(store.work.get('w1936')!.status, 'done');
  const note = agents.waker.pending(a.id)?.note ?? '';
  assert.match(note, /^\[ledger\] Pair run w1936 "Sync run: MP-lowore-pin-pair for PR #2340 on two non-Mac machines" of Final-Factory\/FinalFactory#2340 has finished \(w2057; it checks its pull request Final-Factory\/FinalFactory#2340\)\. Its result: "For w665: PASS on 1a2b3c4d: 400 heartbeats compared, 0 diverged\./);
  assert.deepEqual(store.work.get('w1936')!.pair!.told, ['w665']);
  assert.match(store.work.get('w665')!.log.join('\n'), new RegExp(`pair run w1936 of Final-Factory/FinalFactory#2340 finished \\(it checks its pull request .*\\); its worker ${a.id} was resumed with the result`));
  // Told once: the second request_pair for the same commit is answered, nothing filed.
  agents.waker.cancel(a.id);
  const again = String(await a.h.request_pair!({ what: 'MP-lowore-pin-pair on PR #2340', brief: 'Run it.', commit: '1a2b3c4d' }));
  assert.ok(again.startsWith('Nothing filed: w1936'), again);
  assert.equal(agents.waker.pending(a.id), undefined);
});

test('w2057: a worker that filed its own pair run is resumed by its gate with the host leg’s result, and not told twice when the run closes', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w665', by: BEN }]);
  const a = await startedFor(env, 'w665');
  const filed = String(await a.h.request_pair!({ what: 'MP-lowore-pin-pair on PR #2340', brief: 'Run it.', commit: '1a2b3c4d' }));
  const id = /^Filed (w\d+)/.exec(filed)![1];
  legsStarted(store, id, 'h1', 'c1');
  o.workerTurnEnded(store.sessions.get('c1')!, `Client leg done.\nDONE: ${id}\nLearned: nothing new`);
  o.workerTurnEnded(store.sessions.get('h1')!, `For w665: PASS on 1a2b3c4d, 0 diverged.\nDONE: ${id}\nLearned: nothing new`);
  assert.equal(store.work.get(id)!.status, 'done');
  assert.doesNotMatch(agents.waker.pending(a.id)?.note ?? '', /\[ledger\] Pair run/, 'the close tells it nothing: its gate does');
  const watch = new BlockerWatch({ store, orchestrators: o });
  await watch.tick();
  assert.notEqual(store.work.get('w665')!.status, 'blocked');
  const note = agents.waker.pending(a.id)?.note ?? '';
  // The result is in the cleared reason already (a short one), so it is not appended again; a long one is (pairResult).
  assert.ok(note.includes('For w665: PASS on 1a2b3c4d, 0 diverged.'), note);
  assert.equal(note.match(/PASS on 1a2b3c4d/g)?.length, 1, note);
  assert.deepEqual(store.work.get(id)!.pair!.told, ['w665']);
  agents.waker.cancel(a.id);
});

test('w2057: the dispatcher cannot mark a repeat of a finished pair run, clears a mark with pair_legs 0, and closes a never-started repeat as done with the finished run’s result', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, []);
  putRequests(store, [
    { ...W1936, status: 'done', pair: { legs: 2 }, outcome: 'For w665: PASS on 1a2b3c4d, 0 diverged.' },
    { id: 'w2049', by: BEN, title: 'Sync run again: MP-lowore-pin-pair for PR #2340 at 1a2b3c4d' },
    { id: 'w2050', by: BEN, status: 'queued', title: 'Second sync run of PR #2340', pair: { legs: 2 } },
    { id: 'w2051', by: BEN, status: 'queued', title: 'Third sync run of PR #2340', pair: { legs: 2 } },
  ]);
  const mark = await call(dispatcher().info, 'decide_work', { id: 'w2049', action: 'queue', pair_legs: 2, note: 'needs two machines' });
  assert.equal(mark.isError, true, mark.text);
  assert.match(mark.text, /w2049 repeats pair run w1936 "Sync run: MP-lowore-pin-pair.*already finished on the same pull request and commit \(w2057\)\. Its result: "For w665: PASS on 1a2b3c4d/);
  assert.equal(store.work.get('w2049')!.pair, undefined, 'the mark is not set');
  const clear = await call(dispatcher().info, 'decide_work', { id: 'w2050', action: 'queue', pair_legs: 0, note: 'repeats w1936' });
  assert.equal(clear.isError, false, clear.text);
  assert.match(clear.text, /w2050 is no longer a pair run \(it was .*\) and stays Queued as single work/);
  assert.equal(store.work.get('w2050')!.pair, undefined);
  assert.equal(store.work.get('w2050')!.status, 'queued');
  const notPair = await call(dispatcher().info, 'decide_work', { id: 'w2050', action: 'queue', pair_legs: 0, note: 'again' });
  assert.match(notPair.text, /w2050 is not a pair run/);
  const done = await call(dispatcher().info, 'decide_work', { id: 'w2051', action: 'done', note: 'repeats w1936, which passed' });
  assert.equal(done.isError, false, done.text);
  const w = store.work.get('w2051')!;
  assert.equal(w.status, 'done');
  assert.match(w.outcome ?? '', /^repeats w1936, which passed \(a repeat of pair run w1936, which finished; its result: For w665: PASS on 1a2b3c4d, 0 diverged\.\)$/);
});

test('w2648: w2631 as it happened: the dispatcher re-marks a Queued pair run read from its words to 2 legs and menus none, and a placement fork is never asked', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, []);
  const read = { legs: 3, for: 'w2622', menus: 'read from its words: a menu, a lobby, a click; request_pair menus "none" says it clicks none' };
  putRequests(store, [
    { id: 'w2622', status: 'blocked' },
    { id: 'w2631', status: 'queued', title: 'Pair run for w2622: ship-dispatch-v2 3-peer determinism check', brief: 'Direct IP, no Steam, no menus.', pair: read, constraints: pairText(read) },
  ]);
  const marked = await call(dispatcher().info, 'decide_work', { id: 'w2631', action: 'queue', pair_legs: 2, pair_menus: 'none', note: "lothsahn's rule: run it on what is free" });
  assert.equal(marked.isError, false, marked.text);
  assert.match(marked.text, /^w2631 is now a pair run of 2 legs, .* \(it was a pair run of 3 legs, .*only on computers whose screen is unlocked.*\) and stays Queued\./);
  const w = store.work.get('w2631')!;
  assert.equal(w.status, 'queued');
  assert.equal(w.pair!.legs, 2);
  assert.equal(w.pair!.menus, undefined);
  assert.match(w.pair!.noMenus ?? '', /^none/);
  assert.equal(w.constraints, pairText(w.pair!), "request_pair's constraints follow the marks");
  assert.match(w.log.join('\n'), /dispatcher \(w2648\): now a pair run of 2 legs, .*: lothsahn's rule: run it on what is free \(it was a pair run of 3 legs/);
  // queue with pair_legs no longer reads "menus" back from its words.
  const again = await call(dispatcher().info, 'decide_work', { id: 'w2631', action: 'queue', pair_legs: 2, note: 'again' });
  assert.match(again.text, /^w2631 is already a pair run of 2 legs/);
  assert.equal(store.work.get('w2631')!.pair!.menus, undefined);
  // The card of 08:40 is refused, and names the answer that starts now; nothing reaches lothsahn.
  const ask = await call(dispatcher().info, 'decide_work', {
    id: 'w2631',
    action: 'ask',
    note: 'lothsahn: how should w2631 run?',
    questions: [
      {
        question: 'w2631 is queued: it needs 3 computers at once and only beast fits. How should it run?',
        options: [
          { label: 'Re-file 2 legs, starts now', description: 'm5 hosts and beast runs both clients.', recommended: true },
          { label: '3 legs, wait for pc', description: 'It starts when pc is free.' },
          { label: 'Leave queued', description: 'It waits for three free computers.' },
        ],
      },
    ],
  });
  assert.equal(ask.isError, true, ask.text);
  assert.match(ask.text, /w2648.*Take the one that starts on what is there now \("Re-file 2 legs, starts now"\)/);
  assert.equal(store.work.get('w2631')!.status, 'queued');
  assert.equal(store.work.get('w2631')!.asks, 0);
  // A run whose legs started keeps its marks.
  legsStarted(store, 'w2631', 'h2631', 'c2631');
  const late = await call(dispatcher().info, 'decide_work', { id: 'w2631', action: 'queue', pair_legs: 3, note: 'too late' });
  assert.match(late.text, /w2631's legs started together at .* its marks stay as they are/);
});

test('w2648: a worker\'s request_pair menus "none" is kept, and asked again with legs or menus it re-marks its run whose legs never started', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w2622', by: LOTH }]);
  const a = await startedFor(env, 'w2622');
  const brief = 'Built players, direct IP. Click Host in the title menu on the host.';
  const filed = String(await a.h.request_pair!({ what: '3-peer ship dispatch check', brief, legs: 3, menus: 'none', commit: 'aa5039cd82' }));
  const id = /^Filed (w\d+)/.exec(filed)![1];
  assert.equal(store.work.get(id)!.pair!.menus, undefined, 'its own menus field rules over its words');
  assert.match(store.work.get(id)!.pair!.noMenus ?? '', /^none/);
  // The dispatcher's queue does not read the brief's "title menu" back.
  await call(dispatcher().info, 'decide_work', { id, action: 'queue', pair_legs: 3, note: 'no room' });
  assert.equal(store.work.get(id)!.pair!.menus, undefined);
  const re = String(await a.h.request_pair!({ what: '3-peer ship dispatch check', brief, legs: 2, commit: 'aa5039cd82' }));
  assert.match(re, new RegExp(`^w2622 already has an open pair run, ${id}`));
  assert.equal(store.work.get(id)!.pair!.legs, 2);
  assert.match(store.work.get(id)!.log.join('\n'), /asked again \(w2648\): now a pair run of 2 legs, .*\(it was a pair run of 3 legs/);
});

test('w2057: a worker that ends its turn waiting on a pair run with none filed is told to file it with request_pair, once; one whose PR has a pair run is not', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, sessions } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w665', by: BEN, prs: [PR2340] }, { id: 'w700', by: BEN, prs: [{ ...PR2340, number: 2400 }] }]);
  const a = await startedFor(env, 'w665');
  const line = 'w665: still open: waiting on a Windows or Linux pair worker to run `MP-lowore-pin-pair` for PR #2340 (CI is green, the merge is held for that run)';
  const told = (sid: string) => store.readTranscript(sid).filter((e) => e.kind === 'user' && /No pair run is filed for w\d+/.test((e as { text: string }).text)).length;
  a.info.lastResult = line;
  sessions.events.emit('turnEnd', sessions.get(a.id), line);
  await until('the pair-wait notice reaches it', () => told(a.id) === 1);
  assert.match(store.work.get('w665')!.log.join('\n'), /ended its turn waiting on a pair run with none filed .*told to file it with request_pair \(w2057\)/);
  await until('that turn ends', () => a.info.status === 'idle');
  sessions.events.emit('turnEnd', sessions.get(a.id), line);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(told(a.id), 1, 'once per request');
  // w700's PR has a pair run open (filed by hand): no nudge.
  putRequests(store, [{ id: 'w1999', by: BEN, status: 'queued', title: 'Sync run of PR #2400', pair: { legs: 2 } }]);
  const b = await startedFor(env, 'w700');
  const waits = 'w700: still open: waiting on the pair run of PR #2400';
  b.info.lastResult = waits;
  sessions.events.emit('turnEnd', sessions.get(b.id), waits);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(told(b.id), 0);
});

test('w4225: w4207 as it happened: a worker that stops with "ready for the pair run" and "ready for stills, needs a non-pc computer" is told to file the pair run and its stills leg is Queued off pc, never Stalled; filed, it is Blocked on the run; told twice in vain, the dispatcher files it', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, sessions, dispatcher } = env;
  const other = await startTestMachine(env.machines, { id: 'lothdesktop', sandboxes: ['slot2'] });
  env.closers.push(() => other.stop());
  agentsRoom(agents, []);
  const PR3628 = { repo: 'Final-Factory/FinalFactory', number: 3628, state: 'open' as const };
  putRequests(store, [{ id: 'w4207', by: LOTH, title: 'Some filter options should not be mutually exclusive', prs: [PR3628] }]);
  const a = await startedFor(env, 'w4207');
  await until('the worker is idle', () => a.info.status === 'idle');
  // e14a483b's 22:03Z report on 2026-11-14, its status lines word for word (m3 is pc here).
  const report = [
    'Nothing changed for w4207: it still needs the pair run, stills from a computer other than the pc, and CI.',
    '',
    'w4207: still open: pair run, stills and CI on PR #3628 before the merge',
    'w4207: ready for stills, needs a non-pc computer',
    'w4207: ready for the pair run',
  ].join('\n');
  const told = () => store.readTranscript(a.id).filter((e) => e.kind === 'user' && /No pair run is filed for w4207/.test((e as { text: string }).text)).length;
  a.info.lastResult = report;
  sessions.events.emit('turnEnd', sessions.get(a.id), report);
  await until('the pair-run notice reaches it', () => told() === 1);
  const w = () => store.work.get('w4207')!;
  assert.match(w().log.join('\n'), /ended its turn waiting on a pair run with none filed \("w4207: still open: pair run, stills and CI/);
  assert.deepEqual(w().legs?.map((l) => l.needs), [['lothdesktop']], 'the stills leg is queued off pc');
  assert.match(w().log.join('\n'), /a leg queued for capacity on lothdesktop from worker \w+'s report "w4207: ready for stills, needs a non-pc computer" \(w4225/);
  await until('the nudged turn ends', () => a.info.status === 'idle');
  a.info.lastResult = report;
  const live = agents.workLive().get('w4207')!;
  assert.equal(live.state, 'queued', `${live.state}: ${live.why}`);
  assert.match(live.why, /its leg .* queued/);
  // The same report again, nothing filed: the dispatcher is told to file it, once; the worker is not told again.
  const dispatched = () => store.readTranscript(agents.dispatcherId!).filter((e) => e.kind === 'user' && /PAIR RUN NOT FILED \(w4225\): w4207/.test((e as { text: string }).text)).length;
  sessions.events.emit('turnEnd', sessions.get(a.id), report);
  await until('the dispatcher hears it', () => dispatched() === 1);
  sessions.events.emit('turnEnd', sessions.get(a.id), report);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(dispatched(), 1, 'once per request');
  assert.equal(told(), 1, 'the worker is told once');
  assert.equal(w().legs?.length, 1, 'one leg for the same computers');
  // The worker files it: Blocked on the pair run, not Stalled.
  await until('idle again', () => a.info.status === 'idle');
  await a.h.request_pair!({ what: 'MP-W4207-multi-category', brief: 'Run MP-W4207-multi-category on two computers; pass: 0 diverged.', commit: '1a2b3c4d5e' });
  const filed = agents.workLive().get('w4207')!;
  assert.equal(filed.state, 'blocked', `${filed.state}: ${filed.why}`);
});

test('w2085: the replay of w1958 at 16:32: a look OK for PR #2395 is refused with Ben\'s 04:59 note; past it, the card shows the note as possibly deciding', async (t) => {
  const env = await setupOnMachine(t);
  const { store, machines, dispatcher, chat, call, heard, agents, sessions } = env;
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Fix every clear bug in the Discord bug reports', brief: 'Sweep the new threads.' });
  // 04:59: Ben decides the low-ore alert's wording (thread 1251), the note as the ledger holds it.
  chat(BEN).lastFrom = 'human';
  await call(ben, 'update_work', { id: 'w1', note: W1958_0459 });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: bug sweep', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const w1 = store.work.get('w1')!;
  w1.prs = [{ repo: 'Final-Factory/FinalFactory', number: 2395, title: 'w1958: low-ore alert: right click dismisses it for ten minutes, Shift + right click silences it for good', state: 'open', via: 'line' }];
  store.putWork(w1);
  const read: string[] = [];
  agents.prDiff = async (ref) => {
    read.push(ref);
    return PR2395_DIFF;
  };
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  // 16:32: the fresh session's question, as d57b4ea5 raised it.
  const ask = { who: 'Ben', what: W1958_1632, about: 'The low-ore alert tooltip gets a line for Shift + right click', after: 'I merge #2395 on green', questions: [{ question: 'Can the low-ore alert tooltip merge as it looks?', options: [{ label: 'Yes, merge it as it looks', recommended: true }, { label: 'No, change the wording first' }] }] };
  await assert.rejects(h.waiting_on_person!(ask), (e: Error) => {
    assert.match(e.message, /^Not recorded: ben already decided what Final-Factory\/FinalFactory#2395 adds/i);
    assert.match(e.message, /Right-click dismisses for a while; shift\+right-click silences for good/);
    assert.match(e.message, /Low-ore right-click \(thread 1251\)/);
    return true;
  });
  assert.deepEqual(read, ['Final-Factory/FinalFactory#2395']);
  assert.equal(info.waitingOn, undefined, 'nothing recorded: the request does not show Waiting on input');

  // A question the note leaves open goes through with decided_override, logged; its card carries the note, flagged.
  await h.waiting_on_person!({ ...ask, decided_override: 'the note does not settle the hover arrow touching the tooltip' });
  assert.match(store.work.get('w1')!.log.join('\n'), /let through past Ben's note of [\d:]+ UTC, which decided what Final-Factory\/FinalFactory#2395 adds: "the note does not settle the hover arrow/);
  sessions.events.emit('turnEnd', sessions.get(id), 'w1: still open: waiting on Ben to OK the low-ore tooltip look (#2395)');
  await until('the [needs you]', () => heard(ben.id, '[needs you]').length === 1);
  const card = heard(ben.id, '[needs you]')[0].text;
  assert.match(card, /POSSIBLY DECIDED \(w2085\): Ben's note at [\d-]+ [\d:]+ UTC names "low-ore"/);
  assert.match(card, /Ben's earlier notes on w1 and its related requests \(1\)/);
  assert.match(card, /4\. Low-ore right-click \(thread 1251\): "Right-click dismisses for a while/);
  assert.equal(store.work.get('w1')!.needsYou?.possiblyDecided?.[0].why.includes('"low-ore"'), true);
});

test('w2085: no diff reader, or a design choice, refuses nothing', async (t) => {
  const env = await setupOnMachine(t);
  const { store, machines, dispatcher, chat, call, agents } = env;
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Bug sweep', brief: 'Sweep.' });
  chat(BEN).lastFrom = 'human';
  await call(ben, 'update_work', { id: 'w1', note: W1958_0459 });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: bug sweep', work_id: 'w1' });
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const w1 = store.work.get('w1')!;
  w1.prs = [{ repo: 'Final-Factory/FinalFactory', number: 2395, state: 'open', via: 'line' }];
  store.putWork(w1);
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  const q = (what: string) => ({ who: 'Ben', what, about: 'The low-ore alert', after: 'I build it', questions: [{ question: what, options: [{ label: 'Go with A, the arrow', recommended: true }, { label: 'Go with B, the badge' }] }] });
  agents.prDiff = undefined;
  await h.waiting_on_person!(q('OK the low-ore tooltip look so #2395 can merge'));
  agents.prDiff = async () => PR2395_DIFF;
  await h.waiting_on_person!(q('Pick the arrow style for the low-ore alert pointer'));
  agents.prDiff = async () => {
    throw new Error('gh: not found');
  };
  await h.waiting_on_person!(q('OK the low-ore tooltip look so #2395 can merge'));
  assert.ok(info.waitingOn, 'recorded');
});

test('w2756: the replay of w2651 at 04:57: the worker\'s three questions are refused with Ben\'s 20:51 note, and so is the orchestrator\'s card; a stated reason lets each through, logged', async (t) => {
  const env = await setupOnMachine(t);
  const { store, machines, dispatcher, chat, call } = env;
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Player Inventory UX rethink', brief: 'Mocks for one consistent inventory panel.' });
  // 20:51: Ben picks Build D, the note as the ledger holds it.
  chat(BEN).lastFrom = 'human';
  await call(ben, 'update_work', { id: 'w1', note: W2651_2051 });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: inventory rail', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  // 04:57: worker 8fe9af40's three questions (its stills left out: they live on the portal's review root).
  const bare = (s: string) => s.replace(/\n*!\[[^\]]*\]\([^)]*\)/g, '');
  const questions = W2651_0457.map((q) => ({ ...q, question: bare(q.question) }));
  const ask = {
    who: 'Ben',
    what: "look at the built-game stills and clips of the right-rail inventory and say whether it may merge (behind its toggle, off for players), and answer two layout questions at the Deck's 1280x800 size",
    about: 'The Player Inventory becomes one window in a column on the right that never moves (your pick, Build D), behind a toggle players never see',
    after: 'On your OK I update the HUD pin rules to match, then merge on green CI',
    questions,
  };
  await assert.rejects(h.waiting_on_person!(ask), (e: Error) => {
    assert.match(e.message, /^Not recorded: Ben's own notes on w1 may already settle 2 of these questions \(w2756/);
    assert.match(e.message, /Question 1 .*"move the hover card to the left of the rail/);
    assert.match(e.message, /Question 3 .*make Crafting stop above Station Info instead of hiding it/);
    return true;
  });
  assert.equal(info.waitingOn, undefined, 'nothing recorded: the request does not show Waiting on input');
  assert.match(store.work.get('w1')!.log.join('\n'), /waiting_on_person from worker \w+ refused \(w2756\): Ben's own notes may settle questions 1, 3 of 3/);
  // Asked only what the note leaves open (the Deck rail's width), it goes through.
  await h.waiting_on_person!({ ...ask, questions: [questions[1]] });
  assert.ok(info.waitingOn, 'the open question is recorded');
  // With what the note leaves open, the whole card goes through, logged.
  await h.waiting_on_person!({ ...ask, decided_override: 'his note asked for an OK on built stills before merging' });
  assert.match(store.work.get('w1')!.log.join('\n'), /let through past Ben's notes, which may settle questions 1, 3 of 3: "his note asked for an OK on built stills/);

  // Ben's orchestrator builds its card from it: refused with the note, until it says what the note leaves open.
  await until('that turn ends', () => chat(BEN).info.status === 'idle');
  const card = await call(ben, 'ask_person', { ...questions[2], request: 'w1' });
  assert.equal(card.isError, true, card.text);
  assert.match(card.text, /Not asked: Ben's own notes on w1 may already settle this question \(w2756.*make Crafting stop above Station Info/s);
  assert.match(card.text, /notes_leave_open/);
  assert.equal((await call(ben, 'ask_person', { ...questions[1], request: 'w1' })).isError, false, 'the question the note leaves open is asked');
  const past = await call(ben, 'ask_person', { ...questions[2], request: 'w1', notes_leave_open: 'the Tiles Station Info is taller than the one his note saw' });
  assert.equal(past.isError, false, past.text);
  assert.match(store.work.get('w1')!.log.join('\n'), /ask_person to Ben let through past their note of [\d:]+ UTC, which may settle it: "the Tiles Station Info/);
});
