// The helpers of the orchestrator tests (w5826): server/orchestrators*.test.ts, split out of one orchestrators.test.ts of
// 334 tests that took 481 s on a Windows runner, so node --test runs and shards them as separate files.
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


/**
 * People's own orchestrators and the dispatcher (docs/orchestrators.md), end to end on a real Agents with the scripted
 * fake SDK: the migration from one shared chat, each role's tools, filing and the overlap check, the dispatcher's
 * decisions and replies, where worker updates go, follow-ups, and the guards on attribution and destructive tools.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

/** "#slow" turns of about 1 s (40 pieces 25 ms apart) instead of 4 s, for a test that waits for one to end. */
export function shortSlowTurns(t: { after: (fn: () => void) => void }) {
  setQueryForTesting(fakeQuery({ stepMs: 1, slowStepMs: 25 }) as never);
  t.after(() => setQueryForTesting(fakeQuery({ stepMs: 1 }) as never));
}

export const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
export const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
export const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];
/** Someone who is neither owner (w627: the message_person count still holds for her). */
export const CARA: Requester = { userId: 'cara', displayName: 'Cara' };
export const WITH_CARA: UserInfo[] = [...PEOPLE, { ...CARA, role: 'member' }];
export const T0 = '2026-09-28T09:00:00.000Z';

/**
 * Every session whose turnEnd signal a test's portal handled (setup's listener). A worker on a test machine reports the end of
 * its turn as two messages, its idle status and then the turnEnd signal (server/sessions.ts update then emitTurnEnd), and under
 * load the portal handled the signal a moment after the idle status was seen: a test that went on at "idle" had that first turn
 * end land in its next step, after a drop it faked (w2433, w3759) or after a question it raised (w1812, w3766).
 */
export const turnEnded = new Set<string>();

/** Waits until the session's turn has fully ended: its idle status and its turnEnd signal both handled (turnEnded above). */
export async function firstTurn(info: { id: string; status: string }, what = 'its first turn to end') {
  await until(what, () => info.status === 'idle' && turnEnded.has(info.id));
}

export async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function setup(t: { after: (fn: () => void | Promise<void>) => void }, opts: { legacy?: boolean; notify?: boolean; people?: UserInfo[]; hostAlpha?: boolean; gatherMs?: number } = {}) {
  useFakeVault();
  t.after(() => setVaultContext(undefined));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-orch-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: opts.notify ?? true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  if (opts.legacy) {
    // The one shared orchestrator from before, with a conversation and the global heartbeat.
    const main: SessionInfo = { id: 'main1', kind: 'orchestrator', title: 'Main', status: 'idle', permissionMode: 'default', createdAt: T0, lastActivityAt: T0, turns: 3, costUsd: 1, pendingPermissions: [], sdkSessionId: 'fake-main' };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sandboxes: [], sessions: [main], orchestratorId: 'main1', settings: { heartbeatMinutes: 15 } }));
    fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcripts', 'main1.jsonl'), JSON.stringify({ seq: 1, t: T0, kind: 'user', text: 'start work on spec 098', from: 'human', requestedBy: BEN }) + '\n');
  }
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  sessions.events.on('turnEnd', (x: { info: { id: string } }) => turnEnded.add(x.info.id));
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => opts.people ?? PEOPLE));
  agents.boot();
  // Notices to the dispatcher gather 1.5 s in production; 100 ms here, unless a test is about the gathering.
  (agents.orchestrators as unknown as { d: { gatherMs: number } }).d.gatherMs = opts.gatherMs ?? 100;
  /** Run first at the end (a machine's daemon goes before the portal's folder). */
  const closers: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const c of closers) await c();
    agents.close();
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const o = agents.orchestrators;
  const dispatcher = () => sessions.get(agents.dispatcherId);
  const chat = (r: Requester) => o.personalFor(r);
  /** Call one of an orchestrator's tools as its model would. */
  const call = async (info: SessionInfo, name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === name);
    if (!tool) throw new Error(`${info.title} has no ${name}`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  /** Harness messages a session got carrying `tag` (notices gathered into one message each keep their tag at a line start). */
  const heard = (id: string, tag: string) =>
    store.readTranscript(id).filter((e): e is Extract<TranscriptEvent, { kind: 'user' }> => e.kind === 'user' && e.from === 'system' && e.text.split('\n').some((l) => l.startsWith(tag)));
  /** What a personal orchestrator is told about message_person: its tool's description and its brief. */
  const toldAbout = (info: SessionInfo) =>
    `${agents.orchestratorBelt(info).find((x) => x.name === 'message_person')!.description}
${(agents as unknown as { personalBrief(r: Requester): string }).personalBrief(info.requestedBy!)}`;
  return { dir, cfg, store, sessions, machines, closers, agents, o, dispatcher, chat, call, heard, toldAbout };
}

