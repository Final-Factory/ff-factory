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
 * The orchestrator tests (docs/orchestrators.md), end to end on a real Agents with the scripted agent: reports a person asked for, design go cards, the timing order, questions handed to another person, cross-owner asks.
 * One of the server/orchestrators*.test.ts files split out of orchestrators.test.ts (w5826); helpers in orchestratorsTestKit.ts.
 */


test('w2541: a request marked for a report refuses DONE until its worker files one; the report links to the request and its person finds it', async (t) => {
  const { store, agents, machines, dispatcher, chat, call, cfg } = await setupOnMachine(t);
  agents.reports = new ReportStore(cfg.dataDir, () => []);
  const ben = chat(BEN).info;
  const filed = await call(ben, 'request_work', { title: 'Profile the belt renderer', brief: 'Where do the frames go?', report: 'profile' });
  assert.match(filed.text, /its result is a report \(profile\), which its worker files with file_report/);
  assert.deepEqual({ ...store.work.get('w1')!.report, at: undefined }, { kind: 'profile', at: undefined, by: 'Ben', asked: true });
  assert.match(reportProblem(store.work.get('w1')!)!, /file it first with mcp__machine__file_report/);
  // The dispatcher marks one its person did not (w5223: no ask, so no DONE gate and a worker note), and takes the mark back.
  await call(ben, 'request_work', { title: 'Splitter designs', brief: 'Three ways a splitter could pick.' });
  // A refused decision leaves the mark as it was.
  assert.match((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'queue', note: 'A design; no sandbox free.', report: 'design' })).text, /^ERROR: queue is for capacity only/);
  assert.equal(store.work.get('w2')!.report, undefined);
  assert.match((await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'After the belt profile.', report: 'design', blocker: { kind: 'request', ref: 'w1', what: 'the belt profile' } })).text, /^w2: marked design, but no person asked for it in this turn, so it is no report for people \(w5223\)/);
  assert.equal(store.work.get('w2')!.report?.by, 'the dispatcher');
  assert.equal(store.work.get('w2')!.report?.asked, false);
  assert.equal(reportProblem(store.work.get('w2')!), undefined, 'w5223: a mark no person asked for holds no DONE');
  assert.match((await call(ben, 'update_work', { id: 'w2', report: false })).text, /w2: no report needed any more/);
  assert.equal(store.work.get('w2')!.report, undefined);

  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Profile the belt renderer', title: 'Belt profile', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const h = machines.hooks!.handlersFor(store.sessions.get(id)!, store.machines.get('pc')!);
  const out = await h.file_report!({ title: 'Belt render profile', kind: 'profile', body: 'BeltRenderSystem: 62 ms a frame (measured).' });
  assert.match(out, /^r1 filed for w1, Ben's report/);
  assert.equal(agents.reports.get('r1')!.audience, 'people', 'Ben asked for it');
  assert.deepEqual(store.work.get('w1')!.reports, [{ id: 'r1', title: 'Belt render profile', kind: 'profile' }]);
  assert.equal(reportProblem(store.work.get('w1')!), undefined, 'filed: DONE is no longer held');
  await h.file_report!({ id: 'r1', title: 'Belt render profile, two saves', kind: 'profile', body: 'Measured again.', note: 'second save' });
  assert.deepEqual(store.work.get('w1')!.reports, [{ id: 'r1', title: 'Belt render profile, two saves', kind: 'profile' }]);
  assert.match(store.work.get('w1')!.log.at(-1)!, /report revised \(revision 2\): r1/);

  assert.match((await call(ben, 'list_reports', { person: 'ben' })).text, /r1 · profile · w1 · for Ben · .* · 2 revisions · "Belt render profile, two saves"/);
  assert.match((await call(ben, 'read_report', { id: 'r1', rev: 1 })).text, /revision 1 of 2[\s\S]*BeltRenderSystem: 62 ms/);
});

