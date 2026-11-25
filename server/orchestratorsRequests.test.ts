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
 * The orchestrator tests (docs/orchestrators.md), end to end on a real Agents with the scripted agent: requests and their records: report and thread references, notes, timers, investigations, list_work, closing.
 * One of the server/orchestrators*.test.ts files split out of orchestrators.test.ts (w5826); helpers in orchestratorsTestKit.ts.
 */


test('w343: a brief and related ids only reference reports and threads; the title and subjects claim them', async (t) => {
  const { store, o, chat, call } = setup(t);
  const ben = chat(BEN);
  ben.lastFrom = 'human';
  // w312: a fetch request whose brief lists the reports it is to copy. It claims none, before or after it is done.
  const fetch = await call(ben.info, 'request_work', { title: "Fetch tonight's host desync reports", brief: `Copy ${R1} and ${R2} off FFBox; see https://discord.com/channels/530867164866150410/${TH}.`, related_ids: [R3, 'w1'] });
  assert.equal(fetch.isError, false, fetch.text);
  const w = [...store.work.values()].find((x) => x.title.startsWith('Fetch tonight'))!;
  assert.deepEqual(w.keys.filter((k) => /^(report|discord):/.test(k)), []);
  assert.equal(w.scope, undefined, 'no scope from a brief');
  for (const k of [`report:${R1}`, `report:${R3}`, `discord:${TH}`]) assert.equal(o.boardCheck({ keys: [k] }, 30).verdict, 'clear', k);
  w.status = 'done';
  store.putWork(w);
  assert.equal(o.boardCheck({ keys: [`report:${R1}`] }, 30).verdict, 'clear', 'a done fetch is not the fix');
  // A request whose title names the report, or whose filer gave it as a subject, is the work for it.
  await call(ben.info, 'request_work', { title: `Diagnose desync ${R2}`, brief: 'From the host report.' });
  await call(ben.info, 'request_work', { title: "Fix tonight's cbots fork", brief: `The fork in ${R1}.`, subjects: [R1, `https://discord.com/channels/530867164866150410/${TH}`] });
  const byTitle = [...store.work.values()].find((x) => x.title.startsWith('Diagnose desync'))!;
  const bySubject = [...store.work.values()].find((x) => x.title.startsWith('Fix tonight'))!;
  assert.deepEqual(byTitle.keys.filter((k) => k.startsWith('report:')), [`report:${R2}`]);
  assert.deepEqual(bySubject.subjects, [`report:${R1}`, `discord:${TH}`]);
  assert.deepEqual(bySubject.scope, { threads: [TH] }, 'its own thread is its scope');
  const a = o.boardCheck({ keys: [`report:${R1}`] }, 30);
  assert.deepEqual([a.verdict, a.matches[0].id], ['in_flight', bySubject.id]);
});

test('w343: notes and worker reports never add a report or thread key; board_check never answers by a worker', async (t) => {
  const { store, o, chat, call } = setup(t);
  const ben = chat(BEN);
  ben.lastFrom = 'human';
  await call(ben.info, 'request_work', { title: 'Host kicked from its own game', brief: 'Diagnose the Steam lobby problem.' });
  const w = [...store.work.values()][0];
  const before = [...w.keys];
  assert.equal((await call(ben.info, 'update_work', { id: w.id, note: `Also seen in ${R3} and https://discord.com/channels/530867164866150410/${TH}` })).isError, false);
  // Its worker's report names the reports it downloaded.
  const worker = { id: 'wk1', kind: 'worker', title: 'Diagnose host kick', status: 'running', permissionMode: 'default', createdAt: T0, lastActivityAt: new Date().toISOString(), turns: 1, costUsd: 0, pendingPermissions: [], lastResult: `Read ${R3} and ${R1} from the zip.` } as unknown as SessionInfo;
  store.putSession(worker);
  w.sessionIds = ['wk1'];
  store.putWork(w);
  assert.deepEqual(store.work.get(w.id)!.keys, before);
  for (const k of [`report:${R3}`, `report:${R1}`, `discord:${TH}`]) assert.equal(o.boardCheck({ keys: [k] }, 30).verdict, 'clear', k);
});

test('w343: "Please diagnose this" is not every diagnosis (the text match that held conversations 640-644 on w331)', (t) => {
  const { store, o } = setup(t);
  const now = new Date().toISOString();
  store.putWork({
    id: 'w331',
    title: '<@1531428813538590841> Please diagnose this',
    brief: 'lothsahn asked for this through FFBox (dev request dev-637-957). Bug Bot: Disconnected as host from multiplayer game. Host Kicked.',
    priority: 'normal',
    keys: [`discord:${TH}`, 'ffbox:637'],
    requestedBy: LOTH,
    requesters: [LOTH],
    humanAsked: true,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    sessionIds: [],
    overlaps: [],
    asks: 0,
    log: [],
    source: { kind: 'ffbox-dev', untrusted: true, conversation: '637', threadId: TH },
  });
  const a = o.boardCheck({ keys: [`report:${R3}`], title: 'Please diagnose this desync report', summary: 'A desync diagnosis: the host and a client forked at heartbeat 1424 (containers, directions).' }, 30);
  assert.equal(a.verdict, 'clear', JSON.stringify(a));
});

test('w2044: board_check works out each request\'s concepts once, and again only when its text changes', (t) => {
  const { store, o } = setup(t);
  const now = new Date().toISOString();
  const item = (i: number, brief: string) => ({
    id: `w${100 + i}`,
    title: i === 7 ? 'Conveyor belts jam at the splitter' : `Request number ${i} about turret ammo ${i}`,
    brief,
    priority: 'normal' as const,
    keys: [],
    requestedBy: LOTH,
    requesters: [LOTH],
    humanAsked: true,
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
    sessionIds: [],
    overlaps: [],
    asks: 0,
    log: [],
  });
  for (let i = 0; i < 40; i++) store.putWork(item(i, `Brief ${i}: the turret runs out of ammo near the base.`));
  const q = { keys: [], title: 'belts jam at a splitter', summary: 'The conveyor belt jams where it splits.' };
  const first = o.boardCheck(q, 30);
  assert.equal(first.matches[0]?.id, 'w107', JSON.stringify(first));
  assert.equal(o.boardTextsMade, 40, 'every request once');
  assert.deepEqual(o.boardCheck(q, 30), first, 'the same answer from the kept concepts');
  assert.equal(o.boardTextsMade, 40, 'none again while their text is unchanged');
  store.putWork({ ...store.work.get('w107')!, brief: 'Splitter jams: the belt stops.' });
  o.boardCheck(q, 30);
  assert.equal(o.boardTextsMade, 41, 'a changed brief is worked out again');
});

test('w343: the start-up detach drops referenced report keys (backed up, logged, stamped), keeps own ones, and is idempotent', (t) => {
  const { dir, store, o } = setup(t);
  const now = new Date().toISOString();
  const base = { priority: 'normal' as const, requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active' as const, createdAt: now, updatedAt: now, sessionIds: [], overlaps: [], asks: 0, log: [] };
  // w312: report ids from its brief.
  store.putWork({ ...base, id: 'w312', title: "Fetch tonight's host desync reports", brief: `Copy ${R1} and ${R2}.`, keys: [`report:${R1}`, `report:${R2}`, 'work:w297'] });
  // w343: its brief's report and thread, and the one-thread scope made from that thread.
  store.putWork({ ...base, id: 'w343', title: 'Ledger: detach wrong report keys', brief: `See ${R3} and https://discord.com/channels/530867164866150410/${TH}`, keys: [`discord:${TH}`, `report:${R3}`, 'ref:991'], scope: { threads: [TH] } });
  // Own keys stay: a title's thread, a report the title names by stamp or hash, given subjects, a broad scope.
  store.putWork({ ...base, id: 'w314', title: 'Fix: ship lands in the wrong place (Discord thread 1556008532338278470)', brief: 'x', keys: ['discord:1556008532338278470', 'pr:985'], scope: { threads: ['1556008532338278470'] } });
  store.putWork({ ...base, id: 'w197', title: 'Reproduce desync 20261002T043752Z (Bats target on the host only)', brief: 'x', keys: ['report:20261002T043752Z-desync-f4f4952e62', 'report:20261002T043921Z-desync-1d460c8b98'] });
  store.putWork({ ...base, id: 'w260', title: 'Desync 3fad4b829b: orphan StationGrid entities', brief: 'x', keys: ['report:20261003T072652Z-desync-3fad4b829b'] });
  store.putWork({ ...base, id: 'w350', title: 'Fix the cbots fork', brief: `See ${R2}`, keys: [`report:${R1}`, `report:${R2}`], subjects: [`report:${R1}`] });
  store.putWork({ ...base, id: 'w351', title: 'Triage the threads since Oct 3', brief: 'x', keys: ['discord:1556000000000000001', 'discord:1556000000000000002'], scope: { threads: ['1556000000000000001', '1556000000000000002'] } });
  // An intake request's keys are its source's: untouched.
  store.putWork({ ...base, id: 'w331', title: 'Please diagnose this', brief: `Bug Bot ${R3}`, keys: [`discord:${TH}`, 'ffbox:637', `report:${R3}`], source: { kind: 'ffbox-dev', untrusted: true, conversation: '637', threadId: TH } });

  const done = o.detachBorrowedSubjects();
  assert.deepEqual(done.map((d) => d.id).sort(), ['w197', 'w312', 'w343', 'w350']);
  assert.deepEqual(store.work.get('w312')!.keys, ['work:w297']);
  // Old thread keys and scopes stay (most were a fix request's own thread, linked in its brief): only reports go.
  assert.deepEqual(store.work.get('w343')!.keys, [`discord:${TH}`, 'ref:991']);
  assert.deepEqual(store.work.get('w197')!.keys, ['report:20261002T043752Z-desync-f4f4952e62']);
  assert.equal(store.work.get('w260')!.keys.length, 1);
  assert.deepEqual(store.work.get('w314')!.keys, ['discord:1556008532338278470', 'pr:985']);
  assert.deepEqual(store.work.get('w350')!.keys, [`report:${R1}`]);
  assert.equal(store.work.get('w351')!.keys.length, 2);
  assert.equal(store.work.get('w331')!.keys.length, 3);
  assert.match(store.work.get('w312')!.log.at(-1)!, new RegExp(`keys detached at start-up \\(w343\\): report:${R1}, report:${R2}\\..*Backup: ledger-detach-`));
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('ledger-detach-'));
  assert.equal(backups.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, backups[0]), 'utf8')) as { items: { id: string; keys: string[] }[] };
  assert.deepEqual(saved.items.find((i) => i.id === 'w312')!.keys, [`report:${R1}`, `report:${R2}`, 'work:w297'], 'the backup holds the keys as they were');
  // Run again (every start): nothing to do, no new backup.
  assert.deepEqual(o.detachBorrowedSubjects(), []);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('ledger-detach-')).length, 1);
  for (const k of [`report:${R1}`, `report:${R2}`]) assert.notEqual(o.boardCheck({ keys: [k] }, 30).matches[0]?.id, 'w312');
});

test('w340: a wrongly auto-closed request reopened by hand no longer says it was closed automatically', async (t) => {
  const { store, chat, call } = setup(t);
  const now = new Date().toISOString();
  store.putWork({
    id: 'w50', title: 'Deconstruct frame rate', brief: 'x', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true,
    status: 'done', createdAt: now, updatedAt: now, sessionIds: [], overlaps: [], asks: 0, log: [],
    outcome: 'closed automatically: merged as #1002 (a684e5257e6b) on 2026-10-04',
    autoClosed: { at: now, how: 'prs', pr: 1002, sha: 'a'.repeat(40), text: 'merged as #1002 (a684e5257e6b) on 2026-10-04' },
  });
  const loth = chat(LOTH);
  loth.lastFrom = 'human';
  const r = await call(loth.info, 'update_work', { id: 'w50', reopen: true, note: 'Reopened: it was wrongly auto-closed as "merged as #1002".' });
  assert.equal(r.isError, false, r.text);
  const w = store.work.get('w50')!;
  assert.deepEqual([w.status, w.autoClosed, w.outcome], ['new', undefined, undefined]);
});

