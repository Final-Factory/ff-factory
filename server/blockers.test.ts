// w643: what a Blocked request waits on, and when each kind of blocker clears, stays open, gets stuck or needs a person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKER_STUCK_MS, CI_UNREADABLE_MS, blockerName, blockerProblem, blockerVerdict, gatesName, gatesOf, prRefOf, sameGate, type BlockerFacts } from '../shared/blockers.ts';
import type { WorkBlocker, WorkItem } from '../shared/types.ts';
import { checksState, ghChecks, ghPr, runsState } from './blockerWatch.ts';
import type { RunResult } from './proc.ts';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };

const item = (id: string, o: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `Request ${id}`,
  brief: '',
  priority: 'normal',
  keys: [],
  requestedBy: LOTH,
  requesters: [LOTH],
  humanAsked: true,
  status: 'active',
  createdAt: ago(48),
  updatedAt: ago(1),
  sessionIds: [],
  overlaps: [],
  asks: 0,
  log: [],
  ...o,
});
const block = (b: Partial<WorkBlocker> & Pick<WorkBlocker, 'kind'>): WorkBlocker => ({ what: 'it', at: ago(1), by: 'dispatcher', ...b });
const facts = (work: WorkItem[], o: Partial<BlockerFacts> = {}): BlockerFacts => ({ now: NOW, work: (id) => work.find((w) => w.id === id), ...o });

test('w643: a request blocker clears when that request closes as done, or reports when asked to; follows merges', () => {
  const b = block({ kind: 'request', ref: 'w633', what: "w633's timing table" });
  assert.deepEqual(blockerVerdict(b, facts([item('w633')])), { state: 'open', why: 'w633 is active' });
  assert.deepEqual(blockerVerdict(b, facts([item('w633', { status: 'done', outcome: 'Timing table in specs/633/timing.md' })])), { state: 'clear', why: 'w633 closed as done: Timing table in specs/633/timing.md' });
  // on report: a worker on it finished a turn after the block.
  const r = { ...b, on: 'report' as const };
  const reported = (w: WorkItem, since: number) => w.id === 'w633' && since === Date.parse(b.at);
  assert.equal(blockerVerdict(r, facts([item('w633')], { reportedSince: reported })).state, 'clear');
  assert.equal(blockerVerdict(b, facts([item('w633')], { reportedSince: reported })).state, 'open', 'on done (the default) a report is not enough');
  // Merged into another: that one decides.
  assert.match(blockerVerdict(b, facts([item('w633', { status: 'merged', mergedInto: 'w640' }), item('w640', { status: 'done' })])).why, /^w633 \(merged into w640\) closed as done/);
  // Open however long: the request it follows is what the cleanup stalls.
  assert.equal(blockerVerdict({ ...b, at: ago(24 * 30) }, facts([item('w633')])).state, 'open');
});

test('w643: a request blocker that stalls makes the request stuck; one declined or cancelled asks a person (Waiting on input)', () => {
  const b = block({ kind: 'request', ref: 'w633', what: "w633's timing table" });
  const stalled = blockerVerdict(b, facts([item('w633', { status: 'stalled', stalled: { at: ago(1), kind: 'idle', reason: 'no activity for 26 hours' } })]));
  assert.deepEqual(stalled, { state: 'stuck', why: 'w633, which it waits on, stalled: no activity for 26 hours' });
  const cancelled = blockerVerdict(b, facts([item('w633', { status: 'cancelled', outcome: 'not needed after all' })]));
  assert.deepEqual(cancelled, { state: 'decide', why: "w633 was cancelled without delivering w633's timing table (not needed after all)" });
  assert.equal(blockerVerdict(b, facts([item('w633', { status: 'rejected' })])).state, 'decide');
  assert.equal(blockerVerdict(b, facts([])).state, 'stuck', 'gone from the ledger');
});