// w5223 (lothsahn: "I really only want it when I ask for one"; "we need a dramatic reduction, not a tweak"; "Please make
// sure the cost remains unhidden"): a mark outside a person's turn asks no report; a report nobody asked for is a worker
// note the person's orchestrator does not list by default; a cost estimate always shows.
test('w5223: reports only when a person asks: an unasked mark holds no DONE, an unasked report is a worker note, costs show', async (t) => {
  const { store, agents, machines, dispatcher, chat, call, cfg } = await setupOnMachine(t);
  agents.reports = new ReportStore(cfg.dataDir, () => []);
  const loth = chat(LOTH);
  // A hand-up turn, not Lothsahn's own words: the mark is kept but asks no report.
  loth.lastFrom = 'system';
  const filed = await call(loth.info, 'request_work', { title: 'Where did the Upgrade Planner go', brief: 'Find out.', report: 'investigation' });
  assert.match(filed.text, /not asked by a person: a worker note/);
  assert.equal(store.work.get('w1')!.report?.asked, false);
  assert.equal(reportProblem(store.work.get('w1')!), undefined);
  await call(loth.info, 'request_work', { title: 'FFU G3 rented scale run', brief: 'What would it cost?' });
  loth.lastFrom = 'human';
  // In Lothsahn's own turn, update_work marks it asked.
  await call(loth.info, 'request_work', { title: 'Design the splitter modes', brief: 'Three options.' });
  assert.match((await call(loth.info, 'update_work', { id: 'w3', report: 'design' })).text, /^w3: its result is a design report/);
  assert.equal(store.work.get('w3')!.report?.asked, true);

  const files: Record<string, string> = {};
  for (const [wid, title, extra] of [
    ['w1', 'Where the Upgrade Planner went', {}],
    ['w2', 'FFU G3 rented scale-run cost estimate', {}],
    ['w3', 'Splitter mode options', {}],
  ] as const) {
    const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Go', title: `${wid}: go`, work_id: wid, extra_agent: wid !== 'w1' });
    assert.equal(started.isError, false, started.text);
    const id = /Started agent (\w+)/.exec(started.text)![1];
    const h = machines.hooks!.handlersFor(store.sessions.get(id)!, store.machines.get('pc')!);
    files[wid] = await h.file_report!({ title, kind: 'analysis', body: 'Findings.', ...extra });
  }
  assert.match(files.w1, /^r1 filed for w1 as a worker note:[\s\S]*Your findings go in your final message/);
  assert.match(files.w2, /^r2 filed for w2, Lothsahn's report/);
  assert.match(files.w3, /^r3 filed for w3, Lothsahn's report/);
  assert.deepEqual(['r1', 'r2', 'r3'].map((r) => agents.reports!.get(r)!.audience), ['workers', 'people', 'people']);
  // Lothsahn's orchestrator lists the reports for people; all adds the worker notes.
  const listed = (await call(loth.info, 'list_reports', {})).text;
  assert.match(listed, /^2 reports \(1 worker note not shown: all true lists them\)/);
  assert.doesNotMatch(listed, /Upgrade Planner/);
  assert.match((await call(loth.info, 'list_reports', { all: true })).text, /^3 reports[\s\S]*r1 · analysis · worker note · w1/);
});


// w4739 (r290 fix 5): the w3031 replay. r87, the multi-select design, reached revision 4 with no open questions on
// 2026-11-08 01:43; the go to build was offered in chat ("say 'file the w3031 implementation'") and came 9 d 1 h later.
// Now its close sends Lothsahn's orchestrator a [design closed] message: ask the go on an ask_person card, recommended.
test('w4739: the w3031 replay: a design request closing with no open questions has its person asked the go to build on a card', async (t) => {
  const { store, agents, machines, sessions, dispatcher, chat, call, heard, cfg } = await setupOnMachine(t);
  agents.reports = new ReportStore(cfg.dataDir, () => []);
  const loth = chat(LOTH).info;
  await call(loth, 'request_work', { title: 'Design: multi-select mobile stations and move them together', brief: 'Design multi-select for mobile stations.', report: 'design' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Design it', title: 'w1: multi-select design', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  assert.match(machines.hooks!.specFor(info, store.machines.get('pc')!).append, /ask them all together on one card \(one `waiting_on_person` call with every one in `questions`\)/);
  // Revisions 1 to 3 left questions open; the link keeps them.
  await h.file_report!({ title: 'Multi-selecting mobile stations to move them: options and recommendation', kind: 'design', body: '## Open questions\n1. **Q4:** control groups in v1?\n2. **Q5:** cap the selection?\n' });
  assert.deepEqual(store.work.get('w1')!.reports![0].openQuestions, ['Q4: control groups in v1?', 'Q5: cap the selection?']);
  // Revision 4, as filed: none left.
  await h.file_report!({ id: 'r1', title: 'Multi-selecting mobile stations to move them: options and recommendation', kind: 'design', body: '**TL;DR:** Every question is answered; the design is ready to build.\n\n## Open questions\nNone. All six are answered by lothsahn.\n' });
  assert.deepEqual(store.work.get('w1')!.reports![0].openQuestions, []);
  assert.equal(heard(loth.id, '[design closed]').length, 0, 'nothing before it closes');
  sessions.events.emit('turnEnd', sessions.get(id), 'r1 revised: every question answered, ready to build.\n\nDONE: w1\nLearned: nothing new');
  await until('w1 closes', () => store.work.get('w1')!.status === 'done');
  await until('Lothsahn’s orchestrator hears it', () => heard(loth.id, '[design closed]').length === 1);
  const msg = heard(loth.id, '[design closed]')[0].text;
  assert.match(msg, /^\[design closed\] w1 "Design: multi-select mobile stations and move them together" closed, and its result is a design \(r1 /);
  assert.match(msg, /Ask Lothsahn the go now: ask_person, request w1: "File the build of multi-select mobile stations and move them together now\?", options "Yes, file the build now" \(recommended\)/);
  assert.match(store.work.get('w1')!.log.at(-1)!, /a design closed: Lothsahn's orchestrator told to ask the go to build on a card \(w4739\)/);
  // The card it asks is one ask_person accepts as written.
  const card = await call(loth, 'ask_person', { question: 'File the build of multi-select mobile stations and move them together now?', options: [{ label: 'Yes, file the build now', recommended: true }, { label: "Not yet, I'll say when" }, { label: 'Change the design first' }], request: 'w1' });
  assert.equal(card.isError, false, card.text);
  assert.match(card.text, /Shown to Lothsahn as 3 buttons, Yes, file the build now recommended/);
});

test('w4739: no go card when a build already names the design, nor for a request whose result is not a design', async (t) => {
  const { store, agents, machines, sessions, dispatcher, chat, call, heard, cfg } = await setupOnMachine(t);
  agents.reports = new ReportStore(cfg.dataDir, () => []);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Design: splitter modes', brief: 'Design it.', report: 'design' });
  await call(ben, 'request_work', { title: 'Build: splitter modes', brief: 'Build r1.', related_ids: ['w1'] });
  await call(ben, 'request_work', { title: 'Profile the belts', brief: 'Where do frames go?', report: 'profile' });
  for (const [wid, kind, sb] of [['w1', 'design', 'pc/alpha'], ['w3', 'profile', 'pc/alpha']] as const) {
    const started = await call(dispatcher().info, 'start_agent', { sandbox: sb, prompt: 'Go', title: `${wid}: go`, work_id: wid, extra_agent: wid === 'w3' });
    assert.equal(started.isError, false, started.text);
    const id = /Started agent (\w+)/.exec(started.text)![1];
    const info = store.sessions.get(id)!;
    await firstTurn(info);
    await machines.hooks!.handlersFor(info, store.machines.get('pc')!).file_report!({ title: `${wid} result`, kind, body: '## Open questions\nNone.' });
    sessions.events.emit('turnEnd', sessions.get(id), `Filed.\n\nDONE: ${wid}\nLearned: nothing new`);
    await until(`${wid} closes`, () => store.work.get(wid)!.status === 'done');
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(heard(ben.id, '[design closed]').length, 0);
  assert.match(store.work.get('w1')!.log.at(-1)!, /no go-to-build card: w2 already names it \(w4739\)/);
});

// w2741: d17c8672 was sent w2709 (an investigation with report r36), then w2722; its title named w2722, so file_report
// (workIdsOf: servedBy and the title) refused its revision of r36, though the ledger showed it on w2709 still (holdsOf).
test("w2741: a worker whose title names one request and which holds another files and revises the other request's report", async (t) => {
  const { store, agents, machines, dispatcher, chat, call, cfg } = await setupOnMachine(t);
  agents.reports = new ReportStore(cfg.dataDir, () => []);
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Why tokens show no session usage', brief: 'Find out.', report: 'investigation' });
  await call(ben, 'request_work', { title: 'Token pool: soonest reset', brief: 'Change the pool.' });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Investigate', title: 'w1: why no session usage', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const h = machines.hooks!.handlersFor(store.sessions.get(id)!, store.machines.get('pc')!);
  assert.match(await h.file_report!({ title: 'No session usage', kind: 'investigation', body: 'First pass.' }), /^r1 filed for w1/);
  // It is sent w2 later, and its title follows: w1 is no longer the request it was last sent, nor the one its title names.
  const w2 = store.work.get('w2')!;
  w2.sessionIds.push(id);
  w2.links = { ...w2.links, [id]: { at: new Date(Date.now() + 60_000).toISOString(), how: 'sent' } };
  store.sessions.get(id)!.title = 'w2: token pool';
  assert.deepEqual([...holdsOf(id, [...store.work.values()]).held].sort(), ['w1', 'w2'], 'the ledger shows it on both');
  const out = await h.file_report!({ id: 'r1', title: 'No session usage, revised', kind: 'investigation', body: 'Second pass.' });
  assert.match(out, /^r1 revised: revision 2 for w1/);
  assert.match(await h.file_report!({ title: 'Another', kind: 'investigation', body: 'x', request: 'w1' }), /^r2 filed for w1/);
  // Said DONE on w1: it holds w1 no more, so w1's reports are not its to revise.
  store.work.get('w1')!.done = { [id]: { at: new Date().toISOString(), report: 'DONE: w1' } };
  await assert.rejects(h.file_report!({ id: 'r1', title: 'x', kind: 'investigation', body: 'x' }), /r1 is w1's report; you revise only your own open requests' reports \(yours: w2\)/);
});

test('w2548: the timing order starts a timed leg, and the dispatcher starting it again within a minute is refused, naming the worker', async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta'] });
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', status: 'blocked' }, timedLegRow('w2')]);
  // 15:19:54Z: the pass starts it on pc itself.
  assert.equal(agents.startTimedLeg(store.work.get('w2')!, 'pc', 'pc is idle (no other work on it)'), true);
  await until('the leg is linked to its worker', () => store.work.get('w2')!.sessionIds.length === 1);
  const first = store.work.get('w2')!.sessionIds[0];
  const info = store.sessions.get(first)!;
  assert.equal(info.machineSandbox, 'alpha');
  // Its first prompt still waits (the save being fetched into its Inbox): no process yet, as 9a3c8e5d at 15:20Z.
  await firstTurn(info);
  store.putSession({ ...info, status: 'stopped', turns: 0, sdkSessionId: undefined });
  // 15:20Z: the dispatcher, told to decide it, starts it in the same sandbox.
  const again = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Profile it', title: 'w2: profiled capture', work_id: 'w2' });
  assert.equal(again.isError, true, again.text);
  assert.match(again.text, new RegExp(`^ERROR: w2 already has worker ${first} "w2: timed leg for w1`));
  // With an override it is still refused in that sandbox: the leg's own worker occupies it.
  const forced = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Profile it', title: 'w2: profiled capture', work_id: 'w2', override_duplicate: 'a second look' });
  assert.equal(forced.isError, true, forced.text);
  assert.match(forced.text, new RegExp(`sandbox pc/alpha is not free: ${first} "w2: timed leg for w1`));
  assert.deepEqual(store.work.get('w2')!.sessionIds, [first], 'one worker on the leg');
  assert.equal(store.machines.get('pc')!.sandboxes!.find((x) => x.id === 'alpha')!.sessionIds.filter((id) => store.sessions.get(id)?.kind === 'worker').length, 1);
});

test('w2548: a start under way holds the request: start_agent during the timing order\'s start is refused, and the order skips a leg start_agent is starting', async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta'] });
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1', status: 'blocked' }, timedLegRow('w2'), timedLegRow('w3')]);
  // The order's start has begun (its sandbox being handed over) and has no worker yet: the dispatcher's start is refused,
  // into the same sandbox or another, override or not.
  assert.equal(agents.startTimedLeg(store.work.get('w2')!, 'pc', 'pc is idle'), true);
  for (const extra of [{ sandbox: 'pc/alpha' }, { sandbox: 'pc/beta', override_duplicate: 'a second look', extra_agent: true }]) {
    const r = await call(dispatcher().info, 'start_agent', { prompt: 'Profile it', title: 'w2: profiled capture', work_id: 'w2', ...extra });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /^ERROR: w2 is being started already: FF Factory is starting it itself on pc now \(its timing order, w2055\)/);
  }
  await until('the leg is linked to its worker', () => store.work.get('w2')!.sessionIds.length === 1);
  await until('the order has let go of it', () => agents.startUnderWay('w2') === undefined);
  assert.equal(store.work.get('w2')!.sessionIds.length, 1, 'one worker on the leg');
  // The other way round: while start_agent starts w3, the order does not start it too.
  const p = call(dispatcher().info, 'start_agent', { sandbox: 'pc/beta', prompt: 'Profile it', title: 'w3: profiled capture', work_id: 'w3', extra_agent: true });
  await until('start_agent holds w3', () => agents.startUnderWay('w3') !== undefined);
  assert.match(agents.startUnderWay('w3')!, /a start_agent for it is starting it in/);
  assert.equal(agents.startTimedLeg(store.work.get('w3')!, 'pc', 'pc is idle'), false);
  const r = await p;
  assert.equal(r.isError, false, r.text);
  assert.equal(store.work.get('w3')!.sessionIds.length, 1);
  // Once it has a worker the order skips it, even from an older copy of the request.
  assert.equal(agents.startTimedLeg({ ...store.work.get('w3')!, sessionIds: [] }, 'pc', 'pc is idle'), false);
});

test("w2548: a timed leg's [work request] tells the dispatcher FF Factory starts it itself, not to decide it", () => {
  const leg = { ...timedLegRow('w2'), brief: 'Time it.', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: false, createdAt: T0, updatedAt: T0, sessionIds: [], overlaps: [], asks: 0, log: [] } as WorkItem;
  const text = requestNotice(leg);
  assert.match(text, /^\[work request\] w2 from Lothsahn: "Timed leg for w1/);
  assert.match(text, /Nothing to decide: FF Factory starts this timed leg itself \(its timing order, w2055.*\) when pc can take it/);
  assert.match(text, /Do not start_agent it/);
  assert.doesNotMatch(text, /Decide: start it/);
  assert.match(requestNotice({ ...leg, timedLeg: undefined }), /Decide: start it \(start_agent with work_id "w2"\)/);
});

test('w2867: a question its requester hands to another person ("Ask ben") waits on that person, goes to them, and no note, re-offer or re-ask turns it back to the requester', async (t) => {
  const { store, o, dispatcher, chat, call, heard } = setup(t);
  const loth = chat(LOTH).info;
  const ben = chat(BEN).info;
  await call(loth, 'request_work', { title: 'Far space past 20k', brief: 'Investigate what far space contains.' });
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[work request] w1').length === 1);
  const questions = [{ question: 'What should far space contain?', options: [{ label: 'Add asteroids to Deep Space', recommended: true }, { label: 'Leave it as it is' }] }];
  const asked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'Design pick for far space (report r62).', questions });
  assert.equal(asked.isError, false, asked.text);
  await until('lothsahn has it', () => heard(loth.id, '[needs you]').length === 1);
  const live = async () => (await call(dispatcher().info, 'list_work', { id: 'w1' })).text;
  assert.match(await live(), /Waiting on input on Lothsahn/);

  // lothsahn answers "Ask ben": his orchestrator hands the question on. The words and answers stay; it waits on Ben.
  chat(LOTH).lastFrom = 'human';
  const handed = await call(loth, 'update_work', { id: 'w1', note: 'Ask ben', question_for: 'ben' });
  assert.equal(handed.isError, false, handed.text);
  assert.match(handed.text, /Waiting on input on Ben/);
  const w = store.work.get('w1')!;
  assert.equal(w.status, 'question');
  assert.deepEqual({ text: w.question!.text, asks: w.question!.asks!.map((a) => a.question), for: w.question!.for, by: w.question!.by }, { text: 'Design pick for far space (report r62).', asks: ['What should far space contain?'], for: [BEN], by: 'Lothsahn' });
  assert.match(await live(), /Waiting on input on Ben \(the question Lothsahn handed to Ben/);
  assert.doesNotMatch(await live(), /Waiting on input on Lothsahn/);
  await until('Ben gets it as [needs you]', () => heard(ben.id, '[needs you]').length === 1);
  assert.match(heard(ben.id, '[needs you]')[0].text, /Design pick for far space/);
  assert.equal(w.needsYou!.who.join(), 'Ben');
  // The Waiting tab: Ben's move, not lothsahn's.
  assert.deepEqual(decisionsOn([w], { userId: 'ben', displayName: 'Ben', reviewer: false }).map((d) => d.w.id), ['w1']);
  assert.deepEqual(decisionsOn([w], { userId: 'lothsahn', displayName: 'Lothsahn', reviewer: false }), []);

  // A later note of lothsahn's ("keep waiting on ben's pick") keeps it with Ben: no new question, nothing back to him.
  const kept = await call(loth, 'update_work', { id: 'w1', note: "keep waiting on ben's pick" });
  assert.match(kept.text, /the question stays with Ben \(handed by Lothsahn\)/);
  assert.equal(store.work.get('w1')!.status, 'question');
  assert.deepEqual(store.work.get('w1')!.question!.for, [BEN]);
  assert.match(await live(), /Waiting on input on Ben/);

  // The w2217 re-offer passes it by: it is a question, not undecided.
  const when = Date.now() + 40 * 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(when);
  assert.deepEqual(o.undecidedBound(), []);

  // The dispatcher's re-ask without `for` is refused; with `for` it goes to Ben, never to lothsahn.
  const reask = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'For Ben: far space pick?', questions: [{ question: 'Which far space?', options: [{ label: 'Asteroids', recommended: true }, { label: 'As is' }] }] });
  assert.equal(reask.isError, true);
  assert.match(reask.text, /question is with Ben: Lothsahn handed it on .* pass for: "Ben"/);
  const forBen = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', for: 'ben', note: 'For Ben: a second pick?', questions: [{ question: 'Push the edge out too?', options: [{ label: 'Yes', recommended: true }, { label: 'No' }] }] });
  assert.equal(forBen.isError, false, forBen.text);
  assert.match(forBen.text, /Ben's orchestrator has your question as \[needs you\]/);
  await until('Ben gets the second', () => heard(ben.id, '[needs you]').length === 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(loth.id, '[needs you]').length, 1, 'lothsahn never hears it again');
  assert.match(await live(), /Waiting on input on Ben/);

  // Ben answers in his own words, in a turn of his: the question clears. The turn the second [needs you] opened ends first
  // (w5915: answered inside it, the note was FF Factory's turn, not his, and the question stayed open).
  await until("Ben's orchestrator ends the second ask's turn", () => chat(BEN).info.status === 'idle');
  chat(BEN).lastFrom = 'human';
  const answered = await call(ben, 'update_work', { id: 'w1', note: 'Add asteroids' });
  assert.equal(answered.isError, false, answered.text);
  assert.equal(store.work.get('w1')!.question, undefined);
  assert.equal(store.work.get('w1')!.status, 'new');
});

test('w2867: already_asked records the handed question without a message; the requester can take it back', async (t) => {
  const { store, dispatcher, chat, call, heard } = setup(t);
  const loth = chat(LOTH).info;
  const ben = chat(BEN).info;
  await call(loth, 'request_work', { title: 'Far space past 20k', brief: 'Investigate.' });
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[work request] w1').length === 1);
  await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'Far space pick.', questions: [{ question: 'Which?', options: [{ label: 'A', recommended: true }, { label: 'B' }] }] });
  chat(LOTH).lastFrom = 'human';
  const r = await call(loth, 'update_work', { id: 'w1', question_for: 'Ben', already_asked: true });
  assert.match(r.text, /Ben already has it .*no message sent/);
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal(heard(ben.id, '[needs you]').length, 0);
  assert.match(store.work.get('w1')!.log.join('\n'), /\[needs you\] kept for Ben, not sent/);
  // Taken back: lothsahn's own note answers it.
  await call(loth, 'update_work', { id: 'w1', question_for: 'lothsahn', already_asked: true });
  assert.deepEqual(store.work.get('w1')!.question!.for, [LOTH]);
  await call(loth, 'update_work', { id: 'w1', note: 'B' });
  assert.equal(store.work.get('w1')!.question, undefined);
  // Nothing open: refused.
  const none = await call(loth, 'update_work', { id: 'w1', question_for: 'ben' });
  assert.equal(none.isError, true);
});

test('w2867: the one-off fix makes w2850 Waiting on input on Ben, its question and answers unchanged, and sends nobody anything', async (t) => {
  const { store, o, agents, dispatcher, chat, call, heard } = setup(t);
  const ben = chat(BEN).info;
  const loth = chat(LOTH).info;
  const at = '2026-11-02T07:02:10.000Z';
  const asks = [{ question: 'What should far space contain?', options: [{ label: 'Add asteroids', description: 'Fill it.', recommended: true }, { label: 'Leave it', description: 'Keep it empty.' }] }];
  const text = "For Ben: w2850 works as designed, per report r62. lothsahn left the pick to Ben (\"Ask ben\", then \"keep waiting on ben's pick\").";
  putRequests(store, [{ id: 'w2850', title: 'THAT is hilarious', status: 'question', requesters: [LOTH, BEN], question: { text, at, asks }, needsYou: { key: `question:${at}`, kind: 'question', question: text, who: ['Lothsahn'], to: ['lothsahn'], at, previews: [], prs: [], asks } as unknown as WorkItem['needsYou'] }]);
  o.fixW2850();
  const w = store.work.get('w2850')!;
  assert.deepEqual({ status: w.status, text: w.question!.text, asks: w.question!.asks, at: w.question!.at, for: w.question!.for }, { status: 'question', text, asks, at, for: [BEN] });
  assert.match((await call(dispatcher().info, 'list_work', { id: 'w2850' })).text, /Waiting on input on Ben/);
  assert.equal(o.needsYouDigest(agents.personWaits()), 0, 'the boot digest sends nothing');
  o.fixW2850();
  assert.equal(w.log.filter((l) => l.includes('(w2867 one-off)')).length, 1, 'once');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard(ben.id, '[needs you]').length + heard(loth.id, '[needs you]').length, 0);
});

test('w2972: one leg of a two-worker request hands its PR to the merge-on-green pilot with LEG DONE: on green FF Factory merges it and files the report, and the request stays open for the other leg until a DONE for the whole of it', async (t) => {
  const own = ownPrs('abc1234def5678');
  const env = await setupOnMachine(t);
  const { store, agents, o, dispatcher, heard } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w1x' }]);
  mergeOnGreenArm(o, (id) => id === 'w1');
  const pr = 'Final-Factory/ffu#135';
  const head = 'abc1234def5678';
  let checks: { done: boolean; text: string; green?: true } = { done: false, text: `1 of 1 checks on ${pr} still running` };
  const merges: string[] = [];
  const watch = new BlockerWatch({ store, orchestrators: o, prHealth: own, ci: async () => checks, merge: async (ref) => void merges.push(ref) });
  env.agents.prHealth = own;
  const a = await startedFor(env, 'w1');
  const b = await secondWorkerOn(env, 'w1');
  // 50e2b52d (w2895 row M2.17) on 2026-11-03: "it requires a `DONE: w2895` line, and that would close the whole fan-out request".
  const told = String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on ffu PR #135' }));
  assert.ok(told.includes(`You are one leg of w1 (other workers on it: ${b.id}): end it with "LEG DONE: w1 <your leg>" in place of the DONE line`), told);
  const report = 'Row M2.17: thin bots merged.\n\nLEG DONE: w1 row M2.17\nLearned: nothing new';
  const set = String(await a.h.blocked_on!({ request: 'w1', prs: [`ci:${pr}`], head, what: 'CI on ffu PR #135', merge_on_green: report }));
  assert.doesNotMatch(set, /merge_on_green ignored/, set);
  assert.equal(store.work.get('w1')!.blocked!.mergeOnGreen?.report, report);
  checks = { done: true, green: true, text: `CI on ${pr} finished: all 1 checks passed or skipped` };
  await watch.tick();
  assert.deepEqual(merges, [pr], 'merged on green');
  let w = store.work.get('w1')!;
  assert.notEqual(w.status, 'done', w.log.slice(-3).join(' | '));
  assert.equal(w.done?.[a.id]?.leg, true, 'its leg is recorded as done');
  assert.ok(w.log.some((l) => l.includes(`worker ${a.id} said LEG DONE for its leg ("LEG DONE: w1 row M2.17"); w1 stays open, still on it: ${b.id} (w2972)`)), w.log.slice(-3).join(' | '));
  assert.equal(agents.waker.pending(a.id), undefined, 'the leg worker is not resumed');
  // The leg's worker ending, and the ledger's re-checks, do not close it on a LEG DONE either.
  o.workerEnded(a.info);
  assert.equal(o.recheckDone('w1', 'a test'), false);
  assert.notEqual(store.work.get('w1')!.status, 'done');
  // The other leg finishes with LEG DONE too: still open, and the dispatcher hears nobody is on it.
  const before = heard(dispatcher().info.id, '[ledger]').length;
  o.workerTurnEnded(b.info, 'Row R.M3 merged.\n\nLEG DONE: w1 row R.M3');
  w = store.work.get('w1')!;
  assert.notEqual(w.status, 'done');
  await until('the dispatcher hears the last leg ended', () => heard(dispatcher().info.id, '[ledger]').length > before);
  assert.match(heard(dispatcher().info.id, '[ledger]').at(-1)!.text, /w1 .*finished its leg \("LEG DONE: w1 row R\.M3"\), and no other worker is on it now\. Start its next leg/);
  // A DONE for the whole of it closes it.
  o.workerTurnEnded(b.info, 'Every row is merged.\n\nDONE: w1\nLearned: nothing new');
  w = store.work.get('w1')!;
  assert.equal(w.status, 'done', w.log.slice(-3).join(' | '));
});

