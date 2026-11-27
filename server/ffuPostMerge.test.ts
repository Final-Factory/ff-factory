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
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from './testVault.ts';
import type { Config } from './config.ts';
import { JOB_SKIPPED, ghMasterBatch, type BatchRun, type MasterBatchGh, type PrFacts } from './masterBatch.ts';
import { CULPRIT_JOB, FfuPostMergeWatch, ffuPostMergeSettings, parsePostMergeVerdict } from './ffuPostMerge.ts';
import type { RunResult } from './proc.ts';
import type { Requester, UserInfo, WorkItem } from '../shared/types.ts';

// The end-to-end test starts orchestrators on the real Agents with the scripted fake SDK.
useFakeVault();
setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

/**
 * The ffu post-merge watch (w4930, docs/intake.md "ffu post-merge reverts"): the POSTMERGE_VERDICT line of ffu ci.yml's
 * culprit job (tools/ci-runners/postmerge_culprit.py in ffu), a reverted PR handed back to its request, every verdict a
 * person must look at sent to the ops people, and each run handled once. GitHub is faked; the last test runs through the
 * real orchestrators.
 */

const NOW = Date.now();
const REPO = 'Final-Factory/ffu';
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const sha = (c: string) => c.repeat(40);
const TIP = sha('a');
const CULPRIT = sha('b');
const REVERT = sha('c');

// What postmerge_culprit.py's finish() prints for a revert (its dict: tip, branch, check, checks, culprit, pr, revert, verdict, why, good).
const verdict = (o: Record<string, unknown> = {}) => ({
  tip: TIP,
  branch: 'main',
  check: "bash '/tmp/postmerge/postmerge_check.sh' test clippy hash",
  checks: [{ commit: TIP, passed: false }, { commit: CULPRIT, passed: false }],
  culprit: CULPRIT,
  pr: 921,
  revert: REVERT,
  verdict: 'reverted',
  why: 'bbbbbbbbbb (the first failing commit after dddddddddd) reverted by cccccccccc',
  good: sha('d'),
  dispatched: 'ci.yml',
  ...o,
});
const ts = '2026-11-20T18:58:03.1234567Z';
const logOf = (v: unknown) => `${ts} check at aaaaaaaaaa: FAIL (exit 1)\n${ts} POSTMERGE_VERDICT ${JSON.stringify(v)}\n${ts} Post job cleanup.\n`;

const run = (id: number, o: Partial<BatchRun> = {}): BatchRun => ({
  id,
  attempt: 1,
  sha: TIP,
  status: 'completed',
  conclusion: 'failure',
  createdAt: new Date(NOW - 3_600_000 + id * 1000).toISOString(),
  updatedAt: new Date(NOW - 1_800_000 + id * 1000).toISOString(),
  url: `https://github.com/${REPO}/actions/runs/${id}`,
  ...o,
});

class FakeGh implements MasterBatchGh {
  list: BatchRun[] = [];
  logs = new Map<number, string | typeof JOB_SKIPPED | Error | undefined>();
  prs = new Map<number, PrFacts | Error>();
  calls: string[] = [];
  async runs(repo: string, workflow: string) {
    this.calls.push(`runs ${repo} ${workflow}`);
    return this.list;
  }
  async jobLog(_repo: string, id: number) {
    this.calls.push(`log ${id}`);
    const l = this.logs.get(id);
    if (l instanceof Error) throw l;
    return l;
  }
  async pr(_repo: string, n: number) {
    this.calls.push(`pr ${n}`);
    const p = this.prs.get(n);
    if (p instanceof Error) throw p;
    return p;
  }
}

// ---------------------------------------------------------------- parsing

