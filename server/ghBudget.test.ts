// w3758: the conditional GitHub reads, the budget they report, and the count of the portal's gh calls by caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetOf, callerOf, EtagCache, ghCallLine, ghGet, isGraphql, noteBudget, noteGhCall, resetBudgets, splitInclude, takeGhCalls } from './ghBudget.ts';
import { blockerVerdict, CI_UNREADABLE_MS, type BlockerFacts } from '../shared/blockers.ts';
import { ghChecks, type CheckReads } from './blockerWatch.ts';
import type { RunResult } from './proc.ts';

const NOW = Date.parse('2026-11-09T00:00:00Z');
const RESET = Math.round(NOW / 1000) + 1800;
const head = (status: string, h: Record<string, string>, body: string) => `HTTP/2.0 ${status}\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body}`;

test('splitInclude: status, headers any case, body; plain output is not an answer with headers', () => {
  const a = splitInclude(head('200 OK', { Etag: 'W/"abc"', 'X-Ratelimit-Remaining': '42' }, '{"a":1}'))!;
  assert.equal(a.status, 200);
  assert.equal(a.header('etag'), 'W/"abc"');
  assert.equal(a.header('x-ratelimit-remaining'), '42');
  assert.equal(a.body, '{"a":1}');
  assert.equal(splitInclude('{"a":1}'), undefined);
});

test('ghGet: the second read of an unchanged path sends If-None-Match and serves the 304 from the cache (a 304 is free); a change is read again; an error keeps gh\'s words', async () => {
  resetBudgets();
  const calls: string[][] = [];
  let answer = (a: string[]): RunResult => (a.some((x) => x.startsWith('If-None-Match')) ? { code: 1, stdout: head('304 Not Modified', { 'X-Ratelimit-Remaining': '4000', 'X-Ratelimit-Reset': String(RESET) }, ''), stderr: 'gh: HTTP 304' } : { code: 0, stdout: head('200 OK', { ETag: '"v1"', 'X-Ratelimit-Remaining': '4001', 'X-Ratelimit-Reset': String(RESET) }, '{"n":1}'), stderr: '' });
  const run = async (_c: string, a: string[]) => (calls.push(a), answer(a));
  const cache = new EtagCache();
  assert.deepEqual(await ghGet(run, 'repos/o/r/actions/runs', {}, 'lothsahn', cache), { code: 0, stdout: '{"n":1}', stderr: '' });
  assert.deepEqual(calls[0], ['api', '-i', 'repos/o/r/actions/runs']);
  assert.deepEqual(await ghGet(run, 'repos/o/r/actions/runs', {}, 'lothsahn', cache), { code: 0, stdout: '{"n":1}', stderr: '' });
  assert.deepEqual(calls[1], ['api', '-i', '-H', 'If-None-Match: "v1"', 'repos/o/r/actions/runs']);
  assert.equal(budgetOf('lothsahn', NOW)?.remaining, 4000);
  assert.equal(budgetOf('lothsahn', RESET * 1000 + 1), undefined, 'refilled: unknown again');
  // Another credential does not share the cache: no If-None-Match.
  await ghGet(run, 'repos/o/r/actions/runs', {}, 'ben', cache);
  assert.deepEqual(calls[2], ['api', '-i', 'repos/o/r/actions/runs']);
  answer = () => ({ code: 1, stdout: head('403 Forbidden', { 'X-Ratelimit-Remaining': '0', 'X-Ratelimit-Reset': String(RESET) }, '{"message":"API rate limit exceeded for user ID 10092359."}'), stderr: 'gh: API rate limit exceeded for user ID 10092359. (HTTP 403)' });
  const r = await ghGet(run, 'repos/o/r/pulls/1', {}, 'lothsahn', cache);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rate limit exceeded/);
  assert.equal(budgetOf('lothsahn', NOW)?.remaining, 0);
  // A fake gh's plain output (no headers) passes through as it was.
  assert.deepEqual(await ghGet(async () => ({ code: 0, stdout: '{"x":2}', stderr: '' }), 'p', {}, undefined, cache), { code: 0, stdout: '{"x":2}', stderr: '' });
  resetBudgets();
});