test('w2972: LEG DONE lines are read by request id with words after it; a DONE line is not one, nor a mention in a sentence', () => {
  assert.deepEqual(legDoneIdsIn('LEG DONE: w2895 row M2.17'), ['w2895']);
  assert.deepEqual(legDoneIdsIn('**LEG DONE:** w2895 (row R.M3)\n- LEG-DONE w12'), ['w2895', 'w12']);
  assert.deepEqual(legDoneIdsIn('DONE: w2895'), []);
  assert.deepEqual(legDoneIdsIn('I will write LEG DONE: w2895 later'), []);
  assert.deepEqual(doneIdsIn('LEG DONE: w2895 row M2.17'), [], 'a LEG DONE never closes the request');
});

test("w3186: a longer bench turn Ben approved: recorded in his own turn with his words, marked on its machine for the request's worker, counted from the bench state, and ended once its turns were used", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, machines, o, call } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'normal' }, { id: 'w2', by: LOTH, status: 'active', priority: 'normal' }]);
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  const ben = o.personalFor(BEN);
  const words = 'Give each overload run a one-off 60-minute exclusive turn on pc, with the ffu test runners paused';
  store.append(ben.info.id, { kind: 'user', text: words, from: 'human', uuid: 'u3186' });
  const ask = { request: 'w1', machine: 'pc', turns: 2, minutes: 60, words };

  ben.lastFrom = 'system';
  assert.match((await call(ben.info, 'grant_bench_turn', ask)).text, /only Ben, in a turn of theirs, approves a longer bench turn/);
  ben.lastFrom = 'human';
  assert.match((await call(ben.info, 'grant_bench_turn', { ...ask, words: 'a 60-minute turn on pc please' })).text, /is not in Ben's own recent messages here/);
  assert.match((await call(ben.info, 'grant_bench_turn', { ...ask, minutes: 30 })).text, /minutes: more than the 30-minute turn/);
  assert.match((await call(ben.info, 'grant_bench_turn', { ...ask, machine: 'nowhere' })).text, /machine: one of .*pc/);
  assert.equal(agents.benchPriorities('pc')[a.id].exempt, undefined, 'nothing is marked before it is recorded');
  const recorded = await call(ben.info, 'grant_bench_turn', ask);
  assert.equal(recorded.isError, false, recorded.text);
  assert.match(recorded.text, /^Recorded w1\.b1: 2 exclusive turns of 60 min on pc, 0 used, expires .*approved by Ben .*: "Give each overload run/);
  assert.match(store.work.get('w1')!.log.at(-1)!, /Ben: bench grant w1\.b1 recorded in their own turn: 2 exclusive turns of 60 min on pc/);

  const prios = agents.benchPriorities('pc');
  assert.deepEqual(prios[a.id], { priority: 'normal', requests: ['w1'], exempt: 'approved', approved: { grant: 'w1.b1', by: 'Ben', request: 'w1', turns: 2, turn_min: 60, used: [] } });
  assert.equal(prios[b.id].exempt, undefined, "another request's worker keeps the 30 minutes");
  assert.equal(agents.benchPriorities('elsewhere')[a.id], undefined);

  // The machine's bench state: the worker's approved ticket holds; then its second; then none.
  const stats = machines.statsOf.bind(machines);
  let running: Record<string, unknown>[] = [];
  machines.statsOf = ((mid: string) => ({ ...(stats(mid) ?? {}), ...(mid === 'pc' ? { bench: { mode: running.length ? 'exclusive' : 'free', running, runningCount: running.length, waiting: 0 } } : {}) })) as typeof machines.statsOf;
  t.after(() => void (machines.statsOf = stats));
  running = [{ ticket: 't00000005', mode: 'exclusive', what: 'probe', session: a.id }];
  assert.deepEqual(agents.benchPriorities('pc')[a.id].approved?.used, [], 'a ticket taken without the approval is no turn');
  running = [{ ticket: 't00000007', mode: 'exclusive', what: 'overload 1', session: a.id, approved: true }];
  assert.deepEqual(agents.benchPriorities('pc')[a.id].approved?.used, ['t00000007']);
  assert.match(store.work.get('w1')!.log.at(-1)!, /bench grant w1\.b1 on pc: t00000007 took turn 1 of 2 \(60 min\)/);
  running = [{ ticket: 't00000009', mode: 'exclusive', what: 'overload 2', session: a.id, approved: true }];
  assert.deepEqual(agents.benchPriorities('pc')[a.id].approved?.used, ['t00000007', 't00000009'], 'the mark stays while the last turn holds');
  running = [];
  assert.equal(agents.benchPriorities('pc')[a.id].exempt, undefined, 'both turns used and let go: the 30 minutes again');
  assert.match(store.work.get('w1')!.log.at(-1)!, /ended: its 2 turns \(t00000007, t00000009\) were used/);
  assert.equal((await call(ben.info, 'grant_bench_turn', {})).text, 'No approved bench turns hold now.');

  // A new grant, cancelled in his turn.
  assert.equal((await call(ben.info, 'grant_bench_turn', { ...ask, turns: 1 })).isError, false);
  assert.match((await call(ben.info, 'grant_bench_turn', {})).text, /^Bench turns approved \(w3186\):\n- w1: w1\.b2: 1 exclusive turn of 60 min on pc/);
  assert.match((await call(ben.info, 'grant_bench_turn', { cancel: 'w1.b2' })).text, /^Cancelled w1\.b2/);
  assert.equal(agents.benchPriorities('pc')[a.id].exempt, undefined);
});

test("w3730: a person's orchestrator stops a worker's bench ticket in their name, only in their own turn, and lists what can be stopped", async (t) => {
  const env = await setupOnMachine(t);
  const { store, machines, o, call, heard } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'normal' }]);
  const a = await startedFor(env, 'w1');
  const ben = o.personalFor(BEN);
  const stats = machines.statsOf.bind(machines);
  const running = [
    { ticket: 't00000005', mode: 'exclusive', what: 'perf leg', session: a.id, requests: ['w1'] },
    { ticket: 't00000006', mode: 'shared', what: 'editor boot', session: 'editor:alpha' },
  ];
  machines.statsOf = ((mid: string) => ({ ...(stats(mid) ?? {}), ...(mid === 'pc' ? { bench: { mode: 'exclusive', running, runningCount: running.length, waiting: 0 } } : {}) })) as typeof machines.statsOf;
  const post = machines.post.bind(machines);
  const posted: unknown[] = [];
  machines.post = ((mid: string, msg: { type: string }, ...rest: unknown[]) => (msg.type === 'bench_revoke' ? void posted.push({ mid, ...msg }) : (post as (...a: unknown[]) => unknown)(mid, msg, ...rest))) as typeof machines.post;
  t.after(() => {
    machines.statsOf = stats;
    machines.post = post;
  });

  (ben as unknown as { turnStarter?: unknown }).turnStarter = undefined; // the worker's start notice opened a turn
  ben.lastFrom = 'human';
  const list = await call(ben.info, 'stop_bench_ticket', {});
  assert.match(list.text, new RegExp(`^Bench tickets that can be stopped on any online machine:\n- pc t00000005: exclusive, w1, worker ${a.id.slice(0, 8)}: "perf leg"$`), list.text);
  ben.lastFrom = 'system';
  assert.match((await call(ben.info, 'stop_bench_ticket', { machine: 'pc', ticket: 't00000005' })).text, /only Ben, in a turn of theirs, stops a bench ticket/);
  ben.lastFrom = 'human';
  assert.match((await call(ben.info, 'stop_bench_ticket', { machine: 'pc', ticket: 't00000006' })).text, /editor's ticket \(a harness ticket\)/);
  assert.match((await call(ben.info, 'stop_bench_ticket', { machine: 'pc', ticket: 't00000077' })).text, /pc holds no ticket t00000077 now/);
  assert.equal(posted.length, 0);
  const before = heard(a.id, 'Bench lock (w3730)').length;
  const r = await call(ben.info, 'stop_bench_ticket', { machine: 'pc', ticket: 't00000005' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Stopping pc's exclusive bench ticket t00000005 \("perf leg"\)/);
  assert.deepEqual(posted, [{ mid: 'pc', type: 'bench_revoke', ticket: 't00000005', session: a.id, why: 'stopped by Ben through their orchestrator (w3730)' }]);
  await until('the worker is told who stopped it', () => heard(a.id, 'Bench lock (w3730)').length > before);
  assert.match(heard(a.id, 'Bench lock (w3730)').at(-1)!.text, /Ben stopped your pc's exclusive bench ticket t00000005/);
});

test('w3328: disk_cleanup marks a request a disk clean-up of a machine, from request_work, update_work or the dispatcher\'s start_agent; its worker\'s spec carries it, an ordinary one\'s and a title alone do not', async (t) => {
  const { store, machines, dispatcher, chat, call } = await setupOnMachine(t);
  const ben = chat(BEN);
  const m = store.machines.get('pc')!;
  const startOn = async (id: string, extra: Record<string, unknown> = {}) => {
    const r = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'go', title: `${id}: job`, work_id: id, override_duplicate: 'separate test request', extra_agent: true, ...extra });
    assert.equal(r.isError, false, r.text);
    const info = store.sessions.get(/Started agent (\w+)/.exec(r.text)![1])!;
    return () => machines.hooks!.specFor(info, m);
  };

  // Filed with the flag: the field, the log, and the worker's launch spec.
  await call(ben.info, 'request_work', { title: 'pc V: clean-up', brief: 'Free disk space on pc.', needs: 'agent', disk_cleanup: 'pc' });
  assert.deepEqual({ ...store.work.get('w1')!.diskCleanup, at: '' }, { machine: 'pc', by: 'Ben', at: '' });
  const spec1 = await startOn('w1');
  assert.equal(spec1().diskCleanup, true);

  // An ordinary request, even one titled like a clean-up: no flag, the gate holds its worker.
  await call(ben.info, 'request_work', { title: 'pc disk clean-up, free space', brief: 'Clean up the disk on pc.', needs: 'agent' });
  assert.equal(store.work.get('w2')!.diskCleanup, undefined);
  const spec2 = await startOn('w2');
  assert.equal(spec2().diskCleanup, undefined);

  // Marked later by update_work: the running worker's next spec carries it; false takes it back.
  assert.match((await call(ben.info, 'update_work', { id: 'w2', disk_cleanup: 'nowhere' })).text, /disk_cleanup: no machine "nowhere"/);
  assert.match((await call(ben.info, 'update_work', { id: 'w2', disk_cleanup: 'pc' })).text, /w2: marked a disk clean-up of pc/);
  assert.equal(spec2().diskCleanup, true);
  assert.match((await call(ben.info, 'update_work', { id: 'w2', disk_cleanup: '' })).text, /no longer a disk clean-up of pc/);
  assert.equal(spec2().diskCleanup, undefined);

  // The dispatcher marks it with start_agent, for the sandbox's machine.
  await call(ben.info, 'request_work', { title: 'Leftovers', brief: 'Remove FF Factory leftovers on pc.', needs: 'agent' });
  const spec3 = await startOn('w3', { disk_cleanup: true });
  assert.deepEqual({ ...store.work.get('w3')!.diskCleanup, at: '' }, { machine: 'pc', by: 'the dispatcher', at: '' });
  assert.equal(spec3().diskCleanup, true);

  // A flag for another machine does not reach a worker on this one.
  store.work.get('w3')!.diskCleanup = { machine: 'elsewhere', by: 'Ben', at: '' };
  assert.equal(spec3().diskCleanup, undefined);
});

test("w5929: a disk clean-up request's worker runs machine_cleanup on its own machine, in the background, and hears the result; any other worker is refused", async (t) => {
  const { store, machines, dispatcher, chat, call, heard } = await setupOnMachine(t);
  const ben = chat(BEN);
  const m = store.machines.get('pc')!;
  const startOn = async (id: string) => {
    const r = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'go', title: `${id}: job`, work_id: id, override_duplicate: 'separate test request', extra_agent: true });
    assert.equal(r.isError, false, r.text);
    const info = store.sessions.get(/Started agent (\w+)/.exec(r.text)![1])!;
    assert.ok(machines.hooks!.specFor(info, m).mcp!.tools.some((x) => x.name === 'machine_cleanup'), 'a worker is offered the tool');
    return { info, tool: (a: Record<string, unknown>) => machines.hooks!.handlersFor(info, m)!.machine_cleanup!(a) };
  };
  const asked: { id: string; dryRun?: boolean }[] = [];
  let finish!: (r: unknown) => void;
  t.mock.method(machines, 'cleanupNow', (id: string, o: { dryRun?: boolean }) => {
    asked.push({ id, ...o });
    return new Promise((resolve) => (finish = resolve));
  });

  // An ordinary request's worker: refused, and told how the runner folder goes instead.
  await call(ben.info, 'request_work', { title: 'Something else', brief: 'Not a clean-up.', needs: 'agent' });
  const plain = await startOn('w1');
  await assert.rejects(plain.tool({}), /machine_cleanup is for a disk clean-up request of pc.*for the dispatcher's machine_cleanup on pc/);
  assert.equal(asked.length, 0);

  // A disk clean-up of pc: the pass starts on pc, the call answers at once, the result comes as a message.
  await call(ben.info, 'request_work', { title: 'pc V: clean-up', brief: 'Free disk space on pc.', needs: 'agent', disk_cleanup: 'pc' });
  const w = await startOn('w2');
  assert.match(String(await w.tool({})), /The clean-up pass on pc is running .*\[clean-up\] message/);
  assert.deepEqual(asked, [{ id: 'pc', dryRun: false }]);
  assert.match(String(await w.tool({ dry_run: true })), /still running/, 'one pass at a time per machine');
  assert.equal(asked.length, 1);
  finish({ at: new Date().toISOString(), trigger: 'asked', removed: 1, freedBytes: 15 * 2 ** 30, items: [{ path: 'V:/ffw/ffu-runners/r1/_work/ffu', bytes: 15 * 2 ** 30, rule: 'ffu-runner-work', why: 'no job running' }] });
  await until('the worker hears the result', () => heard(w.info.id, '[clean-up]').length === 1);
  assert.match(heard(w.info.id, '[clean-up]')[0]!.text, /The clean-up pass you started on pc finished/);
  assert.match(String(await w.tool({ dry_run: true })), /The dry-run clean-up pass on pc is running/, 'free again once it finished');
  assert.deepEqual(asked.at(-1), { id: 'pc', dryRun: true });
});

