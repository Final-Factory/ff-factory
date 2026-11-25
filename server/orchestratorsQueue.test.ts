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
 * The orchestrator tests (docs/orchestrators.md), end to end on a real Agents with the scripted agent: budget hits, priorities and the queue's order, pair runs filed by hand, more pair legs.
 * One of the server/orchestrators*.test.ts files split out of orchestrators.test.ts (w5826); helpers in orchestratorsTestKit.ts.
 */


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