test('noteBudget: only the core (REST) budget, and only a full reading', () => {
  resetBudgets();
  noteBudget('a', (n) => ({ 'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(RESET) })[n], NOW);
  assert.equal(budgetOf('a', NOW), undefined);
  noteBudget('a', (n) => ({ 'x-ratelimit-reset': String(RESET) })[n], NOW);
  assert.equal(budgetOf('a', NOW), undefined);
  noteBudget(undefined, (n) => ({ 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': String(RESET) })[n], NOW);
  assert.equal(budgetOf(undefined, NOW)?.remaining, 9, 'no person: the portal\'s own login');
  resetBudgets();
});

test('the count by caller: refs and shas folded, REST, free 304s and GraphQL apart, refusals and rate limits named, the rate-limit read not counted', () => {
  takeGhCalls();
  assert.equal(callerOf('CI on Final-Factory/ffu#518'), 'CI on <pr>');
  assert.equal(callerOf('the head of Final-Factory/FinalFactory#3469 at 4f2a9c1e'), 'the head of <pr> at <sha>');
  assert.equal(isGraphql(['pr', 'view', '1']), true);
  assert.equal(isGraphql(['api', 'graphql', '-f', 'query=x']), true);
  assert.equal(isGraphql(['api', '-i', 'repos/o/r/pulls/1']), false);
  const ok: RunResult = { code: 0, stdout: '{}', stderr: '' };
  noteGhCall('CI on Final-Factory/ffu#518', ['api', '-i', 'repos/o/r/actions/runs'], ok);
  noteGhCall('CI on Final-Factory/ffu#519', ['api', '-i', '-H', 'If-None-Match: "x"', 'repos/o/r/actions/runs'], { code: 1, stdout: 'HTTP/2.0 304 Not Modified\n\n', stderr: 'gh: HTTP 304' });
  noteGhCall('CI on Final-Factory/ffu#518', ['pr', 'view', '518', '--json', 'statusCheckRollup'], { code: 1, stdout: '', stderr: 'GraphQL: Resource not accessible by personal access token' });
  noteGhCall('CI on Final-Factory/ffu#518', ['api', '-i', 'repos/o/r/pulls/518'], { code: 1, stdout: '', stderr: 'gh: API rate limit exceeded for user ID 10092359. (HTTP 403)' });
  noteGhCall('the rate limit read', ['api', 'rate_limit'], ok);
  noteGhCall('x', ['auth', 'status'], ok);
  const rows = takeGhCalls();
  assert.deepEqual(rows, [{ caller: 'CI on <pr>', count: { rest: 2, notModified: 1, graphql: 1, refused: 1, rateLimited: 1 } }]);
  assert.deepEqual(takeGhCalls(), [], 'taken: a new count starts');
  const line = ghCallLine(rows, 15, { coreUsed: 4100, coreLimit: 5000, coreReset: RESET, graphqlUsed: 300 }, NOW);
  assert.equal(line, "github calls, last 15 min, the portal's: REST 2 (+1 free 304s), GraphQL 1; the token's budget: REST 4100 of 5000 used, refills in 30 min; GraphQL 300 used | CI on <pr>: rest 2, 304 1, graphql 1, refused 1, rate limited 1 (w3758)");
});

test('w3758: a ci gate unreadable for GitHub\'s rate limit stays open (paused) however long, on ffu and on FinalFactory; a permission refusal still clears after CI_UNREADABLE_MS (w829)', () => {
  const at = new Date(NOW - 60 * 60_000).toISOString();
  const facts = (u: { since: number; why: string; rateLimited?: boolean }): BlockerFacts => ({ now: NOW, work: new Map(), ci: () => undefined, ciUnreadable: () => u }) as unknown as BlockerFacts;
  for (const ref of ['Final-Factory/ffu#518', 'Final-Factory/FinalFactory#3470']) {
    const b = { kind: 'ci', ref, what: 'CI', at, by: 'worker a' } as never;
    const v = blockerVerdict(b, facts({ since: NOW - 60 * 60_000, why: 'gh: API rate limit exceeded', rateLimited: true }));
    assert.equal(v.state, 'open', ref);
    assert.match(v.why, /^paused: GitHub's rate limit refuses reads of CI on /);
    assert.equal(blockerVerdict(b, facts({ since: NOW - CI_UNREADABLE_MS, why: 'HTTP 403: Resource not accessible by personal access token' })).state, 'clear', `${ref}: a permission refusal`);
  }
});

test('w3758: ghChecks remembers a refused rollup and takes the state and head the watch read: one GraphQL refusal an hour, no second pr view', async () => {
  const calls: string[] = [];
  const run = async (_c: string, a: string[]): Promise<RunResult> => {
    calls.push(a.join(' '));
    if (a.includes('state,statusCheckRollup,headRefOid')) return { code: 1, stdout: '', stderr: 'GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup)' };
    if (a.some((x) => x.includes('actions/runs?head_sha=abc1234'))) return { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 1, name: 'ci', status: 'in_progress', conclusion: null }] }), stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${a.join(' ')}` };
  };
  let now = NOW;
  const reads: CheckReads = { refused: new Map(), known: { state: 'OPEN', head: 'abc1234' }, now: () => now };
  assert.match((await ghChecks('Final-Factory/FinalFactory#3469', run, () => true, reads)).text, /still running/);
  assert.equal(calls.filter((c) => c.startsWith('pr view')).length, 1, 'the refused rollup, once');
  calls.length = 0;
  now += 2 * 60_000;
  assert.match((await ghChecks('Final-Factory/FinalFactory#3469', run, () => true, reads)).text, /still running/);
  assert.deepEqual(calls.filter((c) => c.startsWith('pr ')), [], 'remembered: no GraphQL at all');
  calls.length = 0;
  now += 61 * 60_000;
  await ghChecks('Final-Factory/FinalFactory#3469', run, () => true, reads);
  assert.equal(calls.filter((c) => c.startsWith('pr view')).length, 1, 'tried again after REFUSED_FOR_MS');
});