test('w643: a deploy blocker clears when a different commit runs (the portal, or a machine daemon); a week without one is stuck', () => {
  const portal = block({ kind: 'deploy', sha: 'aaa1111', what: 'the next portal deploy' });
  assert.equal(blockerVerdict(portal, facts([], { portalSha: 'aaa1111' })).state, 'open');
  assert.deepEqual(blockerVerdict(portal, facts([], { portalSha: 'bbb2222' })), { state: 'clear', why: 'the portal runs bbb2222 now (aaa1111 when it was blocked)' });
  assert.equal(blockerVerdict({ ...portal, at: ago(24 * 7) }, facts([], { portalSha: 'aaa1111' })).state, 'stuck');
  const daemon = block({ kind: 'deploy', ref: 'lothdesktop', sha: 'ccc3333', what: 'the worker update' });
  assert.equal(blockerVerdict(daemon, facts([], { portalSha: 'zzz', daemonSha: () => 'ccc3333' })).state, 'open', "the portal's deploy is not the machine's update");
  assert.match(blockerVerdict(daemon, facts([], { daemonSha: (id) => (id === 'lothdesktop' ? 'ddd4444' : undefined) })).why, /^lothdesktop's daemon runs ddd4444 now/);
});

test('w643: machine, usage, lock, time and CI blockers: clear, open, and stuck past their time', () => {
  const m = block({ kind: 'machine', ref: 'm5', what: 'the M5 asleep' });
  assert.equal(blockerVerdict(m, facts([], { online: () => false })).state, 'open');
  assert.equal(blockerVerdict(m, facts([], { online: () => true })).state, 'clear');
  assert.equal(blockerVerdict({ ...m, at: ago(24 * 3) }, facts([], { online: () => false })).state, 'stuck');
  assert.equal(blockerVerdict(m, facts([], { online: () => undefined })).state, 'stuck', 'no such machine');

  const u = block({ kind: 'usage', ref: 'ben@example.com', what: "Ben's weekly limit" });
  assert.equal(blockerVerdict(u, facts([], { usageClear: () => false })).state, 'open');
  assert.equal(blockerVerdict(u, facts([], { usageClear: () => undefined })).state, 'open', 'unknown: still waiting');
  assert.equal(blockerVerdict(u, facts([], { usageClear: (a) => a === 'ben@example.com' })).state, 'clear');
  assert.equal(blockerVerdict({ ...u, at: ago(24 * 8) }, facts([])).state, 'stuck');

  const lock = block({ kind: 'lock', ref: 'lab.lock', holder: 'w633', what: 'the nightly lab' });
  assert.equal(blockerVerdict(lock, facts([item('w633')])).state, 'open');
  assert.match(blockerVerdict(lock, facts([item('w633', { status: 'cancelled' })])).why, /w633, which held lab.lock, is cancelled/, 'any end of the holder frees the lock');
  assert.equal(blockerVerdict(lock, facts([item('w633')], { reportedSince: () => true })).state, 'clear');
  const bare = block({ kind: 'lock', ref: 'lab.lock', what: 'the nightly lab' });
  assert.equal(blockerVerdict(bare, facts([], { nightlyAt: NOW - 2 * 3_600_000 })).state, 'open', 'a nightly report from before the block');
  assert.match(blockerVerdict(bare, facts([], { nightlyAt: NOW - 60_000 })).why, /^the nightly lab reported since/);
  assert.equal(blockerVerdict({ ...bare, until: ago(0.1) }, facts([])).state, 'clear', 'time to look again');
  assert.equal(blockerVerdict({ ...bare, at: ago(24) }, facts([])).state, 'stuck');

  const t = block({ kind: 'time', until: new Date(NOW + 60_000).toISOString(), what: 'after the nightly run' });
  assert.equal(blockerVerdict(t, facts([])).state, 'open');
  assert.equal(blockerVerdict({ ...t, until: ago(0.01) }, facts([])).state, 'clear');
  assert.equal(blockerVerdict({ ...t, at: ago(24 * 365) }, facts([])).state, 'open', 'a time never gets stuck before it comes');
  assert.equal(BLOCKER_STUCK_MS.time, undefined);

  const ci = block({ kind: 'ci', ref: 'Final-Factory/ff-factory#205', what: "#205's checks" });
  assert.equal(blockerVerdict(ci, facts([], { ci: () => ({ done: false, text: '2 of 13 checks still running' }) })).state, 'open');
  assert.deepEqual(blockerVerdict(ci, facts([], { ci: () => ({ done: true, text: 'all passed' }) })), { state: 'clear', why: 'all passed' });
  assert.equal(blockerVerdict({ ...ci, at: ago(6) }, facts([], { ci: () => ({ done: false, text: 'running' }) })).state, 'stuck', 'a hung run');
});

test("w643: CI is done when no check is still running, or the PR merged or closed; failures are named", () => {
  const ref = 'Final-Factory/ff-factory#205';
  assert.deepEqual(checksState({ state: 'OPEN', statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'e2e', status: 'IN_PROGRESS' }] }, ref), { done: false, text: `1 of 2 checks on ${ref} still running` });
  assert.deepEqual(checksState({ state: 'OPEN', statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'vm', status: 'COMPLETED', conclusion: 'SKIPPED' }] }, ref), { done: true, text: `CI on ${ref} finished: all 2 checks passed or skipped` });
  assert.match(checksState({ state: 'OPEN', statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] }, ref).text, /1 of 1 checks failed \(unit\)/);
  assert.equal(checksState({ state: 'MERGED' }, ref).done, true);
  assert.equal(checksState({ state: 'OPEN', statusCheckRollup: [] }, ref).done, false, 'no checks yet: they have not started');
});

