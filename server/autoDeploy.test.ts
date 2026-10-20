import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTO_DEPLOY_FILE, AutoDeploy, deployedLine, ghAutoDeploy, prsInMessages, sameCommit, type BatchPr, type CiVerdict } from './autoDeploy.ts';
import type { Requester } from '../shared/types.ts';
import type { RunResult } from './proc.ts';

/** The automatic portal deploy (w1634, docs/ops-worker.md "Automatic deploys"). */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const OLD = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const A = 'aaaaaaa1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const B = 'bbbbbbb2cccccccccccccccccccccccccccccccc';
const MIN = 60_000;

function world(t: TestContext, over: { enabled?: boolean; busy?: string[]; ci?: CiVerdict; people?: Record<number, Requester[]> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-autodeploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = {
    dir,
    now: Date.parse('2026-10-20T20:00:00Z'),
    enabled: over.enabled ?? true,
    running: OLD.slice(0, 7) as string | undefined,
    head: A,
    ci: over.ci ?? ({ state: 'green', text: 'all green' } as CiVerdict),
    busy: over.busy ?? ([] as string[]),
    prs: [{ number: 485, title: 'Dev Drive status' }] as BatchPr[],
    requests: [] as { ref: string; reason: string; drainMinutes: number }[],
    told: [] as [string, string][],
    lines: [] as string[],
    people: over.people ?? ({ 485: [LOTH], 486: [BEN, LOTH] } as Record<number, Requester[]>),
  };
  const make = () =>
    new AutoDeploy({
      dataDir: dir,
      enabled: () => w.enabled,
      running: () => w.running,
      github: { head: async () => w.head, ci: async () => w.ci, prsBetween: async () => w.prs },
      busy: () => w.busy,
      request: (o) => void w.requests.push(o),
      peopleOf: (n) => w.people[n] ?? [],
      tell: (p, text) => void w.told.push([p.userId, text]),
      now: () => w.now,
      log: (l) => void w.lines.push(l),
    });
  return { w, make, ad: make() };
}

/** fff-update's verification marker for `sha` (update.verified.json), as fff-health writes it once the new code answers. */
const verified = (dir: string, sha: string, at: number) => fs.writeFileSync(path.join(dir, 'update.verified.json'), JSON.stringify({ sha, previous: OLD, at: new Date(at).toISOString() }));

test('batching: merges that land close together go out as one deploy, once main has been quiet for 15 minutes', async (t) => {
  const { w, ad } = world(t);
  await ad.tick();
  assert.equal(w.requests.length, 0, 'not at once: the batch is open');
  assert.match(ad.state.waiting ?? '', /batching: main moved to aaaaaaa1b 0 min ago/);
  w.now += 10 * MIN;
  w.head = B; // a second merge 10 minutes later
  w.prs = [{ number: 485, title: 'Dev Drive status' }, { number: 486, title: 'Chat answer stays visible' }];
  await ad.tick();
  w.now += 14 * MIN;
  await ad.tick();
  assert.equal(w.requests.length, 0, '14 minutes after the second merge: still batching');
  w.now += 1 * MIN;
  await ad.tick();
  assert.deepEqual(w.requests, [{ ref: B, reason: 'auto-deploy: #485, #486', drainMinutes: 30 }], 'ONE deploy, of the newest commit, with both pull requests');
  await ad.tick();
  assert.equal(w.requests.length, 1, 'one deploy at a time: nothing more until it settles');
  assert.ok(ad.pending());
  const saved = JSON.parse(fs.readFileSync(path.join(w.dir, AUTO_DEPLOY_FILE), 'utf8'));
  assert.equal(saved.requested.sha, B, 'recorded with its commit, so the next portal finds it after the restart');
});

test('batching: a steady stream of merges cannot hold a deploy back past 60 minutes', async (t) => {
  const { w, ad } = world(t);
  for (let i = 0; i < 6; i++) {
    w.head = `${i + 2}`.repeat(7) + 'f'.repeat(33);
    await ad.tick();
    w.now += 10 * MIN; // a merge every 10 minutes: never 15 quiet minutes
  }
  assert.equal(w.requests.length, 0, '50 minutes in: still batching');
  await ad.tick();
  assert.equal(w.requests.length, 1, 'deployed at the 60-minute cap');
  assert.equal(w.requests[0].ref, '7'.repeat(7) + 'f'.repeat(33), 'what main had then');
  assert.match(w.lines.join('\n'), /the first commit waited 60 min/);
});

test('the off switch: config autoDeploy.enabled false deploys nothing, and on again it carries on', async (t) => {
  const { w, ad } = world(t, { enabled: false });
  await ad.tick();
  w.now += 120 * MIN;
  await ad.tick();
  assert.equal(w.requests.length, 0);
  assert.match(ad.state.waiting ?? '', /off \(config autoDeploy\.enabled is false\)/);
  w.enabled = true;
  await ad.tick();
  await ad.tick();
  w.now += 15 * MIN;
  await ad.tick();
  assert.equal(w.requests.length, 1, 'on again: deployed after its own quiet wait');
});

test('a commit whose CI is not green is not deployed; nor while a deploy would cut off work', async (t) => {
  const { w, ad } = world(t, { ci: { state: 'running', text: '1 of 2 workflow runs still running' } });
  await ad.tick();
  w.now += 20 * MIN;
  await ad.tick();
  assert.equal(w.requests.length, 0);
  assert.match(ad.state.waiting ?? '', /CI of aaaaaaa1b: 1 of 2 workflow runs still running/);
  w.ci = { state: 'red', text: 'CI on aaaaaaa1b finished: 1 of 2 workflow runs failed' };
  await ad.tick();
  assert.equal(w.requests.length, 0);
  w.ci = { state: 'green', text: 'green' };
  w.busy = ['Lothsahn (orchestrator) is mid-turn', 'a release build is declared on beast (0.50.0.60)'];
  await ad.tick();
  assert.equal(w.requests.length, 0);
  assert.match(ad.state.waiting ?? '', /it would cut off: Lothsahn \(orchestrator\) is mid-turn; a release build is declared on beast/);
  w.busy = [];
  await ad.tick();
  assert.equal(w.requests.length, 1);
});

test('nothing to do when the portal runs the head of main', async (t) => {
  const { w, ad } = world(t);
  w.running = A.slice(0, 12);
  await ad.tick();
  w.now += 120 * MIN;
  await ad.tick();
  assert.equal(w.requests.length, 0);
  assert.equal(ad.state.waiting, undefined);
});

test('after the restart: a verified deploy is recorded and each person hears of their pull requests in one line', async (t) => {
  const { w, ad, make } = world(t);
  w.prs = [{ number: 485, title: 'Dev Drive status' }, { number: 486, title: 'Chat answer stays visible' }, { number: 487 }];
  await ad.tick();
  w.now += 15 * MIN;
  await ad.tick();
  assert.equal(w.requests.length, 1);
  // The deploy's restart: a new portal process on the new commit reads the state back.
  w.now += 3 * MIN;
  w.running = A.slice(0, 7);
  const next = make();
  await next.tick();
  assert.equal(w.told.length, 0, 'not before the verification');
  verified(w.dir, A, w.now);
  await next.tick();
  assert.deepEqual(
    w.told.sort(),
    [
      ['ben', deployedLine([{ number: 486, title: 'Chat answer stays visible' }], A)],
      ['lothsahn', deployedLine([{ number: 485, title: 'Dev Drive status' }, { number: 486, title: 'Chat answer stays visible' }], A)],
    ].sort(),
  );
  assert.match(w.told.find(([u]) => u === 'lothsahn')![1], /^\[portal deploy\] Your FF Factory pull requests #485 \(Dev Drive status\), #486 \(Chat answer stays visible\) are live: the portal deployed aaaaaaa1b by itself/);
  const h = next.state.history[0];
  assert.equal(h.outcome, 'deployed');
  assert.equal(h.deployed, A);
  assert.deepEqual(h.told?.sort(), ['ben', 'lothsahn']);
  assert.equal(next.pending(), false);
});

test('a failed or rolled-back deploy is recorded, its commit is not tried again, and the next commit on main is', async (t) => {
  const { w, ad } = world(t);
  await ad.tick();
  w.now += 15 * MIN;
  await ad.tick();
  w.now += 5 * MIN;
  fs.writeFileSync(path.join(w.dir, 'update.result.json'), JSON.stringify({ ok: false, at: new Date(w.now).toISOString(), error: 'rolled back: the new version did not answer', headBefore: OLD, headAfter: OLD }));
  await ad.tick();
  assert.equal(ad.state.history[0].outcome, 'failed');
  assert.match(ad.state.history[0].note ?? '', /rolled back/);
  assert.equal(w.told.length, 0, 'nobody is told a failed deploy went out (fff-update tells the dispatcher itself)');
  w.now += 60 * MIN;
  await ad.tick();
  assert.equal(w.requests.length, 1, 'the failed commit is not deployed again');
  assert.match(ad.state.waiting ?? '', /the deploy of aaaaaaa1b failed/);
  w.head = B;
  await ad.tick();
  w.now += 15 * MIN;
  await ad.tick();
  assert.equal(w.requests.length, 2);
  assert.equal(w.requests[1].ref, B);
});

test('sameCommit, prsInMessages', () => {
  assert.ok(sameCommit('aaaaaaa', A));
  assert.ok(!sameCommit('aaaaaab', A));
  assert.ok(!sameCommit(undefined, A));
  assert.ok(!sameCommit('aaa', A), 'too short to tell');
  assert.deepEqual(prsInMessages(['Merge pull request #484 from Final-Factory/w1633-dev-drive\n\nWorker update: Dev Drive check', 'w1633: a commit', 'Merge pull request #483 from Final-Factory/x']), [
    { number: 484, title: 'Worker update: Dev Drive check' },
    { number: 483 },
  ]);
});

test('ghAutoDeploy: green needs the push runs and the merged pull request green on its head; a direct push is not deployed', async () => {
  const runs = (list: { status: string; conclusion: string | null }[]) => JSON.stringify({ workflow_runs: list.map((r, i) => ({ name: `wf${i}`, ...r })) });
  let pulls = '[{"number":485,"head":"' + 'c'.repeat(40) + '"}]';
  let prRuns = runs([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }]);
  const calls: string[] = [];
  const run = async (_cmd: string, args: string[]): Promise<RunResult> => {
    const url = args[1];
    calls.push(url);
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' }) as RunResult;
    if (url.includes(`head_sha=${A}`)) return ok(runs([{ status: 'completed', conclusion: 'success' }]));
    if (url.includes('head_sha=')) return ok(prRuns);
    if (url.endsWith('/pulls')) return ok(pulls);
    if (url.includes('/commits/main')) return ok(`${A}\n`);
    return { code: 1, stdout: '', stderr: 'unexpected' } as RunResult;
  };
  const gh = ghAutoDeploy(async () => 'Final-Factory/ff-factory', 'main', run);
  assert.equal(await gh.head(), A);
  assert.equal((await gh.ci(A)).state, 'green');
  prRuns = runs([{ status: 'in_progress', conclusion: null }]);
  assert.equal((await gh.ci(A)).state, 'running');
  prRuns = runs([{ status: 'completed', conclusion: 'failure' }]);
  assert.equal((await gh.ci(A)).state, 'red');
  pulls = '[]';
  assert.match((await gh.ci(A)).text, /not the merge of a pull request/);
  assert.ok(calls.every((c) => c.startsWith('repos/Final-Factory/ff-factory/')));
});