test('w3338: a worker that paused for low disk is Blocked on disk space on its machine and resumed only once that disk is back above its warning line plus the margin; blocked_on disk does the same; a clean-up request is never gated on it', async (t) => {
  const { store, agents, o, dispatcher, call, machines } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }]);
  let clock = Date.now();
  let freeGB = 11;
  const GB = 1024 ** 3;
  // w4257: blocked_on disk reads the same reading the gate does (Machines.diskRoom).
  machines.diskRoom = (m) => (m.toLowerCase() === 'pc' ? { freeBytes: freeGB * GB, warnGB: 15 } : undefined);
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, online: (m) => (m === 'pc' ? true : undefined), disk: (m) => (m === 'pc' ? { freeBytes: freeGB * GB, warnGB: 15 } : undefined), checkInPending: (id) => agents.waker.pending(id) !== undefined });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: 'w1: comet catcher', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const machine = info.machineId!.toLowerCase();
  const w = store.work.get('w1')!;
  // c4cdb382 (w3212) on 2026-11-07 at 07:07Z, after the [disk critical] notice.
  Object.assign(info, { status: 'stopped', lastActivityAt: new Date(clock - 60_000).toISOString(), lastResult: 'w1: still open: paused for low disk on V: (11 GB free); the fix is committed and pushed', lastResultAt: new Date(clock - 60_000).toISOString() });
  assert.match((await watch.tick()).get('w1') ?? '', /^recorded: the wait on disk space on \S+ its worker \w+'s report names \(w3338\)/);
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref], ['blocked', 'disk', machine]);
  assert.equal(blockerName(w.blocked!), `disk space on ${machine}`);
  // Still low, and then above the warning line but inside the margin (15 + 5 GB): no resume, so it cannot flap.
  for (const gb of [11, 17, 19.9]) {
    freeGB = gb;
    clock += 10 * 60_000;
    assert.equal((await watch.tick()).has('w1'), false, `${gb} GB free`);
    assert.equal(w.status, 'blocked');
    assert.equal(agents.waker.pending(id), undefined, `not resumed at ${gb} GB`);
  }
  // 28 GB free (07:58Z): resumed with no person's nudge.
  freeGB = 28;
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: \S+ has 28 GB free \(its warning line 15 GB \+ 5\)/);
  assert.equal(w.status, 'active');
  assert.ok(agents.waker.pending(id), 'its worker is resumed');
  agents.waker.cancel(id);
  assert.equal((await watch.tick()).has('w1'), false, 'the same report is not recorded again');
  // blocked_on disk: the worker's own machine.
  freeGB = 9;
  o.workerBlocked(id, { disk: true, what: 'disk space back' });
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref], ['blocked', 'disk', machine]);
  assert.equal((await watch.tick()).has('w1'), false);
  freeGB = 40;
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: /);
  assert.equal(w.status, 'active');
  // w4257: a late [disk critical] notice (w4241 on biscuit, 40 GB free) is refused by the same test that clears the gate,
  // and so is one just above the margin; inside the margin (19.9 GB) the wait still goes on.
  for (const gb of [40, 20]) {
    freeGB = gb;
    assert.throws(() => o.workerBlocked(id, { disk: true, what: 'disk space back' }), new RegExp(`disk: \\S+ has ${gb} GB free \\(its warning line 15 GB \\+ 5\\), above the line a disk wait clears at.*carry on with your work`));
    assert.equal(w.status, 'active', `no wait at ${gb} GB`);
  }
  freeGB = 19.9;
  o.workerBlocked(id, { disk: true, what: 'disk space back' });
  assert.deepEqual([w.status, w.blocked?.kind], ['blocked', 'disk']);
  freeGB = 40;
  assert.match((await watch.tick()).get('w1') ?? '', /^clear: /);
  // A disk clean-up request (w3328) saying the disk is low is doing the freeing, not waiting on it.
  agents.waker.cancel(id);
  freeGB = 9;
  w.diskCleanup = { machine, by: 'lothsahn', at: new Date(clock).toISOString() };
  clock += 60_000;
  Object.assign(info, { status: 'stopped', lastActivityAt: new Date(clock - 30_000).toISOString(), lastResult: 'w1: still open: waiting for low disk space to recover after the clean-up', lastResultAt: new Date(clock - 30_000).toISOString() });
  await watch.tick();
  assert.equal(w.blocked, undefined, 'a clean-up is never gated on disk');
});

test('w5167: a disk block filed while the disk is already above its warning line plus the margin is refused, records nothing and flips nothing; under that line it is recorded as before', async (t) => {
  const { store, o, dispatcher, call, machines } = await setupOnMachine(t);
  putRequests(store, [{ id: 'w1' }]);
  const GB = 1024 ** 3;
  let freeGB = 24;
  machines.diskRoom = (m) => (m.toLowerCase() === 'pc' ? { freeBytes: freeGB * GB, warnGB: 15 } : undefined);
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => Date.now(), online: (m) => (m === 'pc' ? true : undefined), disk: (m) => (m === 'pc' ? { freeBytes: freeGB * GB, warnGB: 15 } : undefined) });
  const w = store.work.get('w1')!;
  const before = { status: w.status, log: w.log.length };
  // lothdesktop, 2026-11-23 03:52Z: the dispatcher's block of w5155 at 24 GB free over its 15 GB line, cleared the same minute.
  for (const ref of ['pc', 'PC']) {
    const r = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: "LothDesktop's V: back above its warning line", blocker: { kind: 'disk', ref, what: 'disk space on lothdesktop' } });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /disk: pc has 24 GB free \(its warning line 15 GB \+ 5\), already above the line a disk gate clears at.*nothing is recorded: start it now/);
  }
  assert.deepEqual([w.status, w.blocked, w.log.length], [before.status, undefined, before.log], 'no gate, no state change, no log line');
  assert.equal((await watch.tick()).has('w1'), false, 'nothing to clear, so no unblocked line and no notice');
  // At the margin's edge it is refused too (the gate would clear at 20 GB); under it the block is recorded and holds.
  freeGB = 20;
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'disk', ref: 'pc', what: 'disk space' } })).isError, true);
  freeGB = 19.9;
  const held = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'x', blocker: { kind: 'disk', ref: 'pc', what: 'disk space' } });
  assert.equal(held.isError, false, held.text);
  assert.deepEqual([w.status, w.blocked?.kind, w.blocked?.ref], ['blocked', 'disk', 'pc']);
  assert.equal((await watch.tick()).has('w1'), false, 'still under the line: it holds');
});

test('w3338: diskWaitIn reads the five low-disk pause lines of 2026-11-07 and not a clean-up, CI or a person', () => {
  for (const l of [
    'w3212: still open: paused for low disk on V: (11 GB free); the fix is committed and pushed',
    'w3335: still open: paused until disk space is freed on lothdesktop, then the 1.0.0.41 leg',
    'w3252: still open: stopped because of the disk critical notice; the timed leg waits for free disk space',
    'w3273: still open: holding for more disk space before the next build',
    'w3275: still open: waiting on low disk space on lothdesktop',
    'w1: still open: blocked on disk space on lothdesktop',
  ]) assert.equal(diskWaitIn(l), true, l);
  for (const l of [
    'w1: still open: free more disk space on V: (the clean-up)',
    'w1: still open: blocked on CI on PR #12',
    'w1: still open: the disk clean-up freed 20 GB',
    'w1: still open: waiting on lothsahn to approve',
  ]) assert.equal(diskWaitIn(l, ['lothsahn']), false, l);
});

test('w3396: a computer whose sandbox drive is under 30 GB free takes no new FFU (cargo) work; other work still fits', () => {
  const work = (repo?: string) => ({ title: 'Speed up the belt sweep', brief: '', notes: [], needs: 'agent', ...(repo ? { repo } : {}) }) as unknown as WorkItem;
  assert.equal(cargoShortOf(31 * 1024 ** 3), undefined);
  assert.equal(cargoShortOf(undefined), undefined, 'unknown free space fits');
  const short = cargoShortOf(12.5 * 1024 ** 3)!;
  assert.match(short, /12\.5 GB free, under the 30 GB/);
  for (const r of ['Final-Factory/ffu', 'https://github.com/Final-Factory/ffu.git', 'final-factory/FFU/']) assert.ok(isCargoRepo(r), r);
  for (const r of [undefined, 'Final-Factory/FinalFactory', 'Final-Factory/ffu-tools']) assert.ok(!isCargoRepo(r), String(r));
  const fit = { lothdesktop: { platform: 'win32', cargoShort: short }, beast: { platform: 'win32' } };
  assert.equal(unfitWhy(work('Final-Factory/ffu'), 'lothdesktop', fit), `lothdesktop: ${short}`);
  assert.equal(unfitWhy(work('Final-Factory/ffu'), 'beast', fit), undefined, 'a drive with room takes it');
  assert.equal(unfitWhy(work(), 'lothdesktop', fit), undefined, 'game work does not build cargo');
  const r: RoomNow = { game: [], agent: ['lothdesktop', 'beast'], held: [], fit };
  assert.deepEqual(roomForWork(r, work('Final-Factory/ffu'), ['lothdesktop', 'beast']).ids, ['beast']);
});