test('w4930: parsePostMergeVerdict reads the line postmerge_culprit.py prints, the last one, and refuses what it cannot trust', () => {
  const v = parsePostMergeVerdict(logOf(verdict()))!;
  assert.deepEqual([v.verdict, v.tip, v.branch, v.culprit, v.pr, v.revert], ['reverted', TIP, 'main', CULPRIT, 921, REVERT]);
  assert.equal(parsePostMergeVerdict(`POSTMERGE_VERDICT ${JSON.stringify(verdict({ verdict: 'no culprit', culprit: null, pr: null, revert: null }))}\r\n`)!.verdict, 'no culprit', 'no prefix, CRLF');
  assert.equal(parsePostMergeVerdict(`${logOf(verdict({ pr: 1 }))}${logOf(verdict({ pr: 2 }))}`)!.pr, 2, 'the last line');
  // An echoed line is not the verdict; nor is a broken one, a missing verdict or a short tip.
  assert.equal(parsePostMergeVerdict(`${ts} + echo "POSTMERGE_VERDICT {}"`), undefined);
  assert.equal(parsePostMergeVerdict(`${ts} POSTMERGE_VERDICT {"tip":`), undefined);
  assert.equal(parsePostMergeVerdict(logOf(verdict({ verdict: null }))), undefined);
  assert.equal(parsePostMergeVerdict(logOf(verdict({ tip: 'abc' }))), undefined);
  // Bad fields are dropped, not trusted; an unknown verdict is kept as one, with its words.
  const bad = parsePostMergeVerdict(logOf(verdict({ pr: -3, culprit: 'nope', revert: 12, verdict: 'reverted twice', why: 'x\u001b[31m\ny' })))!;
  assert.deepEqual([bad.pr, bad.culprit, bad.revert, bad.verdict, bad.said], [null, null, null, 'unknown', 'reverted twice']);
  assert.ok(!/[\n\u001b]/.test(bad.why));
});

test('w4930: settings default to ffu ci.yml, on, and refuse a malformed repo or workflow', () => {
  assert.deepEqual(ffuPostMergeSettings({}), { enabled: true, repo: REPO, workflow: 'ci.yml' });
  assert.deepEqual(ffuPostMergeSettings({ ffuPostMerge: { enabled: false, repo: 'x y', workflow: 'ci.sh' } }), { enabled: false, repo: REPO, workflow: 'ci.yml' });
});

test('w4930: the gh reads ask for main and the culprit job', async () => {
  const calls: string[] = [];
  const gh = ghMasterBatch(() => async (_cmd: string, args: string[]): Promise<RunResult> => {
    calls.push(args.join(' '));
    if (args.join(' ').includes('/jobs?')) return { code: 0, stdout: JSON.stringify({ jobs: [{ id: 7, name: 'macos' }, { id: 8, name: CULPRIT_JOB }] }), stderr: '' };
    if (args.join(' ').includes('/runs?')) return { code: 0, stdout: JSON.stringify({ workflow_runs: [] }), stderr: '' };
    return { code: 0, stdout: 'the log', stderr: '' };
  }, { branch: 'main', job: CULPRIT_JOB, perPage: 30 });
  await gh.runs(REPO, 'ci.yml');
  assert.equal(await gh.jobLog(REPO, 5), 'the log');
  assert.deepEqual(calls, [
    `api repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&per_page=30`,
    `api repos/${REPO}/actions/runs/5/jobs?per_page=100`,
    `api --allow-escape-sequences repos/${REPO}/actions/jobs/8/logs`,
  ]);
});

// ---------------------------------------------------------------- the watch on a fake ledger

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-fpm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const cfg = { dataDir: dir } as unknown as Config;
  const work = new Map<string, WorkItem>();
  const told: { id: string; mark: string; text: string }[] = [];
  const people: { to: string[]; text: string }[] = [];
  const answer = new Map<string, 'reopened' | 'told' | 'already' | false>();
  const orchestrators = {
    tellPostMergeRevert: (id: string, a: { mark: string; line: string; text: string }) => {
      told.push({ id, mark: a.mark, text: a.text });
      return answer.get(id) ?? 'reopened';
    },
    toPeople: (to: readonly Requester[], text: string) => void people.push({ to: to.map((r) => r.userId), text }),
  };
  const known = new Map([BEN, LOTH].map((r) => [r.userId, r]));
  const identity = { systemPayer: () => BEN, requester: (id?: string) => (id ? known.get(id) : undefined) };
  const gh = new FakeGh();
  const make = () => new FfuPostMergeWatch({ cfg, store: { work } as never, identity: identity as never, orchestrators: orchestrators as never, gh, now: () => NOW });
  return { dir, work, told, people, answer, gh, make };
}

const item = (id: string, o: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title: id, brief: 'x', status: 'done', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], createdAt: '', updatedAt: '', sessionIds: [], overlaps: [], asks: 0, log: [], ...o }) as WorkItem;