/** Sandbox alpha on a machine (pc/alpha, a worktree on its in-process daemon): the portal holds none of its own (w510). */
export async function setupOnMachine(t: { after: (fn: () => void | Promise<void>) => void }, opts: Parameters<typeof setup>[1] = {}, machine: TestMachineOptions = {}) {
  const env = setup(t, { ...opts, hostAlpha: false });
  const pc = await startTestMachine(env.machines, { sandboxes: ['alpha'], ...machine });
  env.closers.push(() => pc.stop());
  return { ...env, pc };
}

// ---------------------------------------------------------------- w677: owners work across each other's requests

export const OWNERS: UserInfo[] = [{ ...BEN, role: 'owner' }, { ...LOTH, role: 'owner' }, { ...CARA, role: 'member' }];
export type UserEv = Extract<TranscriptEvent, { kind: 'user' }>;

// ---------------------------------------------------------------- w343: which threads and reports a request claims

export const R1 = '20261003T222237Z-desync-87b7e4f96f';
export const R2 = '20261003T222246Z-desync-03a1228f27';
export const R3 = '20261004T013255Z-desync-a18df1bf15';
export const TH = '1556096235277000837';

// ---------------------------------------------------------------- w1867: timers' own filings limit, and the investigation bug

/** Fire a fresh timer on `sid` now, through the timers' own delivery (agents.ts), and answer its id. */
export async function fireTimer(agents: Agents, store: Store, sid: string, title: string, createdBy: string, minutesAhead: number): Promise<string> {
  // A fire waits for the end of a turn in progress (timers.ts flush): fire it once the chat is idle.
  await until('the chat is idle', () => !['running', 'starting'].includes(store.sessions.get(sid)!.status));
  const timer = agents.timers.create(sid, { title, note: `${title}.`, schedule: { every_minutes: 240 } }, createdBy);
  const real = agents.timers.now;
  agents.timers.now = () => Date.now() + minutesAhead * 60_000;
  agents.timers.tick();
  agents.timers.now = real;
  return timer.id;
}

/** The requests FF Factory filed by itself to look into an orchestrator's filings. */
export const investigations = (store: Store) => [...store.work.values()].filter((w) => w.title.startsWith('Investigate: '));

/** The computers with room, as the dispatcher's tools see them (Agents.roomNow, read by Orchestrators' `room`). */
export function agentsRoom(agents: Agents, ids: string[]) {
  agents.roomNow = () => ids;
}

/** w1767 and w1768 as on 2026-10-22: one worker, c28c5061, held both and asked one set of questions without naming either. */
export async function twoRequestsOneWorker(t: Parameters<typeof setupOnMachine>[0]) {
  const env = await setupOnMachine(t);
  const { store, machines, dispatcher, chat, call } = env;
  const ben = chat(BEN).info;
  await call(ben, 'request_work', { title: 'Circuit markers in normal view', brief: 'Design and mocks.' });
  await call(ben, 'request_work', { title: 'Circuit alt mode', brief: 'Design and mocks, one visual family with w1.', related_ids: ['w1'] });
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Do it', title: 'w1: Circuit markers in normal view', work_id: 'w1' });
  assert.equal(started.isError, false, started.text);
  const id = /Started agent (\w+)/.exec(started.text)![1];
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  const linked = await call(dispatcher().info, 'decide_work', { id: 'w2', action: 'link', note: 'One designer for both.', session_ids: [id], title: 'w1 and w2: circuit design and mocks' });
  assert.equal(linked.isError, false, linked.text);
  const h = machines.hooks!.handlersFor(info, store.machines.get('pc')!);
  return { ...env, ben, id, info, h };
}
export const CIRCUIT_QUESTIONS = [
  { question: 'Which way should structures with circuit conditions be marked in normal view?', options: [{ label: 'Go with B: the trace, with held-off structures powered down', recommended: true }, { label: 'Go with A: a small badge on each one' }] },
  { question: 'Which key turns the circuit view on?', options: [{ label: 'Use L, and a long press of D-pad up on a pad', recommended: true }, { label: 'Cycle the alt modes with Alt' }] },
];
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- w1868: each question its own card and its own answer

