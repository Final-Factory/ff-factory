import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { SandboxManager } from './sandboxes.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { IntakeManager } from './intake.ts';
import { ProviderManager } from './providers.ts';
import { mintProviderToken, tokenSha256 } from './providerProtocol.ts';
import { MockConnector } from '../e2e/mockConnector.ts';
import type { Config } from './config.ts';
import type { ProviderConversation, Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * The ledger check both ways, end to end (docs/ffbox-connector-contract.md, "Protocol 2"): a fake FFBox connector over
 * a real /provider socket, against the real ledger. The handshake in both versions, a board_check by the exact
 * discord:<thread id> key of a request that only names the thread in its brief (w50, w53), the branch to watch once a
 * worker is on it, the answer pushed again as it changes (a PR, the fix landing, the release), FFBox's own conversation
 * never matching itself, and an ffbox/* PR filed as a review request with its thread's key.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const PEOPLE: UserInfo[] = [{ ...BEN, role: 'owner' }];
const T0 = new Date().toISOString();
const THREAD_A = '1554582984567562253';
const THREAD_B = '1554588033704005712';

async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ledger-'));
  const token = mintProviderToken();
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: 'https://github.com/Final-Factory/FinalFactory.git', basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    providers: { ffbox: { enabled: true, tokenSha256: tokenSha256(token) } },
    intake: { ffbox: { enabled: true, boardCheck: true } },
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const sandboxes = new SandboxManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sandboxes, sessions, machines, new Identity(cfg, () => PEOPLE));
  Object.defineProperty(agents, 'workerOptions', { value: () => ({ model: 'opus' }) });
  store.putSandbox({ id: 'lag', name: 'lag', branch: 'sandbox/lag-lead', base: 'origin/develop', path: path.join(dir, 'lag'), purpose: 'unused', status: 'ready', createdAt: T0, unity: { state: 'stopped' }, sessionIds: [] });
  agents.boot();
  const o = agents.orchestrators;
  (o as unknown as { d: { intakeGatherMs: number } }).d.intakeGatherMs = 20;
  const pm = new ProviderManager(cfg);
  const intake = new IntakeManager({ cfg, store, identity: agents.identity, orchestrators: o, pushBoard: (ref, a) => pm.pushBoard(ref, a) });
  pm.onBoardCheck = (m) => intake.onBoardCheck(m);
  pm.onConversation = (c) => intake.onConversation(c);
  pm.portalAccepts = () => intake.portalAccepts();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => pm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const conns: MockConnector[] = [];
  const connect = () => {
    const c = new MockConnector(url, token);
    conns.push(c);
    return c;
  };
  t.after(async () => {
    for (const c of conns) c.close();
    pm.close();
    server.close();
    intake.close();
    o.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const dispatcher = () => sessions.get(agents.dispatcherId);
  const call = async (info: SessionInfo, name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === name);
    if (!tool) throw new Error(`${info.title} has no ${name}`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { store, agents, o, intake, pm, connect, dispatcher, call };
}

const conv = (o: Partial<ProviderConversation>): ProviderConversation => ({ id: '41', source: 'discord', opener: 'player', title: 'Belts stop', state: 'idle', agentClass: 'ffagent', createdAt: T0, updatedAt: T0, ...o });

test('ledger check both ways: handshake, exact thread keys, what to watch, and the answer pushed as it changes', async (t) => {
  const { store, o, intake, pm, connect, dispatcher, call } = await setup(t);
  const ben = o.personalFor(BEN);
  ben.lastFrom = 'human';
  // Ben's request names the thread by its link; an older one (filed before discord keys existed) by its bare id.
  const filed = await call(ben.info, 'request_work', { title: 'Lag when leading a fleet', brief: `Players report lag, see https://discord.com/channels/530867164866150410/${THREAD_A}` });
  assert.equal(filed.isError, false, filed.text);
  const a = [...store.work.values()].find((w) => w.title === 'Lag when leading a fleet')!;
  assert.ok(a.keys.includes(`discord:${THREAD_A}`), 'the thread link is the request key');
  const old: WorkItem = { id: 'w90', title: 'Tooltips flicker', brief: `From #bug-reports thread ${THREAD_B}.`, priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: T0, updatedAt: T0, sessionIds: [], overlaps: [], asks: 0, log: [] };
  store.putWork(old);

  // The handshake: protocol 2, each side says what it takes.
  const c = connect();
  const welcome = (await c.hello({ protocol: 2, accepts: ['board', 'filed'] })) as unknown as { protocol: number; accepts: string[] };
  assert.equal(welcome.protocol, 2);
  assert.deepEqual(welcome.accepts, ['board_check', 'request', 'accepted', 'refused', 'result']);

  // A check by the exact key: in flight, but nobody is on a branch yet, so nothing to watch.
  c.send({ type: 'board_check', ref: 'conv-9', keys: [`discord:${THREAD_A}`], conversation: '9' });
  let board = (await c.next('board')) as { verdict: string; matches: Record<string, unknown>[]; update?: boolean };
  assert.equal(board.verdict, 'in_flight');
  assert.equal(board.matches[0].id, a.id);
  assert.equal(board.matches[0].watch, undefined);
  // The older request, found by the bare id in its brief.
  c.send({ type: 'board_check', ref: 'conv-10', keys: [`discord:${THREAD_B}`] });
  const older = (await c.next('board')) as { verdict: string; matches: { id: string }[] };
  assert.deepEqual([older.verdict, older.matches[0].id], ['in_flight', 'w90']);
  // An unknown thread: clear.
  c.send({ type: 'board_check', ref: 'conv-11', keys: ['discord:1554599999999999999'] });
  assert.equal(((await c.next('board')) as { verdict: string }).verdict, 'clear');

  // A worker starts on it in sandbox/lag-lead, and opens PR 812: the answer is pushed again, with the branch to watch.
  const started = await call(dispatcher().info, 'start_agent', { sandbox: 'lag', prompt: 'Fix the lag.', title: 'Lag', work_id: a.id });
  assert.equal(started.isError, false, started.text);
  const sb = store.sandboxes.get('lag')!;
  store.putSandbox({ ...sb, git: { branch: 'sandbox/lag-lead', dirty: 0, untracked: 0, pr: { number: 812, url: 'https://github.com/Final-Factory/FinalFactory/pull/812', title: 'Lag', draft: false }, at: T0 } });
  assert.equal(intake.recheckBoards(), 1, 'only the answer that changed goes');
  board = (await c.next('board')) as typeof board;
  assert.equal(board.update, true);
  assert.equal(board.verdict, 'in_flight');
  assert.deepEqual(board.matches[0].watch, { repo: 'Final-Factory/FinalFactory', branch: 'sandbox/lag-lead', pr: 812, target: 'develop' });
  assert.equal(intake.recheckBoards(), 0, 'nothing changed, nothing sent');

  // The fix lands on develop: done, merged but not released (version null).
  const worker = [...store.sessions.values()].find((s) => s.kind === 'worker')!;
  // Linked to the request as a person's request: the marker is read only for intake requests, so close it by hand.
  a.status = 'done';
  a.delivery = { fixCommit: 'abc1234def5678' };
  store.putWork(a);
  assert.ok(worker);
  intake.recheckBoards();
  board = (await c.next('board')) as typeof board;
  assert.equal(board.verdict, 'done');
  assert.deepEqual([board.matches[0].version, board.matches[0].mergedIn, board.matches[0].branch], [null, 'develop@abc1234def5678', 'sandbox/lag-lead']);
  // Released in 0.50.0.51: pushed once more, and then no longer followed.
  o.noteRelease(a.id, { releasedIn: '0.50.0.51' }, 'shipped in 0.50.0.51');
  intake.recheckBoards();
  board = (await c.next('board')) as typeof board;
  assert.equal(board.matches[0].version, '0.50.0.51');
  o.noteRelease(a.id, { announcedBy: 'w99' }, 'x');
  assert.equal(intake.recheckBoards(), 0, 'a released fix is no longer followed');

  // FFBox's own conversation: its ffbox/* PR becomes a review request carrying the thread's key, and never matches itself.
  pm.onConversation?.(conv({ id: '41', threadId: THREAD_B, branch: 'ffbox/tooltip-fix-1', pr: { number: 820, state: 'open' } }));
  const review = [...store.work.values()].find((w) => w.source?.kind === 'ffbox-branch')!;
  assert.ok(review, 'the ffbox/* PR is filed as a review request');
  assert.deepEqual([review.title, review.source?.threadId, review.source?.pr], ['Review and merge ffbox/tooltip-fix-1', THREAD_B, 820]);
  assert.ok(review.keys.includes(`discord:${THREAD_B}`));
  c.send({ type: 'board_check', ref: 'conv-41', keys: [`discord:${THREAD_B}`], conversation: '41' });
  const self = (await c.next('board')) as { matches: { id: string }[] };
  assert.equal(self.matches.some((m) => m.id === review.id), false, "FFBox's own conversation is not someone else's work");
  // Its PR merged on FFBox's side: the review request closes.
  pm.onConversation?.(conv({ id: '41', threadId: THREAD_B, branch: 'ffbox/tooltip-fix-1', pr: { number: 820, state: 'merged' } }));
  assert.equal(review.status, 'done');

  // A protocol 1 connector still gets its answers (the check predates the version), but no pushes.
  c.close();
  await until('the link drops', () => !pm.online);
  const v1 = connect();
  const w1 = (await v1.hello({ protocol: 1 })) as unknown as Record<string, unknown>;
  assert.equal(w1.protocol, 1);
  v1.send({ type: 'board_check', ref: 'conv-10', keys: [`discord:${THREAD_B}`] });
  assert.equal(((await v1.next('board')) as { verdict: string }).verdict, 'in_flight');
  assert.equal(pm.pushBoard('conv-10', { verdict: 'clear', matches: [] }), false);
});