test('w340: the two report keys the w343 detach wrongly took (w197, w313) come back once, as subjects; w318 stays', (t) => {
  const { store, o } = setup(t);
  const now = new Date().toISOString();
  const base = { priority: 'normal' as const, requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'done' as const, createdAt: now, updatedAt: now, sessionIds: [], overlaps: [], asks: 0 };
  const took = (key: string) => [`05:28 keys detached at start-up (w343): ${key}. Its brief only referenced them; a request is the work for a report its title or subjects name. Backup: ledger-detach-x.json`];
  store.putWork({ ...base, id: 'w197', title: 'Reproduce desync 20261002T043752Z', brief: 'the partner is 20261002T043921Z-desync-1d460c8b98', keys: ['report:20261002T043752Z-desync-f4f4952e62'], log: took('report:20261002T043921Z-desync-1d460c8b98') });
  store.putWork({ ...base, id: 'w313', title: 'Review, verify and merge FFBox PR #983', brief: 'desync session 20261003T192822Z-desync-fba8dd45e3', keys: ['pr:983'], log: took('report:20261003T192822Z-desync-fba8dd45e3') });
  store.putWork({ ...base, id: 'w318', title: 'CRITICAL: merge FFBox PR #991', brief: 'desync session 20261003T211451Z-desync-0d4abe93c0', keys: ['pr:991'], log: took('report:20261003T211451Z-desync-0d4abe93c0') });
  assert.deepEqual(o.restoreDetachedSubjects().map((r) => r.id), ['w197', 'w313']);
  assert.ok(store.work.get('w197')!.keys.includes('report:20261002T043921Z-desync-1d460c8b98'));
  assert.deepEqual(store.work.get('w313')!.subjects, ['report:20261003T192822Z-desync-fba8dd45e3']);
  assert.deepEqual(store.work.get('w318')!.keys, ['pr:991']);
  // The detach at the next start keeps them (they are subjects now), and the restore does nothing twice.
  assert.deepEqual(o.detachBorrowedSubjects(), []);
  assert.deepEqual(o.restoreDetachedSubjects(), []);
  assert.equal(o.boardCheck({ keys: ['report:20261003T192822Z-desync-fba8dd45e3'] }, 30).matches[0]?.id, 'w313');
});

// ---------------------------------------------------------------- w362: timers

test('w362: set_timer, list_timers, update_timer, cancel_timer are each orchestrator\'s own; a person writing cancels wake_me, never a timer', async (t) => {
  const { agents, store, o, chat, call, dispatcher } = setup(t);
  const ben = chat(BEN);
  const set = await call(ben.info, 'set_timer', { title: 'FFBox desync scan', note: 'Check FFBox for new desync PRs and tell Ben.', schedule: { every_minutes: 60 } });
  assert.equal(set.isError, false, set.text);
  const id = /Timer (t-[0-9a-f]{8})/.exec(set.text)![1];
  assert.match(set.text, /every 1 h, next at /);
  const wake = await call(ben.info, 'wake_me', { minutes: 30, note: 'check the belt fix' });
  assert.equal(wake.isError, false, wake.text);
  // Ben writes to his orchestrator (the remote path; the message route does the same: waker.cancel, personWrote, send).
  // Not waiting in askOrchestrator (it looks every 1.5 s) but for the answer itself.
  await agents.askOrchestrator('How is it going?', 0, 'test', BEN);
  await until('Ben’s orchestrator answered', () => store.readTranscript(ben.info.id).some((e) => e.kind === 'assistant' && e.text.includes('How is it going?')));
  assert.equal(agents.waker.pending(ben.info.id), undefined, 'wake_me: cancelled by a person writing, as before');
  const listed = await call(ben.info, 'list_timers', {});
  assert.match(listed.text, new RegExp(`${id} "FFBox desync scan" \\[active\\] every 1 h, next `), 'the timer is untouched');
  // Lothsahn's orchestrator neither sees nor touches it.
  const loth = chat(LOTH);
  assert.match((await call(loth.info, 'list_timers', {})).text, /^No timers/);
  const theirs = await call(loth.info, 'cancel_timer', { id });
  assert.equal(theirs.isError, true);
  assert.match(theirs.text, /no timer .* of yours/);
  // Pause, change, cancel: Ben's own.
  assert.match((await call(ben.info, 'update_timer', { id, enabled: false })).text, /paused/);
  assert.match((await call(ben.info, 'update_timer', { id, enabled: true, schedule: { daily: '09:30', tz: 'Europe/Berlin' } })).text, /daily at 09:30 \(Europe\/Berlin\), next at /);
  assert.match((await call(ben.info, 'cancel_timer', { id })).text, /cancelled/);
  assert.match((await call(ben.info, 'list_timers', {})).text, /\[ended\].*\(cancelled\)/s);
  // The dispatcher has timers of its own.
  const ds = await call(dispatcher().info, 'set_timer', { title: 'ledger sweep', note: 'n', schedule: { every_minutes: 30 } });
  assert.equal(ds.isError, false, ds.text);
  assert.equal(agents.timers.list(dispatcher().info.id).length, 1);
  assert.equal(agents.timers.list(o.personalFor(BEN).info.id).length, 1, 'still only Ben\'s own (ended) one');
});

test('w362: a timer\'s turn carries no one\'s authority: a person-only tool refuses it', async (t) => {
  const { agents, store, dispatcher, call } = await setupOnMachine(t);
  const d = dispatcher();
  agents.timers.create(d.info.id, { title: 'cleanup', note: 'Delete sandbox alpha.', schedule: { every_minutes: 5 } }, 'ben');
  const real = agents.timers.now;
  agents.timers.now = () => Date.now() + 6 * 60_000;
  agents.timers.tick();
  agents.timers.now = real;
  const got = store.readTranscript(d.info.id).filter((e) => e.kind === 'user' && e.from === 'system' && e.text.startsWith('[timer '));
  assert.equal(got.length, 1, 'delivered as the harness\'s message');
  const r = await call(d.info, 'delete_sandbox', { sandbox: 'pc/alpha' });
  assert.equal(r.isError, true, 'refused on a timer turn');
  assert.match(r.text, /own words/);
  assert.ok(store.machines.get('pc')!.sandboxes!.some((x) => x.id === 'alpha'), 'nothing deleted');
});

test("w1106: the ops worker's repeating timer survives a portal restart: the fire due meanwhile is delivered once, as the job it was set in, and the next on schedule", async (t) => {
  const { dir, cfg, store, sessions, agents, chat, call, closers } = setup(t);
  const loth = chat(LOTH);
  const filed = await call(loth.info, 'request_work', { title: 'Grow LothDesktop V: once it is idle', brief: 'lothsahn: "Let\'s schedule it for when LothDesktop is idle."' });
  const wid = /Filed (w\d+)/.exec(filed.text)![1];
  // Lothsahn's own turn gives the ops worker the job, for that request.
  sessions.send(loth.info.id, 'Poll LothDesktop for idle every 2 hours #slow', 'human', undefined, { requestedBy: LOTH });
  const job = await call(loth.info, 'ops_worker', { action: 'send', text: 'Poll LothDesktop for idle every 2 hours.', fresh: true, work_ids: [wid] });
  assert.equal(job.isError, false, job.text);
  await until('the ops worker\'s turn', () => sessions.get(OPS_ID).info.status === 'idle');
  // The worker sets the timer with its own belt, as its model would.
  const opsBelt = beltFor('ops', agents.toolSpecs('orchestrator', agents.dispatcherActor, { role: 'ops', sessionId: OPS_ID }));
  for (const name of ['set_timer', 'list_timers', 'update_timer', 'cancel_timer', 'wake_me']) assert.ok(opsBelt.some((x) => x.name === name), `the ops worker has ${name}`);
  const set = await opsBelt.find((x) => x.name === 'set_timer')!.handler({ title: 'w1070 LothDesktop idle check', note: 'Run w1070-idlecheck.ps1 on lothdesktop; on IDLE run w1070-grow.ps1, verify, report and cancel_timer this.', schedule: { every_minutes: 120 }, until: new Date(Date.now() + 3 * 24 * 3600_000).toISOString() });
  const setText = set.content.map((c) => c.text).join('\n');
  assert.ok(!set.isError, setText);
  assert.match(setText, new RegExp(`every 2 h, next at .*, until .*; each fire comes back as Lothsahn's job for ${wid}\\.`));
  const id = /Timer (t-[0-9a-f]{8})/.exec(setText)![1];
  assert.match(await call(loth.info, 'ops_worker', { action: 'status' }).then((r) => r.text), new RegExp(`Its timers \\(w1106\\): .*\\n.*${id} "w1070 LothDesktop idle check" \\[active\\] every 2 h`));
  const fires = () => store.readTranscript(OPS_ID, 500).filter((e) => e.kind === 'user' && e.from === 'system' && e.text.startsWith(`[timer ${id} `)) as { text: string; requestedBy?: Requester }[];
  // Ben's job runs in between: the timer stays the job it was set in.
  const ben = chat(BEN);
  sessions.send(ben.info.id, 'check m5 #slow', 'human', undefined, { requestedBy: BEN });
  assert.equal((await call(ben.info, 'ops_worker', { action: 'send', text: 'ssh m5 uptime', fresh: true })).isError, false);
  await until('Ben\'s job ran', () => sessions.get(OPS_ID).info.status === 'idle' && store.readTranscript(OPS_ID, 500).some((e) => e.kind === 'user' && e.text.startsWith('ssh m5 uptime')));

  assert.equal(fires().length, 0, 'nothing fired before the restart');
  // The portal goes down, 2 h 10 min pass (a fire came due at 2 h), and it starts again on the same data folder.
  agents.close();
  agents.orchestrators.close();
  sessions.stopAll();
  await new Promise((r) => setTimeout(r, 60));
  store.flush();
  const later = Date.now() + 130 * 60_000;
  const store2 = new Store(dir);
  const sessions2 = new SessionManager(cfg, store2);
  const agents2 = new Agents(cfg, store2, sessions2, new MachineManager(cfg, store2, sessions2), new Identity(cfg, () => PEOPLE));
  closers.push(async () => {
    agents2.close();
    agents2.orchestrators.close();
    sessions2.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store2.flush();
  });
  agents2.timers.now = () => later;
  agents2.boot();
  const fires2 = () => store2.readTranscript(OPS_ID, 500).filter((e) => e.kind === 'user' && e.from === 'system' && e.text.startsWith(`[timer ${id} `)) as { text: string; requestedBy?: Requester }[];
  await until('the fire due during the restart', () => fires2().length === 1);
  const fire = fires2()[0];
  assert.match(fire.text, new RegExp(`^\\[timer ${id} "w1070 LothDesktop idle check"\\] Run w1070-idlecheck\\.ps1 on lothdesktop`));
  assert.match(fire.text, new RegExp(`in Lothsahn's job for ${wid}: it carries that job's authority`));
  assert.match(fire.text, new RegExp(`\\[ledger\\] This job is the step left on ${wid}\\.`));
  assert.match(agents2.ops.status(), /job of Lothsahn since/, "the fire opened Lothsahn's job again (Ben's came in between)");
  await until('its turn ends', () => sessions2.get(OPS_ID).info.status === 'idle');
  // Never twice: the ticks after it deliver nothing more until the next fire is due.
  agents2.timers.tick();
  agents2.timers.turnEnded(OPS_ID);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fires2().length, 1, 'delivered once');
  const view = agents2.timers.list(OPS_ID)[0];
  assert.equal(view.fires, 1);
  assert.equal(view.state, 'active');
  // The next on schedule, on its own grid: 4 h after it was set, 2 h after the one the restart delayed.
  assert.ok(Math.abs(Date.parse(view.nextFireAt!) - (later + 110 * 60_000)) < 60_000, String(view.nextFireAt));
  agents2.timers.now = () => Date.parse(view.nextFireAt!);
  agents2.timers.tick();
  await until('the next fire', () => fires2().length === 2);
  assert.doesNotMatch(fires2()[1].text, /missed while FF Factory was down/);
});