/** w1821 as on 2026-10-23: one worker asked two questions (the frame look, the Station strip) on one request. */
export const FRAME_Q = { question: 'How solid should a window frame be where windows stack?', options: [{ label: 'Keep frames see-through over space, solid only over a window', recommended: true }, { label: 'Make every frame fully solid' }] };
export const STRIP_Q = { question: 'When a window covers the Station strip, what should come up over it?', options: [{ label: 'The whole strip comes up over the window', recommended: true }, { label: 'Only the Hide button comes up over the window' }] };
export const wakeOf = (agents: Agents, id: string) => (agents as unknown as { waker: { pending(id: string): { note: string } | undefined } }).waker.pending(id);

// ---------------------------------------------------------------- w740: one session per request

export const firstSaid = (store: Store, id: string) => (store.readTranscript(id).find((e) => e.kind === 'user') as { text: string } | undefined)?.text ?? '';

// ---------------------------------------------------------------- w1076: a request runs on its own person's tokens

/** Each person has a Claude token of their own (config userClaudeEnv), so a process records whose it started on (ranFor). */
export async function setupTwoAccounts(t: Parameters<typeof setupOnMachine>[0]) {
  const env = await setupOnMachine(t, { people: [{ ...BEN, role: 'owner' }, { ...LOTH, role: 'owner' }] });
  (env.cfg as { userClaudeEnv?: Record<string, Record<string, string>> }).userClaudeEnv = {
    ben: { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'b'.repeat(40)}` },
    lothsahn: { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'l'.repeat(40)}` },
  };
  /** A request as the ledger holds it, filed for `who` (the filing tools cap a message's filings). */
  const file = (id: string, who: Requester, over: Partial<WorkItem> = {}) => {
    const w = { id, title: `Job ${id}`, brief: `Do ${id}.`, priority: 'normal', keys: [], requestedBy: who, requesters: [who], humanAsked: true, status: 'new', createdAt: T0, updatedAt: T0, sessionIds: [], overlaps: [], asks: 0, log: [], ...over } as WorkItem;
    env.store.putWork(w);
    env.store.workSeq = Math.max(env.store.workSeq, Number(id.slice(1)));
    return w;
  };
  /** Ben's worker on Ben's w1 in pc/alpha, idle, its process on Ben's token. */
  const bensWorker = async () => {
    file('w1', BEN, { title: 'Rocket Adapters burn cargo' });
    const started = await env.call(env.dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Show the burn', title: 'Adapters', work_id: 'w1' });
    const id = /Started agent (\w+)/.exec(started.text)![1];
    await until('idle on Ben\'s token', () => env.sessions.get(id).info.status === 'idle' && env.sessions.get(id).info.ranFor === 'ben');
    return id;
  };
  return { ...env, file, bensWorker };
}

// ---------------------------------------------------------------- w754: gates outlive a hold, several gates, no polling

/** Requests as the ledger holds them, filed directly (filing through request_work is capped per message). */
export function putRequests(store: Store, rows: (Partial<WorkItem> & { id: string; by?: Requester })[]) {
  for (const { by: given, ...r } of rows) {
    const by = given ?? LOTH;
    store.putWork({ title: `Request ${r.id}`, brief: 'Do it.', priority: 'normal', keys: [], requestedBy: by, requesters: [by], humanAsked: true, createdAt: T0, updatedAt: T0, sessionIds: [], overlaps: [], asks: 0, log: [], ...r, status: r.status ?? 'new' });
  }
  store.workSeq = Math.max(store.workSeq, ...rows.map((r) => Number(r.id.slice(1))));
}

// ---------------------------------------------------------------- w890: waiting on a deploy or a person frees the sandbox

/** A worker started for request `wid` in pc/alpha, past its first turn. */
export async function startedFor(env: Awaited<ReturnType<typeof setupOnMachine>>, wid: string, extra: Record<string, unknown> = {}) {
  const { store, machines, dispatcher, call } = env;
  const before = new Set(store.work.get(wid)?.sessionIds ?? []);
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: 'Fix it', title: `${wid}: fix`, work_id: wid, extra_agent: true, ...extra });
  assert.equal(started.isError, false, started.text);
  // w5278: a sandbox handed over first (a released worker's branch) answers at once; the worker starts once it is switched.
  const fresh = () => (store.work.get(wid)?.sessionIds ?? []).find((x) => !before.has(x));
  if (/^Starting /.test(started.text)) {
    // w5915: the hand-over's own end, not a time: it runs some 30 git processes, which outran a 5 s wait on a loaded BEAST.
    await env.agents.settled();
    assert.ok(fresh(), `${wid}'s worker did not start after the hand-over (its reason is in the log above)`);
  }
  const id = /Started agent (\w+)/.exec(started.text)?.[1] ?? fresh()!;
  const info = store.sessions.get(id)!;
  await firstTurn(info);
  return { id, info, h: machines.hooks!.handlersFor(info, store.machines.get('pc')!) };
}