test('w4930: a reverted verdict goes to the request that lists the reverted PR, once per run', async (t) => {
  const { work, told, people, gh, make } = setup(t);
  work.set('w900', item('w900', { prs: [{ repo: REPO, number: 921, state: 'merged', via: 'line' }] }));
  // The same PR number in the game repo is another request's: never told.
  work.set('w901', item('w901', { prs: [{ repo: 'Final-Factory/FinalFactory', number: 921, state: 'merged', via: 'line' }] }));
  gh.list = [run(10)];
  gh.logs.set(10, logOf(verdict()));
  const w = make();
  const did = await w.tick();
  assert.deepEqual(told.map((x) => x.id), ['w900'], did.join('; '));
  assert.equal(told[0].mark, 'ffu post-merge run 10 reverted bbbbbbbbbb');
  assert.ok(told[0].text.includes('PR #921') && told[0].text.includes('cccccccccc') && told[0].text.includes(`https://github.com/${REPO}/actions/runs/10`));
  assert.deepEqual(people, [], 'nobody else hears a routed revert');
  // Looked at again, and after a restart (the state file): the run is not handled twice.
  await w.tick();
  await make().tick();
  assert.equal(told.length, 1);
  assert.equal(gh.calls.filter((c) => c === 'log 10').length, 1);
});

test('w4930: a reverted PR found by its description\'s Request line', async (t) => {
  const { work, told, gh, make } = setup(t);
  work.set('w930', item('w930'));
  gh.list = [run(11)];
  gh.logs.set(11, logOf(verdict({ pr: 950 })));
  gh.prs.set(950, { body: 'Fixes the thing.\n\nRequest: w930\n', title: 'T', url: '', author: 'a' });
  await make().tick();
  assert.deepEqual(told.map((x) => x.id), ['w930']);
});

test('w4930: a PR read that fails is read again at the next look, not sent to a person', async (t) => {
  const { work, told, people, gh, make } = setup(t);
  work.set('w930', item('w930'));
  gh.list = [run(12)];
  gh.logs.set(12, logOf(verdict({ pr: 950 })));
  gh.prs.set(950, new Error('HTTP 502'));
  const w = make();
  await w.tick();
  assert.deepEqual([told.length, people.length], [0, 0]);
  gh.prs.set(950, { body: 'Part of: w930', title: 'T', url: '', author: 'a' });
  await w.tick();
  assert.deepEqual(told.map((x) => x.id), ['w930']);
});