test('w643: a blocker is checked when set: itself, a closed request, an online machine, a time passed, a malformed PR', () => {
  const work = [item('w634'), item('w633'), item('w600', { status: 'done' }), item('w635', { status: 'blocked', blocked: block({ kind: 'request', ref: 'w634' }) })];
  const f = { now: NOW, work: (id: string) => work.find((w) => w.id === id), online: (id: string) => (id === 'm5' ? false : id === 'lothdesktop' ? true : undefined) };
  const p = (b: Partial<WorkBlocker> & Pick<WorkBlocker, 'kind'>) => blockerProblem({ what: 'x', ...b }, 'w634', f);
  assert.equal(p({ kind: 'request', ref: 'w633' }), undefined);
  assert.match(p({ kind: 'request', ref: 'w634' })!, /itself/);
  assert.match(p({ kind: 'request', ref: 'w600' })!, /done already/);
  assert.match(p({ kind: 'request', ref: 'w999' })!, /no request/);
  assert.match(p({ kind: 'request', ref: 'w635' })!, /wait on each other/);
  assert.equal(p({ kind: 'machine', ref: 'm5' }), undefined);
  assert.match(p({ kind: 'machine', ref: 'lothdesktop' })!, /is online: start it there/);
  assert.match(p({ kind: 'machine', ref: 'nope' })!, /no machine/);
  assert.equal(p({ kind: 'deploy' }), undefined);
  assert.match(p({ kind: 'time', until: ago(1) })!, /has passed/);
  assert.match(p({ kind: 'time', until: 'soon' })!, /not a time/);
  assert.equal(p({ kind: 'ci', ref: 'Final-Factory/ff-factory#205' }), undefined);
  assert.match(p({ kind: 'ci', ref: '#205' })!, /owner\/repo#123/);
  assert.match(blockerProblem({ kind: 'deploy', what: ' ' }, 'w634', f)!, /say what it waits for/);
});

test('w643: blocker names, as "Blocked on …" says them', () => {
  assert.equal(blockerName({ kind: 'request', ref: 'w633' }), 'w633 finishing');
  assert.equal(blockerName({ kind: 'deploy' }), 'a portal deploy');
  assert.equal(blockerName({ kind: 'time', until: '2026-10-08T06:00:00.000Z' }, NOW), '10-08 06:00 UTC');
});

test('w754: a pr blocker clears when the pull request merges, asks when it closed unmerged, and is stuck after a week; prRefOf takes a link', () => {
  const pr = block({ kind: 'pr', ref: 'Final-Factory/FinalFactory#1291', what: 'the Deck screens PR' });
  const state = (s: 'open' | 'merged' | 'closed') => facts([], { pr: () => ({ state: s, text: `Final-Factory/FinalFactory#1291 ${s}` }) });
  assert.equal(blockerVerdict(pr, state('open')).state, 'open');
  assert.deepEqual(blockerVerdict(pr, state('merged')), { state: 'clear', why: 'Final-Factory/FinalFactory#1291 merged' });
  assert.match(blockerVerdict(pr, state('closed')).why, /closed without delivering the Deck screens PR/);
  assert.equal(blockerVerdict(pr, state('closed')).state, 'decide');
  assert.equal(blockerVerdict(pr, facts([])).state, 'open', 'unknown: still waiting');
  assert.equal(blockerVerdict({ ...pr, at: ago(24 * 7) }, state('open')).state, 'stuck');
  assert.equal(blockerName(pr), 'PR Final-Factory/FinalFactory#1291 merging');
  assert.equal(prRefOf('https://github.com/Final-Factory/FinalFactory/pull/1291'), 'Final-Factory/FinalFactory#1291');
  assert.equal(prRefOf('Final-Factory/FinalFactory#1291'), 'Final-Factory/FinalFactory#1291');
  assert.equal(prRefOf('#1291'), undefined, 'no repo: not a reference');
  assert.match(blockerProblem({ kind: 'pr', what: 'x', ref: '#1291' }, 'w750', facts([]))!, /owner\/repo#123/);
});

test('w754: a request with several gates is named by all of them; gates are the same wait by kind and reference', () => {
  const a = block({ kind: 'request', ref: 'w752' });
  const b = block({ kind: 'pr', ref: 'Final-Factory/FinalFactory#1291' });
  assert.deepEqual(gatesOf({}), []);
  assert.deepEqual(gatesOf({ blocked: a, alsoBlocked: [b] }), [a, b]);
  assert.equal(gatesName([a, b]), 'w752 finishing and PR Final-Factory/FinalFactory#1291 merging');
  assert.equal(gatesName([a, b, block({ kind: 'deploy' })]), 'w752 finishing, PR Final-Factory/FinalFactory#1291 merging and a portal deploy');
  assert.equal(sameGate(a, { kind: 'request', ref: 'W752' }), true);
  assert.equal(sameGate(a, b), false);
  // Two requests waiting on each other through a second gate are caught too.
  const work = [item('w750', { status: 'blocked', blocked: block({ kind: 'request', ref: 'w1' }), alsoBlocked: [block({ kind: 'request', ref: 'w752' })] }), item('w752')];
  assert.match(blockerProblem({ kind: 'request', ref: 'w750', what: 'x' }, 'w752', facts(work))!, /wait on each other/);
});

// ---------------------------------------------------------------- w829: CI blocks that never cleared

/** The rollup of #1338 (w814) as gh read it on 2026-10-10 (measured, BEAST's gh); #1335's (w818) had the same nine checks. */
const ROLLUP_1338 = ['docs/Lessons-Index.md freshness:SUCCESS', 'Mode-2 nightly freshness:SUCCESS', 'Nightly e2e ledger:SUCCESS', 'Is this push a version bump:SKIPPED', 'Test in editmode:SUCCESS', 'Release:SKIPPED', 'Branch tip for the cache refresh:SKIPPED', 'Refresh the branch entry after the release:SKIPPED', 'editmode Test Results:SUCCESS'].map((c) => {
  const [name, conclusion] = c.split(':');
  return { name, status: 'COMPLETED', conclusion };
});

test('w829: the checks of #1338 (w814) and #1335 (w818) as they finished read as done, so their blocks held only because the read failed', () => {
  // Both PRs' rollups had every check COMPLETED (Test in editmode at 00:26Z and 00:06Z): checksState clears them at once.
  for (const ref of ['Final-Factory/FinalFactory#1338', 'Final-Factory/FinalFactory#1335']) {
    assert.deepEqual(checksState({ state: 'OPEN', statusCheckRollup: ROLLUP_1338 }, ref), { done: true, text: `CI on ${ref} finished: all 9 checks passed or skipped` });
  }
  // #1328 (w808): its editmode job hung and was cancelled after 90 minutes: done, and named as failed.
  const cancelled = checksState({ state: 'OPEN', statusCheckRollup: [{ name: 'Test in editmode', status: 'COMPLETED', conclusion: 'CANCELLED' }, { name: 'Release', status: 'COMPLETED', conclusion: 'SKIPPED' }] }, 'Final-Factory/FinalFactory#1328');
  assert.deepEqual(cancelled, { done: true, text: 'CI on Final-Factory/FinalFactory#1328 finished: 1 of 2 checks failed (Test in editmode)' });
});

test('w829: Actions runs, the reading without Checks permission: running, green, red, cancelled (#1328), none yet', () => {
  const ref = 'Final-Factory/FinalFactory#1328';
  assert.deepEqual(runsState({ workflow_runs: [] }, ref), { done: false, text: `${ref} has no workflow runs yet` });
  assert.deepEqual(runsState({ workflow_runs: [{ name: 'Lessons index freshness', status: 'completed', conclusion: 'success' }, { name: 'Test Runner', status: 'in_progress', conclusion: null }] }, ref), { done: false, text: `1 of 2 workflow runs on ${ref} still running (Test Runner)` });
  assert.equal(runsState({ workflow_runs: [{ name: 'Test Runner', status: 'queued' }] }, ref).done, false);
  assert.equal(runsState({ workflow_runs: [{ name: 'Test Runner', status: 'waiting' }] }, ref).done, false, 'waiting for an approval is not finished');
  // Green: every run completed with success or skipped.
  assert.deepEqual(runsState({ workflow_runs: [{ name: 'Lessons index freshness', status: 'completed', conclusion: 'success' }, { name: 'Test Runner', status: 'completed', conclusion: 'success' }, { name: 'Release', status: 'completed', conclusion: 'skipped' }] }, ref), { done: true, text: `CI on ${ref} finished: all 3 workflow runs passed or skipped` });
  // Red: a failure, and #1328's first attempt, cancelled at its 90-minute limit (run 37997522857, 23:38Z): both done, both named.
  assert.deepEqual(runsState({ workflow_runs: [{ name: 'Test Runner', status: 'completed', conclusion: 'failure' }] }, ref), { done: true, text: `CI on ${ref} finished: 1 of 1 workflow runs failed (Test Runner: failure)` });
  assert.deepEqual(runsState({ workflow_runs: [{ name: 'Lessons index freshness', status: 'completed', conclusion: 'success' }, { name: 'Test Runner', status: 'completed', conclusion: 'cancelled' }] }, ref), { done: true, text: `CI on ${ref} finished: 1 of 2 workflow runs failed (Test Runner: cancelled)` });
  for (const conclusion of ['timed_out', 'startup_failure', 'action_required']) assert.match(runsState({ workflow_runs: [{ name: 'T', status: 'completed', conclusion }] }, ref).text, /1 of 1 workflow runs failed/, conclusion);
});

/** A fake gh: answers by the command's words; anything else is a failure. */
function fakeGh(answers: { match: RegExp; out?: unknown; err?: string }[]) {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const a = answers.find((x) => x.match.test(line));
    if (!a) return { code: 1, stdout: '', stderr: `unexpected: ${line}` };
    return a.err !== undefined ? { code: 1, stdout: '', stderr: a.err } : { code: 0, stdout: JSON.stringify(a.out), stderr: '' };
  };
  return { run, calls };
}

/** What gh says when a fine-grained token reads a check run (representative; GitHub gives those tokens no Checks permission). */
const REFUSED = 'GraphQL: Resource not accessible by personal access token (repository.pullRequest.commits.nodes.0.commit.statusCheckRollup.contexts.nodes.0)';

test("w829: ghChecks reads the rollup; where GitHub refuses it, the PR state and its head commit's Actions runs; it throws with gh's words when neither reads", async () => {
  const ref = 'Final-Factory/FinalFactory#1328';
  // A token with Checks permission: the rollup, one call.
  const ok = fakeGh([{ match: /statusCheckRollup/, out: { state: 'OPEN', statusCheckRollup: ROLLUP_1338 } }]);
  assert.equal((await ghChecks(ref, ok.run)).done, true);
  assert.deepEqual(ok.calls, ['gh pr view 1328 -R Final-Factory/FinalFactory --json state,statusCheckRollup']);

  // The portal's fine-grained token: the rollup is refused, the runs are read instead.
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(' '));
  try {
    const fg = (runs: unknown, state = 'OPEN') =>
      fakeGh([
        { match: /statusCheckRollup/, err: REFUSED },
        { match: /--json state,headRefOid$/, out: { state, headRefOid: 'b29072e5bb888423364803d52718e93542b53001' } },
        { match: /^gh api repos\/Final-Factory\/FinalFactory\/actions\/runs\?head_sha=b29072e5bb888423364803d52718e93542b53001&per_page=100$/, out: { workflow_runs: runs } },
      ]);
    const running = fg([{ name: 'Test Runner', status: 'in_progress', conclusion: null }]);
    assert.deepEqual(await ghChecks(ref, running.run), { done: false, text: `1 of 1 workflow runs on ${ref} still running (Test Runner)` });
    assert.equal(running.calls.length, 3);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /^blocker watch: gh cannot read pull requests' checks \(GraphQL: Resource not accessible by personal access token .*\); CI blocks read their GitHub Actions runs instead$/);
    assert.equal((await ghChecks(ref, fg([{ name: 'Test Runner', status: 'completed', conclusion: 'cancelled' }]).run)).text, `CI on ${ref} finished: 1 of 1 workflow runs failed (Test Runner: cancelled)`);
    assert.equal((await ghChecks(ref, fg([{ name: 'Test Runner', status: 'completed', conclusion: 'success' }]).run)).done, true);
    assert.equal(warned.length, 1, 'said once per server, not per read');
    // Merged (w818: #1335 merged while its block held): done from the PR state alone, no runs read.
    const merged = fg([], 'MERGED');
    assert.deepEqual(await ghChecks(ref, merged.run), { done: true, text: `${ref} is merged` });
    assert.equal(merged.calls.length, 2);
  } finally {
    console.warn = warn;
  }

  // Nothing reads (gh logged out, the network down): it throws, saying what gh said, never a silent undefined.
  const down = fakeGh([{ match: /./, err: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login' }]);
  await assert.rejects(ghChecks(ref, down.run), { message: 'gh pr view Final-Factory/FinalFactory#1328: HTTP 401: Bad credentials (https://api.github.com/graphql) Try authenticating with: gh auth login' });
  const noRuns = fakeGh([
    { match: /statusCheckRollup/, err: REFUSED },
    { match: /--json state,headRefOid$/, out: { state: 'OPEN', headRefOid: 'abc' } },
    { match: /actions\/runs/, err: 'HTTP 403: Resource not accessible by personal access token' },
  ]);
  await assert.rejects(ghChecks(ref, noRuns.run), /its checks: GraphQL: Resource not accessible.*; its Actions runs: HTTP 403: Resource not accessible by personal access token/);
  await assert.rejects(ghChecks('#1328', ok.run), /"#1328" is not a pull request/);
  // The pr blocker's read throws the same way.
  await assert.rejects(ghPr(ref, down.run), /gh pr view Final-Factory\/FinalFactory#1328: HTTP 401: Bad credentials/);
  assert.deepEqual(await ghPr(ref, fakeGh([{ match: /--json state,mergeCommit$/, out: { state: 'MERGED' } }]).run), { state: 'merged', text: `${ref} merged` });
});

test('w829: CI that cannot be read clears its block after CI_UNREADABLE_MS so its worker looks itself; the clock restarts with a new block', () => {
  assert.equal(CI_UNREADABLE_MS, 15 * 60_000);
  const ref = 'Final-Factory/FinalFactory#1338';
  const ci = block({ kind: 'ci', ref, what: "#1338's checks", at: ago(2) });
  const unreadable = (minutes: number) => ({ ci: () => undefined, ciUnreadable: () => ({ since: NOW - minutes * 60_000, why: REFUSED }) });
  assert.deepEqual(blockerVerdict(ci, facts([], unreadable(10))), { state: 'open', why: `CI on ${ref} is running` });
  assert.deepEqual(blockerVerdict(ci, facts([], unreadable(15))), { state: 'clear', why: `FF Factory could not read CI on ${ref} for 15 min (${REFUSED}), so its worker checks CI itself` });
  // A request blocked again on the same CI 5 minutes ago waits its own 15 minutes, not a clear every minute.
  const again = { ...ci, at: new Date(NOW - 5 * 60_000).toISOString() };
  assert.equal(blockerVerdict(again, facts([], unreadable(60))).state, 'open');
  assert.match(blockerVerdict({ ...again, at: new Date(NOW - 16 * 60_000).toISOString() }, facts([], unreadable(60))).why, /could not read CI on .* for 16 min/);
  // A read that works wins: running stays open, done clears with its words.
  assert.equal(blockerVerdict(ci, facts([], { ci: () => ({ done: false, text: 'running' }), ciUnreadable: () => undefined })).state, 'open');
  assert.deepEqual(blockerVerdict(ci, facts([], { ci: () => ({ done: true, text: 'all passed' }) })), { state: 'clear', why: 'all passed' });
});