/** Room for each kind of work, as the dispatcher's tools and the page see it (Agents.roomFacts, w1089, w1098). */
export function agentsRoomFacts(agents: Agents, r: { game?: string[]; agent?: string[]; held?: { id: string; why: string; for: ('game' | 'agent')[] }[] }) {
  const f = { game: r.game ?? [], agent: r.agent ?? [], held: r.held ?? [] };
  agents.roomNow = () => f.game;
  agents.roomFacts = () => f;
}

/**
 * w1607 as it happened (2026-10-20 04:35 UTC, beast/slot1): w1440's worker 9c38a500 was between turns with a Unity batch
 * build running in the sandbox, on sandbox/slot1-w1440, the branch an earlier w1440 session (80b00fed) had released. The
 * dispatcher started w1602, an FF Factory change, beside it with extra_agent, and the start's hand-over saw 80b00fed's
 * branch and switched the worktree under the build. Here: worker A on w1 builds in pc/alpha, released worker R had A's
 * branch, and B (w2, another repo) and C (w3, game work) arrive.
 */
export async function busySandbox(t: Parameters<typeof setupOnMachine>[0]) {
  const env = await setupOnMachine(t, {}, { maxAgentsPerSandbox: 2 });
  const { store, sessions, machines, agents, dispatcher, call, pc } = env;
  agentsRoom(agents, ['pc']);
  putRequests(store, [{ id: 'w1' }, { id: 'w2', needs: 'agent', repo: 'Final-Factory/ff-factory' }, { id: 'w3' }]);
  const start = (wid: string, extra: Record<string, unknown> = {}) => call(dispatcher().info, 'start_agent', { sandbox: 'pc/alpha', prompt: `${wid} work`, title: `${wid}: job`, work_id: wid, ...extra });
  const first = await start('w1');
  assert.equal(first.isError, false, first.text);
  const a = sessions.get(/Started agent (\w+)/.exec(first.text)![1]);
  await until('A is between turns', () => a.live && a.info.status === 'idle');
  // Its batch build runs in the background: "Working: Unity batch build bench-sl1, between turns".
  Object.assign(a.info, { backgroundTasks: 1, backgroundJobs: [{ type: 'local_bash', description: 'Unity batch build bench-sl1' }] });
  const sb = () => machines.requireSandbox('pc', 'alpha');
  const branch = sb().git?.branch ?? sb().branch;
  sb().git = { branch, dirty: 0, untracked: 0, at: new Date().toISOString() };
  // The earlier session of the same work released the sandbox on that branch (80b00fed).
  const r: SessionInfo = { id: 'r80b00fe', kind: 'worker', title: 'w1: earlier session', status: 'stopped', permissionMode: 'bypassPermissions', createdAt: T0, lastActivityAt: T0, turns: 4, costUsd: 1, pendingPermissions: [], sdkSessionId: 'fake-r', machineId: 'pc', machineSandbox: 'alpha', placeReleased: { at: T0, sandbox: 'alpha', branch, why: 'it waits on CI' } };
  store.putSession(r);
  sb().sessionIds = [...sb().sessionIds, r.id];
  const switches: string[] = [];
  machines.switchBranch = (async (_m: string, to: string) => {
    switches.push(to);
    throw new Error(`switched pc/alpha to ${to}`);
  }) as typeof machines.switchBranch;
  return { ...env, a, branch, start, switches, alpha: pc.path('alpha') };
}

// ---------------------------------------------------------------- w1094: a gate's clearing reaches the worker that set it

/** A second worker on request `wid` (w1049: the bug-5 and bug-6 workers shared one request), linked after the first. */
export async function secondWorkerOn(env: Awaited<ReturnType<typeof setupOnMachine>>, wid: string) {
  const b = await startedFor(env, `${wid}x`, { override_duplicate: 'another bug of the same request' });
  const w = env.store.work.get(wid)!;
  w.sessionIds = [...w.sessionIds, b.id];
  w.links = { ...w.links, [b.id]: { at: new Date(Date.now() + 1000).toISOString(), how: 'sent' } };
  env.store.putWork(w);
  const x = env.store.work.get(`${wid}x`)!;
  x.status = 'done';
  env.store.putWork(x);
  return b;
}

/** w2045: the merge-on-green pilot's arm, set on a test's orchestrators (the server reads worker.mergeOnGreenPilotPercent). */
export function mergeOnGreenArm(o: unknown, arm: (id: string) => boolean) {
  (o as { d: { mergeOnGreenPilot?: (id: string) => boolean } }).d.mergeOnGreenPilot = arm;
}

/**
 * w5549: GitHub reading each pull request as its worker's own (merge on green merges only that): head commit `head`, on a
 * branch named for its request (`<request>-fix`, `requestOf`, w1 by default) of the pull request's own repository.
 */