test('w4930: what a person must look at reaches the ops people: not reverted, no culprit, no request, no verdict, an unknown verdict', async (t) => {
  const { work, told, people, answer, gh, make } = setup(t);
  // A cancelled request: tellPostMergeRevert answers false (the real one is tested at the end).
  answer.set('w902', false);
  work.set('w902', item('w902', { status: 'cancelled', prs: [{ repo: REPO, number: 77, state: 'merged', via: 'line' }] }));
  const cases: [number, string | undefined, RegExp][] = [
    [20, logOf(verdict({ verdict: 'not reverted', revert: null, why: 'the culprit bbbbbbbbbb is itself a post-merge revert: a person decides' })), /did NOT revert it: the culprit bbbbbbbbbb is itself a post-merge revert/],
    [21, logOf(verdict({ verdict: 'no culprit', culprit: null, pr: null, revert: null, why: 'no green run of the post-merge checks on this branch to bisect from' })), /found no merge to blame: no green run/],
    [22, logOf(verdict({ pr: 4040 })), /PR #4040 .* was reverted by cccccccccc on main, but no request lists it/],
    [23, logOf(verdict({ pr: null })), /names no pull request/],
    [24, logOf(verdict({ pr: 77 })), /its request w902 \(cancelled\) cannot take it/],
    [25, `${ts} error: the runner lost its connection\n`, /printed no POSTMERGE_VERDICT line/],
    [26, logOf(verdict({ verdict: 'half reverted' })), /a verdict FF Factory does not know \("half reverted"\)/],
  ];
  for (const [id, log] of cases) {
    gh.list.push(run(id));
    gh.logs.set(id, log);
  }
  gh.prs.set(4040, { body: 'no request line', title: 'T', url: '', author: 'a' });
  const w = make();
  await w.tick();
  assert.equal(people.length, cases.length, people.map((p) => p.text).join('\n'));
  for (const [i, [id, , re]] of cases.entries()) {
    const p = people[i];
    assert.deepEqual(p.to, ['lothsahn', 'ben'], 'the ops people (OPS_PEOPLE)');
    assert.ok(p.text.startsWith('[ffu post-merge] A person must look:') && p.text.includes(`run ${id} `) && re.test(p.text), `${id}: ${p.text}`);
  }
  assert.deepEqual(told.map((x) => x.id), ['w902'], 'asked, since it lists PR #77, and it could not take it');
  await w.tick();
  assert.equal(people.length, cases.length, 'each run once');
});

test('w4930: not reproduced, already reverted, a dry run, a skipped culprit job and a run with none tell nobody', async (t) => {
  const { told, people, gh, make } = setup(t);
  gh.list = [run(30), run(31), run(32), run(33, { conclusion: 'success' }), run(34, { conclusion: 'success' }), run(35, { status: 'in_progress', conclusion: null })];
  gh.logs.set(30, logOf(verdict({ verdict: 'not reproduced', culprit: null, pr: null, revert: null })));
  gh.logs.set(31, logOf(verdict({ verdict: 'already reverted' })));
  gh.logs.set(32, logOf(verdict({ verdict: 'would revert' })));
  gh.logs.set(33, JOB_SKIPPED);
  gh.logs.set(34, undefined);
  const did = await make().tick();
  assert.deepEqual([told.length, people.length], [0, 0], did.join('; '));
  assert.ok(!gh.calls.includes('log 35'), 'a run still going is read when it finishes');
});

test('w4930: a run finished more than 48 hours ago is never acted on', async (t) => {
  const { people, gh, make } = setup(t);
  gh.list = [run(40, { updatedAt: new Date(NOW - 49 * 3_600_000).toISOString() })];
  gh.logs.set(40, logOf(verdict({ verdict: 'no culprit' })));
  await make().tick();
  assert.equal(people.length, 0);
  assert.ok(!gh.calls.includes('log 40'));
});

// ---------------------------------------------------------------- through the real orchestrators

test('w4930: end to end on the real ledger: a done request is reopened with the re-land note, an open one keeps its state, once per mark', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-fpm-e2e-'));
  const users: UserInfo[] = [{ ...BEN, role: 'owner' }, { ...LOTH, role: 'owner' }];
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'master',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    intake: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => users));
  agents.boot();
  (agents.orchestrators as unknown as { d: { gatherMs: number } }).d.gatherMs = 20;
  const o = agents.orchestrators;
  t.after(async () => {
    o.close();
    agents.close(); // w6152: Agents' timers stop before the folder goes (w5915: a release pass wrote into a removed transcript, ENOENT).
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const stamp = new Date(NOW).toISOString();
  const base = { priority: 'normal' as const, keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, createdAt: stamp, updatedAt: stamp, sessionIds: [], overlaps: [], asks: 0, log: [] };
  store.putWork({ ...base, id: 'w50', title: 'Faster belts in ffu', brief: 'x', status: 'done', prs: [{ repo: REPO, number: 921, state: 'merged', via: 'line' }] } as WorkItem);
  store.putWork({ ...base, id: 'w51', title: 'Still going', brief: 'x', status: 'active', prs: [{ repo: REPO, number: 922, state: 'merged', via: 'line' }] } as WorkItem);
  store.putWork({ ...base, id: 'w52', title: 'Dropped', brief: 'x', status: 'cancelled', prs: [{ repo: REPO, number: 923, state: 'merged', via: 'line' }] } as WorkItem);
  const gh = new FakeGh();
  gh.list = [run(100), run(101), run(102)];
  gh.logs.set(100, logOf(verdict()));
  gh.logs.set(101, logOf(verdict({ pr: 922, culprit: sha('e') })));
  gh.logs.set(102, logOf(verdict({ pr: 923, culprit: sha('f') })));
  const w = new FfuPostMergeWatch({ cfg, store, identity: agents.identity, orchestrators: o, gh, now: () => NOW });
  const did = await w.tick();
  const w50 = store.work.get('w50')!;
  assert.equal(w50.status, 'new', did.join('; '));
  assert.ok(w50.reopenedAt, 'reopened: its earlier DONEs and the reverted PR no longer count');
  assert.deepEqual(w50.prs, []);
  assert.ok(w50.log.some((l) => l.includes('ffu post-merge run 100 reverted bbbbbbbbbb: PR #921 broke ffu main') && l.includes('reopened')));
  assert.ok(w50.notes?.some((n) => n.text.includes('Land the fix again') && n.text.includes('git revert cccccccccc')), 'the next worker\'s brief carries how to re-land');
  const w51 = store.work.get('w51')!;
  assert.equal(w51.status, 'active');
  assert.ok(w51.log.some((l) => l.includes('ffu post-merge run 101 reverted eeeeeeeeee')));
  // A cancelled request is not reopened by a machine: the ops people hear it instead.
  assert.equal(store.work.get('w52')!.status, 'cancelled');
  assert.ok(did.some((d) => d.startsWith('run 102: told lothsahn, ben')), did.join('; '));
  // The same mark again changes nothing.
  assert.equal(o.tellPostMergeRevert('w50', { mark: 'ffu post-merge run 100 reverted bbbbbbbbbb', line: 'again', text: 't' }), 'already');
  assert.equal(store.work.get('w50')!.log.filter((l) => l.includes('ffu post-merge run 100')).length, 1);
});
