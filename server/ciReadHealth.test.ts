import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CiReadWatch, ciReadBanner, ciReadLine, probeCiRead, repoSlug } from './ciReadHealth.ts';
import { ghChecks, mergeStateCi } from './blockerWatch.ts';
import type { RunOptions, RunResult } from './proc.ts';

/**
 * w889: the portal could not read CI on any pull request for a day and nothing said so. These pin the loud check and the
 * merge-state reading. The refusals are GitHub's own words as the blocker watch logged them on 2026-10-10.
 */
const REFUSED_ROLLUP = 'GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup.nodes.0.commit.statusCheckRollup)';
const REFUSED_RUNS = 'gh: Resource not accessible by personal access token (HTTP 403)';

/** A gh whose reads succeed or are refused by kind: rollup (checks), runs (Actions), merge (the PR's merge state). */
function gh(can: { rollup?: boolean; runs?: boolean; merge?: boolean; list?: boolean }, mergeState = 'unstable') {
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> => {
    calls.push(args);
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
    const no = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });
    if (args[0] === 'pr' && args[1] === 'list') return can.list === false ? no('HTTP 401: Bad credentials') : ok(JSON.stringify([{ number: 1393, headRefOid: 'b3c825300c' }]));
    if (args.includes('statusCheckRollup')) return can.rollup ? ok(JSON.stringify({ state: 'OPEN', statusCheckRollup: [] })) : no(REFUSED_ROLLUP);
    if (args.includes('state,statusCheckRollup')) return can.rollup ? ok('{}') : no(REFUSED_ROLLUP);
    if (args.includes('state,headRefOid')) return ok(JSON.stringify({ state: 'OPEN', headRefOid: 'b3c825300c' }));
    if (args[0] === 'api' && args[1].includes('/actions/runs')) return can.runs ? ok(JSON.stringify({ workflow_runs: [] })) : no(REFUSED_RUNS);
    if (args[0] === 'api' && /\/pulls\/\d+$/.test(args[1])) {
      if (!can.merge) return no(REFUSED_RUNS);
      return ok(args.includes('.mergeable_state') ? mergeState : JSON.stringify({ mergeable_state: mergeState, head: 'b3c825300c' }));
    }
    return no(`unexpected ${args.join(' ')}`);
  };
  return { run, calls };
}

test('repoSlug: owner/name of the game repo URL', () => {
  assert.equal(repoSlug('https://github.com/Final-Factory/FinalFactory.git'), 'Final-Factory/FinalFactory');
  assert.equal(repoSlug('git@github.com:Final-Factory/FinalFactory.git'), 'Final-Factory/FinalFactory');
  assert.equal(repoSlug('/srv/repo'), undefined);
});

test('probeCiRead: checks, else Actions runs, else only the merge state, else nothing; never ok below Actions', async () => {
  const repo = 'Final-Factory/FinalFactory';
  assert.equal((await probeCiRead(repo, gh({ rollup: true }).run)).level, 'checks');
  assert.equal((await probeCiRead(repo, gh({ runs: true }).run)).level, 'actions');
  const ms = await probeCiRead(repo, gh({ merge: true }).run);
  assert.equal(ms.level, 'merge-state');
  assert.equal(ms.pr, 1393);
  assert.match(ms.why ?? '', /statusCheckRollup.*Actions runs: gh: Resource not accessible by personal access token \(HTTP 403\)/);
  assert.equal((await probeCiRead(repo, gh({}).run)).level, 'none');
  assert.match((await probeCiRead(repo, gh({ list: false }).run)).why ?? '', /pull requests: HTTP 401/);
});

test('the check is loud: a WARNING status line, a banner with the one-line fix, and a [host] report when it turns bad and when it recovers', async () => {
  const reports: string[] = [];
  let can: Parameters<typeof gh>[0] = {};
  const w = new CiReadWatch({ repo: () => 'Final-Factory/FinalFactory', runner: () => gh(can).run, report: (title, body) => reports.push(`${title}: ${body}`), now: () => new Date('2026-10-10T12:00:00Z') });
  assert.match(ciReadLine(w.health), /not measured yet/);
  await w.check();
  assert.equal(w.health?.level, 'none');
  assert.match(ciReadLine(w.health), /^WARNING: GitHub CI reads \(w889\): the portal cannot read CI on Final-Factory\/FinalFactory/);
  assert.match(ciReadBanner(w.health) ?? '', /Every CI wait sits 15 minutes.*"Actions: Read-only" on Final-Factory\/FinalFactory/);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /^FF Factory cannot read CI on pull requests: GitHub CI reads/);
  await w.check();
  assert.equal(reports.length, 1, 'said once, not every half hour');
  can = { merge: true };
  await w.check();
  assert.equal(reports.length, 2, 'a change of level is said again');
  assert.match(ciReadBanner(w.health) ?? '', /Only green CI is seen at once/);
  can = { runs: true };
  await w.check();
  assert.match(reports[2], /^FF Factory reads CI on pull requests again: GitHub CI reads \(w889\): OK, the portal reads GitHub Actions runs/);
  assert.equal(ciReadBanner(w.health), undefined, 'no banner when it reads');
  assert.doesNotMatch(ciReadLine(w.health), /WARNING/);
});

test('mergeStateCi: "clean" after "unstable" on the same head is a green finish; running, failed or never-seen-unstable is not', () => {
  const seen = new Map<string, number>();
  const ref = 'Final-Factory/FinalFactory#1393';
  assert.equal(mergeStateCi({ mergeable_state: 'clean', head: 'a' }, ref, seen), undefined, 'clean before any check ran is not taken for green');
  assert.equal(mergeStateCi({ mergeable_state: 'unstable', head: 'a' }, ref, seen), undefined, 'pending or failing');
  assert.equal(mergeStateCi({ mergeable_state: 'unknown', head: 'a' }, ref, seen), undefined, 'GitHub still computing');
  assert.equal(mergeStateCi({ mergeable_state: 'clean', head: 'b' }, ref, seen), undefined, 'a new push: its checks not seen running');
  const done = mergeStateCi({ mergeable_state: 'clean', head: 'a' }, ref, seen);
  assert.equal(done?.done, true);
  assert.match(done!.text, /CI on Final-Factory\/FinalFactory#1393 finished: every check passed \(read from the pull request's merge state/);
  assert.equal(mergeStateCi({ mergeable_state: 'dirty', head: 'a' }, ref, seen), undefined, 'a conflict says nothing about CI');
});

test('ghChecks with a token that reads neither checks nor Actions runs: unreadable while running, green the read after it turns clean', async () => {
  const ref = 'Final-Factory/FinalFactory#7001';
  const running = gh({ merge: true }, 'unstable');
  await assert.rejects(ghChecks(ref, running.run), (e: Error) => /its merge state: unstable \(pending or failed checks cannot be told apart from it\)/.test(e.message));
  const green = gh({ merge: true }, 'clean');
  const ci = await ghChecks(ref, green.run);
  assert.equal(ci.done, true);
  // A token that reads Actions runs never asks for the merge state.
  const actions = gh({ runs: true });
  await ghChecks('Final-Factory/FinalFactory#7002', actions.run);
  assert.ok(!actions.calls.some((a) => a[0] === 'api' && /\/pulls\/\d+$/.test(a[1])));
});
