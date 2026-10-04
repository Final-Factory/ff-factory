import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { SandboxManager } from './sandboxes.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { LedgerSweep, handledAfterAutoClose } from './ledgerSweep.ts';
import type { PrRecord } from './ledgerRules.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, TranscriptEvent, UserInfo, WorkItem } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * The ledger cleanup (docs/orchestrators.md, "Ledger cleanup") on a real Agents with the scripted fake SDK: pull requests
 * linked to requests and closing them when they merge (w304), and the scheduled sweep's finished, cut-off, stalled and
 * superseded requests (w306). gh and the account meters are stood in for.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const REPO = 'Final-Factory/FinalFactory';

async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup(t: { after: (fn: () => void | Promise<void>) => void }, ledger: Config['ledger'] = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ledger-'));
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
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    ledger,
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const sandboxes = new SandboxManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sandboxes, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  const o = agents.orchestrators;
  const world = { prs: [] as PrRecord[] | undefined, clear: true as boolean | undefined, resumed: [] as { id: string; text: string }[] };
  const sweep = new LedgerSweep({
    cfg,
    store,
    orchestrators: o,
    repos: async () => [REPO],
    prs: async () => world.prs,
    viewPr: async () => undefined,
    resume: (id, text) => void world.resumed.push({ id, text }),
    limitsClear: () => world.clear,
    now: () => NOW,
  });
  t.after(async () => {
    sweep.close();
    o.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const request = (id: string, over: Partial<WorkItem> = {}): WorkItem => {
    const w = {
      id,
      title: `Fix ${id}`,
      brief: 'Make it work.',
      priority: 'normal',
      keys: [],
      requestedBy: BEN,
      requesters: [BEN],
      humanAsked: true,
      status: 'active',
      createdAt: ago(72),
      updatedAt: ago(70),
      sessionIds: [],
      overlaps: [],
      asks: 0,
      log: [],
      ...over,
    } as WorkItem;
    store.putWork(w);
    return w;
  };
  const worker = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => {
    const s = { id, kind: 'worker', title: `Worker ${id}`, status: 'idle', permissionMode: 'bypassPermissions', createdAt: ago(72), lastActivityAt: ago(60), turns: 3, costUsd: 1, pendingPermissions: [], requestedBy: BEN, ...over } as SessionInfo;
    store.putSession(s);
    return s;
  };
  const pr = (number: number, over: Partial<PrRecord> = {}): PrRecord => ({
    repo: REPO,
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    body: '',
    head: `sandbox/x${number}`,
    base: 'develop',
    state: 'merged',
    createdAt: ago(50),
    mergedAt: ago(40),
    sha: `${String(number).padStart(2, '0')}`.repeat(20),
    ...over,
  });
  let seq = 1000;
  /** A worker ran `gh pr create` at `at` and it printed this PR's URL. */
  const opened = (sessionId: string, number: number, at: string) => {
    const file = path.join(dir, 'transcripts', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `tu${seq}`;
    const lines = [
      { seq: seq++, t: at, kind: 'tool_use', toolUseId: id, name: 'Bash', input: { command: 'gh pr create --base develop --fill' } },
      { seq: seq++, t: at, kind: 'tool_result', toolUseId: id, isError: false, text: `https://github.com/${REPO}/pull/${number}` },
    ];
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const heard = (who: Requester = BEN) => store.readTranscript(o.personalFor(who).info.id).filter((e): e is Extract<TranscriptEvent, { kind: 'user' }> => e.kind === 'user' && e.from === 'system' && e.text.startsWith('[ledger cleanup]'));
  const get = (id: string) => o.requireWork(id);
  return { dir, cfg, store, sessions, agents, o, sweep, world, request, worker, pr, opened, heard, get };
}

test('one linked PR merged closes the request, logs how, starts nothing, and its person hears one line', async (t) => {
  const { request, worker, pr, world, sweep, get, heard, store } = setup(t);
  request('w1', { sessionIds: ['s1'] });
  worker('s1');
  world.prs = [pr(11, { body: 'Fix the belts\n\nRequest: w1' })];
  assert.deepEqual(await sweep.checkPrs(), ['w1']);
  const w = get('w1');
  assert.equal(w.status, 'done');
  assert.deepEqual([w.autoClosed?.how, w.autoClosed?.pr], ['prs', 11]);
  assert.match(w.autoClosed!.text, /^merged as #11 \(1111111111\d\d\) on 2026-10-0\d$/);
  assert.match(w.log.at(-1)!, /closed automatically by the ledger cleanup: merged as #11/);
  assert.deepEqual(w.prs?.map((p) => [p.number, p.state]), [[11, 'merged']]);
  await until('the person hears', () => heard().length === 1);
  assert.match(heard()[0].text, /^\[ledger cleanup\] closed as done 1: w1 "Fix w1" \(merged as #11/);
  assert.equal([...store.sessions.values()].filter((s) => s.kind === 'worker').length, 1, 'no worker was started');
  assert.deepEqual(await sweep.checkPrs(), [], 'closed once');
});

test('a PR is linked when the request’s own worker opened it (its gh pr create) after the request was filed, not when a report merely mentions it', async (t) => {
  const { request, worker, pr, world, sweep, get, opened } = setup(t);
  request('w1', { sessionIds: ['s1'] });
  worker('s1', { lastResult: `Related: https://github.com/${REPO}/pull/5 and the plan.` });
  opened('s1', 6, ago(50));
  world.prs = [pr(5, { head: 'sandbox/alpha', createdAt: ago(60), mergedAt: ago(55) }), pr(6, { head: 'sandbox/alpha', createdAt: ago(50) })];
  await sweep.checkPrs();
  assert.deepEqual(get('w1').prs?.map((p) => [p.number, p.via]), [[6, 'worker']]);
  assert.equal(get('w1').status, 'done');
});

test('related ids, a PR number in the brief and a merge from before the request was filed never link or close it (w339 and #988)', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  request('w339', { createdAt: ago(10), updatedAt: ago(1), sessionIds: ['s1'], relatedIds: ['PR 988', 'w292'], keys: ['pr:988'], brief: 'Follow-up to #988, the earlier bay tier.' });
  worker('s1', { status: 'running', lastResult: `The earlier PR https://github.com/${REPO}/pull/988 is the base.` });
  world.prs = [pr(988, { head: 'sandbox/bay', createdAt: ago(40), mergedAt: ago(30) })];
  assert.deepEqual(await sweep.checkPrs(), []);
  await sweep.run();
  assert.equal(get('w339').status, 'active');
  assert.equal(get('w339').prs, undefined);
  // not running any more: still no link, so the PR rule closes nothing
  worker('s1', { status: 'idle', lastActivityAt: ago(1), lastResult: 'Working on it.' });
  assert.deepEqual(await sweep.checkPrs(), []);
  assert.equal(get('w339').status, 'active');
});

test('a worker that does two requests in sequence: each PR goes to the request the worker was on, never the other', async (t) => {
  const { request, worker, pr, world, sweep, get, opened } = setup(t);
  request('w314', { createdAt: ago(60), updatedAt: ago(20), sessionIds: ['s1'] });
  request('w324', { createdAt: ago(30), updatedAt: ago(1), sessionIds: ['s1'] });
  worker('s1', { lastActivityAt: ago(1), lastResult: 'Now on the next request.' });
  opened('s1', 985, ago(50));
  opened('s1', 1005, ago(20));
  world.prs = [pr(985, { head: 'sandbox/shared', createdAt: ago(50), mergedAt: ago(45) }), pr(1005, { head: 'sandbox/shared', createdAt: ago(20), mergedAt: ago(15) })];
  await sweep.checkPrs();
  assert.deepEqual(get('w314').prs?.map((p) => p.number), [985]);
  assert.deepEqual(get('w324').prs?.map((p) => p.number), [1005]);
  assert.equal(get('w314').autoClosed?.pr, 985);
  assert.equal(get('w324').autoClosed?.pr, 1005);
});

test('today’s automatic closes are checked again: a close whose PR no longer qualifies is reopened with its wrong link dropped, a sound one stays', async (t) => {
  const { request, worker, pr, world, sweep, get, heard } = setup(t);
  const closedBy = (number: number) => ({ at: ago(3), how: 'prs' as const, pr: number, sha: 'a'.repeat(40), text: `merged as #${number} (aaaaaaaaaaaa) on 2026-10-03` });
  request('w339', { status: 'done', createdAt: ago(10), updatedAt: ago(3), sessionIds: ['s1'], autoClosed: closedBy(988), outcome: 'closed automatically: merged as #988', prs: [{ repo: REPO, number: 988, state: 'merged' }] });
  worker('s1', { status: 'running', lastActivityAt: ago(1) });
  request('w2', { status: 'done', createdAt: ago(40), updatedAt: ago(3), sessionIds: ['s2'], autoClosed: closedBy(50), outcome: 'closed automatically: merged as #50', prs: [{ repo: REPO, number: 50, state: 'merged' }] });
  worker('s2', { lastActivityAt: ago(5) });
  request('w3', { status: 'done', createdAt: ago(40), updatedAt: ago(3), autoClosed: closedBy(60), outcome: 'closed automatically: merged as #60', prs: [{ repo: REPO, number: 60, state: 'merged', via: 'line' }] });
  world.prs = [pr(988, { createdAt: ago(40), mergedAt: ago(30) }), pr(50, { body: 'Request: w2', createdAt: ago(35), mergedAt: ago(30) }), pr(60, { body: 'Request: w3', createdAt: ago(35), mergedAt: ago(30) })];
  await sweep.run();
  const w = get('w339');
  assert.equal(w.status, 'active', 'reopened, its worker is on it');
  assert.equal(w.autoClosed, undefined);
  assert.equal(w.outcome, undefined);
  assert.deepEqual(w.prs, []);
  assert.match(w.log.join('\n'), /reopened by the ledger cleanup: PR #988 is not this request's by the strict link rules/);
  assert.equal(get('w2').status, 'done');
  assert.equal(get('w3').status, 'done');
  await until('the person hears', () => heard().length >= 1);
  assert.match(heard().map((e) => e.text).join('\n'), /w339 .*reopened: PR #988 is not this request's/);
  await sweep.run();
  assert.equal(get('w339').status, 'active', 'and it stays open');
});

test('w340: the w50 and w312 shapes are reopened at the first pass after a start, and the server log says so', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  const lines: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  const closedBy = (number: number) => ({ at: ago(4), how: 'prs' as const, pr: number, sha: 'b'.repeat(40), text: `merged as #${number} (bbbbbbbbbbbb) on 2026-10-04` });
  // w50: an old request, closed on a PR opened days after by someone else, with no Request: line.
  request('w50', { status: 'done', createdAt: ago(24 * 5), updatedAt: ago(4), autoClosed: closedBy(1002), outcome: 'closed automatically: merged as #1002', prs: [{ repo: REPO, number: 1002, state: 'merged' }] });
  // w312: a fetch request whose worker merged FFBox's PR #991 (an ffbox/ branch) but did not open it.
  request('w312', { status: 'done', createdAt: ago(8), updatedAt: ago(4), sessionIds: ['s9'], autoClosed: closedBy(991), outcome: 'closed automatically: merged as #991', prs: [{ repo: REPO, number: 984, state: 'merged' }, { repo: REPO, number: 991, state: 'merged' }] });
  worker('s9', { lastActivityAt: ago(5) });
  world.prs = [
    pr(1002, { head: 'ffbox-f/altd-desync', createdAt: ago(6), mergedAt: ago(5) }),
    pr(984, { head: 'w297-desync-fix', createdAt: ago(7), mergedAt: ago(6) }),
    pr(991, { head: 'ffbox/desync-report-hauler-departure-d627t1-7ecb12b4', createdAt: ago(7), mergedAt: ago(6) }),
  ];
  await sweep.checkPrs();
  assert.deepEqual([get('w50').status, get('w312').status], ['new', 'active']);
  assert.equal(get('w312').autoClosed, undefined);
  assert.equal(get('w50').outcome, undefined);
  assert.ok(lines.some((l) => /^ledger cleanup: reopened w312 \(active\): PR #991 is not this request's/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^ledger cleanup: reopened w50 \(new\): PR #1002/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^ledger cleanup: rechecked 2 automatic close\(s\) from the last 14 days; reopened 2$/.test(l)), lines.join('\n'));
  // Later passes with nothing to reopen stay quiet.
  const n = lines.length;
  await sweep.checkPrs();
  assert.equal(lines.filter((l) => l.startsWith('ledger cleanup:')).length, lines.slice(0, n).filter((l) => l.startsWith('ledger cleanup:')).length);
});

test('two PRs, one merged: the request stays open and the log says why, once', async (t) => {
  const { request, worker, pr, world, sweep, get, heard } = setup(t);
  request('w1', { sessionIds: ['s1'] });
  worker('s1');
  world.prs = [pr(11, { body: 'Request: w1' }), pr(12, { body: 'Request: w1', state: 'open', mergedAt: undefined })];
  assert.deepEqual(await sweep.checkPrs(), []);
  assert.equal(get('w1').status, 'active');
  assert.deepEqual(get('w1').prs?.map((p) => [p.number, p.state]), [[11, 'merged'], [12, 'open']]);
  assert.equal(get('w1').log.filter((l) => /PR #11 merged; still open: PR #12 is open/.test(l)).length, 1);
  await sweep.checkPrs();
  assert.equal(get('w1').log.filter((l) => /still open/.test(l)).length, 1, 'noted once');
  world.prs = [pr(11, { body: 'Request: w1' }), pr(12, { body: 'Request: w1', mergedAt: ago(1) })];
  assert.deepEqual(await sweep.checkPrs(), ['w1']);
  assert.equal(get('w1').autoClosed?.pr, 12, 'the last merge');
});

test('a release stays open after its PR merges; a step after the merge, a plan of PRs and a worker saying more keep a request open too', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  request('w1', { title: 'Release 0.50.0.60', brief: 'Use /ff-agents:ci-release.', sessionIds: ['s1'] });
  request('w2', { brief: 'Fix it, then run a 2-peer check after the merge.', sessionIds: ['s2'] });
  request('w3', { brief: 'PR1 data, PR2 presentation.', sessionIds: ['s3'] });
  request('w4', { sessionIds: ['s4'] });
  for (const n of [1, 2, 3, 4]) worker(`s${n}`, n === 4 ? { lastResult: 'The first half is merged. The second PR is next.' } : {});
  world.prs = [1, 2, 3, 4].map((n) => pr(20 + n, { body: `Request: w${n}` }));
  assert.deepEqual(await sweep.checkPrs(), []);
  for (const n of [1, 2, 3, 4]) assert.equal(get(`w${n}`).status, 'active', `w${n} stays open`);
  assert.match(get('w1').log.join('\n'), /PR #21 merged; still open: a release ends when the build is live and the patch notes are posted/);
  assert.match(get('w2').log.join('\n'), /still open: its brief asks for a step after the merge/);
  assert.match(get('w3').log.join('\n'), /still open: its brief plans more than one PR/);
  assert.match(get('w4').log.join('\n'), /more is coming/);
});

test('a release closes once its worker reports it live with the notes posted (the full cleanup)', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  request('w1', { title: 'Release 0.50.0.60', brief: 'Use /ff-agents:ci-release.', sessionIds: ['s1'] });
  worker('s1', { lastResult: 'Release 0.50.0.60 is live on development.', lastActivityAt: ago(2) });
  world.prs = [pr(21, { body: 'Request: w1' })];
  await sweep.run();
  assert.equal(get('w1').status, 'active', 'merged, but the notes are not posted');
  worker('s1', { lastActivityAt: ago(2), lastResult: 'Release 0.50.0.60 is live on development. Notes posted: https://discord.com/channels/530867164866150410/1069745561672106015/1290000000000000001. Done.' });
  await sweep.run();
  assert.equal(get('w1').status, 'done');
  assert.ok(['prs', 'report'].includes(get('w1').autoClosed!.how));
});

test('a PR closed without merging keeps the request open, notes it once, and tells its person when no other PR is open', async (t) => {
  const { request, worker, pr, world, sweep, get, heard } = setup(t);
  request('w1', { sessionIds: ['s1'] });
  worker('s1', { lastActivityAt: ago(1) });
  world.prs = [pr(30, { body: 'Request: w1', state: 'closed', mergedAt: undefined, closedAt: ago(2) })];
  await sweep.checkPrs();
  assert.equal(get('w1').status, 'active');
  assert.equal(get('w1').log.filter((l) => /PR #30 was closed without merging/.test(l)).length, 1);
  await until('the person hears', () => heard().length === 1);
  assert.match(heard()[0].text, /for your attention 1: w1 .*PR #30 was closed without merging; the request stays open/);
  await sweep.checkPrs();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(heard().length, 1, 'told once');
  request('w2', { sessionIds: ['s2'] });
  worker('s2', { lastActivityAt: ago(1) });
  world.prs = [pr(31, { body: 'Request: w2', state: 'closed', mergedAt: undefined, closedAt: ago(2) }), pr(32, { body: 'Request: w2', state: 'open', mergedAt: undefined })];
  await sweep.checkPrs();
  assert.match(get('w2').log.join('\n'), /PR #31 was closed without merging; PR #32 is still open/);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(heard().length, 1, 'another PR is open: nothing more to say to the person');
});

test('a request with a running worker is never touched, merged PR or not, quiet or not', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  request('w1', { sessionIds: ['s1'] });
  worker('s1', { status: 'running', lastActivityAt: ago(100), lastResult: 'All done.' });
  request('w2', { sessionIds: ['s2'], updatedAt: ago(100) });
  worker('s2', { status: 'waiting_permission', lastActivityAt: ago(100) });
  world.prs = [pr(11, { body: 'Request: w1' })];
  await sweep.run();
  assert.equal(get('w1').status, 'active');
  assert.equal(get('w1').prs, undefined, 'not even linked');
  assert.equal(get('w2').status, 'active');
});

test('finished but unclosed: a final report that plainly says delivered closes it; one that says more, or nothing clear, does not', async (t) => {
  const { request, worker, sweep, get } = setup(t);
  for (const [id, text] of [['w1', 'All done. The copy is in Screenshots.'], ['w2', 'Done with step one. Next steps: the second part.'], ['w3', 'I found three causes of the belt bug.']] as const) {
    request(id, { sessionIds: [`s-${id}`], updatedAt: ago(5) });
    worker(`s-${id}`, { lastResult: text, lastActivityAt: ago(5) });
  }
  request('w4', { sessionIds: ['s-w4'], updatedAt: ago(0.2) });
  worker('s-w4', { lastResult: 'All done.', lastActivityAt: ago(0.2) });
  await sweep.run();
  assert.equal(get('w1').status, 'done');
  assert.equal(get('w1').autoClosed?.how, 'report');
  assert.match(get('w1').outcome!, /final report says it is delivered/);
  assert.equal(get('w2').status, 'active');
  assert.equal(get('w3').status, 'active', 'not 24 hours quiet yet');
  assert.equal(get('w4').status, 'active', 'the report is minutes old: the person may still be talking to it');
});

test('cut off by a limit: resumed once when the account has room, else stalled with the reason; a second cut-off stalls', async (t) => {
  const { request, worker, world, sweep, get, store } = setup(t);
  request('w1', { sessionIds: ['s1'], updatedAt: ago(8) });
  worker('s1', { status: 'stopped', statusDetail: 'You hit your usage limit · resets 3pm', lastActivityAt: ago(8) });
  world.clear = true;
  await sweep.run();
  assert.equal(get('w1').status, 'active');
  assert.deepEqual(world.resumed.map((r) => r.id), ['s1']);
  assert.match(world.resumed[0].text, /cut off \(stopped on a usage or rate limit/);
  assert.ok(get('w1').resumedBy?.s1);
  assert.match(get('w1').log.join('\n'), /resumed worker s1 once/);
  // cut off again: never a second resume.
  store.putSession({ ...store.sessions.get('s1')!, status: 'stopped', statusDetail: 'usage limit again', lastActivityAt: ago(7) });
  await sweep.run();
  assert.equal(world.resumed.length, 1);
  assert.equal(get('w1').status, 'stalled');
  assert.match(get('w1').stalled!.reason, /resumed it once already/);

  request('w2', { sessionIds: ['s2'], updatedAt: ago(8) });
  worker('s2', { status: 'stopped', statusDetail: 'weekly limit reached', lastActivityAt: ago(8) });
  world.clear = false;
  await sweep.run();
  assert.equal(get('w2').status, 'stalled');
  assert.equal(get('w2').stalled?.kind, 'cut-off');
  assert.match(get('w2').stalled!.reason, /limit has not reset yet/);
  assert.equal(world.resumed.length, 1);
  request('w3', { sessionIds: ['s3'], updatedAt: ago(8) });
  worker('s3', { status: 'stopped', statusDetail: 'weekly limit reached', lastActivityAt: ago(8) });
  world.clear = undefined;
  await sweep.run();
  assert.match(get('w3').stalled!.reason, /whether the limit has reset is unknown/);
});

test('cut off by a restart is resumed once; by a refused tool, stalled', async (t) => {
  const { request, worker, world, sweep, get } = setup(t);
  request('w1', { sessionIds: ['s1'], updatedAt: ago(8) });
  worker('s1', { status: 'stopped', turnOpenSince: ago(8), lastActivityAt: ago(8) });
  request('w2', { sessionIds: ['s2'], updatedAt: ago(8) });
  worker('s2', { status: 'error', statusDetail: 'Permission denied by the guard: a push to master', lastActivityAt: ago(8) });
  await sweep.run();
  assert.deepEqual(world.resumed.map((r) => r.id), ['s1']);
  assert.equal(get('w1').status, 'active');
  assert.equal(get('w2').status, 'stalled');
  assert.match(get('w2').stalled!.reason, /refused tool.*refused again/);
});

test('stalled: no worker running and 24 hours quiet; never closed, and not for what waits on a person', async (t) => {
  const { request, worker, sweep, get } = setup(t);
  request('w1', { status: 'new', updatedAt: ago(30) });
  request('w2', { status: 'queued', updatedAt: ago(2) });
  request('w3', { status: 'question', updatedAt: ago(100), question: { text: 'Co-op?', at: ago(100) } });
  request('w4', { status: 'new', updatedAt: ago(100), approval: { state: 'pending' } });
  request('w5', { sessionIds: ['s5'], updatedAt: ago(40) });
  worker('s5', { status: 'stopped', lastActivityAt: ago(40), lastResult: 'I looked into the splitter and found a likely cause.' });
  await sweep.run();
  assert.equal(get('w1').status, 'stalled');
  assert.equal(get('w1').stalled?.kind, 'idle');
  assert.match(get('w1').stalled!.reason, /no worker running and no activity for 30 hours; no worker ever started/);
  assert.equal(get('w2').status, 'queued', 'only 2 hours quiet');
  assert.equal(get('w3').status, 'question');
  assert.equal(get('w4').status, 'new');
  assert.equal(get('w5').status, 'stalled');
  assert.equal(get('w5').stalled?.kind, 'unsure', 'its last report does not say it is done');
  assert.ok(['stalled'].includes(get('w1').status) && get('w1').outcome === undefined, 'stalling closes nothing');
});

test('superseded: an old release request after a newer release finished is stalled with the newer one named, not closed', async (t) => {
  const { request, sweep, get } = setup(t);
  request('w1', { title: 'Release 0.50.0.50', brief: '/ff-agents:ci-release', status: 'new', createdAt: ago(300), updatedAt: ago(290) });
  request('w2', { title: 'Release 0.50.0.58', brief: '/ff-agents:ci-release', status: 'done', createdAt: ago(100), updatedAt: ago(90) });
  await sweep.run();
  assert.equal(get('w1').status, 'stalled');
  assert.deepEqual([get('w1').stalled?.kind, get('w1').stalled?.by], ['superseded', 'w2']);
  assert.match(get('w1').stalled!.reason, /^probably superseded by w2/);
});

test('a stalled request is its person’s: a note revives it, close ends it, and the cleanup does not touch it again', async (t) => {
  const { request, sweep, get, o } = setup(t);
  request('w1', { status: 'new', updatedAt: ago(30) });
  request('w2', { status: 'new', updatedAt: ago(30) });
  await sweep.run();
  assert.equal(get('w1').status, 'stalled');
  const chat = o.personalFor(BEN);
  chat.lastFrom = 'human';
  assert.match(o.update(chat, { id: 'w1', note: 'Still wanted: please carry on.' }), /revived from stalled/);
  assert.equal(get('w1').status, 'new');
  assert.equal(get('w1').stalled, undefined);
  assert.match(o.update(chat, { id: 'w2', close: 'cancelled', note: 'No longer needed.' }), /w2 is cancelled/);
  assert.equal(get('w2').status, 'cancelled');
  const log = get('w1').log.length;
  await sweep.run();
  assert.equal(get('w1').status, 'new', 'revived: its quiet clock restarted');
  assert.equal(get('w1').log.length, log);
});

test('nothing changed: no message, no log line, and the first run lists what stayed open; later ones stay silent', async (t) => {
  const { request, worker, pr, world, sweep, get, heard } = setup(t);
  request('w1', { title: 'Release 0.50.0.60', brief: 'Use /ff-agents:ci-release.', sessionIds: ['s1'] });
  worker('s1', { lastResult: 'Release PR merged; building.' });
  world.prs = [pr(21, { body: 'Request: w1' })];
  request('w2', { status: 'queued', updatedAt: ago(1) });
  await sweep.run();
  await until('the first run tells what stayed open', () => heard().length === 1);
  assert.match(heard()[0].text, /stayed open 1: w1 .*release ends when the build is live/);
  const logLen = get('w1').log.length;
  assert.match(await sweep.run(), /left open with a reason/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(heard().length, 1, 'the second run says nothing');
  assert.equal(get('w1').log.length, logLen, 'and logs nothing');
  assert.equal(get('w2').status, 'queued');
});

test('a run with nothing to do says so, tells nobody, and is on its schedule; off means off', async (t) => {
  const { request, sweep, heard } = setup(t);
  request('w1', { status: 'queued', updatedAt: ago(1) });
  assert.equal(await sweep.run(), 'nothing to do');
  assert.equal(sweep.state().lastRunAt, new Date(NOW).toISOString());
  assert.deepEqual([sweep.state().enabled, sweep.state().everyHours], [true, 4]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(heard().length, 0);
  const off = setup(t, { cleanup: { enabled: false, everyHours: 6 } });
  assert.match(await off.sweep.run(), /off/);
  assert.deepEqual([off.sweep.state().enabled, off.sweep.state().everyHours], [false, 6]);
});

test('gh down: the pull-request rule waits, the rest of the cleanup still runs', async (t) => {
  const { request, sweep, world, get } = setup(t);
  request('w1', { status: 'new', updatedAt: ago(30) });
  world.prs = undefined;
  assert.deepEqual(await sweep.checkPrs(), []);
  await sweep.run();
  assert.equal(get('w1').status, 'stalled');
});

test('w363: a full pass that starts while a PR pass runs waits for it, then closes, resumes and stalls every category, and logs each', async (t) => {
  const { request, worker, world, sweep, get } = setup(t);
  const lines: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  // FINISHED, in the words Ben's workers used (old requests, no Request: lines, no PRs).
  const done = (id: string, report: string) => {
    request(id, { createdAt: ago(130), updatedAt: ago(30), sessionIds: [`s-${id}`] });
    worker(`s-${id}`, { lastActivityAt: ago(30), lastResult: report });
  };
  done('w92', "TL;DR: It's fully merged to develop, so I'm idle.");
  done('w157', 'TL;DR:** Deploy is fixed and merged into develop as 1e0ba7209.');
  done('w122', 'Nothing is open or pending.');
  done('w89', 'My task is finished.');
  // Not finished: waiting on CI.
  done('w95', 'Waiting on CI; I will merge when it is green.');
  // CUT OFF by a usage limit: the turn ended idle with Claude's limit line as its result.
  request('w17', { createdAt: ago(130), updatedAt: ago(30), sessionIds: ['s-w17'] });
  worker('s-w17', { lastActivityAt: ago(30), lastResult: "You've hit your session limit · resets 7pm" });
  // IDLE for days with no worker; and a SUPERSEDED old release.
  request('w10', { createdAt: ago(130), updatedAt: ago(100) });
  request('w83', { title: 'Release 0.50.0.60', brief: '/ff-agents:ci-release', status: 'active', createdAt: ago(130), updatedAt: ago(120) });
  request('w300', { title: 'Release 0.50.0.72', brief: '/ff-agents:ci-release', status: 'done', createdAt: ago(20), updatedAt: ago(10) });
  // A RUNNING worker is never touched, whatever its report says.
  request('w200', { createdAt: ago(130), updatedAt: ago(100), sessionIds: ['s-w200'] });
  worker('s-w200', { status: 'running', lastActivityAt: ago(100), lastResult: 'Done.' });

  // The PR pass holds the sweep busy (gh slow) when the full pass is due.
  let release!: () => void;
  const slow = new Promise<PrRecord[]>((r) => (release = () => r([])));
  world.prs = slow as unknown as PrRecord[];
  const prPass = sweep.checkPrs();
  await new Promise((r) => setTimeout(r, 20));
  const full = sweep.run();
  await new Promise((r) => setTimeout(r, 50));
  release();
  world.prs = [];
  await prPass;
  const summary = await full;
  assert.notEqual(summary, 'a cleanup is already running', 'it waited instead of skipping');
  assert.ok(sweep.state().lastRunAt, 'and recorded the run');

  assert.deepEqual(['w92', 'w157', 'w122', 'w89'].map((id) => get(id).status), ['done', 'done', 'done', 'done']);
  assert.match(get('w92').outcome ?? '', /final report says it is delivered/);
  assert.notEqual(get('w95').status, 'done', 'waiting on CI is not finished');
  assert.equal(world.resumed.length, 1, 'the limit-cut worker is resumed once (its limit has reset)');
  assert.equal(world.resumed[0].id, 's-w17');
  assert.deepEqual([get('w10').status, get('w10').stalled?.kind], ['stalled', 'idle']);
  assert.deepEqual([get('w83').status, get('w83').stalled?.kind, get('w83').stalled?.by], ['stalled', 'superseded', 'w300']);
  assert.equal(get('w200').status, 'active', 'a running worker is never touched');
  for (const re of [/^ledger cleanup: closed w92 \(ben\): /, /^ledger cleanup: resumed w17 \(ben\): /, /^ledger cleanup: stalled w10 \(ben\): /, /^ledger cleanup: stalled w83 \(ben\): probably superseded by w300/, /^ledger cleanup: full pass: closed 4, resumed 1, stalled/]) {
    assert.ok(lines.some((l) => re.test(l)), `${re}\n${lines.join('\n')}`);
  }
});

test('w363: a usage limit not yet reset stalls the request with the reason; a worker that is idle for another reason is not cut off', async (t) => {
  const { request, worker, world, sweep, get } = setup(t);
  world.prs = [];
  world.clear = false;
  request('w34', { createdAt: ago(130), updatedAt: ago(30), sessionIds: ['s-w34'] });
  worker('s-w34', { lastActivityAt: ago(30), lastResult: "You've hit your weekly limit · resets Oct 6" });
  request('w35', { createdAt: ago(130), updatedAt: ago(2), sessionIds: ['s-w35'] });
  worker('s-w35', { lastActivityAt: ago(2), lastResult: 'I looked at the limit code: the weekly limit resets on Monday.' });
  await sweep.run();
  assert.deepEqual([get('w34').status, get('w34').stalled?.kind], ['stalled', 'cut-off']);
  assert.match(get('w34').stalled!.reason, /weekly limit.*the limit has not reset yet/);
  assert.equal(world.resumed.length, 0);
  assert.equal(get('w35').status, 'active', 'a report that mentions a limit is not a cut-off');
});

test('w370: auto-closed on a loose link, reopened by hand, closed by hand: the re-check leaves it closed', async (t) => {
  const { request, pr, world, sweep, get, o } = setup(t);
  const closedBy = { at: ago(4), how: 'prs' as const, pr: 1002, sha: 'a'.repeat(40), text: 'merged as #1002 (a684e5257e6b) on 2026-10-04' };
  request('w50', {
    requestedBy: LOTH, requesters: [LOTH], createdAt: ago(120), updatedAt: ago(4), status: 'done',
    autoClosed: closedBy, outcome: 'closed automatically: merged as #1002 (a684e5257e6b) on 2026-10-04',
    prs: [{ repo: REPO, number: 884, state: 'merged' }, { repo: REPO, number: 1002, state: 'merged' }],
    log: ['01:41 linked PR #884 (merged), PR #1002 (open)', '02:29 closed automatically by the ledger cleanup: merged as #1002 (a684e5257e6b) on 2026-10-04'],
  });
  world.prs = [pr(1002, { head: 'ffbox-f/altd-desync', createdAt: ago(6), mergedAt: ago(5) }), pr(884, { createdAt: ago(130), mergedAt: ago(125) })];
  const loth = o.personalFor(LOTH);
  loth.lastFrom = 'human';
  o.update(loth, { id: 'w50', reopen: true, note: 'Reopened: it was wrongly auto-closed as "merged as #1002".' });
  o.update(loth, { id: 'w50', close: 'done', note: "Closed at lothsahn's request (likely covered by w257/#961 and w287)." });
  const w = get('w50');
  assert.deepEqual([w.status, w.autoClosed, w.prs], ['done', undefined, []], 'a hand close clears the mark and the loose links');
  await sweep.checkPrs();
  assert.equal(get('w50').status, 'done', 'a person’s close is final');
  assert.equal(get('w50').outcome, "Closed at lothsahn's request (likely covered by w257/#961 and w287).");
  assert.doesNotMatch(get('w50').log.join('\n'), /reopened by the ledger cleanup/);
});

test('w370: a stale auto-close mark under a later hand close (from before the fix) is dropped, never acted on; the dispatcher’s close counts too', async (t) => {
  const { request, pr, world, sweep, get } = setup(t);
  const closedBy = (n: number) => ({ at: ago(4), how: 'prs' as const, pr: n, sha: 'a'.repeat(40), text: `merged as #${n} (aaaaaaaaaaaa) on 2026-10-04` });
  // w50 as it was at 06:33: reopened by hand on the old code (the mark stayed), then closed by hand.
  request('w50', {
    requestedBy: LOTH, requesters: [LOTH], createdAt: ago(120), updatedAt: ago(1), status: 'done', autoClosed: closedBy(1002),
    outcome: "Closed at lothsahn's request.", prs: [{ repo: REPO, number: 1002, state: 'merged' }],
    log: ['02:29 closed automatically by the ledger cleanup: merged as #1002 (a684e5257e6b) on 2026-10-04', '05:29 lothsahn: reopened; note: Reopened: wrongly auto-closed', "06:33 lothsahn: note: Closed at lothsahn's request.; closed as done"],
  });
  // w339 as it was at 02:26: auto-closed on #988, reopened by hand, then closed by the dispatcher on its own PR #1011.
  request('w339', {
    requestedBy: LOTH, requesters: [LOTH], createdAt: ago(10), updatedAt: ago(2), status: 'done', autoClosed: closedBy(988),
    outcome: 'Merged as PR #1011: the Express Logistics Bay text.', prs: [{ repo: REPO, number: 988, state: 'merged' }],
    log: ['01:54 closed automatically by the ledger cleanup: merged as #988 (3e375ee92d6e) on 2026-10-04', '01:54 lothsahn: reopened; note: Reopened', '02:26 dispatcher: done: Merged as PR #1011'],
  });
  // An ordinary automatic close on a loose link, nobody touched since: still checked and reopened.
  request('w8', { createdAt: ago(200), updatedAt: ago(4), status: 'done', autoClosed: closedBy(1013), outcome: 'closed automatically: merged as #1013', prs: [{ repo: REPO, number: 1013, state: 'merged' }], log: ['03:39 closed automatically by the ledger cleanup: merged as #1013 (7ee49a003bc9) on 2026-10-04'] });
  world.prs = [pr(1002, { createdAt: ago(6), mergedAt: ago(5) }), pr(988, { createdAt: ago(20), mergedAt: ago(15) }), pr(1013, { createdAt: ago(6), mergedAt: ago(5) })];
  await sweep.checkPrs();
  assert.deepEqual([get('w50').status, get('w50').autoClosed, get('w50').outcome], ['done', undefined, "Closed at lothsahn's request."]);
  assert.deepEqual([get('w339').status, get('w339').autoClosed, get('w339').outcome], ['done', undefined, 'Merged as PR #1011: the Express Logistics Bay text.']);
  assert.equal(get('w8').status, 'new', 'the cleanup’s own close is still checked');
  assert.equal(handledAfterAutoClose(['03:39 closed automatically by the ledger cleanup: merged as #1013', '05:30 reopened by the ledger cleanup: PR #1013 is not this request\'s']), false);
  assert.equal(handledAfterAutoClose(['02:29 closed automatically by the ledger cleanup: x', '05:29 ben: reopened']), true);
  assert.equal(handledAfterAutoClose(['02:29 closed automatically by the ledger cleanup: x', '05:31 worker ab12cd34: FIX-LANDED 1a2b3c4d']), true);
});