export function ownPrs(head: string | ((ref: string) => string), requestOf: (ref: string) => string = () => 'w1') {
  return async (ref: string): Promise<PrHealth> => ({ state: 'open', head: typeof head === 'string' ? head : head(ref), headRef: `${requestOf(ref)}-fix`, headRepo: ref.split('#')[0] });
}

/** w2153: a request's gates, each with the worker that set it (shared/blockers.ts gateSetter), sorted. */
export function gateRefs(w: WorkItem): string[] {
  return (w.blocked ? [w.blocked, ...(w.alsoBlocked ?? [])] : []).map((g) => `${g.by}: ${g.kind} ${g.ref ?? ''}`).sort();
}

// ---------------------------------------------------------------- w1126, w1128, w1129: a Claude pool hold, and resumes that outlive a gate

export const LOTH_TOKEN = 'vault-lothsahn-1 …EAAA';
export const POOL_HELD_UNTIL = '2026-10-12T12:50:00.000Z';

/** Lothsahn's pool as the usage gate reads it (index.ts gatePools): held until 12:50Z, or serving. */
export function lothPool() {
  const pool = { serving: false };
  const pools = (): [string, GatePoolToken[]][] => [
    ['lothsahn', [{ name: 'vault-lothsahn-1', last4: 'EAAA', priority: pool.serving, view: pool.serving ? { state: 'ok' } : { state: 'held', until: POOL_HELD_UNTIL } }]],
  ];
  return { pool, pools, usageClear: (ref: string) => poolForRef(ref, pools())?.serves };
}

/** A fake vault whose pool holds every run while `held.on` (machineRunEnv then throws PoolHeldError, as on 2026-10-12). */
export function heldVault(t: { after: (fn: () => void) => void }) {
  const held = { on: false };
  const ok = useFakeVault();
  const forRun = ok.vault.forRun.bind(ok.vault);
  useFakeVault({
    vault: {
      forRun: ((run: { userId?: string }, o: { claude: boolean }) =>
        held.on && o.claude
          ? { env: {}, problems: [], claudeHold: { why: 'every token is at a limit (vault-lothsahn-1: 5-hour 92% (>= 80): held until Mon 12:50Z): the first frees up Mon 12:50Z', next: POOL_HELD_UNTIL } }
          : forRun(run as never, o as never)),
    } as never,
  });
  t.after(() => setVaultContext(undefined));
  return held;
}

// w1872: lothsahn, 2026-10-23, "Have the dispatcher replace anything waiting on timing on m5". w1789's leg queued for m5 at
// 06:46 still waited there after #572 (which refused only new pins): its worker's report said "still open: waiting for a
// sandbox on m5 for the timed runs". Timed work is re-placed by "Next timed work", never queued on m5.
export const M5_NO = 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"';
export const fixTimedFacts = (o: Orchestrators) => {
  (o as unknown as { d: { timedFacts: () => { noTimed: Record<string, string>; takes: string[] } } }).d.timedFacts = () => ({ noTimed: { m5: M5_NO }, takes: ['lothdesktop', 'beast'] });
};

// w1969: the fleet the ask decides on, with the test machine "pc" as BEAST (6 agent slots); m5 takes no timed runs.
export const askFleet = (): Computer[] => {
  const box = (id: string, maxAgents: number, platform: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 1, midTurn: 0, maxAgents, sandboxes: 1, maxSandboxes: 3, freeSandboxes: 1, memUsedBytes: 16 * 1024 ** 3, memTotalBytes: 64 * 1024 ** 3, editors: 0, maxEditors: 2, platform, ...o });
  return [box('pc', 6, 'win32', { live: 6 }), box('lothlaptop', 1, 'win32', { live: 1, midTurn: 1, freeSandboxes: 0 }), box('m3', 2, 'darwin'), box('m5', 4, 'darwin', { noTimedRuns: M5_NO })];
};

// ---------------------------------------------------------------- w1944: queued work and the room it can really use

/** A queued request, as decide_work queue leaves it. */
export function queuedItem(id: string, title: string, priority: WorkItem['priority'], at = T0): WorkItem {
  return { id, title, brief: 'Do it.', priority, keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'queued', queuedFor: { at }, createdAt: at, updatedAt: at, sessionIds: [], overlaps: [], asks: 0, log: [] };
}

