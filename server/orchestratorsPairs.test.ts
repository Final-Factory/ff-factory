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
