import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { LedgerSweep, handledAfterAutoClose } from './ledgerSweep.ts';
import type { PrRecord } from './ledgerRules.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, TranscriptEvent, UserInfo, WorkItem } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { workLiveAll } from '../shared/workState.ts';

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
const APP = 'Final-Factory/ff-factory';

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
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  const o = agents.orchestrators;
  const world = { prs: [] as PrRecord[] | undefined, clear: true as boolean | undefined, resumed: [] as { id: string; text: string }[], view: undefined as ((number: number) => PrRecord | undefined) | undefined, viewed: [] as number[], portal: undefined as string | undefined, daemons: [] as { id: string; sha?: string }[], ancestors: new Set<string>() };
  const sweep = new LedgerSweep({
    cfg,
    store,
    orchestrators: o,
    repos: async () => [REPO],
    prs: async () => world.prs,
    viewPr: async (_repo, number) => {
      world.viewed.push(number);
      return world.view?.(number);
    },
    resume: (id, text) => void world.resumed.push({ id, text }),
    limitsClear: () => world.clear,
    appRepo: async () => APP,
    portalSha: () => world.portal,
    daemons: () => world.daemons,
    contains: async (sha, head) => world.ancestors.has(`${sha}:${head}`),
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
  // The ledger's clock is the sweep's here: w50, closed at ago(4), must not age with the wall clock (this began failing at
  // 2026-10-10T08:00Z, 7 days after NOW, when updateProblem refused to reopen a request "closed more than 7 days ago").
  (o as unknown as { now: () => Date }).now = () => new Date(NOW);
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

// ---------------------------------------------------------------- w419: DONE markers, the wrap-up and the follow-up

const told = (store: Store, o: Agents['orchestrators'], who: Requester, prefix: string) =>
  store.readTranscript(o.personalFor(who).info.id).filter((e) => e.kind === 'user' && e.text.startsWith(prefix));

test('w419: DONE: wNNN from its own worker closes the request with the report as the note; a mention in a sentence does not', async (t) => {
  const { request, worker, o, get, store } = setup(t);
  request('w1', { sessionIds: ['s1'], prs: [{ repo: REPO, number: 11, state: 'merged', at: ago(5), via: 'line' }] });
  request('w2', { sessionIds: ['s1'] });
  const s1 = worker('s1');
  o.workerTurnEnded(s1, 'Started on it. Reply DONE: w2 when you are sure, the brief says.');
  assert.equal(get('w2').status, 'active', 'DONE inside a sentence is not a marker');
  o.workerTurnEnded(s1, 'TL;DR: #11 merged and the check ran clean.\n\n**DONE: w1**\nLearned: nothing new');
  const w = get('w1');
  assert.equal(w.status, 'done');
  assert.equal(w.outcome, 'TL;DR: #11 merged and the check ran clean.');
  assert.match(w.log.at(-1)!, /closed as done: worker s1 said DONE: w1\. Its report: TL;DR: #11 merged/);
  await until('its person hears', () => told(store, o, BEN, '[ledger] w1').length === 1);
  assert.equal(get('w2').status, 'active', 'the other request of the same worker stays open');
});

test('w419: a DONE is refused back to the worker while a PR is open, a step after the merge is not covered, or it is not its worker; a hand close stays', async (t) => {
  const { request, worker, o, get } = setup(t);
  request('w1', { sessionIds: ['s1'], prs: [{ repo: REPO, number: 11, state: 'merged', at: ago(5), via: 'line' }, { repo: REPO, number: 12, state: 'open', via: 'line' }] });
  request('w2', { sessionIds: ['s1'], brief: 'Fix it, then run the paired determinism audit after the merge.', prs: [{ repo: REPO, number: 13, state: 'merged', at: ago(5), via: 'line' }] });
  request('w3', { sessionIds: ['s9'] });
  request('w4', { sessionIds: ['s1'], status: 'cancelled' });
  const s1 = worker('s1');
  o.workerTurnEnded(s1, 'Merged.\nDONE: w1\nDONE: w2\nDONE: w3\nDONE: w4\nLearned: nothing new');
  assert.equal(get('w1').status, 'active');
  assert.match(get('w1').log.join('\n'), /said DONE, refused: PR #12 is still open: merge or close it first/);
  assert.equal(get('w2').status, 'active');
  assert.match(get('w2').log.join('\n'), /refused: its brief asks for a step after the merge .*say in the report what it showed/);
  assert.equal(get('w3').status, 'active', 'not its worker');
  assert.equal(get('w4').status, 'cancelled', 'a request closed by hand stays closed (w370)');
  // The report covers the step: now it closes.
  o.workerTurnEnded(s1, 'The paired audit after the merge passed: no divergence on 544 heartbeats.\nDONE: w2\nLearned: nothing new');
  assert.equal(get('w2').status, 'done');
});

test('w741: a DONE carries a Learned: line; without one it is refused and the worker told; a reopened request needs the check, not "nothing new"', async (t) => {
  const { request, worker, o, get } = setup(t);
  request('w1', { sessionIds: ['s1'], prs: [{ repo: REPO, number: 11, state: 'merged', at: ago(5), via: 'line' }] });
  request('w2', { sessionIds: ['s1'], reopenedAt: ago(30), prs: [{ repo: REPO, number: 14, state: 'merged', at: ago(5), via: 'line' }] });
  const s1 = worker('s1');
  o.workerTurnEnded(s1, 'Merged.\nDONE: w1');
  assert.equal(get('w1').status, 'active');
  assert.match(get('w1').log.join('\n'), /said DONE, refused: say what it taught you: add a line `Learned: <the file or PR where you wrote it down>` or `Learned: nothing new`/);
  o.workerTurnEnded(s1, 'Merged.\nDONE: w1\n**Learned:** nothing new');
  assert.equal(get('w1').status, 'done', 'markdown around the line is fine');
  // w704: closed on unit tests, reopened by its person: the DONE names the check that would have caught it.
  o.workerTurnEnded(s1, 'Live SP and MP runs fill both holds.\nDONE: w2\nLearned: nothing new');
  assert.equal(get('w2').status, 'active');
  assert.match(get('w2').log.join('\n'), /refused: a person reopened it: the `Learned:` line names the check that would have caught the miss/);
  o.workerTurnEnded(s1, 'Live SP and MP runs fill both holds.\nDONE: w2\nLearned: evidence-gate checklists/done.md item 2, the brief\'s Done item by item (final-factory-agents #19)');
  assert.equal(get('w2').status, 'done');
});

test('w419: sent to another request, a worker is asked first to wrap up the one it was on; its answer goes to that request’s log', async (t) => {
  const { request, worker, o, get } = setup(t);
  request('w1', { sessionIds: ['s1'], links: { s1: { at: ago(30), how: 'sent' } } });
  request('w2', { status: 'new', createdAt: ago(1) });
  const s1 = worker('s1');
  assert.equal(o.wrapUpBefore('s1', 'w1'), '', 'the request it is on: no wrap-up');
  const pre = o.wrapUpBefore('s1', 'w2');
  assert.match(pre, /^\[wrap-up\] Before the new work below: you were on w1 "Fix w1"\. .*`DONE: <id>`.*`<id>: still open: <what>` if you go on with it as well.*`<id>: paused: <why>` if you set it aside until w2 is done\. Then carry on with the new work/);
  assert.match(get('w1').log.at(-1)!, /worker s1 was sent w2: asked to wrap w1 up first/);
  o.linkWorker('w2', s1, 'sent to worker s1');
  o.workerTurnEnded(s1, 'Started w2: reading the save.\n\nw1: still open: the 2-peer check after the merge.');
  assert.equal(get('w1').status, 'active');
  assert.match(get('w1').log.at(-1)!, /wrap-up from worker s1: w1: still open: the 2-peer check after the merge\./);
  assert.equal(get('w1').outcome, 'w1: still open: the 2-peer check after the merge.');
  assert.equal(get('w2').outcome, 'Started w2: reading the save.');
  // A DONE in the wrap-up closes it like any DONE.
  request('w3', { status: 'new', createdAt: ago(0.5) });
  o.wrapUpBefore('s1', 'w3');
  o.linkWorker('w3', s1, 'sent to worker s1');
  o.workerTurnEnded(s1, 'On w3 now.\nDONE: w2\nLearned: nothing new');
  assert.equal(get('w2').status, 'done');
});

test('w915: a request a busy worker holds is never stalled or asked about, even sent on to a later request; one it let go of still is', async (t) => {
  const { request, worker, world, sweep, get } = setup(t);
  // w909 on 2026-10-10: its worker was sent w911 and went on with w909's PR; the page said "Stalled, moved on to w911".
  request('w1', { sessionIds: ['s1'], updatedAt: ago(40), createdAt: ago(80), links: { s1: { at: ago(80), how: 'sent' } }, prs: [{ repo: REPO, number: 21, state: 'merged', at: ago(8), via: 'line' }], brief: 'Fix it, then run the paired audit after the merge.' });
  request('w2', { sessionIds: ['s1'], updatedAt: ago(1), createdAt: ago(2), links: { s1: { at: ago(2), how: 'sent' } } });
  worker('s1', { status: 'running', lastActivityAt: ago(0.1) });
  request('w3', { sessionIds: ['s3'], updatedAt: ago(40), createdAt: ago(80), links: { s3: { at: ago(80), how: 'sent' } }, setAside: { s3: { at: ago(3), kind: 'paused', for: 'w4' } } });
  request('w4', { sessionIds: ['s3'], updatedAt: ago(1), createdAt: ago(3), links: { s3: { at: ago(4), how: 'sent' } } });
  worker('s3', { status: 'running', lastActivityAt: ago(0.1) });
  request('w5', { sessionIds: ['s5'], updatedAt: ago(40), createdAt: ago(80), links: { s5: { at: ago(80), how: 'sent' } } });
  request('w6', { sessionIds: ['s5'], updatedAt: ago(1), createdAt: ago(2), links: { s5: { at: ago(2), how: 'sent' } } });
  worker('s5', { status: 'stopped', lastActivityAt: ago(40) });
  await sweep.run();
  assert.equal(get('w1').status, 'active', 'held by a busy worker: not stalled');
  assert.equal(get('w1').followUp, undefined, 'and not asked "Is it done?"');
  assert.equal(get('w3').status, 'active', 'paused by a busy worker: not stalled');
  assert.equal(get('w5').status, 'stalled', 'its worker stopped: nothing works on it');
  assert.deepEqual(world.resumed, []);
});

test('w915: the wrap-up asks about everything the worker holds; paused sets it aside for the new request, silence lets it go, still open keeps it', async (t) => {
  const { request, worker, o, get, store } = setup(t);
  request('w1', { sessionIds: ['s1'], links: { s1: { at: ago(30), how: 'sent' } } });
  request('w2', { sessionIds: ['s1'], links: { s1: { at: ago(20), how: 'sent' } } });
  request('w3', { sessionIds: ['s1'], links: { s1: { at: ago(10), how: 'sent' } } });
  request('w4', { status: 'new', createdAt: ago(1) });
  const s1 = worker('s1', { status: 'running' });
  const pre = o.wrapUpBefore('s1', 'w4');
  assert.match(pre, /you were on w1 "Fix w1", w2 "Fix w2", w3 "Fix w3"\./, 'also the older ones it held on to, not only the request its turn was on');
  assert.match(pre, /`w1: paused: <why>` if you set it aside until w4 is done|`<id>: paused: <why>` if you set it aside until w4 is done/);
  o.linkWorker('w4', s1, 'sent to worker s1');
  o.workerTurnEnded(s1, 'On w4 now.\n\nw1: paused: the runner group needs an admin; back on it after w4\nw3: still open: the 2-peer check');
  assert.equal(get('w1').setAside?.s1?.kind, 'paused');
  assert.equal(get('w1').setAside?.s1?.for, 'w4');
  assert.equal(get('w2').setAside?.s1?.kind, 'released', 'asked, it said nothing about w2');
  assert.match(get('w2').log.at(-1)!, /did not say how w2 stands in its wrap-up; no longer counted as working on it/);
  assert.equal(get('w3').setAside, undefined, 'still open: it goes on with it');
  const live = workLiveAll([get('w1'), get('w2'), get('w3'), get('w4')], { session: (id) => store.sessions.get(id), now: NOW });
  assert.deepEqual([...live].map(([id, l]) => `${id}:${l.state}`), ['w1:paused', 'w2:stalled', 'w3:working', 'w4:working']);
  assert.equal(live.get('w1')?.why, 'worker s1 on w4 first');
  // A paused line outside a wrap-up counts too, for the request the turn is on; "still open" takes it up again.
  o.workerTurnEnded(s1, 'w3: paused: waiting on the audit slot');
  assert.equal(get('w3').setAside?.s1?.for, 'w4');
  o.workerTurnEnded(s1, 'w3: still open: the audit slot came');
  assert.equal(get('w3').setAside, undefined);
});

test('w419: merged and open for a step after the merge, quiet 6 hours: its worker is asked once a day, also while busy on another request; gone, it stalls', async (t) => {
  const { request, worker, pr, world, sweep, get, store } = setup(t);
  const brief = 'Fix it, then run the paired audit after the merge.';
  request('w1', { brief, sessionIds: ['s1'] });
  worker('s1', { lastActivityAt: ago(10) });
  // w2's worker moved on to w5 (newer) and is running there: the PR pass skips w2, so its PR is linked as an earlier pass left it.
  // It let w2 go in the wrap-up (said nothing about it); w6 it still holds (w915), so the cleanup leaves w6 alone.
  request('w2', { brief, sessionIds: ['s2'], createdAt: ago(72), setAside: { s2: { at: ago(4), kind: 'released' } }, prs: [{ repo: REPO, number: 22, state: 'merged', at: ago(8), via: 'line' }], log: ['04:00 PR #22 merged; still open: its brief asks for a step after the merge (a check, an audit, a verification)'] });
  request('w6', { brief, sessionIds: ['s2'], createdAt: ago(80), prs: [{ repo: REPO, number: 26, state: 'merged', at: ago(8), via: 'line' }], log: ['04:00 PR #26 merged; still open: its brief asks for a step after the merge (a check, an audit, a verification)'] });
  request('w5', { sessionIds: ['s2'], createdAt: ago(3) });
  worker('s2', { status: 'running', lastActivityAt: ago(0.1) });
  request('w3', { brief, sessionIds: ['gone'] });
  request('w4', { brief, sessionIds: ['s4'] });
  worker('s4', { lastActivityAt: ago(2) });
  world.prs = [pr(21, { body: 'Request: w1', mergedAt: ago(8) }), pr(23, { body: 'Request: w3', mergedAt: ago(8) }), pr(24, { body: 'Request: w4', mergedAt: ago(8) })];
  const summary = await sweep.run();
  assert.match(summary, /asked 2 whether done/);
  assert.deepEqual(world.resumed.map((r) => r.id).sort(), ['s1', 's2']);
  const ask = world.resumed.find((r) => r.id === 's1')!.text;
  assert.match(ask, /^\[ledger cleanup\] Is w1 "Fix w1" done\? PR #21 merged \(2026-10-03 04:00 UTC\) and it stayed open: its brief asks for a step after the merge.*a line `DONE: w1`/);
  assert.equal(get('w1').followUp?.sessionId, 's1');
  assert.match(get('w1').log.join('\n'), /ledger cleanup asked worker s1 whether it is done \(no word for 8 h since PR #21 merged/);
  assert.equal(get('w3').status, 'stalled');
  assert.match(get('w3').stalled!.reason, /^follow-up unconfirmed: its brief asks for a step after the merge .*no worker is left to ask/);
  assert.equal(get('w4').followUp, undefined, 'word 2 hours ago: not asked yet');
  assert.equal(get('w5').followUp, undefined);
  assert.equal(get('w6').followUp, undefined, 'its worker s2 is mid-turn and still holds it: not asked, not stalled');
  // Once a day: the next pass asks nobody again.
  await sweep.run();
  assert.equal(world.resumed.length, 2);
  assert.ok(store);
});

// ---------------------------------------------------------------- w434: a request with several workers

test('w434: with two workers on a request, the first one\'s DONE records its part and keeps it open; the last one\'s closes it', async (t) => {
  const { request, worker, o, get, store } = setup(t);
  // w428 on 2026-10-05: worker 2092b20c's DONE after its hardware read closed the request while the placement work was unpushed.
  request('w1', { sessionIds: ['s1', 's2'], links: { s1: { at: ago(3), how: 'sent' }, s2: { at: ago(2), how: 'sent' } } });
  const s1 = worker('s1');
  worker('s2', { status: 'running' });
  o.workerTurnEnded(s1, 'BEAST hardware read: the CPU throttles at 95 °C.\nDONE: w1\nLearned: nothing new');
  assert.equal(get('w1').status, 'active', "one worker's DONE does not close it");
  assert.deepEqual(Object.keys(get('w1').done ?? {}), ['s1']);
  assert.match(get('w1').log.join('\n'), /worker s1 said DONE for its part; still on it: s2$/m);
  // The last worker's DONE closes it, on its report.
  o.workerTurnEnded(worker('s2'), 'Placement preference merged as #104.\nDONE: w1\nLearned: nothing new');
  assert.equal(get('w1').status, 'done');
  assert.equal(get('w1').outcome, 'Placement preference merged as #104.');
  assert.match(get('w1').log.join('\n'), /closed as done: worker s2 said DONE: w1 \(its workers s1, s2 each said DONE\)/);
  await until('its person hears', () => told(store, o, BEN, '[ledger] w1').length === 1);
});

test('w434: the last worker ending (or moving on) closes a request its other workers said DONE for; a missing step still holds it', async (t) => {
  const { request, worker, o, get } = setup(t);
  request('w1', { sessionIds: ['s1', 's2'] });
  const s1 = worker('s1');
  const s2 = worker('s2', { status: 'running' });
  o.workerTurnEnded(s1, 'My part is in.\nDONE: w1\nLearned: nothing new');
  assert.equal(get('w1').status, 'active');
  // s2 stops (the idle reaper, a stop by hand): nobody is left on it, so s1's DONE closes it.
  store(s2, 'stopped');
  o.workerEnded(s2);
  assert.equal(get('w1').status, 'done');
  assert.match(get('w1').log.at(-1)!, /closed as done: its last worker still on it, s2, ended, and worker s1 had said DONE/);
  // A worker sent newer work has moved on: it no longer holds the request open.
  request('w2', { sessionIds: ['s3', 's4'], links: { s3: { at: ago(5), how: 'sent' }, s4: { at: ago(5), how: 'sent' } } });
  request('w3', { sessionIds: ['s4'], links: { s4: { at: ago(1), how: 'sent' } } });
  worker('s4', { status: 'running' });
  o.workerTurnEnded(worker('s3'), 'Done here.\nDONE: w2\nLearned: nothing new');
  assert.equal(get('w2').status, 'done', 's4 moved on to w3');
  // A step after the merge the report does not cover keeps it open even when the last worker ends.
  request('w5', { sessionIds: ['s5', 's6'], brief: 'Fix it, then run the paired determinism audit after the merge.' });
  o.workerTurnEnded(worker('s5'), 'Fixed.\nDONE: w5\nLearned: nothing new');
  const s6 = worker('s6', { status: 'stopped' });
  o.workerEnded(s6);
  assert.equal(get('w5').status, 'active');
  assert.match(get('w5').log.at(-1)!, /worker s6 ended; its other workers said DONE, but it stays open: its brief asks for a step after the merge/);

  function store(s: SessionInfo, status: SessionInfo['status']) {
    worker(s.id, { ...s, status });
  }
});

test('w475: a request whose worker is Waiting (a check-in, a background task, a queued message) is not stalled or asked about', async (t) => {
  const { request, worker, sweep, get } = setup(t);
  request('w1', { sessionIds: ['s1'], updatedAt: ago(70) });
  worker('s1', { lastActivityAt: ago(60), wakeAt: new Date(NOW + 10 * 60_000).toISOString() });
  request('w2', { sessionIds: ['s2'], updatedAt: ago(70) });
  worker('s2', { lastActivityAt: ago(60), backgroundTasks: 1 });
  request('w3', { sessionIds: ['s3'], updatedAt: ago(70) });
  worker('s3', { lastActivityAt: ago(60) });
  await sweep.run();
  assert.equal(get('w1').status, 'active', 'its worker checks in later');
  assert.equal(get('w2').status, 'active', 'its worker has a background task open');
  assert.equal(get('w3').status, 'stalled', 'idle with nothing pending: stalled, as before');
});

// ---------------------------------------------------------------- w515: PR states read live, refused DONEs re-checked

test('w515: a DONE seconds after its PR merged closes the request: the open PR is read live before refusing', async (t) => {
  const { request, worker, pr, world, sweep, o, get } = setup(t);
  // w484 on 2026-10-06: PR #1092 merged at 01:55:49, the DONE came at 01:56:24, the ledger still held it open.
  request('w1', { sessionIds: ['s1'], prs: [{ repo: REPO, number: 1092, state: 'open', via: 'line' }] });
  const s1 = worker('s1');
  o.prsLive = (id) => sweep.refreshLive(id);
  world.view = (n) => (n === 1092 ? pr(1092, { body: 'Request: w1', mergedAt: ago(0.01) }) : undefined);
  o.workerTurnEnded(s1, 'TL;DR: merged as #1092; the 2-peer check passed before the merge.\nDONE: w1\nLearned: nothing new');
  await until('it closes', () => get('w1').status === 'done');
  const w = get('w1');
  assert.deepEqual(w.prs?.map((p) => [p.number, p.state]), [[1092, 'merged']]);
  assert.match(w.log.join('\n'), /pull request states updated \(read live from GitHub\): PR #1092 merged/);
  assert.match(w.log.join('\n'), /closed as done: worker s1 said DONE: w1 \(its PR states read live from GitHub\)/);
  assert.doesNotMatch(w.log.join('\n'), /refused/);
  assert.deepEqual(world.viewed, [1092]);
});

test('w515: when gh cannot read the PR, the refusal says it could not verify it, not that it is still open', async (t) => {
  const { request, worker, sweep, o, get } = setup(t);
  request('w1', { sessionIds: ['s1'], prs: [{ repo: REPO, number: 11, state: 'open', via: 'line' }] });
  const s1 = worker('s1');
  o.prsLive = (id) => sweep.refreshLive(id);
  o.workerTurnEnded(s1, 'Merged.\nDONE: w1\nLearned: nothing new');
  await until('it is refused', () => get('w1').log.some((l) => /refused/.test(l)));
  assert.equal(get('w1').status, 'active');
  assert.match(get('w1').log.join('\n'), /said DONE, refused: couldn't verify PR #11 on GitHub just now \(the ledger last read it as open\)/);
  assert.doesNotMatch(get('w1').log.join('\n'), /still open/);
  // A live read that throws is the same: unverified.
  request('w2', { sessionIds: ['s1'], prs: [{ repo: REPO, number: 12, state: 'open', via: 'line' }] });
  o.prsLive = async () => {
    throw new Error('gh: HTTP 502');
  };
  o.workerTurnEnded(s1, 'Merged.\nDONE: w2\nLearned: nothing new');
  await until('it is refused', () => get('w2').log.some((l) => /refused/.test(l)));
  assert.match(get('w2').log.join('\n'), /couldn't verify PR #12/);
});

test('w515: a PR closed without merging and its merged replacement: the DONE closes the request (#1081 then #1087)', async (t) => {
  const { request, worker, pr, world, sweep, o, get } = setup(t);
  // w443: #1081 was closed and superseded by #1087, which merged; the ledger held both as open.
  request('w1', { sessionIds: ['s1'], prs: [{ repo: REPO, number: 1081, state: 'open', via: 'line' }, { repo: REPO, number: 1087, state: 'open', via: 'line' }] });
  const s1 = worker('s1');
  o.prsLive = (id) => sweep.refreshLive(id);
  world.view = (n) => (n === 1081 ? pr(1081, { state: 'closed', mergedAt: undefined, closedAt: ago(2) }) : n === 1087 ? pr(1087, { mergedAt: ago(0.01) }) : undefined);
  o.workerTurnEnded(s1, 'The fix merged as #1087 (#1081 was closed, superseded by it).\nDONE: w1\nLearned: nothing new');
  await until('it closes', () => get('w1').status === 'done');
  assert.deepEqual(get('w1').prs?.map((p) => [p.number, p.state]), [[1081, 'closed'], [1087, 'merged']]);
  // The same in the 5-minute pass: the list has both, the request is closed as merged, the closed one is not a blocker.
  request('w2', { sessionIds: ['s2'], prs: [{ repo: REPO, number: 2081, state: 'open', via: 'line' }, { repo: REPO, number: 2087, state: 'open', via: 'line' }] });
  worker('s2');
  world.prs = [pr(2081, { body: 'Request: w2', state: 'closed', mergedAt: undefined, closedAt: ago(3) }), pr(2087, { body: 'Request: w2', mergedAt: ago(1) })];
  assert.deepEqual(await sweep.checkPrs(), ['w2']);
  assert.equal(get('w2').autoClosed?.pr, 2087);
});

test('w515: a DONE refused on a stale open PR closes on the next pass once the PR shows merged; a busy or closed request gets fresh states too', async (t) => {
  const { request, worker, pr, world, sweep, o, get } = setup(t);
  // No live read (as before w515): refused on the cached state.
  request('w1', { sessionIds: ['s1'], brief: 'Done when: a 2-peer check passes; the PR is merged once it is green and verified.', prs: [{ repo: REPO, number: 1089, state: 'open', via: 'line' }] });
  const s1 = worker('s1');
  o.workerTurnEnded(s1, 'TL;DR: merged as #1089. Checked in a built player at 1080p, 1440p and Steam Deck, and the 2-peer check passed.\nDONE: w1\nLearned: nothing new');
  assert.match(get('w1').log.join('\n'), /refused: PR #1089 is still open/);
  // Its worker answers the refusal with another DONE, whose own text names no check (w454's second report).
  o.workerTurnEnded(s1, 'PR #1089 was merged at 01:32 UTC; gh pr view reports state MERGED.\nDONE: w1\nLearned: nothing new');
  assert.match(get('w1').done!.s1.text!, /2-peer check passed[^]*gh pr view reports/, 'both DONE reports are kept for the re-check');
  // A busy request (its worker is on it) and a closed one.
  request('w2', { sessionIds: ['s2'], prs: [{ repo: REPO, number: 22, state: 'open', via: 'line' }] });
  worker('s2', { status: 'running' });
  request('w3', { status: 'done', sessionIds: [], prs: [{ repo: REPO, number: 33, state: 'open', via: 'line' }] });
  world.prs = [pr(1089, { body: 'Request: w1', mergedAt: ago(0.1) }), pr(22, { body: 'Request: w2', mergedAt: ago(0.1) }), pr(33, { body: 'Request: w3', mergedAt: ago(5) })];
  await sweep.checkPrs();
  const w1 = get('w1');
  assert.equal(w1.status, 'done');
  assert.match(w1.log.join('\n'), /closed as done: worker s1 said DONE at \d\d:\d\d UTC and was refused then; PR #1089 merged since/);
  assert.equal(get('w2').status, 'active', 'its worker is running: states only, never closed');
  assert.deepEqual(get('w2').prs?.map((p) => p.state), ['merged']);
  assert.equal(get('w3').status, 'done');
  assert.deepEqual(get('w3').prs?.map((p) => p.state), ['merged'], 'a closed request no longer lists a merged PR as open (w443)');
});

test('w515: a refused DONE whose report does not cover a step after the merge stays refused; a report saying a PR merged reads it live', async (t) => {
  const { request, worker, pr, world, sweep, o, get } = setup(t);
  request('w1', { sessionIds: ['s1'], brief: 'Fix it, then run the paired determinism audit after the merge.', prs: [{ repo: REPO, number: 11, state: 'open', via: 'line' }] });
  const s1 = worker('s1');
  o.workerTurnEnded(s1, 'It is in.\nDONE: w1\nLearned: nothing new');
  world.prs = [pr(11, { body: 'Request: w1', mergedAt: ago(0.1) })];
  await sweep.checkPrs();
  assert.equal(get('w1').status, 'active');
  assert.match(get('w1').log.join('\n'), /PR #11 merged; still open: its brief asks for a step after the merge/);
  // A report that says #21 merged reads it live at once.
  request('w2', { sessionIds: ['s2'], prs: [{ repo: REPO, number: 21, state: 'open', via: 'line' }] });
  const s2 = worker('s2');
  o.prsLive = (id) => sweep.refreshLive(id);
  world.view = (n) => (n === 21 ? pr(21, { mergedAt: ago(0.01) }) : undefined);
  o.workerTurnEnded(s2, 'PR #21 is merged into develop; waiting on the nightly before I call it done.');
  await until('its state is read', () => get('w2').prs?.[0].state === 'merged');
  assert.equal(get('w2').status, 'active', 'no DONE: the PR pass decides, not the report');
});

test('w515: the one-time repair reads every PR the ledger holds as open, once, and logs what stays open and why', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  // Older than the list reaches: only a read by number finds them.
  request('w1', { status: 'done', prs: [{ repo: REPO, number: 1087, state: 'open', via: 'line' }] });
  request('w2', { sessionIds: ['s2'], prs: [{ repo: REPO, number: 1085, state: 'open', via: 'line', partOf: true }] });
  worker('s2');
  world.prs = [];
  world.view = (n) => (n === 1087 || n === 1085 ? pr(n, { body: n === 1085 ? 'Part of: w2' : 'Request: w1', mergedAt: ago(10) }) : undefined);
  const logs: string[] = [];
  const log = t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.join(' ')));
  await sweep.checkPrs();
  log.mock.restore();
  assert.deepEqual(world.viewed.sort(), [1085, 1087]);
  assert.deepEqual(get('w1').prs?.map((p) => p.state), ['merged']);
  assert.equal(get('w2').status, 'active');
  assert.ok(logs.some((l) => /PR repair: w2 stays open: PR #1085 is one step of it/.test(l)), logs.join('\n'));
  // Once: a later pass reads no closed request's PR by number again.
  world.viewed = [];
  request('w3', { status: 'done', prs: [{ repo: REPO, number: 9, state: 'open', via: 'line' }] });
  await sweep.checkPrs();
  assert.deepEqual(world.viewed, []);
});

test('w643: a Blocked request whose blocker is open and progressing is never stalled, however quiet, nor asked "Is it done?"; a merged PR with nothing left still closes it', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  request('w633', { updatedAt: ago(1), sessionIds: ['s633'] });
  worker('s633', { status: 'running', lastActivityAt: ago(0.1) });
  // w634 waits on w633 for days with nothing touching it; w641 waits on the next portal deploy.
  request('w634', { status: 'blocked', updatedAt: ago(100), blocked: { kind: 'request', ref: 'w633', what: "w633's timing table", at: ago(100), by: 'dispatcher' } });
  request('w641', { status: 'blocked', updatedAt: ago(100), blocked: { kind: 'deploy', what: 'the next portal deploy', at: ago(100), by: 'dispatcher', sha: 'aaa1111' } });
  // A blocked request with a merged PR and a step after the merge: no "Is it done?" while it is blocked.
  request('w642', { status: 'blocked', brief: 'Fix it, then run the paired audit after the merge.', sessionIds: ['s642'], blocked: { kind: 'time', until: new Date(NOW + 3_600_000).toISOString(), what: 'after the nightly run', at: ago(20), by: 'dispatcher' } });
  worker('s642', { lastActivityAt: ago(10) });
  // A blocked request whose PR merged with nothing left closes as done, like any other.
  request('w650', { status: 'blocked', sessionIds: ['s650'], blocked: { kind: 'machine', ref: 'm5', what: 'the M5 asleep', at: ago(5), by: 'dispatcher' } });
  worker('s650', { lastActivityAt: ago(4), lastResult: 'Done: PR #65 merged and verified.' });
  world.prs = [pr(64, { body: 'Request: w642', mergedAt: ago(8) }), pr(65, { body: 'Request: w650', mergedAt: ago(3) })];
  await sweep.run();
  assert.equal(get('w634').status, 'blocked', 'its blocker w633 is being worked');
  assert.equal(get('w641').status, 'blocked');
  assert.equal(get('w642').status, 'blocked');
  assert.equal(get('w642').followUp, undefined, 'not asked "Is it done?" while blocked');
  assert.deepEqual(world.resumed.map((r) => r.id), []);
  assert.equal(get('w650').status, 'done', get('w650').log.join('\n'));
});

// ---------------------------------------------------------------- w631: finished requests close themselves

test('w631: a request whose only step left after the merge is a portal deploy closes once the portal runs the merge, not before', async (t) => {
  const { request, worker, pr, world, sweep, get, heard } = setup(t);
  // w605 on 2026-10-07: merged, its worker waiting on the portal deploy, which the ops worker then did.
  request('w1', { sessionIds: ['s1'], title: 'Portal update no longer blocks the workers' });
  worker('s1', { lastResult: "Merged as #193. Waiting on the portal deploy, which needs lothsahn's own words." });
  world.prs = [pr(193, { repo: APP, body: 'Request: w1', sha: 'a'.repeat(40) })];
  world.portal = 'b0b0b0b';
  await sweep.checkPrs();
  assert.equal(get('w1').status, 'blocked', 'the portal does not run it yet: Blocked on the deploy (w643)');
  assert.deepEqual({ ...get('w1').blocked, at: undefined }, { kind: 'deploy', what: 'a portal deploy, after the merge', at: undefined, by: 'ledger cleanup', sha: 'b0b0b0b' });
  assert.match(get('w1').log.join('\n'), /PR #193 merged; still open: its worker's last report says more is coming[^\n]*\n.*blocked by the ledger cleanup on a portal deploy, after the merge: its only step left/);
  // Deployed: the running portal contains the merge.
  world.portal = 'c1c1c1c';
  world.ancestors.add(`${'a'.repeat(40)}:c1c1c1c`);
  assert.deepEqual(await sweep.checkPrs(), ['w1']);
  const w = get('w1');
  assert.equal(w.status, 'done');
  assert.equal(w.autoClosed?.how, 'deploy');
  assert.match(w.autoClosed!.text, /^merged as #193 \(aaaaaaaaaaaa\) on 2026-10-0\d; deployed since: the portal runs c1c1c1c$/);
  await until('its person hears', () => heard().some((h) => /closed as done 1: w1/.test(h.text)));
});

test("w890: w889 as it happened: its report puts a check of its own after the deploy, so the deploy landing resumes the worker instead of closing the request", async (t) => {
  const { request, worker, pr, world, sweep, get, o } = setup(t);
  // The worker's check-in (Agents.waker, which needs a live session handle this test does not build).
  const woke: { id: string; note: string }[] = [];
  (o as unknown as { d: { restoreWake: (id: string, note: string) => boolean } }).d.restoreWake = (id, note) => (woke.push({ id, note }), true);
  request('w1', { sessionIds: ['s1'], title: "FF Factory can't read GitHub CI on PRs" });
  worker('s1', { status: 'stopped', lastResult: 'w1: still open: waiting on Ben to give the go-ahead for the portal deploy of 65b1d27 and to add "Actions: Read-only" to the portal\'s D7 token; then I verify a live PR read and the health check' });
  world.prs = [pr(193, { repo: APP, body: 'Request: w1', sha: 'a'.repeat(40) })];
  world.portal = 'b0b0b0b';
  await sweep.checkPrs();
  assert.equal(get('w1').status, 'blocked', 'the cleanup blocks it on the deploy, as before');
  assert.equal(get('w1').blocked?.by, 'ledger cleanup');
  // The deploy lands: not closed. Its worker is resumed (a check-in within a minute) for the step it named.
  world.portal = 'c1c1c1c';
  world.ancestors.add(`${'a'.repeat(40)}:c1c1c1c`);
  assert.deepEqual(await sweep.checkPrs(), []);
  const w = get('w1');
  assert.equal(w.status, 'active');
  assert.equal(w.blocked, undefined);
  assert.equal(w.autoClosed, undefined);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].id, 's1');
  assert.match(woke[0].note, /^w1: the deploy you waited for has happened \(the portal runs c1c1c1c\)\. Your report put a step after it: "then I verify a live PR read and the health check"\. Do it now, then report\.$/);
  assert.match(w.log.at(-1)!, /^.*the deploy happened \(the portal runs c1c1c1c\); its worker s1 resumes within a minute for its step after it: then I verify a live PR read and the health check \(it was blocked on a portal deploy\)/);
});

test('w631: the deploy re-check is strict: another step left, a game-repo PR, a Part of: PR, machines not updated, or an unknown portal keep it open', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  const sha = (n: number) => String(n).padStart(2, '0').repeat(20);
  world.portal = 'feedfee';
  for (const n of [11, 12, 13, 14, 15]) world.ancestors.add(`${sha(n)}:feedfee`);
  // Another step besides the deploy: the paired audit.
  request('w1', { sessionIds: ['s1'], brief: 'Fix it, then run the paired determinism audit after the merge.' });
  worker('s1', { lastResult: 'Merged. Waiting on the portal deploy.' });
  // A game-repo PR: its "deploy" is not the portal's.
  request('w2', { sessionIds: ['s2'] });
  worker('s2', { lastResult: 'Merged. Waiting on the deploy.' });
  // Part of: more follows.
  request('w3', { sessionIds: ['s3'] });
  worker('s3', { lastResult: 'Merged. Waiting on the portal deploy.' });
  // Machine updates: each connected daemon must run it.
  request('w4', { sessionIds: ['s4'] });
  worker('s4', { lastResult: 'Merged as #14. Still to do: update the worker machines (beast, lothdesktop).' });
  world.daemons = [{ id: 'beast', sha: 'beefbee' }, { id: 'lothdesktop', sha: 'd00d00d' }];
  world.ancestors.add(`${sha(14)}:beefbee`);
  world.prs = [pr(11, { repo: APP, body: 'Request: w1' }), pr(12, { body: 'Request: w2' }), pr(13, { repo: APP, body: 'Part of: w3' }), pr(14, { repo: APP, body: 'Request: w4' })];
  await sweep.checkPrs();
  // w4's only step left is the machines' update: Blocked on it (w643); the others have more left, or are not this app's.
  assert.deepEqual(['w1', 'w2', 'w3', 'w4'].map((id) => get(id).status), ['active', 'active', 'active', 'blocked']);
  assert.equal(get('w4').blocked?.ref, 'machines');
  // The last machine updates: w4 closes, naming each daemon.
  world.daemons = [{ id: 'beast', sha: 'beefbee' }, { id: 'lothdesktop', sha: 'e0e0e0e' }];
  world.ancestors.add(`${sha(14)}:e0e0e0e`);
  assert.deepEqual(await sweep.checkPrs(), ['w4']);
  assert.match(get('w4').autoClosed!.text, /deployed since: each connected machine's daemon runs it \(beast beefbee, lothdesktop e0e0e0e\)$/);
  // A portal whose commit is unknown (no git, no FFSB_GIT_SHA) closes nothing.
  request('w5', { sessionIds: ['s5'] });
  worker('s5', { lastResult: 'Merged. Waiting on the portal deploy.' });
  world.prs.push(pr(15, { repo: APP, body: 'Request: w5' }));
  world.portal = undefined;
  await sweep.checkPrs();
  assert.equal(get('w5').status, 'blocked', 'not closed: Blocked on the portal deploy (w643)');
  assert.equal(get('w5').blocked?.sha, undefined, 'no commit known to compare with');
});

test('w631: a worker whose request names another (a takeover) closes that one with its DONE too, and both people hear it', async (t) => {
  const { request, worker, o, get, store } = setup(t);
  // w556 (Ben's) was left by its first worker; w604 (Lothsahn's) took it over and finished it.
  request('w556', { title: 'Windows shader warm-up', sessionIds: ['s0'] });
  worker('s0', { status: 'stopped' });
  request('w604', { title: 'Finish the Windows warm-up', requestedBy: LOTH, requesters: [LOTH], brief: 'Resume w556 now that Blender is installed.', sessionIds: ['s1'], createdAt: ago(10) });
  request('w7', { title: 'Unrelated', sessionIds: ['s9'] });
  const s1 = worker('s1', { requestedBy: LOTH });
  o.workerTurnEnded(s1, 'Warm-up lists merged as #1196 and checked in a Release player.\nDONE: w604\nDONE: w556\nDONE: w7\nLearned: nothing new');
  assert.equal(get('w604').status, 'done');
  assert.equal(get('w556').status, 'done', 'w604 names w556: its DONE closes it');
  assert.ok(get('w556').sessionIds.includes('s1'));
  assert.match(get('w556').log.join('\n'), /worker s1 said DONE for it from w604 "Finish the Windows warm-up" \(Lothsahn's\), which names w556: now one of its workers/);
  assert.equal(get('w7').status, 'active', 'a request nothing of its names stays open');
  await until('Ben hears w556 closed', () => told(store, o, BEN, '[ledger] w556').length === 1);
  await until('Lothsahn hears it too', () => told(store, o, LOTH, '[ledger] w556').length === 1);
  assert.match((told(store, o, LOTH, '[ledger] w556')[0] as { text: string }).text, /\(Ben's\) closed as done: worker s1 said DONE: w556/);
  // Named by its related ids alone works the same.
  request('w8', { sessionIds: ['s0'] });
  request('w9', { requestedBy: LOTH, requesters: [LOTH], relatedIds: ['w8'], sessionIds: ['s2'], createdAt: ago(5) });
  o.workerTurnEnded(worker('s2', { requestedBy: LOTH }), 'Both fixed.\nDONE: w9\nDONE: w8\nLearned: nothing new');
  assert.equal(get('w8').status, 'done');
});

test('w631: a report without a DONE or still-open line is asked about once, a moment after the turn; one that says how things stand is not', async (t) => {
  const { request, worker, o, get, sweep, world } = setup(t);
  o.statusAskDelayMs = 0;
  const asked = (id: string) => get(id).log.filter((l) => /asked worker \S+ how w\d+ stands/.test(l)).length;
  // Reads finished, but no marker: asked.
  request('w1', { sessionIds: ['s1'] });
  const s1 = worker('s1');
  o.workerTurnEnded(s1, 'All done: the fix is merged into develop and the fast suite is green.');
  await until('w1 asked', () => asked('w1') === 1);
  // Not again within 6 hours, even when the answer has no line either.
  o.workerTurnEnded(s1, 'It is merged.');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asked('w1'), 1);
  // A status line, a question, a report that says something is left, and a worker with a check-in ahead: not asked.
  request('w2', { sessionIds: ['s2'] });
  o.workerTurnEnded(worker('s2'), 'Merged #12.\nw2: still open: the nightly comparison after the merge');
  assert.equal(get('w2').outcome, 'w2: still open: the nightly comparison after the merge', 'its own line is its latest word');
  request('w3', { sessionIds: ['s3'] });
  o.workerTurnEnded(worker('s3'), 'Which of the two layouts do you want?');
  request('w4', { sessionIds: ['s4'] });
  o.workerTurnEnded(worker('s4'), 'Pushed; the remaining step is the 2-peer run.');
  request('w5', { sessionIds: ['s5'] });
  o.workerTurnEnded(worker('s5', { wakeAt: new Date(Date.now() + 20 * 60_000).toISOString() }), 'Build started; checking back in 20 minutes.');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(['w2', 'w3', 'w4', 'w5'].map(asked), [0, 0, 0, 0]);
  // Never answered: the cleanup still stalls it a day later, quoting the worker's own line when it has one.
  request('w6', { sessionIds: ['s6'], updatedAt: ago(30) });
  worker('s6', { status: 'stopped', lastActivityAt: ago(30), lastResult: 'Merged #16.\nw6: still open: waiting for the portal deploy' });
  world.prs = [];
  await sweep.run();
  assert.equal(get('w6').status, 'stalled');
  assert.match(get('w6').stalled!.reason, /its worker said: "w6: still open: waiting for the portal deploy"$/);
});

test("w631: the ops worker's DONE closes the requests its job was sent for, and only those", async (t) => {
  const { request, o, get, store } = setup(t);
  request('w1', { brief: 'Fix it, then deploy the portal.', prs: [{ repo: APP, number: 191, state: 'merged', at: ago(5), via: 'line' }] });
  request('w2', {});
  const ops = { id: 'ops-worker', kind: 'ops', title: 'Orchestration worker', status: 'idle', requestedBy: LOTH } as SessionInfo;
  const lines = o.opsTurnEnded(ops, 'Deployed: the portal runs c1c1c1c, verified by fffctl status.\nDONE: w1\nDONE: w2\nLearned: nothing new', { workIds: ['w1'], by: LOTH });
  assert.equal(get('w1').status, 'done');
  assert.match(get('w1').log.join('\n'), /closed as done: the orchestration worker said DONE: w1/);
  assert.equal(get('w2').status, 'active', 'the job was not sent for w2');
  assert.deepEqual(lines, ['DONE not accepted: w2: the job was not sent for it (ops_worker send with work_ids names the requests a job is a step of)', 'w1 closed as done on its DONE line']);
  await until('Ben and Lothsahn hear it', () => told(store, o, BEN, '[ledger] w1').length === 1 && told(store, o, LOTH, '[ledger] w1').length === 1);
  // A step after the merge the report does not cover is refused as for any worker.
  request('w3', { brief: 'Fix it, then run the paired audit after the merge.', prs: [{ repo: APP, number: 192, state: 'merged', at: ago(5), via: 'line' }] });
  assert.match(o.opsTurnEnded(ops, 'Deployed.\nDONE: w3\nLearned: nothing new', { workIds: ['w3'], by: LOTH }).join('\n'), /w3: its brief asks for a step after the merge/);
  assert.equal(get('w3').status, 'active');
});

test('w631: the backlog: a stalled request whose PRs name it only in their titles closes on the next pass; a step-only title keeps it open', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  // Ben's w165 on 2026-10-07: every PR merged on 10-02 (no Request: line then), stalled as "unsure" for days.
  request('w165', { status: 'stalled', stalled: { at: ago(48), kind: 'unsure', reason: 'its last report does not say it is done' }, sessionIds: ['s1'], createdAt: ago(130) });
  worker('s1', { status: 'stopped', lastActivityAt: ago(100), lastResult: 'Riders, Bats and beams are drawn on the ship; the two PRs are merged.' });
  request('w170', { status: 'stalled', stalled: { at: ago(48), kind: 'unsure', reason: 'x' }, createdAt: ago(130) });
  request('w186', { status: 'stalled', stalled: { at: ago(48), kind: 'unsure', reason: 'x' }, createdAt: ago(130) });
  world.prs = [
    pr(884, { title: 'Two players on one mobile station: riders, Bats and beams drawn on the ship (w165)', mergedAt: ago(120) }),
    pr(915, { title: 'A player who rides a station is hidden to everyone (w165)', mergedAt: ago(110) }),
    pr(883, { title: 'Desync report: show a construction bot\'s cargo (w170 diagnostics)', mergedAt: ago(120) }),
    pr(903, { title: 'w186: smooth-motion architecture, research and plan (docs only, do not merge yet)', mergedAt: ago(120) }),
  ];
  await sweep.run();
  assert.equal(get('w165').status, 'done');
  assert.deepEqual(get('w165').prs?.map((p) => [p.number, p.via]), [[884, 'title'], [915, 'title']]);
  assert.equal(get('w170').status, 'stalled', 'a request named inside other words is not linked');
  assert.equal(get('w186').status, 'stalled', 'a plan PR is a step: the request stays');
  assert.match(get('w186').log.join('\n'), /PR #903 merged; still open: PR #903 is one step of it/);
});

test('w631: a stalled request whose worker reported it delivered after the stall closes; one whose report predates the stall stays', async (t) => {
  const { request, worker, world, sweep, get } = setup(t);
  request('w1', { status: 'stalled', stalled: { at: ago(48), kind: 'idle', reason: 'no activity' }, sessionIds: ['s1'], updatedAt: ago(48) });
  worker('s1', { status: 'stopped', lastActivityAt: ago(10), lastResult: 'Picked it up again: the fix is merged into develop and the fast suite is green. Nothing more to do.' });
  request('w2', { status: 'stalled', stalled: { at: ago(48), kind: 'unsure', reason: 'unclear' }, sessionIds: ['s2'], updatedAt: ago(48) });
  worker('s2', { status: 'stopped', lastActivityAt: ago(60), lastResult: 'The fix is merged into develop. Nothing more to do.' });
  world.prs = [];
  await sweep.run();
  assert.equal(get('w1').status, 'done');
  assert.match(get('w1').autoClosed!.text, /its worker's final report says it is delivered/);
  assert.equal(get('w2').status, 'stalled', 'its report was read before it stalled: a person decides');
});

test('w643: Merged, follow-up pending on a deploy is Blocked on it; another step turning up unblocks it back to its follow-up, and a week without the deploy stalls it', async (t) => {
  const { request, worker, pr, world, sweep, get } = setup(t);
  world.portal = 'b0b0b0b';
  request('w1', { sessionIds: ['s1'] });
  worker('s1', { lastResult: 'Merged as #193. Waiting on the portal deploy.' });
  request('w2', { sessionIds: ['s2'], status: 'blocked', blocked: { kind: 'deploy', what: 'a portal deploy, after the merge', at: ago(24 * 8), by: 'ledger cleanup', sha: 'b0b0b0b' } });
  worker('s2', { lastResult: 'Merged as #194. Waiting on the portal deploy.' });
  world.prs = [pr(193, { repo: APP, body: 'Request: w1' }), pr(194, { repo: APP, body: 'Request: w2' })];
  await sweep.checkPrs();
  assert.equal(get('w1').status, 'blocked');
  assert.equal(get('w2').status, 'stalled', 'eight days and no deploy');
  assert.deepEqual([get('w2').stalled?.kind, get('w2').stalled?.reason], ['blocked', 'blocked on a portal deploy, after the merge for 8 days: no deploy has run the merge']);
  // Its worker says the paired audit is left too: back to Merged, follow-up pending, for the cleanup's "Is it done?".
  worker('s1', { lastResult: 'Merged as #193. Still to do after the deploy: run the paired determinism audit.' });
  await sweep.checkPrs();
  assert.equal(get('w1').status, 'active');
  assert.equal(get('w1').blocked, undefined);
  assert.match(get('w1').log.join('\n'), /unblocked by the ledger cleanup: a deploy is no longer the only step left/);
});

// ---------------------------------------------------------------- w731: a reopen invalidates every DONE and PR from before it

/**
 * w712 on 2026-10-09: its worker's DONE at 01:37 was refused (a PR was still open), the PR merged, a person reopened it for
 * a new defect (the colour), and the cleanup closed it twice more on that old DONE while the worker was mid-fix.
 */
function reopenedAfterOldDone(t: Parameters<typeof setup>[0]) {
  const s = setup(t);
  const { request, worker, pr, world, sweep, o, get } = s;
  request('w1', { sessionIds: ['s1'], prs: [{ repo: REPO, number: 1, state: 'open', via: 'line' }] });
  const s1 = worker('s1');
  // DONE while PR #1 is open: refused, and kept for the re-check.
  o.workerTurnEnded(s1, 'The panel fits.\nDONE: w1\nLearned: nothing new');
  assert.match(get('w1').log.join('\n'), /said DONE, refused: PR #1 is still open/);
  // The PR merges; the cleanup closes it on that DONE (w515).
  world.prs = [pr(1, { body: 'Request: w1', createdAt: ago(50), mergedAt: ago(40) })];
  const closedFirst = sweep.checkPrs();
  const reopen = async () => {
    await closedFirst;
    assert.equal(get('w1').status, 'done');
    const ben = o.personalFor(BEN);
    ben.lastFrom = 'human';
    // The reopen, and the worker starts on the new defect.
    o.update(ben, { id: 'w1', reopen: true, note: 'The panel turned dark navy: the colour fix.' });
    worker('s1', { status: 'running' });
  };
  return { ...s, reopen, s1 };
}

test('w731: a reopened request is not closed again on its worker’s DONE from before the reopen, nor on a PR that merged before it; a new DONE closes it', async (t) => {
  const { sweep, o, get, reopen, worker } = reopenedAfterOldDone(t);
  await reopen();
  const w = get('w1');
  assert.equal(w.status, 'new');
  assert.ok(w.reopenedAt);
  assert.equal(w.done, undefined, 'the DONE from before the reopen is dropped');
  assert.deepEqual(w.prs, [], 'and so are the PR links from before it');
  assert.match(w.log.at(-1)!, /reopened \(its earlier PR #1 and DONEs no longer count/);
  // The cleanup runs: no close (the 01:43 close of w712).
  assert.deepEqual(await sweep.checkPrs(), []);
  assert.equal(get('w1').status, 'new');
  // Runs again with the old PR still merged and still saying Request: w1 (the 01:53 close): still no close, and no re-link.
  assert.deepEqual(await sweep.checkPrs(), []);
  assert.equal(get('w1').status, 'new');
  assert.deepEqual(get('w1').prs, []);
  await sweep.run();
  assert.equal(get('w1').status, 'new', 'a full pass too');
  // Not even with the worker gone: the old DONE and PR are not evidence of the reopened work.
  worker('s1', { status: 'idle', lastResult: 'Working on the colour.' });
  assert.deepEqual(await sweep.checkPrs(), []);
  assert.equal(get('w1').status, 'new');
  // A new DONE closes it.
  o.workerTurnEnded(worker('s1', { status: 'idle' }), 'The colour is fixed.\nDONE: w1\nLearned: the regression test in #12');
  assert.equal(get('w1').status, 'done');
  assert.match(get('w1').log.join('\n'), /closed as done: worker s1 said DONE: w1/);
});

test('w731: a reopened request closes on a PR opened after the reopen that merged', async (t) => {
  const { world, pr, sweep, get, reopen, worker } = reopenedAfterOldDone(t);
  await reopen();
  assert.deepEqual(await sweep.checkPrs(), []);
  // The worker opens the colour fix's PR and it merges; the old PR is still listed.
  const now = new Date().toISOString();
  world.prs = [pr(1, { body: 'Request: w1', createdAt: ago(50), mergedAt: ago(40) }), pr(2, { body: 'Request: w1', createdAt: now, mergedAt: now })];
  worker('s1', { status: 'idle', lastResult: 'Merged the colour fix.' });
  assert.deepEqual(await sweep.checkPrs(), ['w1']);
  const w = get('w1');
  assert.equal(w.status, 'done');
  assert.deepEqual(w.prs?.map((p) => p.number), [2], 'only the PR opened after the reopen is its own');
  assert.equal(w.autoClosed?.pr, 2);
});

test('w731: a request reopened twice counts only what came after its latest reopen', async (t) => {
  const { world, pr, sweep, o, get, reopen, worker } = reopenedAfterOldDone(t);
  await reopen();
  const first = new Date().toISOString();
  world.prs = [pr(2, { body: 'Request: w1', createdAt: first, mergedAt: first })];
  worker('s1', { status: 'idle' });
  assert.deepEqual(await sweep.checkPrs(), ['w1'], 'the first reopen: its new PR closes it');
  await new Promise((r) => setTimeout(r, 5));
  const ben = o.personalFor(BEN);
  ben.lastFrom = 'human';
  o.update(ben, { id: 'w1', reopen: true, note: 'Still wrong on the Deck.' });
  worker('s1', { status: 'running' });
  assert.ok(get('w1').reopenedAt! > first);
  assert.deepEqual(await sweep.checkPrs(), [], 'PR #2 came before the second reopen');
  assert.equal(get('w1').status, 'new');
  await sweep.run();
  assert.equal(get('w1').status, 'new');
  // A PR after the second reopen closes it.
  const later = new Date().toISOString();
  world.prs.push(pr(3, { body: 'Request: w1', createdAt: later, mergedAt: later }));
  worker('s1', { status: 'idle' });
  assert.deepEqual(await sweep.checkPrs(), ['w1']);
  assert.deepEqual(get('w1').prs?.map((p) => p.number), [3]);
});

test('w731: an idle reopened request is not closed on its worker’s old "delivered" report; one that reports again after the reopen is', async (t) => {
  const { request, worker, sweep, o, get } = setup(t);
  // The ledger's clock is the sweep's here: a request closed at ago(5) must not age with the wall clock (this began
  // failing at 2026-10-10T07:00Z, 7 days after NOW, when updateProblem refused to reopen a request "closed a week ago").
  (o as unknown as { now: () => Date }).now = () => new Date(NOW);
  request('w1', { sessionIds: ['s1'], status: 'done', updatedAt: ago(5) });
  worker('s1', { lastResult: 'All done. The copy is in Screenshots.', lastActivityAt: ago(5) });
  const ben = o.personalFor(BEN);
  ben.lastFrom = 'human';
  o.update(ben, { id: 'w1', reopen: true, note: 'One more defect.' });
  await sweep.run();
  assert.equal(get('w1').status, 'new', 'the report predates the reopen');
  worker('s1', { lastResult: 'All done. Fixed that too.', lastActivityAt: new Date(Date.now() + 1000).toISOString() });
  await sweep.run();
  // `now` of the sweep is fixed in the past, so this report is also "too recent": the quiet period rules, not the reopen.
  assert.notEqual(get('w1').status, 'stalled');
});