/** Two Windows computers, pc (alpha) and beast (slot1), both with room (w1945). */
export async function twoComputers(t: Parameters<typeof setupOnMachine>[0]) {
  const env = await setupOnMachine(t);
  const beast = await startTestMachine(env.machines, { id: 'beast', sandboxes: ['slot1'] });
  env.closers.push(() => beast.stop());
  for (const id of ['pc', 'beast']) env.store.putMachine({ ...env.store.machines.get(id)!, platform: 'win32' });
  agentsRoom(env.agents, ['pc', 'beast']);
  return env;
}


// w4618: w4595's brief as FF Factory filed it (the pair run for w4571: two legs of ffnightly MP scenarios on the default lab),
// trimmed to what the rule reads, FF Factory's own w3697 sentence included (it names "a pair lab or the relay").
export const W4595_BRIEF = `Determinism check for two simulation PRs of request w4571 at once (performance only, both claim no change in behaviour).
Run commit f20e095502af58a31d983ac0b19f990776eea6d4 (branch w4571-pair-check). Build that commit's player on each computer the usual way (player slot pool) and play these MP scenarios host + client, with \`ffnightly.py run --scenarios-from f20e095502af58a31d983ac0b19f990776eea6d4\`:
1. MP-station-drive-join
2. MP-W1859-host-drives-remote-client (host drives, remote client watches)
3. MP-new-grid-unpowered-join
Passes: every scenario passes, no desync report, and the per-heartbeat state hashes of host and client match.

FF Factory filed this for worker cfc16074 on w4571 (w1945, request_pair): a pair run of 2 legs, on any computers, any OS (a Mac only as the host, leg 1). No leg goes on a Mac (w3697): each leg starts MP-station-drive-join's host and its client on its own computer, and a Mac refuses a multiplayer client (the game repo's scripts/nightly/player_slots.py require_mac_client_ok, w665; w3697). A pair lab or the relay (leg 1 hosts, the others join), a cross-OS pair or FF_MAC_GPU_HANG_OK=<request> in its words lets a Mac host.`;

// ---------------------------------------------------------------- w2049: priority low, and started work pinned to a computer

/** The capacity ping's request ids in the order it lists the ones that fit (w2049). */
export function pingOrder(ping: string): string[] {
  const fitting = ping.split('Queued for capacity and fitting it')[1]?.split('Queued with no room')[0] ?? '';
  return [...fitting.matchAll(/(w\d+) "/g)].map((m) => m[1]);
}
// ---------------------------------------------------------------- w2057: workers file their own pair runs

/** w2057: a leg worker of a pair run, idle. */
export function legWorker(store: Store, id: string) {
  store.putSession({ id, kind: 'worker', title: `leg ${id}`, status: 'idle', permissionMode: 'bypassPermissions', createdAt: T0, lastActivityAt: T0, turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: BEN } as unknown as SessionInfo);
}

/** w2057: w1936 as Ben's orchestrator filed it on 10-23: a sync run of PR #2340, marked a pair, with no tie to w665. */
export const W1936 = { id: 'w1936', by: BEN, title: 'Sync run: MP-lowore-pin-pair for PR #2340 on two non-Mac machines', brief: 'Run MP-lowore-pin-pair on branch w665-lowore-pin-no-collider.' };
export const PR2340 = { repo: 'Final-Factory/FinalFactory', number: 2340, state: 'open' as const };

/** w2057: legs started on the pair run `id`, on two leg workers. */
export function legsStarted(store: Store, id: string, host: string, client: string) {
  legWorker(store, host);
  legWorker(store, client);
  const p = store.work.get(id)!;
  p.status = 'active';
  p.sessionIds = [host, client];
  p.pair = { ...p.pair!, started: { at: T0, legs: [{ session: host, sandbox: 'lothdesktop/slot1' }, { session: client, sandbox: 'beast/slot2' }] } } as WorkItem['pair'];
  store.putWork(p);
}

/** w2304: a pair run for w2263 filed by its worker, its legs started: the host on pc/alpha, the client on lothdesktop/slot6. */
export async function livePairFor(env: Awaited<ReturnType<typeof setupOnMachine>>) {
  const { store, agents } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: 'w2263', by: LOTH, status: 'active' }]);
  const a = await startedFor(env, 'w2263');
  const id = /^Filed (w\d+)/.exec(String(await a.h.request_pair!({ what: 'Singularity fuel reserve on PR #2607', brief: 'Host from the save, client joins, 2000 heartbeats.', legs: 2 })))![1];
  const leg = (sid: string, machineId: string, machineSandbox: string) =>
    store.putSession({ id: sid, kind: 'worker', title: `leg ${sid}`, status: 'idle', permissionMode: 'bypassPermissions', createdAt: T0, lastActivityAt: T0, turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: LOTH, machineId, machineSandbox } as SessionInfo);
  leg('39c87651', 'pc', 'alpha');
  leg('0de45d46', 'lothdesktop', 'slot6');
  const p = store.work.get(id)!;
  p.status = 'active';
  p.sessionIds = ['39c87651', '0de45d46'];
  p.pair = { ...p.pair!, started: { at: T0, legs: [{ session: '39c87651', sandbox: 'pc/alpha' }, { session: '0de45d46', sandbox: 'lothdesktop/slot6' }] } };
  store.putWork(p);
  return { a, id, p };
}