// w3455 (ben, 2026-11-07): w3431 and w3392, pair runs Ben cleared to run without Steam, stayed Blocked on Steam sign-ins.
test('w3455: request_pair steam "none: <why>" needs no Steam, and decide_work pair_steam "none" clears the Steam gate of a Blocked pair run with no re-filing', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, dispatcher, call } = env;
  const o = agents.orchestrators;
  agentsRoom(agents, []);
  store.putMachine({ ...store.machines.get('pc')!, steam: { checkedAt: T0, installed: true, running: true, accountId: 7155839, persona: 'Lothsahn' } });
  // w3431's filing: its worker said steam "none: a direct (non-Steam) host and join ...".
  putRequests(store, [{ id: 'w3315', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w3315');
  const out = String(await a.h.request_pair!({ what: 'Production planner client plans kept across a rejoin, PR #3358', brief: "Leg 1 hosts on the repo's usual paired multiplayer path, not Steam; leg 2 joins, quits and rejoins.", steam: "none: a direct (non-Steam) host and join as the repo's paired multiplayer runs do" }));
  const filed = store.work.get(/^Filed (w\d+)/.exec(out)![1])!;
  assert.equal(filed.pair!.steam, undefined, out);
  assert.match(filed.pair!.noSteam ?? '', /^none/);
  assert.notEqual(filed.blocked?.kind, 'steam', out);
  // w3392 as it stood: marked as needing Steam from its words, and Blocked on Steam by the blocker watch.
  const read = { legs: 2, for: 'w3360', steam: STEAM_READ };
  // (Its words name a Steam lobby here, so the mark stands on its own: w3455's restate test below has w3392's real words.)
  putRequests(store, [{ id: 'w3392', by: BEN, status: 'queued', title: 'Pair run for w3360: Escape menu open while riding 60 s', brief: 'Both legs meet in a Steam lobby.', pair: read, constraints: pairText(read) }]);
  assert.deepEqual(o.holdSteamPairs(), ['w3392']);
  const p = () => store.work.get('w3392')!;
  assert.deepEqual([p().status, p().blocked?.kind], ['blocked', 'steam']);
  // An override_gate that does not rule Steam out and pair_legs leave it blocked; pair_steam "none" clears it.
  const legs = await call(dispatcher().info, 'decide_work', { id: 'w3392', action: 'queue', pair_legs: 2, override_gate: 'Ben said go', note: 'Ben: "go"' });
  assert.equal(p().status, 'blocked', legs.text);
  const none = await call(dispatcher().info, 'decide_work', { id: 'w3392', action: 'queue', pair_steam: 'none', note: 'Ben, 2026-11-07: "Yes, no Steam: start it when two computers have room"' });
  assert.equal(none.isError, false, none.text);
  assert.equal(p().status, 'queued', none.text);
  assert.equal(p().blocked, undefined);
  assert.equal(p().pair!.steam, undefined);
  assert.match(p().pair!.noSteam ?? '', /^none: .*decide_work pair_steam "none"/);
  assert.equal(p().constraints, pairText(p().pair!));
  const log = p().log.join('\n');
  assert.match(log, /dispatcher \(w2648\): now a pair run of 2 legs.*: Ben, 2026-11-07: "Yes, no Steam: start it when two computers have room" \(it was .*signed in to Stea/);
  assert.match(log, /unblocked: computers signed in to Steam cleared \(its Steam requirement was set to none: Ben, 2026-11-07/);
  // Neither the blocker watch nor a later queue with pair_legs marks it again from its words.
  assert.deepEqual(o.holdSteamPairs(), []);
  await call(dispatcher().info, 'decide_work', { id: 'w3392', action: 'queue', pair_legs: 2, note: 'again' });
  assert.equal(p().pair!.steam, undefined);
  assert.equal(p().status, 'queued');
});

// w3455, after #866 deployed: w3431 and w3392 stayed Blocked on Steam, because their marks were stored before it and nothing
// read them again (w3431: steam "none: a direct (non-Steam) host and join ..."; w3392: read from FF Factory's own filing
// paragraph), and the dispatcher's queue with pair_legs 2, pair_menus "none" and Ben's words in override_gate kept them.
test('w3455: a Steam mark stored before the fix is restated with no re-filing, and override_gate words that say "no Steam" clear one', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, dispatcher, call } = env;
  const o = agents.orchestrators;
  agentsRoom(agents, []);
  store.putMachine({ ...store.machines.get('pc')!, steam: { checkedAt: T0, installed: true, running: true, accountId: 7155839, persona: 'Lothsahn' } });
  const gate = { kind: 'steam' as const, what: 'a pair run of 2 legs that needs Steam needs 2 computers signed in to different Steam accounts', at: T0, by: 'dispatcher' };
  const filing = (p: { legs: number; steam?: string }) =>
    `FF Factory filed this for worker 96d0517c (w1945, request_pair): ${pairText(p)}. Its legs start together.`;
  const w3431Pair = { legs: 2, for: 'w3315', steam: "none: a direct (non-Steam) host and join as the repo's paired multiplayer runs do (ff-agents:determinism-audit / LocalMultiplayer automation)" };
  const w3392Pair = { legs: 2, for: 'w3360', steam: STEAM_READ };
  const steamPair = { legs: 2, for: 'w3315', steam: 'both legs join through a Steam lobby' };
  putRequests(store, [
    { id: 'w3431', by: BEN, status: 'blocked', blocked: gate, title: 'Pair run for w3315: Production planner client plans kept across a rejoin, PR #3358', brief: `Leg 1 (host): host a new multiplayer game from this commit (the repo's usual paired multiplayer path, not Steam).\n\n${filing(w3431Pair)}`, pair: w3431Pair, constraints: pairText(w3431Pair) },
    { id: 'w3392', by: BEN, status: 'blocked', blocked: gate, title: 'Pair run for w3360: w3360 D: Escape menu open while riding 60 s', brief: `Ben, 2026-11-07: "Yes, no Steam: start it when two computers have room": the legs use a direct LAN or Tailscale host and join.\n\nFF Factory filed this for worker 4696760c on w3360 (w1945, request_pair): a pair run of 2 legs, only on computers whose screen is unlocked (it clicks the game's menus: read from its words: a menu, a lobby, a click).`, pair: w3392Pair, constraints: pairText(w3392Pair) },
    { id: 'w9001', by: BEN, status: 'blocked', blocked: gate, title: 'Pair run: lobby join', brief: 'Both legs meet in a Steam lobby.', pair: steamPair, constraints: pairText(steamPair) },
  ]);
  const w = (id: string) => store.work.get(id)!;
  // The dispatcher's own call on w3392, as it was refused at 21:52 UTC: it is Queued for capacity now.
  const q = await call(dispatcher().info, 'decide_work', { id: 'w3392', action: 'queue', pair_legs: 2, pair_menus: 'none', override_gate: 'Ben, 2026-11-07: "Yes, no Steam: start it when two computers have room"', note: 'Ben cleared it to run without Steam.' });
  assert.equal(q.isError, false, q.text);
  assert.deepEqual([w('w3392').status, w('w3392').blocked, w('w3392').pair!.steam], ['queued', undefined, undefined], q.text);
  assert.match(w('w3392').log.join('\n'), /\(w3455\): it needs no Steam: its stored Steam mark was read from FF Factory's own filing text, not its words; now a pair run of 2 legs/);
  // The blocker watch alone frees w3431, with no dispatcher call: unblocked, back to the dispatcher to start or queue.
  assert.deepEqual(o.holdSteamPairs(), []);
  assert.deepEqual([w('w3431').status, w('w3431').blocked, w('w3431').pair!.steam], ['new', undefined, undefined]);
  assert.match(w('w3431').pair!.noSteam ?? '', /^none: /);
  assert.equal(w('w3431').constraints, pairText(w('w3431').pair!));
  assert.match(w('w3431').log.join('\n'), /unblocked: computers signed in to Steam cleared \(its Steam mark was restated/);
  const q2 = await call(dispatcher().info, 'decide_work', { id: 'w3431', action: 'queue', pair_legs: 2, note: 'Ben: no Steam.' });
  assert.equal(w('w3431').status, 'queued', q2.text);
  // A mark its own words make stands until a person's words rule Steam out: Ben's, given as override_gate.
  assert.equal(w('w9001').status, 'blocked');
  const go = await call(dispatcher().info, 'decide_work', { id: 'w9001', action: 'queue', override_gate: 'go ahead', note: 'go' });
  assert.equal(w('w9001').status, 'blocked', go.text);
  const none = await call(dispatcher().info, 'decide_work', { id: 'w9001', action: 'queue', override_gate: 'Ben, 2026-11-07: "Yes, no Steam: start the planner rejoin run now"', note: 'Ben cleared it to run without Steam.' });
  assert.equal(none.isError, false, none.text);
  assert.deepEqual([w('w9001').status, w('w9001').pair!.steam], ['queued', undefined], none.text);
  assert.deepEqual(o.holdSteamPairs(), []);
});

test('w3522: reclaim frees no sandbox that a pair or timed hold would keep from its work; with neither hold it still does', async (t) => {
  const env = await twoComputers(t);
  const { store, agents } = env;
  const pressure = () => (agents as unknown as { reclaimPressure: () => Pressure[] }).reclaimPressure().find((p) => p.work === 'w3')!;
  // Every sandbox held (biscuit/slot3 at 00:37Z on 2026-11-08): pc stands for biscuit, beast for lothdesktop.
  const places = agents.places.bind(agents);
  let small = false;
  agents.places = () => places().map((p) => ({ ...p, freeSandboxes: 0, sandboxes: p.maxSandboxes, ...(small && p.id === 'pc' ? { maxAgents: 1 } : {}) }));
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w3', status: 'queued', queuedFor: { at: '2026-10-24T10:00:00Z' } }]);
  const free = pressure();
  assert.equal(free.room, false);
  assert.deepEqual([...free.machines].sort(), ['beast', 'pc'], 'with no hold a freed sandbox on either computer is w3\'s');
  assert.equal(free.held, undefined);
  // An older pair run fits both: the sandbox a reclaim frees would be held for it (w1945), so w3 frees none.
  putRequests(store, [{ id: 'w2', status: 'queued', queuedFor: { at: T0 }, pair: { legs: 2 } }]);
  const held = pressure();
  assert.deepEqual(held.machines, []);
  assert.deepEqual(held.preemptOn, []);
  assert.equal(held.held?.length, 2);
  assert.match(held.held![0], /^(pc|beast): last free sandbox is held for w2 "Request w2" \(normal, Queued since 09:00 UTC\), a pair run of 2 legs/);
  const none = pickReclaim(held, [{ machine: 'pc', sandbox: 'alpha', sessions: [], priority: 'low', midTurn: false, activeAt: 0, editorStopped: true }]);
  assert.ok('none' in none && /^a sandbox freed for it would be held for other work: (pc|beast): last free sandbox is held for w2/.test(none.none), JSON.stringify(none));
  // Work above the pair's priority goes first (pairHoldProblem), so it still reclaims.
  store.work.get('w3')!.priority = 'urgent';
  assert.deepEqual([...pressure().machines].sort(), ['beast', 'pc']);
  store.work.get('w3')!.priority = 'normal';
  store.work.get('w2')!.status = 'done';
  // A timed hold (w1995) keeps a small computer's last sandbox only while the work has room on another computer; then it has
  // room and frees nothing. With every sandbox held it steps aside, so the freed sandbox is w3's and the reclaim stands.
  small = true;
  putRequests(store, [{ id: 'w5', title: 'Timed leg for w1440: belt A/B', status: 'queued', queuedFor: { at: T0, needs: ['pc'] }, timedLeg: { for: 'w1440', forSession: 'abc', from: 'beast', small: ['pc'] } }]);
  const timed = pressure();
  assert.deepEqual([...timed.machines].sort(), ['beast', 'pc']);
  assert.equal(timed.held, undefined);
  // With beast free (the only case a timed hold keeps pc's sandbox from w3), w3 has room and frees nothing.
  agents.places = () => places().map((p) => ({ ...p, freeSandboxes: p.id === 'beast' ? 1 : 0, sandboxes: p.maxSandboxes, ...(p.id === 'pc' ? { maxAgents: 1 } : {}) }));
  agentsRoom(agents, ['beast']);
  assert.equal(pressure().room, true);
});

test("w3606: an owner answers the other owner's question in their own words: it is answered, the dispatcher resumes, the log quotes them, its owner hears who and what", async (t) => {
  const { dispatcher, ben, loth, says, w, tab, call, heard, o } = await crossOwnerQuestion(t);
  assert.deepEqual([tab(BEN), tab(LOTH)], [['w1'], []]);
  // Outside his own turn a note stays a note (w677): the question still waits on Ben.
  loth.lastFrom = 'system';
  const note = await call(loth.info, 'update_work', { id: 'w1', note: 'Keep it open.' });
  assert.match(note.text, /It stays Ben's/);
  assert.deepEqual([w().status, w().question?.text], ['question', 'Keep w1 open and schedule it later?']);
  says('Yes, keep it open and schedule it when the other higher priority work is done. I have answered for Ben.');
  const r = await call(loth.info, 'update_work', { id: 'w1', note: 'Keep it open; schedule it after the higher priority work.' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([w().status, w().question, w().requestedBy.userId], ['new', undefined, 'ben']);
  assert.deepEqual([tab(BEN), tab(LOTH)], [[], []]);
  assert.match(w().log.join('\n'), /Lothsahn \(an owner, on Ben's request, in their own words: "Yes, keep it open and schedule it when the other higher priority work is done\. I have answered for Ben\."\): note: Keep it open/);
  // w4238: the note says whom it answered for, so a wait on Ben reads as settled at once (shared/workState.ts personWaitSettled).
  assert.deepEqual(w().notes?.at(-1)?.for, ['Ben']);
  assert.equal(o.personalOf('ben')!.info.openAsks, undefined, "Ben's card left his tab");
  await until('Ben is told who answered and what', () => heard(ben.info.id, '[from another owner]').some((e) => e.text.startsWith('[from another owner] Lothsahn answered the question on it: Keep it open; schedule it after the higher priority work., on your w1 "FFU owner_term flakes"') && e.text.includes('"Yes, keep it open')));
  await until('the dispatcher resumes with the answer', () => heard(dispatcher().info.id, '[work update]').some((e) => e.text.includes('w1') && e.text.includes('Keep it open; schedule it after the higher priority work.')));
});

test("w3606: an owner moves the question waiting on the other owner to themselves: it leaves Ben's tab and comes to theirs", async (t) => {
  const { ben, loth, says, w, tab, call, heard, o } = await crossOwnerQuestion(t);
  // Not in his own turn: refused, nothing moves.
  loth.lastFrom = 'system';
  const refused = await call(loth.info, 'update_work', { id: 'w1', question_for: 'lothsahn' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /moves its question only on Lothsahn's own words/);
  assert.deepEqual(tab(BEN), ['w1']);
  says('Take that question off Ben, it is mine now.');
  const r = await call(loth.info, 'update_work', { id: 'w1', question_for: 'lothsahn', note: 'Lothsahn takes it' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([w().status, w().question!.for, w().question!.text], ['question', [LOTH], 'Keep w1 open and schedule it later?']);
  assert.deepEqual([tab(BEN), tab(LOTH)], [[], ['w1']]);
  assert.equal(o.personalOf('ben')!.info.openAsks, undefined, "Ben's card left his tab");
  assert.match(w().log.join('\n'), /Lothsahn \(an owner, on Ben's request\) moved its question from Ben to Lothsahn, in their own words: "Take that question off Ben/);
  await until('lothsahn gets it', () => heard(loth.info.id, '[needs you]').length === 1);
  await until('Ben is told', () => heard(ben.info.id, '[from another owner]').some((e) => e.text.startsWith('[from another owner] Lothsahn moved the question on it from Ben to Lothsahn, on your w1')));
  // And it moves back to Ben the same way.
  const back = await call(loth.info, 'update_work', { id: 'w1', question_for: 'ben' });
  assert.equal(back.isError, false, back.text);
  assert.deepEqual([tab(BEN), tab(LOTH)], [['w1'], []]);
});

test("w3606: an owner changes the other owner's priority in their own words; outside their turn it is refused", async (t) => {
  const { ben, loth, says, w, call, heard } = await crossOwnerQuestion(t);
  loth.lastFrom = 'system';
  const refused = await call(loth.info, 'update_work', { id: 'w1', priority: 'urgent' });
  assert.match(refused.text, /changes its priority only on Lothsahn's own words/);
  assert.equal(w().priority, 'normal');
  says('Please make w1 urgent');
  const r = await call(loth.info, 'update_work', { id: 'w1', priority: 'urgent' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([w().priority, w().status, w().question?.text, w().runsFor?.userId ?? 'ben'], ['urgent', 'question', 'Keep w1 open and schedule it later?', 'ben'], 'only the priority: the question still waits on Ben, the pool stays his');
  assert.match(w().log.join('\n'), /Lothsahn \(an owner, on Ben's request, in their own words: "Please make w1 urgent"\): priority normal → urgent/);
  await until('Ben is told', () => heard(ben.info.id, '[from another owner]').some((e) => e.text.startsWith('[from another owner] Lothsahn changed its priority normal → urgent, on your w1')));
});

test("w3606: a member's request, or a question waiting on a member, stays theirs even in an owner's own turn", async (t) => {
  const { store, dispatcher, chat, call, says, loth } = await crossOwnerQuestion(t);
  const cara = chat(CARA);
  cara.lastFrom = 'human';
  await call(cara.info, 'request_work', { title: "Cara's thing", brief: 'x' });
  await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'ask', note: 'Which one?', questions: [{ question: 'Which?', options: [{ label: 'A', recommended: true }, { label: 'B' }] }] });
  says('Answer it: A. And make it urgent, and give its question to me.');
  assert.match((await call(loth.info, 'update_work', { id: 'w2', note: 'A' })).text, /^ERROR: w2 is Cara's request, not Lothsahn's: an owner adds notes only to another owner's request/);
  assert.match((await call(loth.info, 'update_work', { id: 'w2', priority: 'urgent' })).text, /its priority stays its people's to change/);
  assert.match((await call(loth.info, 'update_work', { id: 'w2', question_for: 'lothsahn' })).text, /^ERROR: w2 is Cara's request, not Lothsahn's: its question stays with whoever it waits on/);
  assert.equal(store.work.get('w2')!.status, 'question');
  // Ben's question handed to Cara stays Cara's.
  const ben = chat(BEN);
  ben.lastFrom = 'human';
  assert.equal((await call(ben.info, 'update_work', { id: 'w1', question_for: 'cara' })).isError, false);
  says('Answer w1: keep it.');
  assert.match((await call(loth.info, 'update_work', { id: 'w1', note: 'keep it' })).text, /w1's question waits on Cara, not on an owner: it stays theirs/);
  assert.deepEqual(store.work.get('w1')!.question!.for, [CARA]);
});

test('w3615: w3533 as it happened: its blocker cancelled, the [needs you] question sent, a note outside Ben\'s turn, the dispatcher settles it as blocked on another request: Blocked, the question closed, Ben\'s card withdrawn and Ben told', async (t) => {
  const env = setup(t);
  const { store, agents, o, dispatcher, chat, call, heard } = env;
  agentsRoom(agents, []);
  // w1 stands for w3545 (the pair run cancelled as replaced), w2 for w3533 (Ben's), w3 for w3612 (the pair run replacing w1).
  putRequests(store, [{ id: 'w1', status: 'active' }, { id: 'w2', by: BEN }, { id: 'w3', status: 'active' }]);
  const blocked = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'waits on the pair run', blocker: { kind: 'request', ref: 'w1', what: "w1's pair run report" } });
  assert.equal(blocked.isError, false, blocked.text);
  const watch = new BlockerWatch({ store, orchestrators: o });
  store.work.get('w1')!.status = 'cancelled';
  await watch.tick();
  const w2 = store.work.get('w2')!;
  assert.equal(w2.status, 'question');
  const told = toldPeople(o);
  const ben = chat(BEN).info;
  await until('Ben gets the question as [needs you]', () => heard(ben.id, '[needs you]').length === 1);
  relayAsCard(env, BEN, 'w2', 'a1');
  assert.equal(ben.openAsks?.length, 1, "Ben's card is open");
  const live = async () => (await call(dispatcher().info, 'list_work', { id: 'w2' })).text;
  assert.match(await live(), /Waiting on input on Ben/);
  // 08:27: Ben's note outside his own turn (his orchestrator relays lothsahn's word): it answers nothing (w3161).
  const noted = await call(ben, 'update_work', { id: 'w2', note: 'Already decided by Lothsahn: wait on w3 instead of w1.' });
  assert.equal(noted.isError, false, noted.text);
  assert.ok(w2.question, 'the question stays open after a note outside his turn');
  // The dispatcher settles it: blocked on w3's report.
  const settled = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'Settled by Lothsahn, whose word Ben defers to here.', blocker: { kind: 'request', ref: 'w3', what: "w3's pair run report (replaces w1)" } });
  assert.equal(settled.isError, false, settled.text);
  assert.equal(w2.status, 'blocked');
  assert.equal(w2.question, undefined, 'the question is closed');
  assert.equal(w2.needsYou?.answered?.by, 'the dispatcher', 'its [needs you] is answered');
  assert.match(await live(), /Blocked on w3 finishing/);
  assert.doesNotMatch(await live(), /Waiting on input/);
  assert.equal(chat(BEN).info.openAsks, undefined, "Ben's card is withdrawn");
  assert.deepEqual(decisionsOn([...store.work.values()].filter(isOpen), { userId: 'ben', displayName: 'Ben', reviewer: false }), [], 'nothing waits on Ben');
  assert.match(w2.log.join('\n'), /settles the question that waited on Ben/);
  assert.ok(told('ben').some((x) => /^\[dispatch\] w2 .*blocked on w3 finishing.*settles the question that waited on Ben.*their card about it is withdrawn/.test(x)), told('ben').join(' | '));
});

test('w3615: every decide_work action but ask settles a pending question, and so does a new worker started on it; a new ask does not', async (t) => {
  const env = setup(t);
  const { store, agents, dispatcher, chat, call } = env;
  agentsRoom(agents, []);
  const at = new Date(Date.now() - 60_000).toISOString();
  const question = { text: 'Is it still needed?', at };
  putRequests(store, ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'].map((id) => ({ id, by: BEN, status: 'question' as const, question })));
  putRequests(store, [{ id: 'w9', status: 'active' }]);
  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']) relayAsCard(env, BEN, id, `card-${id}`);
  assert.equal(chat(BEN).info.openAsks?.length, 7);
  const decide = (id: string, a: Record<string, unknown>) => call(dispatcher().info, 'decide_work', { id, note: 'decided', ...a });
  const results = [
    await decide('w1', { action: 'block', blocker: { kind: 'request', ref: 'w9', what: 'w9 first' } }),
    await decide('w2', { action: 'queue' }),
    await decide('w3', { action: 'merge', into: 'w9' }),
    await decide('w4', { action: 'reject' }),
    await decide('w5', { action: 'done', note: 'decided: it repeats w9, which covers it' }),
  ];
  for (const r of results) assert.equal(r.isError, false, r.text);
  // start_agent (and message_agent with work_id) on it: a new worker linked.
  env.o.linkWorker('w7', { id: 'fresh-worker', title: 'w7: do it' }, 'started worker fresh-worker');
  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w7']) assert.equal(store.work.get(id)!.question, undefined, `${id}'s question is closed`);
  assert.equal(store.work.get('w7')!.status, 'active');
  // A new ask keeps a question open, and its card.
  const again = await decide('w6', { action: 'ask', note: 'And what should it wait for?', questions: [{ question: 'What should w6 wait for now?', options: [{ label: 'Wait for w9 to finish first', recommended: true }, { label: 'Start it now without waiting' }] }] });
  assert.equal(again.isError, false, again.text);
  assert.ok(store.work.get('w6')!.question);
  assert.deepEqual((chat(BEN).info.openAsks ?? []).map((a) => a.request), ['w6']);
});

test('w3615: a question one requester answers withdraws the card of the requester it was asked of, who is told', async (t) => {
  const env = setup(t);
  const { store, o, chat, call } = env;
  const told = toldPeople(o);
  putRequests(store, [{ id: 'w1', by: BEN, requesters: [BEN, LOTH], status: 'question', question: { text: 'Is w1 still needed?', at: new Date(Date.now() - 60_000).toISOString() } }]);
  relayAsCard(env, BEN, 'w1', 'b1');
  assert.equal(chat(BEN).info.openAsks?.length, 1);
  chat(LOTH).lastFrom = 'human';
  const r = await call(chat(LOTH).info, 'update_work', { id: 'w1', note: 'Yes, keep w1 open and start it now.' });
  assert.equal(r.isError, false, r.text);
  assert.equal(store.work.get('w1')!.question, undefined);
  assert.equal(chat(BEN).info.openAsks, undefined, "Ben's card is withdrawn: Lothsahn answered it");
  assert.match(store.work.get('w1')!.log.join(' '), /settles the question that waited on Ben/);
  assert.ok(told('ben').some((x) => /settles the question that waited on Ben/.test(x)), told('ben').join(' | '));
});

test('w3615: at a boot, a question the dispatcher already settled with a block or a queue is closed, its card withdrawn and its person told; one asked after the decision stays', async (t) => {
  const env = setup(t);
  const { store, o, chat } = env;
  const told = toldPeople(o);
  const asked = new Date(Date.now() - 120_000).toISOString();
  const decided = new Date(Date.now() - 60_000).toISOString();
  putRequests(store, [
    { id: 'w1', by: BEN, status: 'blocked', question: { text: 'Is w1 still needed?', at: asked }, blocked: { kind: 'request', ref: 'w9', what: 'w9 reporting', at: decided, by: 'dispatcher' } },
    { id: 'w2', by: BEN, status: 'queued', question: { text: 'Is w2 still needed?', at: asked }, queuedFor: { at: decided } },
    { id: 'w3', by: BEN, status: 'blocked', question: { text: 'Is w3 still needed?', at: decided }, blocked: { kind: 'request', ref: 'w9', what: 'w9 reporting', at: asked, by: 'dispatcher' } },
    { id: 'w9', by: BEN, status: 'active' },
  ]);
  relayAsCard(env, BEN, 'w1', 'b1');
  relayAsCard(env, BEN, 'w3', 'b3');
  assert.equal(chat(BEN).info.openAsks?.length, 2);
  assert.deepEqual(o.settleStaleQuestions().sort(), ['w1', 'w2']);
  assert.equal(store.work.get('w1')!.question, undefined);
  assert.equal(store.work.get('w2')!.question, undefined);
  assert.equal(store.work.get('w1')!.status, 'blocked');
  assert.equal(store.work.get('w3')!.question?.text, 'Is w3 still needed?', 'a question asked after the block still waits');
  assert.deepEqual(chat(BEN).info.openAsks?.map((a) => a.request), ['w3']);
  assert.match(store.work.get('w1')!.log.join(' '), /block at .* settled its question.*w3615 repair/);
  assert.ok(told('ben').some((x) => /^\[dispatch\] w1 .*settled its question/.test(x)), told('ben').join(' | '));
  assert.deepEqual(o.settleStaleQuestions(), [], 'a second boot finds nothing');
});

test("w3740: a machine that drops under a worker's game player holds its request off players there, the resume says why, the guard refuses its launch, and only Ben's own yes clears it", async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents, o, call } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'normal' }, { id: 'w2', by: BEN, status: 'active', priority: 'normal' }]);
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  await until('its first turn', () => a.info.status === 'idle');
  // pc drops (unplanned) with both mid-turn; only a's game player ran there in the last half hour.
  o.workersCutOff('pc', [a.id, b.id], { [a.id]: 'its "running player pid 57328 slot 0" ticket there, last seen 21:34Z' });
  const w1 = store.work.get('w1')!;
  assert.equal(w1.crashHolds?.length, 1);
  assert.equal(store.work.get('w2')!.crashHolds, undefined, 'no player of its own there: no hold');
  assert.match(w1.log.find((l) => l.includes('crash hold')) ?? '', /crash hold on pc \(w3740\): pc dropped at \d\d:\d\dZ with w1's worker \w+ mid-turn \(its "running player pid 57328 slot 0" ticket there/);
  const mark = agents.benchPriorities('pc')[a.id].crashHold;
  assert.deepEqual(mark?.requests, ['w1']);
  assert.equal(agents.benchPriorities('pc')[b.id].crashHold, undefined);
  assert.equal(agents.benchPriorities('elsewhere')[a.id]?.crashHold, undefined);

  // The machine is back: the gate clears and the worker is resumed with the hold in its note.
  const watch = new BlockerWatch({ store, orchestrators: o, online: (m) => (m === 'pc' ? true : undefined) });
  await watch.tick();
  assert.match(agents.waker.pending(a.id)?.note ?? '', /Your turn stopped when pc went offline .* Crash hold \(w3740\): pc went offline while you ran a game player or a timed leg there.*w1 launches no game player on pc .*waiting_on_person/);
  // The worker's later turn end does not lift it: only a person does.
  o.workerTurnEnded(a.info, 'Collected the panics.\n\nw1: still open: asking Ben');
  assert.equal(liveCrashHolds(w1).length, 1);

  // The guard on pc, reading what the daemon writes from that mark.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3740-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeBenchPriorities(root, agents.benchPriorities('pc'), new Date(), false);
  const held = () => readCrashHold(root, a.id);
  assert.match(checkCrashHoldLaunch('python scripts/nightly/player_slots.py launch --scenario gpu-t7', held) ?? '', /^Refused \(w3740\): crash hold\. This machine went offline at \d\d:\d\dZ while w1's worker ran its "running player pid 57328/);
  assert.equal(checkCrashHoldLaunch('python scripts/nightly/player_slots.py launch --scenario x', () => readCrashHold(root, b.id)), undefined, "another request's worker launches");
  assert.equal(checkCrashHoldLaunch('git status', held), undefined, 'only a player launch is refused');

  // Clearing: only Ben, in his turn, with his words.
  const ben = o.personalFor(BEN);
  const words = 'ok, one more run on the pc, then stop';
  store.append(ben.info.id, { kind: 'user', text: words, from: 'human', uuid: 'u3740' });
  assert.match((await call(ben.info, 'clear_crash_hold', {})).text, /^Crash holds \(w3740\).*\n- pc dropped at .* with w1's worker/);
  (ben as unknown as { turnStarter?: unknown }).turnStarter = undefined;
  ben.lastFrom = 'system';
  assert.match((await call(ben.info, 'clear_crash_hold', { request: 'w1', words })).text, /only Ben, in a turn of theirs, clears a crash hold/);
  ben.lastFrom = 'human';
  assert.match((await call(ben.info, 'clear_crash_hold', { request: 'w1', words: 'sure go ahead' })).text, /is not in Ben's own recent messages here/);
  assert.match((await call(ben.info, 'clear_crash_hold', { request: 'w2', words })).text, /w2 has no crash hold/);
  const cleared = await call(ben.info, 'clear_crash_hold', { request: 'w1', words });
  assert.equal(cleared.isError, false, cleared.text);
  assert.match(cleared.text, /^Cleared w1's crash hold on pc/);
  assert.match(w1.log.at(-1)!, /Ben: crash hold on pc cleared in their own turn: "ok, one more run on the pc, then stop" \(w3740\)/);
  assert.equal(agents.benchPriorities('pc')[a.id].crashHold, undefined);
  writeBenchPriorities(root, agents.benchPriorities('pc'), new Date(), false);
  assert.equal(checkCrashHoldLaunch('python scripts/nightly/player_slots.py launch --scenario gpu-t7', held), undefined, 'cleared: it launches');

  // A second drop under its player holds it again.
  o.workersCutOff('pc', [a.id], { [a.id]: 'its "probe" ticket there, last seen 22:10Z' });
  assert.equal(liveCrashHolds(w1, 'pc').length, 1);
});

test('w3740: a worker that ran on through the drop (a network blip) shows the machine never went down: its crash hold goes with its gate; a planned drop or no recent player holds nothing', async (t) => {
  const env = await setupOnMachine(t);
  const { store, o, agents } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'normal' }]);
  const a = await startedFor(env, 'w1');
  await until('its first turn', () => a.info.status === 'idle');
  o.workersCutOff('pc', [a.id], { [a.id]: 'its "running player pid 1" ticket there, last seen 10:00Z' });
  assert.equal(liveCrashHolds(store.work.get('w1')!).length, 1);
  o.workersLived('pc', [a.id]);
  const w1 = store.work.get('w1')!;
  assert.equal(liveCrashHolds(w1).length, 0);
  assert.match(w1.crashHolds![0].clearedBy ?? '', /ran on through the drop/);
  assert.equal(agents.benchPriorities('pc')[a.id].crashHold, undefined);
  o.workersCutOff('pc', [a.id]);
  assert.equal(liveCrashHolds(w1).length, 0, 'a drop with no recent player of its there holds nothing');
});

test('w3740: the portal notes each worker\'s last game player or exclusive ticket per machine and names it when that machine drops within the half hour', () => {
  const seen: PlayerSeen = new Map();
  const t0 = Date.parse('2026-11-08T21:33:00Z');
  const bench = (running: BenchState['running']): BenchState => ({ mode: 'shared', running, runningCount: running.length, waiting: 0 });
  noteBench(seen, bench([
    { ticket: 't1', mode: 'shared', what: 'running player pid 57328 slot 0', session: '7d906e95' },
    { ticket: 't2', mode: 'shared', what: 'unity-slot build', session: 'bbbb' },
    { ticket: 't3', mode: 'exclusive', what: 'timed run tr_1', session: 'cccc' },
    { ticket: 't4', mode: 'exclusive', what: 'probe leg 3', session: 'dddd' },
  ]), t0);
  assert.deepEqual([...seen.keys()].sort(), ['7d906e95', 'dddd'], 'a build or a harness ticket is no player');
  // The player was killed (its ticket gone) 3 minutes before the panic; the drop came 4 minutes after that.
  noteBench(seen, bench([]), t0 + 3 * 60_000);
  const drop = t0 + 7 * 60_000;
  assert.deepEqual(recentPlayers(seen, ['7d906e95-full-id', 'eeee'], drop), { '7d906e95-full-id': 'its "running player pid 57328 slot 0" ticket there, last seen 21:33Z' });
  assert.deepEqual(recentPlayers(seen, ['7d906e95'], t0 + CRASH_HOLD_WINDOW_MS + 1), {}, 'past the half hour: no hold');
  assert.equal(riskyTicket({ mode: 'shared', what: 'running player pid 2', session: 'editor:slot1' }), false);
});

test("w4306: the nightly schedule's run, a pair run and a timed leg filed from it all run on the pool vault.unattributed.nightly names, though the run names lothsahn (systemPayer)", async (t) => {
  const { cfg, store, agents, o, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  (cfg as unknown as Config).vault = { unattributed: { nightly: 'ben' } };
  // w1 stands for w4303 (Nightly e2e run 2026-11-15): filed for intake.nightly.run.person, lothsahn, so not unattributed.
  putRequests(store, [{ id: 'w1', title: 'Nightly e2e run 2026-11-15 on pc', status: 'active', humanAsked: false }]);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Run the nightly lab', title: 'w1: nightly', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  await until('its first turn', () => store.sessions.get(id)!.status === 'idle');
  // Its source set after the echo worker's first turn, whose echo of the nightly intake rules would close it.
  store.putWork({ ...store.work.get('w1')!, source: { kind: 'nightly-run', untrusted: false, channel: 'nightly e2e', nightlyRun: { date: '2026-11-15', machine: 'pc' } } });
  assert.equal(personForWork(cfg as unknown as Config, store.work.get('w1')!), 'ben', 'the run itself');
  o.filePair(id, { what: 'MP desync pair', brief: 'Run the MP desync pair on master.' });
  const pair = [...store.work.values()].find((w) => w.pair?.for === 'w1')!;
  assert.equal(pair.requestedBy.userId, 'lothsahn', 'the ledger still shows whom the night is for');
  assert.equal(personForWork(cfg as unknown as Config, pair), 'ben', 'its pair run');
  const leg = store.work.get(o.fileTimedLeg(id, { what: 'frametime A/B', brief: 'Time master and the fix.', from: 'pc', needs: ['biscuit'], why: 'pc is big' }).id)!;
  assert.equal(leg.timedLeg?.for, 'w1');
  assert.equal(personForWork(cfg as unknown as Config, leg), 'ben', 'its timed leg');
  // Without the mapping, the default (lothsahn, w1031) applies to all three.
  (cfg as unknown as Config).vault = {};
  assert.deepEqual([store.work.get('w1')!, pair, leg].map((w) => personForWork(cfg as unknown as Config, w)), ['lothsahn', 'lothsahn', 'lothsahn']);
});

test('w4306: a pair run or timed leg of other nobody\'s work keeps its kind (intake, ffbox), and one of a request a person took over runs for them', () => {
  const cfg = { vault: { unattributed: { intake: 'ben', ffbox: 'ben' } } };
  const base = { requestedBy: LOTH, unattributed: true };
  const intake: Partial<WorkItem> = { ...base, source: { kind: 'discord-bug', untrusted: true } };
  const ffbox: Partial<WorkItem> = { ...base, source: { kind: 'ffbox-request', untrusted: true } };
  for (const parent of [intake, ffbox]) {
    const child = { requestedBy: LOTH, ...inheritedPayer(parent as WorkItem) };
    assert.equal(personForWork(cfg, child), 'ben', `a child of ${parent.source!.kind}`);
  }
  const taken = { ...intake, runsFor: { userId: 'maya', displayName: 'Maya', at: T0, why: 'answered its question' } };
  assert.equal(personForWork(cfg, { requestedBy: LOTH, ...inheritedPayer(taken as WorkItem) }), 'maya');
  assert.deepEqual(inheritedPayer({ requestedBy: BEN } as WorkItem), {}, "a person's own request: its children are theirs by requestedBy");
});

test('w5577: unfiled handed-up follow-ups are sent again at 2 h, become one card for their person at 12 h and are never filed by FF Factory; File files them once, Drop drops them', async (t) => {
  const { store, machines, sessions, dispatcher, chat, call, heard, o } = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta'] });
  const ben = chat(BEN).info;
  const clock = o as unknown as { now: () => Date };
  const m = store.machines.get('pc')!;
  /** A request of Ben's whose worker hands up two follow-ups and says DONE. */
  const handedUp = async (name: string, sandbox: string) => {
    const f = await call(ben, 'request_work', { title: `${name} design`, brief: `Design the ${name}.` });
    const id = /Filed (w\d+)/.exec(f.text)![1];
    const s = await call(dispatcher().info, 'start_agent', { sandbox, prompt: 'Design it', title: `${id}: ${name}`, work_id: id });
    assert.equal(s.isError, false, s.text);
    const wid = /Started agent (\w+)/.exec(s.text)![1];
    const info = store.sessions.get(wid)!;
    await until('its first turn', () => info.status === 'idle');
    const told = heard(ben.id, '[follow-ups to file]').length;
    await machines.hooks!.handlersFor(info, m).hand_up_requests!({
      items: [
        { title: `Compose the ${name} loop`, brief: `Compose the looping section of the ${name}, the part that repeats through the fight.` },
        { title: `Record the ${name} roar set`, brief: `Record and mix twelve roar variations for the ${name}.` },
      ],
    });
    await until('Ben’s orchestrator hears the briefs', () => heard(ben.id, '[follow-ups to file]').length === told + 1);
    sessions.events.emit('turnEnd', sessions.get(wid), `Design done, PR merged.\n\nDONE: ${id}\nLearned: nothing new`);
    await new Promise((r) => setTimeout(r, 200));
    assert.notEqual(store.work.get(id)!.status, 'done');
    return id;
  };
  const id = await handedUp('boss music', 'pc/alpha');
  const w = () => store.work.get(id)!;
  const at = Date.parse(w().handedUp!.at);

  // 1 h: nothing yet. 3 h: sent again, once, saying it becomes a card, not that FF Factory files it.
  clock.now = () => new Date(at + 3_600_000);
  assert.equal(o.handUpStep(w()), undefined);
  clock.now = () => new Date(at + 3 * 3_600_000);
  assert.equal(o.handUpStep(w()), 'resent');
  await until('sent again', () => heard(ben.id, '[follow-ups to file]').length === 2);
  const again = heard(ben.id, '[follow-ups to file]')[1].text;
  assert.match(again, /Sent again: 2 of them are still not filed, 3 h after the hand-up\. .*become a card for Ben .*FF Factory never files them by itself/s);
  assert.equal(o.handUpStep(w()), undefined, 'sent again once');

  // 13 h: one card for Ben, nothing filed; later sweeps change nothing.
  const before = new Set(store.work.keys());
  clock.now = () => new Date(at + 13 * 3_600_000);
  assert.equal(o.handUpStep(w()), 'card');
  const cardAt = w().handedUp!.card;
  assert.ok(cardAt);
  const live = handUpLive(w(), clock.now().getTime())!;
  assert.equal(live.handUpCard, true);
  assert.deepEqual(live.waitsOn, ['Ben']);
  assert.ok(!live.backlog && !live.orchestrator, 'a person’s card, not an orchestrator’s backlog');
  for (const h of [14, 20, 48]) {
    clock.now = () => new Date(at + h * 3_600_000);
    assert.equal(o.handUpStep(w()), undefined, `no second card at ${h} h`);
  }
  assert.equal(w().handedUp!.card, cardAt);
  assert.deepEqual([...store.work.keys()].filter((k) => !before.has(k)), [], 'FF Factory filed nothing');
  assert.equal(w().log.filter((l) => l.includes('a card for Ben now')).length, 1);
  assert.equal(handUpsPending(w()), 2);
  assert.notEqual(w().status, 'done');

  // Only the person it was handed up to clicks it.
  assert.throws(() => o.fileHandUps(id, { userId: 'maya', displayName: 'Maya' }), /handed up to Ben, who files or drops them/);

  // File: both follow-ups filed once, as Ben's requests related to the source; the request closes on its kept DONE.
  const r = o.fileHandUps(id, BEN);
  assert.equal(r.left, 0, r.text);
  const made = [...store.work.values()].filter((x) => !before.has(x.id));
  assert.deepEqual(made.map((x) => x.title).sort(), ['Compose the boss music loop', 'Record the boss music roar set']);
  for (const x of made) {
    assert.deepEqual(x.relatedIds, [id]);
    assert.equal(x.requestedBy.userId, 'ben');
  }
  assert.equal(handUpsPending(w()), 0);
  assert.equal(handUpLive(w(), clock.now().getTime()), undefined, 'the card is gone');
  await until('the request closes on its kept DONE', () => w().status === 'done');
  assert.throws(() => o.fileHandUps(id, BEN), /no handed-up follow-ups waiting/, 'File again files nothing');
  assert.equal([...store.work.values()].filter((x) => !before.has(x.id)).length, 2, 'filed once');

  // Drop: a second request's card, dropped with a reason: nothing filed, nothing pending, it closes.
  const id2 = await handedUp('dragon roar', 'pc/beta');
  const w2 = () => store.work.get(id2)!;
  const at2 = Date.parse(w2().handedUp!.at);
  clock.now = () => new Date(at2 + 13 * 3_600_000);
  assert.equal(o.handUpStep(w2()), 'card');
  const before2 = new Set(store.work.keys());
  o.dropHandUps(id2, BEN, 'not wanted after all');
  assert.equal(handUpsPending(w2()), 0);
  assert.deepEqual(w2().handedUp!.dropped && { by: w2().handedUp!.dropped!.by, note: w2().handedUp!.dropped!.note }, { by: 'Ben', note: 'not wanted after all' });
  assert.deepEqual([...store.work.keys()].filter((k) => !before2.has(k)), [], 'Drop files nothing');
  await until('the dropped request closes on its kept DONE', () => w2().status === 'done');
  assert.equal(o.handUpStep(w2()), undefined);
});

test('w4468: request_pair split lets a Mac host with no w3697 sentence in the brief; decide_work pair_allow and pair_split widen a queued pair and re-place it; a pair\'s named needs never hide room; a person\'s game ending pings capacity', async (t) => {
  const env = await twoComputers(t);
  const { store, agents, dispatcher, call } = env;
  const o = agents.orchestrators;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w4300', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w4300');
  const out = String(await a.h.request_pair!({ what: 'MP-W4440-belt-split on two computers', brief: 'Run MP-W4440-belt-split with ffnightly.py, leg 1 the host.', split: 'lab.pair-m5-beast.json spreads its peers' }));
  const filed = store.work.get(/^Filed (w\d+)/.exec(out)![1])!;
  assert.equal(filed.pair!.split, 'lab.pair-m5-beast.json spreads its peers', out);
  assert.doesNotMatch(filed.brief, /\(w3697\)/, 'a split pair takes no "No leg goes on a Mac" sentence');
  assert.doesNotMatch(out, /no leg on a Mac/);

  // w4334 as it stood: avoid [beast] from filing; lothsahn's note "drop the avoid" and "A Mac may host leg 1".
  putRequests(store, [{ id: 'w4334', by: BEN, status: 'queued', title: 'Pair run for w4300: MP-W4440-belt-split', brief: 'Run MP-W4440-belt-split with ffnightly.py.', pair: { legs: 2, for: 'w4300', avoid: ['beast'] }, constraints: pairText({ legs: 2, for: 'w4300', avoid: ['beast'] }) }]);
  const pings: string[] = [];
  const ping = o.capacityMayHaveFreed.bind(o);
  o.capacityMayHaveFreed = (why: string) => { pings.push(why); ping(why); };
  const r = await call(dispatcher().info, 'decide_work', { id: 'w4334', action: 'queue', pair_allow: ['beast'], pair_split: 'Lothsahn: "A Mac may host leg 1"', note: 'Lothsahn, 2026-11-16: "drop the avoid"' });
  assert.equal(r.isError, false, r.text);
  const w = store.work.get('w4334')!;
  assert.equal(w.pair!.avoid, undefined);
  assert.equal(w.pair!.split, 'Lothsahn: "A Mac may host leg 1"');
  assert.equal(w.constraints, pairText(w.pair!));
  assert.match(pings.join('\n'), /w4334's pair marks changed/);
  assert.equal((await call(dispatcher().info, 'decide_work', { id: 'w4300', action: 'queue', pair_allow: ['beast'], note: 'x' })).isError, true, 'not a pair run');

  // w4462: queued naming [lothdesktop]; pc and beast have room for both legs: flagged, its named needs ignored.
  putRequests(store, [{ id: 'w4462', by: BEN, status: 'queued', title: 'Pair run for w4300: join check', brief: 'Host on leg 1, join from leg 2.', pair: { legs: 2, for: 'w4300' } }]);
  store.putWork({ ...store.work.get('w4462')!, queuedFor: { at: T0, needs: ['lothdesktop'] } });
  for (const id of ['w4334']) store.putWork({ ...store.work.get(id)!, status: 'done' });
  agentsRoom(agents, ['pc', 'beast']);
  await call(dispatcher().info, 'list_work', { id: 'w4462' });
  const later = Date.now() + 11 * 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(later);
  assert.deepEqual(o.flagQueuedWithRoom(['pc', 'beast']), ['w4462']);

  // A person's game ending on a computer re-places the queue (the machines' stats handler calls onPlayEnded).
  pings.length = 0;
  env.machines.onPlayEnded!('pc');
  assert.match(pings.join('\n'), /a person's game on pc ended/);
});

// w4553 (lothsahn, 2026-11-17) found two ffu rows on the same code at start and held the later one Blocked; w5197 (lothsahn,
// 2026-11-23: "Let FFU look requests run at once; each merges main before pushing, and the later PR fixes conflicts") starts
// it all the same: both rows run, and each worker is told which files it shares and with whom.
test('w5197: two ffu rows that share a file both start, and both workers get the shared-files note; game work is never checked', async (t) => {
  const { store, agents, dispatcher, call } = await setupOnMachine(t);
  agentsRoom(agents, ['pc']);
  putRequests(store, [
    { id: 'w5189', repo: 'Final-Factory/ffu', title: 'FFU look: rim light', brief: 'Rim light on hulls.' },
    { id: 'w5164', repo: 'Final-Factory/ffu', title: 'FFU look: dark Assembler tops', brief: 'Assembler tops are too dark.' },
    { id: 'w5150', repo: 'Final-Factory/ffu', brief: 'Tech rewards in sector/rewards.rs.' },
    { id: 'w4420', brief: 'Fix crates/ffu-render/src/mesh.wgsl in the game repo (not ffu).' },
  ]);
  let reads = 0;
  (agents as unknown as { ffuReads: unknown }).ffuReads = { openPrs: async () => (reads++, []), hubs: async () => [] };
  const first = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', title: 'Rim light', work_id: 'w5189', prompt: 'Edit crates/ffu-render/src/mesh.wgsl.' });
  assert.equal(first.isError, false, first.text);
  assert.doesNotMatch(first.text, /w5197/, 'nothing in flight shares its files');
  assert.deepEqual(store.work.get('w5189')!.ffuFiles, ['crates/ffu-render/src/mesh.wgsl']);
  const s1 = store.work.get('w5189')!.sessionIds[0];
  await until('w5189 ends its first turn', () => store.sessions.get(s1)?.status === 'idle');

  const second = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', title: 'Assembler tops', work_id: 'w5164', prompt: 'Darken less in crates/ffu-render/src/mesh.wgsl.', extra_agent: true });
  assert.equal(second.isError, false, second.text);
  assert.match(second.text, /^Started agent .* It may edit files other ffu work in flight edits \(w5197\): w5189 \(in flight, no pull request yet\): crates\/ffu-render\/src\/mesh\.wgsl; it was told, and so was each of those requests' worker/);
  const w = store.work.get('w5164')!;
  assert.notEqual(w.status, 'blocked');
  assert.equal(w.blocked, undefined);
  assert.equal(w.sessionIds.length, 1);
  const s2 = w.sessionIds[0];
  await until('w5164 ends its first turn', () => store.sessions.get(s2)?.status === 'idle');
  assert.match(JSON.stringify(store.readTranscript(s2)), /w5164 may edit files other ffu work in flight edits: w5189 \(in flight, no pull request yet\): crates\/ffu-render\/src\/mesh\.wgsl\. Nothing waits on it: merge origin\/main/);
  await until('w5189 is told', () => JSON.stringify(store.readTranscript(s1)).includes('w5164 just started on ffu work that may edit files yours edits too: crates/ffu-render/src/mesh.wgsl'));
  assert.ok(w.log.some((l) => /ffu files shared with work in flight \(w5197\), started anyway: w5189 .*mesh\.wgsl/.test(l)), w.log.join('\n'));
  assert.ok(store.work.get('w5189')!.log.some((l) => l.includes(`ffu files shared with w5164 (w5197): told ${s1}`)), store.work.get('w5189')!.log.join('\n'));

  // A row on other files gets no note.
  const other = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', title: 'Rewards', work_id: 'w5150', prompt: 'Edit crates/ffu-sim/src/sector/rewards.rs.', extra_agent: true });
  assert.doesNotMatch(other.text, /w5197/, other.text);
  // The peer note starts a turn for w5189's worker: let every worker go idle, as a game start needs a free sandbox (w1607).
  await until('every worker is idle', () => [...store.sessions.values()].every((x) => x.status !== 'running' && x.status !== 'starting'));
  // Game work is not read at all.
  const before = reads;
  await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Go.', title: 'Game', work_id: 'w4420', extra_agent: true });
  assert.equal(reads, before);
  // A gh failure starts the row (logged), with no note.
  (agents as unknown as { ffuReads: unknown }).ffuReads = { openPrs: async () => { throw new Error('HTTP 401'); }, hubs: async () => [] };
  putRequests(store, [{ id: 'w4421', repo: 'Final-Factory/ffu', brief: 'crates/ffu-platform/src/lib.rs' }]);
  await until('every worker is idle again', () => [...store.sessions.values()].every((x) => x.status !== 'running' && x.status !== 'starting'));
  const open = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Go.', title: 'Fails open', work_id: 'w4421', extra_agent: true });
  assert.match(open.text, /^Started agent/, open.text);
});

test('w4613: request_pair with a published player: a leg on a computer of its OS is told to fetch it with fetch_attachment and skip the build; a leg on another OS gets no such line; a player of another commit is refused', async (t) => {
  const env = await twoComputers(t);
  const { dir, store, agents, dispatcher, call } = env;
  const files = new AttachmentStore(path.join(dir, 'att'));
  agents.attachments = files;
  const sha = '670a034960aa11bb22cc33dd44ee55ff66778899';
  const packed = path.join(dir, `player-${sha}-win.tar.gz`);
  fs.writeFileSync(packed, 'a packed player');
  const att = await files.addFile(packed, { source: 'worker "w665" on pc', session: 'x' });
  const note = path.join(dir, 'notes.txt');
  fs.writeFileSync(note, 'not a player');
  const plain = await files.addFile(note, { source: 'worker "w665" on pc', session: 'x' });
  putRequests(store, [{ id: 'w665', by: BEN, status: 'active' }]);
  const a = await startedFor(env, 'w665');
  const ask = (extra: Record<string, unknown>) => a.h.request_pair!({ what: 'MP determinism pair on PR #2340', brief: 'Run the MP determinism pair on the branch; pass: none diverged.', legs: 1, ...extra });
  await assert.rejects(async () => ask({ player: plain.id }), /player: att_\w+ is notes\.txt, not a packed game player/);
  await assert.rejects(async () => ask({ player: 'att_zzzzzzzzzzzz' }), /player: no attachment "att_zzzzzzzzzzzz"/);
  await assert.rejects(async () => ask({ player: att.id, commit: 'abcdef1234' }), new RegExp(`player ${att.id} is a player of 670a034960, not of commit abcdef1234`));
  const out = String(await ask({ player: att.id }));
  const id = /^Filed (w\d+)/.exec(out)![1];
  assert.deepEqual(store.work.get(id)!.pair!.player, { id: att.id, key: `${sha}-win`, os: 'win', size: fs.statSync(packed).size });
  assert.equal(store.work.get(id)!.pair!.commit, sha, "without commit, the player's commit is the run's");
  const ok = await call(dispatcher().info, 'start_agent', { work_id: id, prompt: 'Run the MP determinism pair.', title: 'MP pair', sandbox: 'beast/slot1' });
  assert.equal(ok.isError, false, ok.text);
  const leg = store.sessions.get(store.work.get(id)!.pair!.started!.legs[0].session)!;
  await until('the leg ends its first turn', () => leg.status === 'idle');
  const said = JSON.stringify(store.readTranscript(leg.id));
  assert.match(said, /Fetch the requester's player instead of building it \(w4613\)/);
  assert.ok(said.includes(`Call fetch_attachment with id ${att.id} before anything else`), 'the leg on beast (Windows) fetches the Windows player');
  // Another OS gets nothing (it builds as before); a computer that already holds the commit gets w4601's line instead.
  const player = store.work.get(id)!.pair!.player!;
  assert.equal(fetchPlayerNote(sha, player, { platform: 'linux' }), '');
  assert.equal(fetchPlayerNote(sha, player, { platform: 'darwin' }), '');
  assert.match(fetchPlayerNote(sha, player, { platform: 'win32' }), /attachment att_\w+, 0 MB packed/);
  assert.match(fetchPlayerNote('1234567', player, { platform: 'win32' }), /the run's commit is 1234567: if it is not 670a034960, build instead/);
});

test('w4634: decide_work with no action sets only timed, report or pair marks; done refuses w4592\'s placeholder close', async (t) => {
  const env = setup(t);
  const { store, agents, dispatcher, call } = env;
  agentsRoom(agents, []);
  putRequests(store, [
    { id: 'w1', by: LOTH, status: 'new', title: 'Release the next 1.0 build (1.0.0.50)', brief: 'Run a timed bench before the release.' },
    { id: 'w2', by: LOTH, status: 'new', title: 'Why did the build slow down?' },
  ]);
  // w4592's own call, as it happened: refused, and the flag stays as it was.
  const was = needsTimed(store.work.get('w1')!);
  const bad = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'done', timed: false, note: 'placeholder' });
  assert.equal(bad.isError, true, bad.text);
  assert.match(bad.text, /placeholder note/);
  assert.equal(store.work.get('w1')!.status, 'new');
  assert.equal(needsTimed(store.work.get('w1')!), was);
  // A real-looking note on a request no worker reported on: refused too.
  const unworked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'done', note: 'the release has gone out to players' });
  assert.equal(unworked.isError, true, unworked.text);
  assert.match(unworked.text, /no worker ever reported on w1/);
  assert.equal(store.work.get('w1')!.status, 'new');
  // No action: only the flag changes.
  const flag = await call(dispatcher().info, 'decide_work', { id: 'w1', timed: false, note: 'a release, it times nothing' });
  assert.equal(flag.isError, false, flag.text);
  assert.match(flag.text, /w1 is not timed work now/);
  assert.equal(store.work.get('w1')!.status, 'new');
  assert.equal(needsTimed(store.work.get('w1')!), false);
  const report = await call(dispatcher().info, 'decide_work', { id: 'w2', report: 'analysis', note: 'a person asked why' });
  assert.equal(report.isError, false, report.text);
  assert.equal(store.work.get('w2')!.report?.kind, 'analysis');
  assert.equal(store.work.get('w2')!.status, 'new');
  // No action and no flag, or an action's own field without its action: refused.
  const empty = await call(dispatcher().info, 'decide_work', { id: 'w2', note: 'hm' });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /needs an action/);
  const stray = await call(dispatcher().info, 'decide_work', { id: 'w2', into: 'w1', timed: false, note: 'merge it' });
  assert.equal(stray.isError, true);
  assert.match(stray.text, /into belongs to an action/);
  // Done with a reason still closes it.
  const ok = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'done', note: 'it repeats w1, which covers the same question' });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(store.work.get('w2')!.status, 'done');
});

test('w4925: a pair run that has not started is not blocked on a named computer or an hour while another computer has room, unless a person asked; one blocked so beside room is flagged', async (t) => {
  const { store, agents, o, dispatcher, chat, call, heard } = setup(t);
  agentsRoom(agents, []);
  await call(chat(BEN).info, 'request_work', { title: 'MP pair check', brief: 'Run the pair.' });
  await call(chat(BEN).info, 'request_work', { title: 'Second MP pair check', brief: 'Run the pair.' });
  for (const id of ['w1', 'w2']) {
    const q = await call(dispatcher().info, 'decide_work', { id, action: 'queue', note: 'every computer is busy', pair_legs: 1 });
    assert.equal(q.isError, false, q.text);
  }
  const until6 = new Date(Date.now() + 6 * 3_600_000).toISOString();
  // w2 is blocked on an hour while nothing has room: allowed.
  const ok = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'block', note: 'wait for the morning', blocker: { kind: 'time', until: until6, what: 'the morning' } });
  assert.equal(ok.isError, false, ok.text);
  // w4622: biscuit frees, and the dispatcher would park w1 on an hour (or lothlaptop) anyway: refused, naming the room.
  agentsRoom(agents, ['biscuit']);
  const refused = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'only a Windows computer will do', blocker: { kind: 'time', until: until6, what: 'lothlaptop free' } });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /w1 is a pair run of 1 leg.*biscuit has room for it now: a pair run waits for no named computer or time \(w4925/);
  assert.equal(store.work.get('w1')!.status, 'queued');
  // A person's words let it wait, and are kept so the ledger does not flag it.
  const asked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'lothsahn asked', blocker: { kind: 'time', until: until6, what: 'the morning' }, override_gate: 'lothsahn: keep it waiting until morning' });
  assert.equal(asked.isError, false, asked.text);
  assert.equal(store.work.get('w1')!.pair?.waitAsked, 'lothsahn: keep it waiting until morning');
  // w2, blocked by the dispatcher alone, is flagged once biscuit's room has stood past the grace; w1 is not.
  await call(dispatcher().info, 'list_work', { id: 'w2' });
  const later = Date.now() + 11 * 60_000;
  (o as unknown as { now: () => Date }).now = () => new Date(later);
  assert.deepEqual(o.flagQueuedWithRoom(['biscuit']), ['w2']);
  assert.deepEqual(o.flagQueuedWithRoom(['biscuit']), [], 'once an hour at most');
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[ledger] WRONG STATE: a pair run').length > 0);
  assert.match(heard(dispatcher().info.id, '[ledger] WRONG STATE: a pair run')[0].text, /w2 "Second MP pair check" .*room on biscuit\)/);
  assert.match(store.work.get('w2')!.log.join('\n'), /flagged: blocked on .* while biscuit has room for this pair run/);
});

test('w4925: a pair run whose commit CI failed to compile ends with the error lines before its legs run, and its asker is cleared with them', async (t) => {
  const { store, o, dispatcher, chat, call } = setup(t);
  await call(chat(BEN).info, 'request_work', { title: 'Black hole station fix', brief: 'Fix it.' });
  await call(chat(BEN).info, 'request_work', { title: 'MP pair check of the fix', brief: 'Run the pair.' });
  const sha = '9cc67303f5c74aa88ffd7cf53369a1ec77bfe68b';
  store.putWork({ ...store.work.get('w2')!, status: 'queued', queuedFor: { at: new Date().toISOString() }, pair: { legs: 1, for: 'w1', commit: sha.slice(0, 12) } });
  const b = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'block', note: 'waits on its pair run', blocker: { kind: 'request', ref: 'w2', what: 'its pair run' } });
  assert.equal(b.isError, false, b.text);
  const reads: string[] = [];
  let verdict: { done: boolean; lines?: string[]; run?: string } = { done: false };
  let clock = Date.now();
  const watch = new BlockerWatch({ store, orchestrators: o, now: () => clock, compile: async (repo, s) => (reads.push(`${repo}@${s}`), verdict) });
  // CI still running: nothing happens, and the commit is read again only after COMPILE_READ_MS.
  await watch.tick();
  await watch.tick();
  assert.deepEqual(reads, [`Final-Factory/FinalFactory@${sha.slice(0, 12)}`]);
  assert.equal(store.work.get('w2')!.status, 'queued');
  // w4880's case: CI went red on CS0103 five minutes after request_pair.
  verdict = { done: true, lines: ["Assets/Tests/BlackHoleStationSwallowTest.cs(41,13): error CS0103: The name 'FpExtensions' does not exist in the current context"], run: 'https://github.com/Final-Factory/FinalFactory/actions/runs/44694929723' };
  clock += COMPILE_READ_MS;
  const did = await watch.tick();
  assert.match(did.get('w2')!, /^closed: did not compile at 9cc67303f5: CI \(https:\/\/github.com\/Final-Factory\/FinalFactory\/actions\/runs\/44694929723\) failed with Assets\/Tests\/BlackHoleStationSwallowTest.cs\(41,13\): error CS0103/);
  const p = store.work.get('w2')!;
  assert.equal(p.status, 'done');
  assert.match(p.outcome!, /^FAIL: did not compile at 9cc67303f5.*No player was run: fix the build, push, and request_pair again/);
  // Its asker, blocked on it, is cleared with the errors on the next look; a finished commit is never read again.
  await watch.tick();
  assert.notEqual(store.work.get('w1')!.status, 'blocked');
  assert.equal(reads.length, 2);
});

test('w4925: compileErrorsIn and ghCompileVerdict read the C# errors of a failed run at a commit, once each', async () => {
  const log = [
    'Test in editmode\tUNKNOWN STEP\t2026-11-20T07:30:01.1Z Assets/Tests/A.cs(41,13): error CS0103: The name \'X\' does not exist in the current context',
    'Test in editmode\tUNKNOWN STEP\t2026-11-20T07:30:02.1Z Assets/Tests/A.cs(41,13): error CS0103: The name \'X\' does not exist in the current context',
    'Test in editmode\tUNKNOWN STEP\t2026-11-20T07:30:03.1Z error CS1002: ; expected',
    'Test in editmode\tUNKNOWN STEP\t2026-11-20T07:30:04.1Z ##[error]Process completed with exit code 1.',
  ].join('\n');
  assert.deepEqual(compileErrorsIn(log), ["Assets/Tests/A.cs(41,13): error CS0103: The name 'X' does not exist in the current context", 'error CS1002: ; expected']);
  const full = 'a'.repeat(40);
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push(args.join(' '));
    if (args[1]?.startsWith('repos/o/r/commits/')) return { code: 0, stdout: `${full}\n`, stderr: '' };
    if (args[1]?.startsWith('repos/o/r/actions/runs')) return { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 7, name: 'Test Runner', status: 'completed', conclusion: 'failure', head_sha: full, html_url: 'https://x/runs/7' }, { id: 8, name: 'Lint', status: 'in_progress', head_sha: full }] }), stderr: '' };
    if (args[0] === 'run') return { code: 0, stdout: log, stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${cmd} ${args.join(' ')}` };
  };
  const v = await ghCompileVerdict('o/r', 'aaaaaaa', run);
  assert.deepEqual(v, { done: true, lines: compileErrorsIn(log), run: 'https://x/runs/7' });
  assert.deepEqual(calls, ['api repos/o/r/commits/aaaaaaa --jq .sha', `api repos/o/r/actions/runs?head_sha=${full}&per_page=50`, 'run view 7 -R o/r --log-failed']);
  // A failure that is no compile error (a test failed): no lines, done only once every run finished.
  const green = await ghCompileVerdict('o/r', full, async (_c, args) => (args[0] === 'run' ? { code: 0, stdout: 'Test in editmode\tx\t1 Expected 3 but was 4', stderr: '' } : { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 7, status: 'completed', conclusion: 'failure', head_sha: full }] }), stderr: '' }));
  assert.deepEqual(green, { done: true });
});

test('w5341: a pair leg here is sent one level up while its other leg holds a Unity slot on another machine, and no longer once it lets go', async (t) => {
  const env = await setupOnMachine(t);
  const { store, agents } = env;
  putRequests(store, [{ id: 'w1', by: BEN, status: 'active', priority: 'normal' }]);
  const a = await startedFor(env, 'w1');
  const pc = store.machines.get('pc')!;
  const beta = { ...pc.sandboxes![0], id: 'beta', unity: { ...pc.sandboxes![0].unity, state: 'running' as const } };
  store.putMachine({ ...pc, id: 'other', sandboxes: [beta] });
  store.sessions.set('leg2', { ...a.info, id: 'leg2', machineId: 'other', machineSandbox: 'beta' });
  const at = new Date().toISOString();
  store.putWork({ ...store.work.get('w1')!, pair: { legs: 2, started: { at, legs: [{ session: a.id, sandbox: 'pc/alpha' }, { session: 'leg2', sandbox: 'other/beta' }] } } });
  const mark = agents.benchPriorities('pc')[a.id];
  assert.equal(pc.sandboxes![0].unity.state === 'stopped' || pc.sandboxes![0].unity.state === 'crashed', true, 'this leg holds no slot here');
  assert.equal(mark.priority, 'high', 'normal → high while leg2 holds its side on other');
  assert.deepEqual({ half: mark.pair?.half, from: mark.pair?.from, work: mark.pair?.work, others: mark.pair?.others }, { half: 'waiting', from: 'normal', work: 'w1', others: ['other'] });
  // leg2's editor stops: the raise goes with it.
  store.putMachine({ ...store.machines.get('other')!, sandboxes: [{ ...beta, unity: { ...beta.unity, state: 'stopped' } }] });
  assert.deepEqual(agents.benchPriorities('pc')[a.id], { priority: 'normal', requests: ['w1'] });
});