// ---------------------------------------------------------------- w384: idle workers

test('w384: the reaper stops idle workers whose request closed, moved on, or that sat an hour, resumably; never a protected one', async (t) => {
  const { store, sessions, machines, agents } = await setupOnMachine(t);
  const now = Date.now();
  const make = async (id: string, over: Partial<SessionInfo> = {}) => {
    const h = sessions.create({ kind: 'worker', title: id, permissionMode: 'bypassPermissions', options: () => ({ model: 'opus' }) });
    Object.assign(h.info, over);
    sessions.send(h.info.id, 'hello');
    await until(`${id} idle`, () => h.info.status === 'idle');
    return h;
  };
  const request = (id: string, status: WorkItem['status'], sessionIds: string[]) =>
    store.putWork({ id, title: id, brief: 'x', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status, createdAt: T0, updatedAt: T0, sessionIds, overlaps: [], asks: 0, log: [] });
  const done = await make('done');
  request('w1', 'done', [done.info.id]);
  const handed = await make('handed');
  const other = await make('other');
  request('w2', 'active', [handed.info.id, other.info.id]);
  const quiet = await make('quiet');
  request('w3', 'active', [quiet.info.id]);
  quiet.info.lastActivityAt = new Date(now - 61 * 60_000).toISOString();
  const fresh = await make('fresh');
  request('w4', 'active', [fresh.info.id]);
  // Protected: a pending wake_me; a sandbox with uncommitted changes (mp-r2's 4b35b8c1 held uncommitted work).
  const waking = await make('waking');
  request('w5', 'done', [waking.info.id]);
  agents.waker.schedule(waking.info.id, 30, 'check CI');
  const dirty = machines.createSession('pc', { kind: 'worker', title: 'dirty', permissionMode: 'bypassPermissions', sandbox: 'alpha' });
  sessions.send(dirty.info.id, 'hello');
  await until('dirty idle', () => dirty.live && dirty.info.status === 'idle');
  request('w6', 'done', [dirty.info.id]);
  const m = store.machines.get('pc')!;
  m.sandboxes!.find((x) => x.id === 'alpha')!.git = { branch: 'x', dirty: 2, untracked: 0, at: T0 };
  store.putMachine(m);
  // other is the newest worker on w2 and idle a moment: kept.
  const stopped = agents.reapIdle(now).sort();
  assert.deepEqual(stopped, [done.info.id, handed.info.id, quiet.info.id].sort());
  for (const h of [done, handed, quiet]) assert.equal(h.live, false);
  for (const h of [fresh, other, waking, dirty]) assert.equal(h.live, true, h.info.title);
  assert.match(agents.keepIdle(waking) ?? '', /wake_me is pending/);
  assert.match(agents.keepIdle(dirty) ?? '', /2 uncommitted change/);
  assert.match(store.readTranscript(done.info.id).at(-1)!.kind === 'system' ? (store.readTranscript(done.info.id).at(-1) as { text: string }).text : '', /Stopped by FF Factory while idle: its request is closed \(w1 done\)\. Its history is kept/);
  // Resumable: a message resumes the stopped one with its history.
  const sdk = done.info.sdkSessionId;
  sessions.send(done.info.id, 'one more thing');
  await until('resumed', () => done.info.status === 'idle' && done.live);
  assert.equal(done.info.sdkSessionId === sdk || !!done.info.sdkSessionId, true);
  // w656: once its sandbox is clean the worker there is stopped too, and its sandbox stays its until the release pass releases it.
  m.sandboxes!.find((x) => x.id === 'alpha')!.git = { branch: 'x', dirty: 0, untracked: 0, at: T0 };
  store.putMachine(m);
  assert.ok(agents.reapIdle(now).includes(dirty.info.id));
  assert.equal(dirty.info.releaseDue?.why, 'stopped while idle: its request is closed (w6 done)');
  assert.equal(done.info.releaseDue, undefined, 'not in a machine sandbox: nothing to release');
});


test('w4589: a worker whose own background job is at work is not stopped as idle and keeps its sandbox; once the job goes quiet, or its request closes, it is', async (t) => {
  const { store, sessions, machines, agents } = await setupOnMachine(t);
  const now = Date.now();
  const request = (id: string, status: WorkItem['status'], sessionIds: string[]) =>
    store.putWork({ id, title: id, brief: 'x', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status, createdAt: T0, updatedAt: T0, sessionIds, overlaps: [], asks: 0, log: [] });
  // biscuit, 2026-11-17: w4568's worker 202bc503 sat 61 min between turns while its scenario batches ran.
  const lab = machines.createSession('pc', { kind: 'worker', title: 'lab', permissionMode: 'bypassPermissions', sandbox: 'alpha' });
  sessions.send(lab.info.id, 'hello');
  await until('lab idle', () => lab.live && lab.info.status === 'idle');
  request('w4568', 'active', [lab.info.id]);
  lab.info.lastActivityAt = new Date(now - 61 * 60_000).toISOString();
  const stats = (machines as unknown as { stats: Map<string, MachineStats> }).stats;
  const report = (busyJobs: BusyJob[], at = now) => stats.set('pc', { ...(stats.get('pc') ?? ({} as MachineStats)), unity: { used: 0, interactive: 0, batch: 0, outside: 0, players: 0, overLimit: false, ramLimitPct: 90, waiting: [], granted: [], at: new Date(at).toISOString(), busyJobs }, at: new Date(at).toISOString() });
  report([{ session: lab.info.id, pids: [4242], cpuSec: 41, what: 'python3, FinalFactory' }]);
  assert.deepEqual(agents.reapIdle(now), [], 'kept: its job is at work');
  assert.equal(lab.live, true);
  assert.equal(lab.info.releaseDue, undefined, 'its sandbox is not released');
  assert.match(agents.keepIdle(lab, true, true) ?? '', /its own background job is still at work on pc \(1 process\(es\), 41 s of CPU a minute: python3, FinalFactory\)/);
  // Another worker's job, or a report from a daemon gone quiet, keeps nothing.
  report([{ session: 'someone-else', pids: [1], cpuSec: 60, what: 'python3' }]);
  assert.equal(agents.keepIdle(lab, true, true), undefined);
  report([{ session: lab.info.id, pids: [4242], cpuSec: 41, what: 'python3' }], now - 6 * 60_000);
  assert.equal(agents.keepIdle(lab, true, true), undefined, 'stats 6 min old');
  // Its request closed: a busy job is no reason to keep it.
  report([{ session: lab.info.id, pids: [4242], cpuSec: 41, what: 'python3' }]);
  store.putWork({ ...store.work.get('w4568')!, status: 'done' });
  assert.equal(agents.keepIdle(lab, true, true), undefined);
  store.putWork({ ...store.work.get('w4568')!, status: 'active' });
  // The job went quiet (a hung process uses no CPU, so the daemon lists none): stopped as idle, its sandbox due for release.
  report([]);
  assert.deepEqual(agents.reapIdle(now), [lab.info.id]);
  await until('lab stopped', () => !lab.live);
  assert.match((lab.info as SessionInfo).releaseDue?.why ?? '', /stopped while idle: idle for 61 min/);
});


// ---------------------------------------------------------------- w402: owners close each other's requests