/**
 * w2305: pair run `id` for `asker` under way, its leg under test stopped in pc/alpha (a clean worktree the release pass could
 * take) and its partner leg at work on lothdesktop. `mine` is leg 1 (the host) or 2 (the client); the client is the newest worker.
 */
export async function heldLegFor(t: { after: (fn: () => void | Promise<void>) => void }, asker: string, mine: 1 | 2, me: string, partner: string, extra: Partial<SessionInfo> = {}) {
  const env = await setupOnMachine(t);
  const { store, agents, o } = env;
  agentsRoom(agents, []);
  putRequests(store, [{ id: asker, by: LOTH, status: 'active' }]);
  const a = await startedFor(env, asker);
  const id = /^Filed (w\d+)/.exec(String(await a.h.request_pair!({ what: `pair run for ${asker}`, brief: 'Host from the save, client joins, 2000 heartbeats.' })))![1];
  // The asker's own worker is elsewhere: pc/alpha is the leg's.
  store.putSession({ ...store.sessions.get(a.id)!, machineId: 'm5', machineSandbox: 'slot9' });
  const base = { kind: "worker" as const, permissionMode: "bypassPermissions" as const, createdAt: T0, lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(), turns: 3, costUsd: 0, pendingPermissions: [], requestedBy: LOTH };
  store.putSession({ ...base, id: me, title: `${id}: leg ${mine}`, status: 'stopped', machineId: 'pc', machineSandbox: 'alpha', ...extra } as SessionInfo);
  store.putSession({ ...base, id: partner, title: `${id}: leg ${3 - mine}`, status: 'running', machineId: 'lothdesktop', machineSandbox: 'slot3' } as SessionInfo);
  const legs = mine === 1 ? [{ session: me, sandbox: 'pc/alpha' }, { session: partner, sandbox: 'lothdesktop/slot3' }] : [{ session: partner, sandbox: 'lothdesktop/slot3' }, { session: me, sandbox: 'pc/alpha' }];
  const p = store.work.get(id)!;
  p.status = 'active';
  p.sessionIds = legs.map((l) => l.session);
  p.pair = { ...p.pair!, started: { at: T0, legs } };
  store.putWork(p);
  const sb = () => store.machines.get('pc')!.sandboxes!.find((x) => x.id === 'alpha')!;
  const pass = () => {
    (agents as unknown as { waitLive?: unknown }).waitLive = undefined;
    sb().git = { branch: 'sandbox/alpha', dirty: 0, untracked: 0, ...sb().git, at: new Date().toISOString() };
    return (agents as unknown as { placeAgain: { tick(): string[] } }).placeAgain.tick();
  };
  const watch = new BlockerWatch({ store, orchestrators: o });
  return { ...env, id, p, pass, watch };
}

// ---------------------------------------------------------------- w2357: a request and its timed leg waiting on each other

/** A worker on `work` that finished a turn `ms` from now with `report`. */
export function putReport(store: Store, work: string, sid: string, report: string, ms = 1000) {
  store.putSession({ id: sid, kind: 'worker', title: `${work}: leg`, status: 'idle', permissionMode: 'default', createdAt: T0, lastActivityAt: new Date(Date.now() + ms).toISOString(), turns: 2, costUsd: 1, pendingPermissions: [], lastResult: report });
  store.putWork({ ...store.work.get(work)!, sessionIds: [sid] });
}

// ---------------------------------------------------------------- w2371: a past wait is no wait cycle
// w2335 (the Leech fix) was woken three times between 08:54Z and 08:56Z on 2026-10-27 by "a wait cycle (w2335 -> w2338
// -> w2335)": its timed leg w2338's newest report still said it waited for w2335's fix commit, which w2335's worker had
// pushed in a turn after that report, and w2338 waited only for a free sandbox on biscuit (a message queued for it).
export async function w2371Setup(t: Parameters<typeof setupOnMachine>[0]) {
  const env = await setupOnMachine(t);
  agentsRoom(env.agents, []);
  putRequests(env.store, [{ id: 'w1', status: 'active' }, { id: 'w2', title: 'Timed leg for w1: Leech stack probe', status: 'active', needs: 'game', timedLeg: { for: 'w1', forSession: 'p1', from: 'pc', small: ['biscuit'] } }]);
  // The leg's report, a minute ago: it waits for the parent's commit.
  putReport(env.store, 'w2', 'k2', "w2: still open: waiting for w1's worker p1 to send its fix commit on sandbox/slot3-w1, then the fix-side run", -60_000);
  return env;
}

// w2548: w2547, a timed leg, was started twice in lothdesktop/slot1 on 2026-10-29: at 15:19:59Z by FF Factory's timing order
// (w2055) as 9a3c8e5d, and at 15:20Z by the dispatcher (start_agent work_id w2547) as 57ab10fc, which its [work request]
// had told to "Decide: start it". The first worker's process had not started yet (its brief waited on the save download),
// so its status was still "stopped" and start_agent's live check skipped it; the sandbox check skipped it as the request's own.
export const timedLegRow = (id: string): Partial<WorkItem> & { id: string } => ({
  id,
  title: `Timed leg for w1: w1: profiled capture on pc`,
  status: 'queued',
  queuedFor: { at: T0, needs: ['pc'] },
  timedLeg: { for: 'w1', forSession: 'aaaaaaaa', from: 'm3', small: ['pc'] },
});

// w3606 (lothsahn: "Please make it so that upon our request, ben and I can answer each other's questions and we can move
// questions to each other"): between owners, in the acting owner's own turn.
export async function crossOwnerQuestion(t: Parameters<typeof setup>[0]) {
  const env = setup(t, { people: OWNERS });
  const { store, o, dispatcher, chat, call, heard } = env;
  store.onEvent = (sid, e) => o.observeAsk(sid, e);
  const ben = chat(BEN);
  ben.lastFrom = 'human';
  await call(ben.info, 'request_work', { title: 'FFU owner_term flakes', brief: 'Fix the owner_term flakes.' });
  await until('the dispatcher hears it', () => heard(dispatcher().info.id, '[work request] w1').length === 1);
  const asked = await call(dispatcher().info, 'decide_work', { id: 'w1', action: 'ask', note: 'Keep w1 open and schedule it later?', questions: [{ question: 'Keep it open?', options: [{ label: 'Keep it open', recommended: true }, { label: 'Cancel it' }] }] });
  assert.equal(asked.isError, false, asked.text);
  await until('Ben has it', () => heard(ben.info.id, '[needs you]').length === 1);
  // Ben's orchestrator shows it as a card of its own too.
  store.append(ben.info.id, { kind: 'tool_use', toolUseId: 'b1', name: 'mcp__sandboxes__ask_person', input: { question: 'About w1: keep it open and schedule it later?', options: [{ label: 'Keep w1 open', description: '', recommended: true }, { label: 'Cancel w1', description: '' }] } });
  store.append(ben.info.id, { kind: 'tool_result', toolUseId: 'b1', isError: false, text: 'Shown' });
  assert.equal(o.personalOf('ben')!.info.openAsks?.length, 1);
  const loth = chat(LOTH);
  /** lothsahn writes to his orchestrator: his own turn, with his words in its transcript. */
  const says = (text: string) => {
    store.append(loth.info.id, { kind: 'user', text, from: 'human', requestedBy: LOTH });
    loth.lastFrom = 'human';
  };
  const w = () => store.work.get('w1')!;
  const tab = (p: Requester) => decisionsOn([w()], { ...p, reviewer: false }).map((d) => d.w.id);
  return { ...env, ben, loth, says, w, tab };
}

/** w3615: what toPeople sends each person, by userId. */
export function toldPeople(o: Orchestrators) {
  const told: { to: string; text: string }[] = [];
  const real = o.toPeople.bind(o);
  o.toPeople = (people, text) => {
    for (const p of people) told.push({ to: p.userId, text });
    real(people, text);
  };
  return (userId: string) => told.filter((x) => x.to === userId).map((x) => x.text);
}

/** w3615: Ben's orchestrator relays request `id`'s question as a card of its own (ask_person about it). */
export function relayAsCard(env: ReturnType<typeof setup>, who: Requester, id: string, toolUseId: string) {
  const { store, o, chat } = env;
  store.onEvent = (sid, e) => o.observeAsk(sid, e);
  const info = chat(who).info;
  store.append(info.id, { kind: 'tool_use', toolUseId, name: 'mcp__sandboxes__ask_person', input: { question: `Is ${id} still needed now that what it waited on was cancelled?`, options: [{ label: `Yes, keep ${id} open`, description: '', recommended: true }, { label: `No, close ${id}`, description: '' }], request: id } });
  store.append(info.id, { kind: 'tool_result', toolUseId, isError: false, text: 'Shown' });
  return info;
}