test("w402: an owner closes or reopens another person's request in their own turn, with a reason; logged, its person told", async (t) => {
  const { store, dispatcher, chat, call, heard } = setup(t, { people: [{ ...BEN, role: 'owner' }, { ...LOTH, role: 'owner' }] });
  const ben = chat(BEN);
  const loth = chat(LOTH);
  ben.lastFrom = 'human';
  await call(ben.info, 'request_work', { title: 'Tidy the ledger page', brief: 'Sort the closed requests newest first.' });
  const w = () => store.work.get('w1')!;
  loth.lastFrom = 'human';
  // In his own turn (between owners any turn will do since w677: see below), only a close or a reopen, with a reason.
  // A priority goes alone (w3606: in his own turn it changes as Ben's own would), never with a close (a note alone is w677's: see below).
  assert.match((await call(loth.info, 'update_work', { id: 'w1', close: 'done', priority: 'high', note: 'x' })).text, /its priority stays its people's to change/);
  assert.match((await call(loth.info, 'update_work', { id: 'w1', close: 'done' })).text, /say why in a note: Ben will be told who closed w1 and why/);
  assert.equal(w().status, 'new', 'nothing changed yet');
  const r = await call(loth.info, 'update_work', { id: 'w1', close: 'done', note: 'Ben asked me to close it: shipped in #1040.' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^w1 \(Ben's request\) is done: closed as done by Lothsahn\. Ben's orchestrator is told who and why\.$/);
  assert.deepEqual([w().status, w().outcome, w().requestedBy.userId], ['done', 'Ben asked me to close it: shipped in #1040.', 'ben']);
  assert.match(w().log.at(-1)!, /closed as done by Lothsahn \(Ben's request\), in Lothsahn's own turn: Ben asked me to close it: shipped in #1040\.$/);
  await until("Ben's orchestrator hears who closed it and why", () => heard(ben.info.id, '[dispatch]').some((e) => /w1 "Tidy the ledger page": closed as done by Lothsahn, who asked for it in their own words \(it is your request\)\.\nBen asked me to close it/.test(e.text)));
  // Reopened the same way; the dispatcher hears a reopen, as for the person's own.
  const back = await call(loth.info, 'update_work', { id: 'w1', reopen: true, note: 'Closed by mistake: the sort is not in yet.' });
  assert.match(back.text, /^w1 \(Ben's request\) is new: reopened by Lothsahn\./);
  assert.equal(w().status, 'new');
  assert.match(w().log.at(-1)!, /reopened by Lothsahn \(Ben's request\), in Lothsahn's own turn: Closed by mistake/);
  await until('Ben hears the reopen', () => heard(ben.info.id, '[dispatch]').some((e) => /reopened by Lothsahn/.test(e.text)));
  await until('the dispatcher hears the reopen', () => heard(dispatcher().info.id, '[work update]').some((e) => /w1 "Tidy the ledger page" \(new\) from Lothsahn: reopened for Ben/.test(e.text)), 5000);
  // And Ben, an owner too, closes Lothsahn's.
  await call(loth.info, 'request_work', { title: 'Profile the belts', brief: 'Where does the tick go?' });
  ben.lastFrom = 'human';
  assert.match((await call(ben.info, 'update_work', { id: 'w2', close: 'cancelled', note: 'Lothsahn dropped it this morning.' })).text, /^w2 \(Lothsahn's request\) is cancelled: cancelled by Ben\./);
});

test("w631: closes a person asks for in their own turn do not count toward the filings cap; anything else still does", async (t) => {
  const { o, store, chat, call } = setup(t, { people: [{ ...BEN, role: 'owner' }, { ...LOTH, role: 'owner' }] });
  const ben = chat(BEN);
  const loth = chat(LOTH);
  loth.lastFrom = 'human';
  for (let i = 0; i < FILINGS_PER_MESSAGE; i++) await call(loth.info, 'request_work', { title: `Lothsahn's task ${i}`, brief: 'x' });
  ben.lastFrom = 'human';
  for (let i = 0; i < FILINGS_PER_MESSAGE + 3; i++) await call(ben.info, 'request_work', { title: `Ben's finished task ${i}`, brief: 'x' }), o.personWrote(ben.info.id);
  // Ben's one "close everything that's done": more closes than the cap, his own requests and an owner's close of Lothsahn's.
  const mine = [...store.work.values()].filter((w) => w.requestedBy.userId === 'ben').map((w) => w.id);
  assert.ok(mine.length > FILINGS_PER_MESSAGE);
  for (const id of mine) {
    const r = await call(ben.info, 'update_work', { id, close: 'done', note: 'finished: its PR merged' });
    assert.equal(r.isError, false, `${id}: ${r.text}`);
  }
  for (const id of ['w1', 'w2']) {
    const r = await call(ben.info, 'update_work', { id, close: 'cancelled', note: 'Lothsahn dropped it' });
    assert.equal(r.isError, false, `${id}: ${r.text}`);
  }
  // Notes in the same turn still count: the cap holds for anything but a close.
  for (let i = 0; i < FILINGS_PER_MESSAGE; i++) assert.equal((await call(ben.info, 'request_work', { title: `New thing ${i}`, brief: 'x' })).isError, false);
  const later = [...store.work.values()].filter((w) => w.requestedBy.userId === 'ben' && w.status === 'new').map((w) => w.id);
  assert.match((await call(ben.info, 'update_work', { id: later[0], note: 'one more detail' })).text, new RegExp(`${FILINGS_PER_MESSAGE} filings since Ben last wrote`));
  // A close in a harness turn (a check-in, a relayed report) counts as before.
  ben.lastFrom = 'system';
  assert.match((await call(ben.info, 'update_work', { id: later[0], close: 'done', note: 'x' })).text, new RegExp(`${FILINGS_PER_MESSAGE} filings since Ben last wrote`));
});

test("w1867: in a turn lothsahn's own timer started, his orchestrator files past the cap up to his limit of 100; the 101st is held; FF Factory files one bug; his message starts it again", async (t) => {
  const { cfg, o, store, agents, chat, call } = setup(t);
  cfg.orchestrator = { ...cfg.orchestrator, timerFilingsPerMessage: { lothsahn: 100 } };
  const loth = chat(LOTH);
  const timer = await fireTimer(agents, store, loth.info.id, 'close finished requests and unjam stuck ones', 'lothsahn', 241);
  assert.deepEqual(o.timerTurn(loth)?.map((x) => x.id), [timer], 'the turn its message opened is the timer\'s');
  const results: string[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await call(loth.info, 'request_work', { title: `Unjam stuck request number ${i}`, brief: 'x' });
    assert.equal(r.isError, false, `filing ${i + 1}: ${r.text}`);
    results.push(r.text);
  }
  assert.ok(results.length > FILINGS_PER_MESSAGE, 'past the limit every other turn has');
  // The 100th: FF Factory filed its bug, and the orchestrator is told so in that result.
  const bugs = investigations(store);
  assert.equal(bugs.length, 1);
  const bug = bugs[0];
  assert.match(results[99], new RegExp(`\\[FF Factory\\] That was filing 100 in this turn: FF Factory filed ${bug.id} .*by itself to find out why \\(w1867\\)\\. Do not file it again`));
  assert.ok(!results.slice(0, 99).some((x) => x.includes('[FF Factory]')));
  assert.equal(bug.title, "Investigate: Lothsahn's orchestrator made 100 filings in one turn");
  assert.deepEqual([bug.requestedBy.userId, bug.repo, bug.needs, bug.humanAsked, bug.status], ['lothsahn', 'Final-Factory/ff-factory', 'agent', false, 'new']);
  assert.match(bug.brief, new RegExp(`session ${loth.info.id}: /#/session/${loth.info.id}\\) reached 100 filings .* in one turn, from \\S+ to \\S+, started by timer ${timer} "close finished requests and unjam stuck ones"`));
  assert.match(bug.brief, new RegExp(`Timers that started these turns: timer ${timer} `));
  assert.match(bug.brief, /- \S+: started by timer t-\w+ .*; 100 filings: new request "Unjam stuck request number 0", /);
  assert.match(bug.log.at(-1)!, /filed by FF Factory for Lothsahn \(w1867\).*counts against no limit/);
  // The 101st is held, as the cap's refusals are, and names the bug; asking again files no second bug.
  for (let i = 0; i < 2; i++) {
    const over = await call(loth.info, 'request_work', { title: `One more stuck request ${i}`, brief: 'x' });
    assert.equal(over.isError, true);
    assert.match(over.text, new RegExp(`^ERROR: 100 filings since Lothsahn last wrote \\(in a turn their timer ${timer} started: config orchestrator\\.timerFilingsPerMessage\\) \\(a limit against loops\\); FF Factory filed ${bug.id} to find out why so many\\. Held: FF Factory offers this call back`));
  }
  assert.equal(investigations(store).length, 1, 'filed once per hit');
  // His message starts the count again: the next timer turn files again.
  o.personWrote(loth.info.id);
  await fireTimer(agents, store, loth.info.id, 'second timer', 'lothsahn', 2 * 241);
  assert.equal((await call(loth.info, 'request_work', { title: 'One more stuck request again', brief: 'x' })).isError, false);
  assert.equal(investigations(store).length, 1);
});

test('w1867: turns a person starts, worker reports and dispatches keep the filings limit, whatever their timers may do; a person not named keeps it in timer turns too', async (t) => {
  const { cfg, o, store, sessions, agents, chat, call } = setup(t);
  cfg.orchestrator = { ...cfg.orchestrator, timerFilingsPerMessage: { lothsahn: 100 } };
  const loth = chat(LOTH);
  const file = (who: SessionInfo, title: string) => call(who, 'request_work', { title, brief: 'x' });
  const fill = async (who: SessionInfo, tag: string) => {
    for (let i = 0; i < FILINGS_PER_MESSAGE; i++) assert.equal((await file(who, `${tag} task ${i}`)).isError, false);
  };
  // His own turn.
  o.personWrote(loth.info.id);
  loth.lastFrom = 'human';
  await fill(loth.info, 'Own turn');
  const own = await file(loth.info, 'Own turn one too many');
  assert.match(own.text, new RegExp(`^ERROR: ${FILINGS_PER_MESSAGE} filings since Lothsahn last wrote \\(a limit against loops\\)\\. Held`));
  // A worker's report: a harness message, not a timer's.
  o.personWrote(loth.info.id);
  sessions.send(loth.info.id, '[worker update] w5: done', 'system');
  assert.equal(o.timerTurn(loth), undefined);
  await fill(loth.info, 'Report turn');
  assert.match((await file(loth.info, 'Report turn one too many')).text, new RegExp(`^ERROR: ${FILINGS_PER_MESSAGE} filings since Lothsahn last wrote \\(a limit against loops\\)`));
  // The timer's own turn goes on where they stopped, counted with them.
  await fireTimer(agents, store, loth.info.id, 'ledger sweep', 'lothsahn', 241);
  assert.equal((await file(loth.info, 'Timer turn goes on')).isError, false);
  // Ben has no setting: his timers' turns have the filings limit.
  const ben = chat(BEN);
  const benTimer = await fireTimer(agents, store, ben.info.id, 'Ben ledger sweep', 'ben', 241);
  assert.deepEqual(o.timerTurn(ben)?.map((x) => x.id), [benTimer]);
  await fill(ben.info, 'Ben timer');
  assert.match((await file(ben.info, 'Ben timer one too many')).text, new RegExp(`^ERROR: ${FILINGS_PER_MESSAGE} filings since Ben last wrote \\(in a turn their timer ${benTimer} started: config orchestrator\\.timerFilingsPerMessage\\) \\(a limit against loops\\)\\. Held`));
  const told = (agents as unknown as { personalBrief(r: Requester): string }).personalBrief(LOTH);
  assert.match(told, /A timer's turn is not Lothsahn's: what needs their own words still does, and it may file up to 100 times since Lothsahn wrote \(w1867\)\./);
  assert.match((agents as unknown as { personalBrief(r: Requester): string }).personalBrief(BEN), new RegExp(`it may file up to ${FILINGS_PER_MESSAGE} times since Ben wrote`));
  assert.match(agents.orchestratorBelt(loth.info).find((x) => x.name === 'request_work')!.description, new RegExp(`At most ${FILINGS_PER_MESSAGE} filings between two messages of your person, 100 when turns your own timers started made them \\(counted with the rest\\)\\. At 100 in one turn FF Factory files a bug`));
});

test("w1867: FF Factory files the investigation bug for any person's orchestrator at 100 filings in one turn that no timer started (Ben's, in his own turn): once, against no limit", async (t) => {
  const { cfg, o, store, sessions, chat, call, heard, dispatcher } = setup(t);
  // A person's own turn holds closes uncounted (w631) and here a raised limit; 100 filings in it are still looked into.
  cfg.orchestrator = { ...cfg.orchestrator, filingsPerMessage: 100 };
  const ben = chat(BEN);
  o.personWrote(ben.info.id);
  ben.lastFrom = 'human';
  let last = '';
  for (let i = 0; i < 100; i++) {
    const r = await call(ben.info, 'request_work', { title: `Ben's own task number ${i}`, brief: 'x' });
    assert.equal(r.isError, false, `filing ${i + 1}: ${r.text}`);
    last = r.text;
  }
  const bugs = investigations(store);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].title, "Investigate: Ben's orchestrator made 100 filings in one turn");
  assert.equal(bugs[0].requestedBy.userId, 'ben');
  assert.match(bugs[0].brief, /in one turn, from \S+ to \S+, started by Ben's own message\./);
  assert.match(bugs[0].brief, /No timer started these turns\./);
  assert.match(last, new RegExp(`That was filing 100 in this turn: FF Factory filed ${bugs[0].id} `));
  // Against no limit: the filings count stays at 100 (FF Factory's own filing took none of it), and the 101st is the limit's.
  assert.match((await call(ben.info, 'request_work', { title: 'Ben one more', brief: 'x' })).text, /^ERROR: 100 filings since Ben last wrote \(a limit against loops\); FF Factory filed w\d+ to find out why so many/);
  // Closes he asks for in his own turn count toward it too, though the limit does not count them (w631): his next
  // message opens a new turn, and its 100th close is a new hit, so one more bug.
  o.personWrote(ben.info.id);
  sessions.send(ben.info.id, 'close everything that is done', 'human', undefined, { requestedBy: BEN });
  const mine = [...store.work.values()].filter((w) => w.title.startsWith("Ben's own task")).map((w) => w.id);
  for (const id of mine) assert.equal((await call(ben.info, 'update_work', { id, close: 'done', note: 'finished' })).isError, false, id);
  const after = investigations(store);
  assert.equal(after.length, 2, 'one bug per hit: a new turn');
  assert.match(after[1].brief, /in one turn, .* started by Ben's own message\.[\s\S]*100 filings: w\d+, w\d+/);
  // The dispatcher hears of FF Factory's bugs as of any request.
  await until('the dispatcher hears of the bug', () => heard(dispatcher().info.id, '[work request]').some((e) => e.text.includes(`${bugs[0].id} `)));
});

test("w402: a member cannot close or reopen another person's request, even in their own turn", async (t) => {
  const { store, chat, call } = setup(t);
  const ben = chat(BEN);
  const loth = chat(LOTH);
  ben.lastFrom = 'human';
  await call(ben.info, 'request_work', { title: 'Tidy the ledger page', brief: 'Sort the closed requests newest first.' });
  loth.lastFrom = 'human';
  const r = await call(loth.info, 'update_work', { id: 'w1', close: 'done', note: 'looks done to me' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^ERROR: w1 is Ben's request, not Lothsahn's; only an owner closes or reopens another person's request, or adds a note to another owner's$/);
  assert.equal(store.work.get('w1')!.status, 'new');
  assert.equal(store.work.get('w1')!.log.some((l) => /Lothsahn/.test(l)), false, 'nothing logged');
});


// ---------------------------------------------------------------- w416: placing work where there is room

test('w536: every worker runs in a sandbox: start_agent with a machine alone is refused naming its sandboxes, no main clone takes work, and standing agents count against the agent cap', async (t) => {
  const { store, agents, dispatcher, call } = setup(t);
  const GB = 1024 ** 3;
  const machines = (agents as unknown as { machines: MachineManager }).machines;
  const machine = (id: string, extra: Record<string, unknown>) =>
    store.putMachine({ id, host: id, purpose: 'unused', status: 'ready', online: true, repoPath: `/w/${id}`, home: '/h', portalUrl: 'http://x', sessionIds: [], createdAt: T0, ...extra } as never);
  const sb = (id: string) => ({ id, branch: `sandbox/${id}`, base: 'origin/develop', path: `D:\\work\\ffsb\\${id}`, purpose: 'unused', status: 'ready', createdAt: T0, unity: { state: 'stopped' }, sessionIds: [] });
  machine('lothdesktop', { platform: 'win32', sandboxRoot: 'D:\\work\\ffsb', maxSandboxes: 3, maxSandboxAgents: 6, sandboxes: [sb('sb1'), sb('sb2')] });
  // No sandbox_root: no workers at all (it gets one through the worker installer, w513).
  machine('m3', { platform: 'darwin' });
  // A small pool: its agent cap is every sandbox full, 1 x 2.
  machine('beast', { platform: 'win32', sandboxRoot: 'F:\\ffsb', maxSandboxes: 1, maxAgentsPerSandbox: 2, sandboxes: [sb('sb1')] });
  Object.assign(machines, { isOnline: () => true, statsOf: () => ({ hostname: 'x', platform: 'x', cpuModel: 'x', cpuCount: 8, loadPct: 5, memTotalBytes: 64 * GB, memFreeBytes: 40 * GB, at: T0 }) });
  agents.hostMem = () => ({ free: 50 * GB, total: 64 * GB });
  assert.deepEqual(['lothdesktop', 'm3', 'beast'].map((id) => agentCap(machines.require(id))), [6, STANDING_CAP_NO_POOL, 2]);

  // add_machine has no max_agents any more.
  const add = agents.toolSpecs().find((x) => x.name === 'add_machine')!;
  assert.equal('max_agents' in add.schema, false);

  // The capacity block holds sandbox computers only; list_machines shows each one's agent cap.
  const list = (await call(dispatcher().info, 'list_sandboxes', {})).text;
  assert.match(list, /\n- lothdesktop: ROOM \d+%/);
  assert.doesNotMatch(list, /main clone|- m3\b/);
  const machinesText = (await call(dispatcher().info, 'list_machines', {})).text;
  assert.match(machinesText, /workers in its sandboxes; up to 6 agents in all, standing agents included/);
  assert.match(machinesText, /no workers \(no sandbox_root\); up to 2 agents in all, standing agents included/);
  assert.doesNotMatch(machinesText, /max_agents|in the main clone/);

  // start_agent with the machine alone: refused before any record is made, naming its sandboxes, with or without them.
  const before = store.sessions.size;
  const start = beltFor('remote', agents.toolSpecs('human', agents.fixedActor(LOTH), { role: 'remote', owner: LOTH })).find((x) => x.name === 'start_agent')!;
  const run = async (a: Record<string, unknown>) => {
    const r = await start.handler(a);
    return { text: r.content.map((c) => c.text).join(''), isError: !!r.isError };
  };
  const r = await run({ machine: 'lothdesktop', prompt: 'Profile the belts', title: 'Belt profile' });
  assert.equal(r.isError, true);
  assert.match(r.text, /lothdesktop runs workers in sandboxes only: start this one in one of its sandboxes \(lothdesktop\/sb1, lothdesktop\/sb2\)/);
  const none = await run({ machine: 'm3', prompt: 'x', title: 'x' });
  assert.equal(none.isError, true);
  assert.match(none.text, /m3 runs workers in sandboxes only: start this one in a sandbox, on a computer that has a sandbox root \(it has none\)/);
  assert.equal(store.sessions.size, before, 'no agent record left behind');
  // unity and switch_branch act on sandboxes only.
  for (const [tool, args] of [['unity', { machine: 'm3', action: 'status' }], ['switch_branch', { machine: 'lothdesktop', branch: 'feature/x' }]] as const) {
    assert.match((await call(dispatcher().info, tool, args)).text, /a machine's main clone takes no agents \(w536\): give a sandbox/, tool);
  }

  // A worker recorded in a main clone before the change is refused outright, not queued for a slot.
  const old = machines.createSession('m3', { kind: 'worker', title: 'old', model: 'opus', permissionMode: 'bypassPermissions' });
  assert.equal(machines.placeFull(old), undefined, 'not queued');
  assert.throws(() => machines.dispatchSend(old as never, 'hi', 'orchestrator', 'u1'), /m3 runs workers in sandboxes only/);
  assert.equal(machines.mainCloneRefusal(machines.require('m3'), 'standing'), undefined, 'standing agents are never refused by it');

  // The agent cap: BEAST's sandbox agents and standing agents mid-turn together, 2.
  const nightly = agents.standing.create({ name: 'Nightly reader', charter: 'Read the nightly report.', trigger: { kind: 'manual' }, machineId: 'beast' } as never);
  const busy = machines.createSession('beast', { kind: 'worker', title: 'busy', model: 'opus', permissionMode: 'bypassPermissions', sandbox: 'sb1' });
  busy.info.status = 'running';
  const next = machines.createSession('beast', { kind: 'worker', title: 'next', model: 'opus', permissionMode: 'bypassPermissions', sandbox: 'sb1' });
  assert.equal(machines.placeFull(next), undefined, '1 of 2');
  const duty = machines.createSession('beast', { kind: 'standing', title: 'duty', model: 'opus', permissionMode: 'bypassPermissions' });
  duty.info.status = 'running';
  assert.match(machines.placeFull(next)!, /2 agents mid-turn on beast, in sandboxes and standing agents together \(its agent cap 2\)/);
  assert.match(agents.standing.runNow(nightly.id), /^Queued for an agent slot \(2\/2 in use\)/);
  duty.info.status = 'idle';
  assert.equal(machines.placeFull(next), undefined, 'an idle agent takes no slot');
});

test("w464 change 6, w1078: claudeAccounts.dispatcher pins the dispatcher to one vault token, else it runs on the system payer's pool; people's orchestrators keep their own", (t) => {
  const { cfg, agents, dispatcher, chat } = setup(t);
  useFakeVault({ vault: { claudeByName: (name: string) => (name === 'vault-pin-1' ? { entry: { name, last4: 'pppp' }, token: fakeToken('pinned') } : undefined) } as never });
  const tokenOf = (info: SessionInfo) => (agents.orchestratorOptions(info) as { env: Record<string, string | undefined> }).env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.equal(tokenOf(dispatcher().info), fakeToken('ben'), "unset: the system payer's (Ben, the owner) pool");
  cfg.claudeAccounts = { dispatcher: 'vault:vault-pin-1' };
  assert.equal(tokenOf(dispatcher().info), fakeToken('pinned'), 'pinned: that one vault token, whoever the system payer is');
  assert.equal(tokenOf(chat(BEN).info), fakeToken('ben'), "Ben's own orchestrator still runs on his pool");
  cfg.claudeAccounts = { dispatcher: 'vault:gone' };
  assert.throws(() => tokenOf(dispatcher().info), /pinned to vault token gone/, 'a pin the vault cannot give: the dispatcher does not start, on no other credential');
});

// ---------------------------------------------------------------- w467: no secrets for orchestrators

test("w467: an orchestrator's hooks refuse config.json, data/ and ~/.ssh, and let its own memory and other folders through", async (t) => {
  const { cfg, agents, chat } = setup(t);
  const info = chat(BEN).info;
  const hooks = agents.orchestratorOptions(info).hooks!.PreToolUse![0].hooks;
  const run = async (tool: string, input: Record<string, unknown>) => {
    for (const h of hooks) {
      const r = (await h({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (r.hookSpecificOutput?.permissionDecision === 'deny') return 'deny';
    }
    return 'pass';
  };
  assert.equal(await run('Read', { file_path: configPath() }), 'deny');
  assert.equal(await run('Read', { file_path: path.join(cfg.dataDir, 'users.json') }), 'deny');
  assert.equal(await run('Read', { file_path: path.join(os.homedir(), '.ssh', 'id_ed25519') }), 'deny');
  assert.equal(await run('Grep', { pattern: 'sk-ant', path: cfg.dataDir }), 'deny');
  const memory = memoryDirFor(cfg, info);
  assert.equal(await run('Read', { file_path: path.join(memory, 'MEMORY.md') }), 'pass', 'its own memory folder');
  assert.equal(await run('Read', { file_path: path.join(cfg.dataDir, 'attachments', 'att_1-Player.log') }), 'pass', 'files people attached');
  assert.equal(await run('Read', { file_path: path.join(os.tmpdir(), 'some-repo', 'README.md') }), 'pass');
});

test("w650: Lothsahn's and Ben's orchestrators read data/'s reports and ledger, never its secrets or a write; the dispatcher and other people's keep w467's rules", async (t) => {
  const { cfg, agents, chat, dispatcher } = setup(t, { people: WITH_CARA });
  const hooksOf = (info: SessionInfo) => agents.orchestratorOptions(info).hooks!.PreToolUse![0].hooks;
  const run = async (info: SessionInfo, tool: string, input: Record<string, unknown>) => {
    for (const h of hooksOf(info)) {
      const r = (await h({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
      if (r.hookSpecificOutput?.permissionDecision === 'deny') return 'deny';
    }
    return 'pass';
  };
  const data = (...p: string[]) => path.join(cfg.dataDir, ...p);
  for (const who of [BEN, LOTH]) {
    const info = chat(who).info;
    for (const p of [data('w643-migration.md'), data('work.json'), data('ledger.json'), data('transcripts', 'x.jsonl'), data('orchestrator-memory', 'dispatcher', 'MEMORY.md')]) assert.equal(await run(info, 'Read', { file_path: p }), 'pass', `${who.userId}: ${p}`);
    assert.equal(await run(info, 'Glob', { pattern: '*.md', path: cfg.dataDir }), 'pass', 'names only');
    for (const p of [data('users.json'), data('auth-sessions.json'), data('api-keys.json'), data('machine-tokens.json'), data('vault.json'), data('vapid.json'), data('state.json'), data('send-queue.json')]) assert.equal(await run(info, 'Read', { file_path: p }), 'deny', `${who.userId}: ${p}`);
    assert.equal(await run(info, 'Grep', { pattern: 'token', path: cfg.dataDir }), 'deny');
    for (const [tool, input] of [['Write', { file_path: data('w643-migration.md'), content: 'x' }], ['Edit', { file_path: data('work.json'), old_string: 'a', new_string: 'b' }], ['Write', { file_path: data('orchestrator-memory', 'dispatcher', 'MEMORY.md'), content: 'x' }]] as const) {
      assert.equal(await run(info, tool, input), 'deny', `${who.userId}: ${tool} ${input.file_path}`);
    }
    const o = agents.orchestratorOptions(info) as { tools: string[]; systemPrompt: { append: string } };
    assert.deepEqual(o.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ToolSearch'], 'no shell: no Bash path to data/');
    assert.ok(o.systemPrompt.append.includes("## The portal's data folder"), 'the brief says what it may read');
  }
  for (const info of [dispatcher().info, chat(CARA).info]) {
    assert.equal(await run(info, 'Read', { file_path: data('w643-migration.md') }), 'deny');
    assert.equal(await run(info, 'Glob', { pattern: '*.md', path: cfg.dataDir }), 'deny');
    assert.ok(!(agents.orchestratorOptions(info) as { systemPrompt: { append: string } }).systemPrompt.append.includes("## The portal's data folder"));
  }
});

// ---------------------------------------------------------------- w496: every dispatched worker's first message is its brief

test('w496: a worker started for a request gets the request as filed, its notes and the PR line in its first message, at once or queued at the cap', async (t) => {
  shortSlowTurns(t);
  const { store, sessions, agents, dispatcher, chat, call } = await setupOnMachine(t, {}, { maxAgentsPerSandbox: 1 });
  const ben = chat(BEN);
  ben.lastFrom = 'human';
  await call(ben.info, 'request_work', { title: 'Ghosts fly over the station', brief: 'Remote players float 2 m above the deck after a resync. Reproduce with the attached save.', constraints: 'No save-layout change.', related_ids: ['w445'] });
  await call(ben.info, 'update_work', { id: 'w1', note: 'It also happens after a host migration, not only a resync: check both.' });
  const first = (id: string) => store.readTranscript(id).find((e) => e.kind === 'user') as { text: string } | undefined;
  const checkBrief = (text: string) => {
    assert.match(text, /^Fix the ghosts \(the dispatcher's brief\)/, 'the dispatcher’s brief first');
    assert.match(text, /The request as filed \(w1, added by the harness/);
    assert.match(text, /Title: Ghosts fly over the station/);
    assert.match(text, /Remote players float 2 m above the deck after a resync/);
    assert.match(text, /Constraints: No save-layout change\./);
    assert.match(text, /Related: w445/);
    assert.match(text, /Notes since it was filed \(1\):\n- .* UTC, Ben: It also happens after a host migration, not only a resync: check both\./);
    assert.match(text, /put a line `Request: w1` in its description/);
  };
  // The normal path: the brief is the first message.
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: "Fix the ghosts (the dispatcher's brief).", title: 'Ghosts', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const a = /Started agent (\w+)/.exec(started.text)![1];
  await until('the brief went', () => !!first(a));
  checkBrief(first(a)!.text);

  // Queued at the cap (w384): the first message waits, and is still the brief when it goes, before a later nudge.
  await call(ben.info, 'request_work', { title: 'Lag lead on the client', brief: 'The client leads the host by 3 heartbeats.' });
  await until('a idle', () => sessions.get(a).info.status === 'idle');
  sessions.send(a, '#slow keep busy', 'orchestrator');
  await until('a mid-turn', () => sessions.get(a).info.status === 'running');
  // w1089: the dispatcher's start_agent no longer queues a worker behind a full sandbox: it is refused, saying what is there.
  const refused = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Find the lag lead.', title: 'Lag lead', work_id: 'w2', override_duplicate: 'another request', extra_agent: true });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /sandbox pc\/alpha is full: .*"w1: Ghosts" \(Working\); 1 agents mid-turn there \(max_agents_per_sandbox 1\), so a worker started there would only wait in the send queue/);
  // The send queue still holds a brief at the cap for the ways that reach it (a start from /mcp, a session resumed): the brief goes first.
  const b = agents.startWorker({ sandbox: 'pc/alpha', prompt: 'Find the lag lead.\n\nThe request as filed (w2): The client leads the host by 3 heartbeats.', title: 'Lag lead', from: 'orchestrator' }).info.id;
  assert.match((agents as unknown as { queuedLine(id: string): string }).queuedLine(b), /Queued, not refused: 1 agents mid-turn in sandbox pc\/alpha \(max_agents_per_sandbox 1\)/);
  assert.equal(first(b), undefined, 'nothing delivered yet');
  sessions.send(b, 'Start your brief now.', 'orchestrator');
  await until('the brief went', () => !!first(b), 20_000);
  assert.match(first(b)!.text, /^Find the lag lead\.[\s\S]*The request as filed \(w2[\s\S]*The client leads the host by 3 heartbeats/);
  await until('the nudge went after it', () => store.readTranscript(b).filter((e) => e.kind === 'user').length === 2, 20_000);
  assert.match((store.readTranscript(b).filter((e) => e.kind === 'user')[1] as { text: string }).text, /Start your brief now/);
  await until('the workers answered', () => [...sessions.sessions.values()].filter((s) => s.info.kind === 'worker').every((s) => s.info.status === 'idle'), 20_000);
});

test('w496: the request as filed: whole notes from WorkItem.notes, older ones from the log; an intake request gets only its notes', () => {
  const base = { id: 'w9', title: 'T', brief: 'B', requesters: [BEN], log: [] as string[] };
  assert.match(requestAsFiled({ ...base, notes: [{ at: '2026-10-06T02:30:00.000Z', by: 'Ben', text: 'x'.repeat(1500) }] }), new RegExp(`2026-10-06 02:30 UTC, Ben: ${'x'.repeat(1500)}$`));
  assert.match(requestAsFiled({ ...base, log: ['01:02 filed by Ben', '01:05 Ben: priority normal → high; note: use the m5 save'] }), /- 01:05, Ben: use the m5 save$/);
  assert.equal(requestAsFiled({ ...base, source: { kind: 'discord-bug' } as never }), '', 'an intake request without notes: its text is in workerRules');
  assert.match(requestAsFiled({ ...base, source: { kind: 'discord-bug' } as never, notes: [{ at: '2026-10-06T02:30:00.000Z', by: 'Lothsahn', text: 'Yes, alternate evenly.' }] }), /Notes since it was filed \(1\):\n- .*Lothsahn: Yes, alternate evenly\.$/);
});

test('w1482: the request as filed goes only with a brief that does not already quote it', () => {
  const brief = 'Turn the PowerShell tool off for workers on non-Windows machines.\n\nDone when:\n- The worker session builder omits PowerShell only on non-Windows machines, with a unit test pinning both branches.\n- PR merged on green CI.';
  const w = { id: 'w9', title: 'PowerShell off off Windows', brief, constraints: 'Do not deploy the portal.', relatedIds: ['w1479'], requesters: [BEN], log: [] as string[] };
  // A dispatcher that summarises: the filed text goes too, whole.
  const summary = requestAsFiled(w, 'Build decision 1 of the audit for the Macs and Linux hosts. Done when it merges.');
  assert.match(summary, /The request as filed \(w9[\s\S]*Title: PowerShell off off Windows[\s\S]*with a unit test pinning both branches[\s\S]*Constraints: Do not deploy the portal\.[\s\S]*Related: w1479/);
  // A dispatcher that quotes it (Markdown, quote marks and line breaks aside) and names its constraints and related ids: nothing to add.
  const quoted = `Brief:\n> Turn the "PowerShell" tool off for workers on non-Windows machines.\n> Done when: - The worker session builder omits PowerShell only on non-Windows machines, with a unit test pinning both branches.\n> - PR merged on **green** CI.\nConstraints: do not deploy the portal. Related: w1479.`;
  assert.equal(requestAsFiled(w, quoted), '');
  // Quoted, but a note came since: only the note.
  const noted = requestAsFiled({ ...w, notes: [{ at: '2026-10-18T21:00:00.000Z', by: 'Ben', text: 'Also Linux.' }] }, quoted);
  assert.ok(!/Title:/.test(noted) && /Notes since it was filed \(1\):\n- .*Ben: Also Linux\.$/.test(noted), noted);
  // Quoted, but the constraints left out: they go alone.
  const noConstraints = requestAsFiled(w, quoted.replace(/Constraints:.*/, 'Related: w1479.'));
  assert.ok(!/Title:/.test(noConstraints) && /Constraints: Do not deploy the portal\./.test(noConstraints), noConstraints);
  // Half a quote is not a quote.
  assert.match(requestAsFiled(w, 'Turn the PowerShell tool off for workers on non-Windows machines.'), /Title: PowerShell off off Windows/);
});

// ---------------------------------------------------------------- w527: standing agents' delegations are ledger requests

test("w527: a standing agent's delegation flows into the ledger and onto a worker with no clicks; queued, it waits for capacity", async (t) => {
  const { store, agents, o, dispatcher, chat, call, heard } = await setupOnMachine(t);
  const st = agents.standing;
  const sentry = st.create({ name: 'Nightly sentry', charter: 'Watch develop.', trigger: { kind: 'manual' }, tools: ['delegate'], autoApprove: { enabled: true }, owner: BEN, machineId: 'pc' });
  const title = 'Verify suspected regressions from PRs #1105, #1024, #1065';
  const task = 'Run MP-belt-items-after-load-join on develop. If it fails, bisect PR 1105, PR 1024 and PR 1065, fix with a test guard, and open a PR into develop.';

  // Filed at once, for the agent's owner, its task verbatim: no Approve click, no sandbox picked here.
  const d = st.requestDelegation(sentry.id, title, task);
  assert.deepEqual([d.status, d.autoApproved, d.workId], ['approved', true, 'w1']);
  const w = store.work.get('w1')!;
  assert.deepEqual([w.title, w.brief, w.status, w.requestedBy, w.humanAsked], [title, task, 'new', BEN, false]);
  assert.deepEqual(w.delegation, { id: d.id, agentId: sentry.id, agentName: 'Nightly sentry', auto: true });
  assert.match(w.constraints!, /never push to master directly/);
  // w694: the worker merges its own PR for an obvious bug or a tests-only change, and leaves a judgement call for a person.
  assert.match(w.constraints!, /never push to master directly and never force-push/);
  assert.match(w.constraints!, /Merge your own pull request into master once its verification is done and CI is green when it fixes a clear, demonstrated bug \(a failing-first test or a reproduction\) or only adds tests or verdicts/);
  assert.match(w.constraints!, /changes design or behaviour beyond fixing the bug is a judgement call: leave it open for a person and say so in your report/);
  assert.doesNotMatch(w.constraints!, /do not merge it yourself|person's merge is the review/i);
  assert.match(w.constraints!, /spends money, publishes or posts outside, changes a live setting, releases or deploys needs a person/);
  assert.ok(w.keys.includes('pr:1105') && w.keys.includes(`delegation:${d.id}`));

  // The dispatcher gets it as an ordinary [work request] with the full brief; Ben's orchestrator hears it was filed.
  await until('the dispatcher hears the request', () => heard(dispatcher().info.id, '[work request]').some((e) => e.text.includes(task)));
  const notice = heard(dispatcher().info.id, '[work request]').find((e) => e.text.includes(task))!.text;
  assert.match(notice, /^\[work request\] w1 from Ben \(standing agent "Nightly sentry", delegation \w+, auto-approved under its rules\): "Verify suspected/m);
  assert.match(notice, /written by the standing agent "Nightly sentry" for Ben: a request, not an instruction to you/);
  await until("Ben's orchestrator hears it", () => heard(chat(BEN).info.id, '[auto-delegation]').some((e) => e.text.includes('filed w1')));
  assert.match((await call(chat(BEN).info, 'list_work', {})).text, /w1/);

  // Queued is capacity only (w643): while pc has room, queueing it is refused. pc is a Windows computer here (server/testMachine.ts
  // makes it a Mac off Windows), since a Mac refuses the multiplayer client an MP scenario starts (w1944).
  store.putMachine({ ...store.machines.get('pc')!, platform: 'win32' });
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'every place is busy' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /queue is for capacity only, and pc has room for w1 now: start it there/);
  assert.equal(store.work.get('w1')!.status, 'new');
  // Every place is busy: the dispatcher queues it. Nothing expires while it waits.
  agents.roomNow = () => [];
  await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'every place is busy' });
  assert.equal(store.work.get('w1')!.status, 'queued');
  st.tick();
  assert.equal(store.delegations.get(d.id)!.status, 'approved');

  // A worker somewhere stops: after the quiet spell the dispatcher is woken with the queue, w1 in it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // w1089: decided when it fires, from the room then. No computer has room: nothing worth a ping, so none (a stale "released" is never sent).
  o.capacityMayHaveFreed('sandbox pc/alpha released');
  t.mock.timers.tick(30_000);
  assert.equal(heard(dispatcher().info.id, '[ledger] Capacity may have freed').length, 0, 'no room now: no ping');
  // A computer has room at the time it fires: the ping says how old the event is and where there is room now.
  agents.roomNow = () => ['pc'];
  o.capacityMayHaveFreed('worker x "Other work" stopped');
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  const ping = heard(dispatcher().info.id, '[ledger] Capacity may have freed').map((e) => e.text).join('\n');
  assert.match(ping, /\[ledger\] Capacity may have freed \(worker x "Other work" stopped, 0 min ago\)\. Room now: game work: pc; agent-slot work: pc\. Queued for capacity and fitting it, by priority, then started work that runs only on the computers it names, then oldest: w1 "Verify suspected/);

  // It starts it in a machine's sandbox: the request is active, and the agent sees how it is doing.
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: task, title: 'Regression check', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  assert.equal(store.work.get('w1')!.status, 'active');
  // The worker's brief carries the request as filed: the agent's words for Ben, and the merge rule (w694: its own PR for an obvious bug, a person's for a judgement call).
  const workerId = /Started agent (\w+)/.exec(started.text)![1];
  assert.deepEqual(store.sessions.get(workerId)!.requestedBy, BEN);
  const first = () => store.readTranscript(workerId).find((e): e is Extract<TranscriptEvent, { kind: 'user' }> => e.kind === 'user');
  await until("the worker's brief went", () => !!first());
  const brief = first()!.text;
  assert.match(brief, /this is what the standing agent "Nightly sentry" asked, filed for Ben\):/);
  assert.match(brief, /Merge your own pull request into master once its verification is done and CI is green when it fixes a clear, demonstrated bug/);
  assert.match(brief, /judgement call: leave it open for a person/);
  assert.doesNotMatch(brief, /do not merge it yourself|a person's merge is the review/);
  const mine = await st.handlers(sentry.id).my_delegations!({});
  assert.ok(mine.startsWith(`- ${d.id} "Verify suspected`), mine);
  assert.match(mine, /" approved, asked [^\n]*\n {2}w1 \[active\]; last outcome/);

  // De-dup: the sentry asks again the next night; it is the same request, not a second one.
  const again = st.requestDelegation(sentry.id, title, `${task} (again)`);
  assert.deepEqual([again.workId, again.repeat], ['w1', true]);
  assert.equal([...store.work.values()].filter((x) => x.delegation).length, 1);
  assert.match(store.work.get('w1')!.log.at(-1)!, /"Nightly sentry" asked for it again \(delegation \w+\); not filed twice/);
});

test('w527: Approve, the orchestrator in its person\'s own words, and Start now: queued without a free slot, bumped to the front', async (t) => {
  const { store, agents, dispatcher, chat, call, heard } = await setupOnMachine(t);
  const st = agents.standing;
  const a = st.create({ name: 'PR reviewer', charter: 'Review PRs.', trigger: { kind: 'manual' }, tools: ['delegate'], owner: LOTH, machineId: 'pc' });
  const d = st.requestDelegation(a.id, 'Fix the doc links', 'Fix the broken links in docs/.');
  assert.equal(d.status, 'pending', 'no auto-approve: it waits');
  assert.equal(store.work.size, 0);

  // Ben's orchestrator, in a turn Ben did not start: refused. In Ben's own turn: filed for Lothsahn, the agent's owner.
  const ben = chat(BEN);
  ben.lastFrom = 'system';
  assert.match((await call(ben.info, 'approve_delegation', { id: d.id, user_asked: true })).text, /only Ben, in their own words, approves a delegation/);
  // w5507: Ben's turn that a relayed report joined, asking for the approval: refused without his own words.
  (ben as unknown as { relayedInTurn: boolean; turnStarter?: unknown }).turnStarter = { uuid: 'u-ben', from: 'human' };
  (ben as unknown as { relayedInTurn: boolean }).relayedInTurn = true;
  assert.match((await call(ben.info, 'approve_delegation', { id: d.id, user_asked: true, words: 'approve the doc links delegation' })).text, /only Ben, in their own words, approves a delegation/);
  (ben as unknown as { turnStarter?: unknown }).turnStarter = undefined;
  ben.lastFrom = 'human';
  const ok = await call(ben.info, 'approve_delegation', { id: d.id, user_asked: true });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /Approved by Ben: filed as w1 for Lothsahn/);
  const w = store.work.get('w1')!;
  assert.deepEqual([w.requestedBy, w.requesters, w.delegation?.auto, w.delegation?.approvedBy], [LOTH, [LOTH, BEN], false, BEN]);
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[work request]').some((e) => e.text.includes('approved by Ben')));

  // Start now (the dashboard): urgent, and the dispatcher is told to start it ahead of the queue.
  await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'queue', note: 'later' });
  st.bumpDelegation(d.id, LOTH);
  assert.equal(store.work.get('w1')!.priority, 'urgent');
  await until('the dispatcher hears Start now', () => heard(dispatcher().info.id, '[work update]').some((e) => e.text.includes('Lothsahn pressed "Start now"')));
});

test('w575: a worker is titled for each request it is handed (start, link) and keeps the title across a restart', async (t) => {
  const { dir, store, sessions, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Install LothDesktop from scratch', brief: 'Wipe and reinstall the worker root.' });
  await call(ben, 'request_work', { title: 'Fix the dashboard labels', brief: 'Titles follow the job.', related_ids: ['w1'] });
  // The dispatcher always names the job: no title, no start.
  const untitled = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Reinstall', work_id: 'w1' });
  assert.equal(untitled.isError, true);
  assert.match(untitled.text, /title: what the job is/);
  const tooLong = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Reinstall', work_id: 'w1', title: 'x'.repeat(90) });
  assert.match(tooLong.text, /keep "w1: <description>" to 80/);
  // A description that already starts with an id gets it once.
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Reinstall', work_id: 'w1', title: 'w1: LothDesktop fresh install, slot1..6' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  assert.equal(sessions.get(id).info.title, 'w1: LothDesktop fresh install, slot1..6');

  // decide_work link names the job for the workers it links.
  assert.match((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'link', note: 'Already on it.', session_ids: [id] })).text, /title: what the job is/);
  assert.equal(sessions.get(id).info.title, 'w1: LothDesktop fresh install, slot1..6', 'a refused link renames nothing');
  const linked = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'link', note: 'Already on it.', session_ids: [id], title: 'dashboard titles and fixed labels' });
  assert.equal(linked.isError, false, linked.text);
  assert.equal(sessions.get(id).info.title, 'w2: dashboard titles and fixed labels');

  // Kept on disk: a restarted portal reads the same title.
  store.flush();
  assert.equal(new Store(dir).sessions.get(id)?.title, 'w2: dashboard titles and fixed labels');
});

test('w575: a sandbox label is its name and never changes: no set_label for workers, no set_sandbox_label, old labels give way', async (t) => {
  const { cfg, store, sessions, agents, machines, dispatcher, call } = await setupOnMachine(t);
  const m = store.machines.get('pc')!;
  const sb = m.sandboxes!.find((s) => s.id === 'alpha')!;
  assert.equal(sb.purpose, 'alpha');
  assert.equal(agents.orchestratorBelt(dispatcher().info).some((x) => x.name === 'set_sandbox_label'), false, 'the dispatcher cannot relabel a sandbox');
  const create = agents.orchestratorBelt(dispatcher().info).find((x) => x.name === 'create_sandbox')!;
  assert.equal('purpose' in (create.schema as Record<string, unknown>), false, 'create_sandbox takes no label');

  // A worker's tools: no set_label; one started before w575 that still calls it changes nothing.
  const w = agents.startWorker({ sandbox: 'pc/alpha', prompt: 'Look around', title: 'Look', from: 'human' });
  const spec = machines.hooks!.specFor(w.info, m);
  assert.equal(spec.mcp?.tools.some((x) => x.name === 'set_label'), false);
  assert.doesNotMatch(spec.append, /set_label|set it to `unused`/);
  const said = await machines.hooks!.handlersFor(w.info, m).set_label!({ purpose: 'w554: waiting on Ben' });
  assert.match(String(said), /never changes/);
  assert.equal(store.machines.get('pc')!.sandboxes!.find((s) => s.id === 'alpha')!.purpose, 'alpha');

  // A label stored before w575 gives way to the name when the portal starts.
  const old = store.machines.get('pc')!;
  old.sandboxes = old.sandboxes!.map((s) => ({ ...s, purpose: 'w554: waiting on Ben' }));
  store.putMachine(old);
  new MachineManager(cfg, store, sessions);
  assert.equal(store.machines.get('pc')!.sandboxes!.find((s) => s.id === 'alpha')!.purpose, 'alpha');
  // list_sandboxes shows no label: what a sandbox does is its agents' titles under it.
  const listed = (await call(dispatcher().info, 'list_sandboxes', {})).text;
  assert.match(listed, /- pc\/alpha( FREE)?: ready;/);
  assert.doesNotMatch(listed, /w554/);
});

test("w1163: a worker gets the manifest's machine tools, each deferred with its group as ToolSearch hint, and its brief says how to load a group", async (t) => {
  const { store, machines, dispatcher, chat, call } = await setupOnMachine(t);
  await call(chat(BEN).info, 'request_work', { title: 'Look', brief: 'Look around.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Look around', title: 'Look', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const spec = machines.hooks!.specFor(store.sessions.get(id)!, store.machines.get('pc')!);
  assert.deepEqual(spec.mcp!.tools.map((x) => x.name), toolsOf('worker'));
  for (const x of spec.mcp!.tools) {
    assert.equal(x.alwaysLoad, undefined, `${x.name}: deferred (measured: always-loading it costs workers more than its lookups, docs/tool-manifest.md)`);
    assert.equal(x.searchHint, `group_${(TOOL_MANIFEST as Record<string, { group: string }>)[x.name].group}`, x.name);
  }
  assert.ok(spec.append.includes(deferredToolsLine('worker', 'Your FF Factory tools (mcp__machine__*) are')));
  // The daemon's SDK server carries both to Claude Code (_meta), as the coordinators' do.
  const server = buildOptions(spec, {}).mcpServers!.machine as unknown as { instance: { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> } };
  assert.equal(server.instance._registeredTools.blocked_on._meta?.['anthropic/searchHint'], 'group_timers');
  assert.equal(server.instance._registeredTools.blocked_on._meta?.['anthropic/alwaysLoad'], undefined);
});

test('w920: a worker has portal_logs on the machine tool belt and in its brief, and it reads the portal list and a clean-up log without writing', async (t) => {
  const { store, machines, dispatcher, chat, call, cfg } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Check the portal logs', brief: 'Read them.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Check the portal logs', title: 'Portal logs', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const m = store.machines.get('pc')!;
  const info = store.sessions.get(id)!;
  const spec = machines.hooks!.specFor(info, m);
  const tool = spec.mcp?.tools.find((x) => x.name === 'portal_logs');
  assert.ok(tool, 'a worker has portal_logs');
  assert.match(tool.description, /read-only/);
  assert.match(tool.description, /never state\.json, the vault, logins, sessions, keys/);
  assert.match(spec.append, /mcp__machine__portal_logs/);
  assert.match(spec.append, /Check what FF Factory itself did \(a deploy, a clean-up, a restart, a tool that behaved oddly\) with `mcp__machine__portal_logs` before you infer it/);
  const h = machines.hooks!.handlersFor(info, m);
  assert.equal(typeof h.portal_logs, 'function');

  const dir = path.join(cfg.dataDir, 'cleanup', 'pc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cleanup-log.jsonl'), JSON.stringify({ at: '2026-10-10T09:00:00Z', trigger: 'hourly', removed: 1, softFreeGB: 20, top: [{ path: '/work/ffa-x', bytes: 2 * 1024 ** 3, rule: 'agent-temp', why: 'session ended' }] }) + '\n');
  fs.writeFileSync(path.join(cfg.dataDir, 'state.json'), '{"secret":"not for workers"}');
  // The store's own background save (start_agent's) may still be in flight as a `.async.tmp` (server/durable.ts): that is
  // not the read writing. Since w5072 the list of sources runs a journal check, long enough to catch one mid-write.
  const listing = () => fs.readdirSync(cfg.dataDir).filter((f) => !f.endsWith('.async.tmp')).sort();
  // w5626: Ben's own orchestrator is still in the turn request_work started; its first model call saves its context meter
  // to <dataDir>/meters (server/meterStates.ts, from sessions.ts saveMeter), about 100 ms in. That is not the read
  // writing: let every portal session's turn end first, or `meters` lands between the two listings on a slow runner. The
  // saves that turn queued (work.json and its rotated copies, server/durable.ts) land before the first listing too.
  await firstTurn(ben, 'Ben’s orchestrator’s turn to end');
  await until('no portal session mid-turn', () => [...store.sessions.values()].every((s) => s.status !== 'running'));
  await store.saved();
  const before = listing();

  assert.match(await h.portal_logs!({}), /- cleanup: .*\n[\s\S]*Clean-up logs kept for: pc/);
  const out = await h.portal_logs!({ source: 'cleanup', machine: 'pc' });
  assert.match(out, /\[2026-10-10T09:00:00Z\] removed: \/work\/ffa-x {2}2\.0 GB {2}\(session ended\)/);
  await assert.rejects(h.portal_logs!({ source: 'state.json' }), /is not one portal_logs reads/);
  assert.deepEqual(listing(), before, 'reading wrote nothing');
  // Through the wire the daemon uses: a call by name that is not a tool is not available to the session.
  assert.equal('write_portal_logs' in h, false);
});

test('w642: a worker reads its own request and the ones it names, is refused others until its person grants ledger reading, and writes nothing', async (t) => {
  const { store, machines, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  const loth = chat(LOTH).info;
  await call(loth, 'request_work', { title: 'Lothsahn belt work', brief: 'Belts.' });
  await call(ben, 'request_work', { title: 'Something unrelated', brief: 'Other.' });
  await call(ben, 'request_work', { title: 'List the finished requests', brief: 'Go through the ledger; w1 is one to check.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'List the finished requests', title: 'Finished requests', work_id: 'w3' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const m = store.machines.get('pc')!;
  const info = store.sessions.get(id)!;
  const spec = machines.hooks!.specFor(info, m);
  assert.ok(spec.mcp?.tools.some((x) => x.name === 'read_work'), 'a worker has read_work');
  assert.match(spec.append, /mcp__machine__read_work/);
  const h = machines.hooks!.handlersFor(info, m);
  for (const x of ['update_work', 'request_work', 'decide_work', 'start_agent', 'list_work']) assert.equal(x in h, false, `a worker has no ${x}`);
  const read = (a: Record<string, unknown>) => h.read_work!(a);

  // Its own request, and the one it names (Lothsahn's), with no grant.
  assert.match(await read({}), /Yours: w3\. They name: w1\./);
  assert.match(await read({ id: 'w3' }), /w3 \[active\][^\n]*: "List the finished requests"[\s\S]*Brief:\n~~~text\nGo through the ledger; w1 is one to check\.\n~~~/);
  assert.match(await read({ id: 'w1' }), /"Lothsahn belt work"\nFor Lothsahn/);
  // Refused: an unrelated request, and the ledger list.
  await assert.rejects(read({ id: 'w2' }), /w2 is outside what you may read/);
  await assert.rejects(read({ all: true }), /needs a ledger-read grant/);

  // Only the request's own person grants it; Lothsahn cannot, and an intake request never gets it.
  const refused = await call(loth, 'update_work', { id: 'w3', ledger_read: true });
  assert.match(refused.text, /^ERROR: w3 is not Lothsahn's request/);
  const granted = await call(ben, 'update_work', { id: 'w3', ledger_read: true });
  assert.equal(granted.isError, false, granted.text);
  assert.match(granted.text, /w3: its workers may now list and read every open and stalled request/);
  assert.equal(store.work.get('w3')!.ledgerRead?.by, 'Ben');
  assert.match(store.work.get('w3')!.log.at(-1)!, /Ben: its workers may read the ledger/);
  assert.match((await call(ben, 'list_work', { id: 'w3' })).text, /Its workers may read the ledger \(read_work all; granted by Ben\)/);

  // Granted: the filtered list, and an unrelated open request by id. Reading writes nothing.
  const before = structuredClone([...store.work.values()]);
  const all = await read({ all: true });
  assert.match(all, /The ledger's open and stalled requests \(granted by w3\)\./);
  for (const w of ['w1', 'w2', 'w3']) assert.match(all, new RegExp(`- ${w} \\[`));
  assert.match(await read({ all: true, person: 'lothsahn' }), /- w1 \[[\s\S]*Shown 1-1 of 1\./);
  assert.match(await read({ id: 'w2', close: 'done', note: 'closing it' }), /"Something unrelated"/);
  assert.deepEqual([...store.work.values()], before, 'read_work changed nothing');
  assert.equal(store.work.get('w2')!.status, 'new');

  // Taken back: refused again. Filed with the grant, a request has it from the start.
  assert.equal((await call(ben, 'update_work', { id: 'w3', ledger_read: false })).isError, false);
  await assert.rejects(read({ id: 'w2' }), /outside what you may read/);
  await call(ben, 'request_work', { title: 'Audit the stalled requests', brief: 'Which can close?', ledger_read: true });
  assert.equal(store.work.get('w4')!.ledgerRead?.by, 'Ben');
  const intake = { ...store.work.get('w2')!, id: 'w9', source: { kind: 'discord-bug', untrusted: true, channel: '#bugs' } } as WorkItem;
  store.putWork(intake);
  assert.match((await call(ben, 'update_work', { id: 'w9', ledger_read: true })).text, /^ERROR: w9 came from the intake/);
});

test('w2653: a worker exports the spend record only once its person grants it, and an intake request never gets the grant', async (t) => {
  const { store, machines, agents, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  const loth = chat(LOTH).info;
  agents.spend = new SpendStore(fs.mkdtempSync(path.join(os.tmpdir(), 'spend-grant-')), { work: () => store.work.values(), session: (id) => store.sessions.get(id), priorResults: () => 1 });
  await call(ben, 'request_work', { title: 'What a finished request costs', brief: 'From the spend record.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Cost per request', title: 'Spend', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  const m = store.machines.get('pc')!;
  assert.ok(machines.hooks!.specFor(info, m).mcp?.tools.some((x) => x.name === 'spend_export'), 'a worker has spend_export');
  const h = machines.hooks!.handlersFor(info, m);
  await assert.rejects(h.spend_export!({}), /spend_export needs a spend-read grant on one of your open requests \(w1\)/);
  assert.match((await call(loth, 'update_work', { id: 'w1', spend_read: true })).text, /^ERROR: w1 is not Lothsahn's request/);
  const granted = await call(ben, 'update_work', { id: 'w1', spend_read: true });
  assert.match(granted.text, /w1: its workers may now export the spend record/);
  assert.equal(store.work.get('w1')!.spendRead?.by, 'Ben');
  assert.match((await call(ben, 'list_work', { id: 'w1' })).text, /Its workers may export the spend record \(spend_export; granted by Ben\)/);
  assert.match(await h.spend_export!({ view: 'summary', since: '2026-10-01' }), /^# spend_export view=summary since=2026-10-01T00:00:00\.000Z/);
  assert.equal((await call(ben, 'update_work', { id: 'w1', spend_read: false })).isError, false);
  await assert.rejects(h.spend_export!({}), /needs a spend-read grant/);
  await call(ben, 'request_work', { title: 'Spend by model', brief: 'Tokens per session.', spend_read: true });
  assert.equal(store.work.get('w2')!.spendRead?.by, 'Ben');
  const intake = { ...store.work.get('w2')!, id: 'w9', spendRead: undefined, source: { kind: 'discord-bug', untrusted: true, channel: '#bugs' } } as WorkItem;
  store.putWork(intake);
  assert.match((await call(ben, 'update_work', { id: 'w9', spend_read: true })).text, /^ERROR: w9 came from the intake/);
});

test('w4528: every worker reads every transcript with no grant, read-only, secrets masked; a worker on a request quoting players\' text never does', async (t) => {
  const { store, machines, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN).info;
  const loth = chat(LOTH).info;
  const token = `github_pat_${'q'.repeat(60)}`;
  // Two other agents' transcripts: Ben's and Lothsahn's orchestrators, neither the worker's own.
  store.append(ben.id, { kind: 'assistant', text: 'InputValidationError on wake_me: minutes missing' });
  store.append(loth.id, { kind: 'tool_result', toolUseId: 'x1', isError: true, text: `InputValidationError in unity: action required ${token}` });
  await call(ben, 'request_work', { title: 'Tool-call failures of the last 8 hours', brief: 'Count them by cause.' });
  assert.equal(Object.keys(store.work.get('w1')!).includes('transcriptRead'), false, 'an ordinary request carries no grant');
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Audit the failures', title: 'Failures', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  const m = store.machines.get('pc')!;
  const tools = machines.hooks!.specFor(info, m).mcp?.tools.map((x) => x.name) ?? [];
  assert.ok(tools.includes('search_transcripts') && tools.includes('agent_transcript'), 'a worker has both tools, deferred');
  const brief = machines.hooks!.specFor(info, m).append ?? '';
  assert.match(brief, /Transcripts are yours to read, no grant needed/, 'its brief says it may read them');
  assert.doesNotMatch(brief, /transcript-read grant|transcript_read/, 'no word of a grant left in its brief');
  const h = machines.hooks!.handlersFor(info, m);
  const since = new Date(Date.now() - 8 * 3600_000).toISOString();
  // Every agent, in a time window, with no grant; read-only (the ledger and the transcripts are unchanged), secrets masked.
  // The fake worker's own echo turn lands its report first: that is its own, not these reads.
  await until('the worker reported', () => !!store.work.get('w1')!.outcome);
  const before = structuredClone([...store.work.values()]);
  const lothBefore = store.readTranscript(loth.id, 400).length;
  const hits = await h.search_transcripts!({ query: 'InputValidationError', since, until: new Date(Date.now() + 60_000).toISOString() });
  assert.ok(hits.includes(ben.id) && hits.includes(loth.id), `hits in both orchestrators' transcripts: ${hits}`);
  assert.ok(!hits.includes(token), 'no token in a snippet');
  assert.match(await h.search_transcripts!({ query: 'InputValidationError', until: '2020-01-01' }), /^No matches in/, 'the window holds');
  const read = await h.agent_transcript!({ session_id: loth.id, last: 5 });
  assert.match(read, /InputValidationError in unity/);
  assert.ok(!read.includes(token), 'no token in a transcript read');
  assert.deepEqual([...store.work.values()], before, 'the ledger is unchanged');
  assert.equal(store.readTranscript(loth.id, 400).length, lothBefore, 'the transcript is unchanged');
  // The retired transcript_read flag is gone from request_work and update_work: nothing on the request says it is granted.
  assert.doesNotMatch((await call(ben, 'list_work', { id: 'w1' })).text, /transcript/i, 'list_work shows no grant');
  // A trusted intake request (a nightly run's) keeps the tools.
  const w1 = store.work.get('w1')!;
  store.putWork({ ...w1, source: { kind: 'nightly', untrusted: false } });
  assert.match(await h.agent_transcript!({ session_id: loth.id, last: 5 }), /InputValidationError in unity/, 'a trusted source is no bar');
  // A worker that serves a request quoting players' text is refused both, even once it closed, and its brief says why.
  store.putWork({ ...w1, id: 'w9', status: 'done', source: { kind: 'discord-bug', untrusted: true, channel: '#bugs' } });
  await assert.rejects(h.search_transcripts!({ query: 'InputValidationError', since }), /search_transcripts is closed to a worker on a request filed from players' text \(w9\)/);
  await assert.rejects(h.agent_transcript!({ session_id: loth.id }), /agent_transcript is closed to a worker on a request filed from players' text \(w9\)/);
  const closed = machines.hooks!.specFor(info, m).append ?? '';
  assert.match(closed, /Other agents' transcripts are closed to you: you serve a request filed from players' text \(w9\)/);
  assert.doesNotMatch(closed, /Transcripts are yours to read/);
});
