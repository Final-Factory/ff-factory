import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchCarriesRequest, mergeOwnerProblem, mergeTimeProblem, type MergeOwner } from './mergeOwner.ts';
import { prHealthOf } from './blockerWatch.ts';

/** w5549 (w5451 item 17): merge on green merges only the calling worker's own pull request, by its head as GitHub reads it. */

const GAME = 'Final-Factory/FinalFactory';
const owner: MergeOwner = { request: 'w5549', sandboxBranches: ['sandbox/slot2-w5487', 'sandbox/slot2-w5487'], gameRepo: GAME };
const head = (headRef: string, headRepo = GAME, crossRepo = false) => ({ state: 'open' as const, head: 'a'.repeat(40), headRef, headRepo, ...(crossRepo ? { crossRepo: true as const } : {}) });

test('w5549: its own pull request is allowed: its sandbox branch in the game repo, a branch named for its request in any repo, the request\'s own branch', () => {
  assert.equal(mergeOwnerProblem(`${GAME}#4330`, head('sandbox/slot2-w5487'), owner), undefined);
  assert.equal(mergeOwnerProblem('Final-Factory/ff-factory#1161', head('w5549-merge-owner', 'Final-Factory/ff-factory'), owner), undefined);
  assert.equal(mergeOwnerProblem('Final-Factory/ffu#900', head('design/w5549-x', 'final-factory/FFU'), owner), undefined);
  assert.equal(mergeOwnerProblem(`${GAME}#4331`, head('ffbox/thread-123'), { ...owner, sourceBranch: 'ffbox/thread-123' }), undefined);
});

test("w5549: another worker's pull request is refused, saying why", () => {
  const other = mergeOwnerProblem(`${GAME}#4328`, head('sandbox/slot1-w5480'), owner);
  assert.match(other!, /^its head branch is sandbox\/slot1-w5480, which is not your sandbox's branch \(sandbox\/slot2-w5487\) or a branch named for w5549 \(w5549-<what>\): it is not your request's pull request$/);
  assert.match(mergeOwnerProblem('Final-Factory/ff-factory#1160', head('w5534-push-owner', 'Final-Factory/ff-factory'), owner)!, /not .*a branch named for w5549/);
  // A longer id is another request's (w55490 is not w5549), and a sandbox branch counts only in the game repo.
  assert.ok(mergeOwnerProblem('Final-Factory/ffu#1', head('w55490-x', 'Final-Factory/ffu'), owner));
  assert.ok(mergeOwnerProblem('Final-Factory/ff-factory#1', head('sandbox/slot2-w5487', 'Final-Factory/ff-factory'), owner));
  // A shared branch is nobody's, even when the sandbox sits on it.
  assert.match(mergeOwnerProblem(`${GAME}#2`, head('master'), { ...owner, sandboxBranches: ['master'] })!, /shared branch/);
});

test('w5549: a fork head is refused, though its branch carries the request id or the sandbox branch name; an unreadable head is refused', () => {
  assert.match(mergeOwnerProblem(`${GAME}#9`, head('w5549-fix', 'someone/FinalFactory', true), owner)!, /^its head is someone\/FinalFactory:w5549-fix, a branch of another repository \(a fork\), not of Final-Factory\/FinalFactory$/);
  assert.match(mergeOwnerProblem(`${GAME}#9`, head('sandbox/slot2-w5487', 'someone/FinalFactory', true), owner)!, /a fork/);
  // GitHub names no repository for a deleted fork's head.
  assert.match(mergeOwnerProblem(`${GAME}#9`, { state: 'open', headRef: 'w5549-fix', crossRepo: true }, owner)!, /a fork/);
  assert.match(mergeOwnerProblem(`${GAME}#9`, undefined, owner)!, /could not read .*head branch from GitHub/);
  assert.match(mergeOwnerProblem(`${GAME}#9`, { state: 'open', head: 'a'.repeat(40) }, owner)!, /could not read/);
});

test('w5549: at the merge, a head that is no longer the armed branch of the same repository, or a gate armed before the check, is not merged', () => {
  assert.equal(mergeTimeProblem(`${GAME}#1`, head('w5549-x'), 'w5549-x'), undefined);
  assert.match(mergeTimeProblem(`${GAME}#1`, head('w5549-renamed'), 'w5549-x')!, /head is Final-Factory\/FinalFactory:w5549-renamed, not Final-Factory\/FinalFactory:w5549-x/);
  assert.match(mergeTimeProblem(`${GAME}#1`, head('w5549-x', 'evil/FinalFactory', true), 'w5549-x')!, /evil\/FinalFactory:w5549-x/);
  assert.match(mergeTimeProblem(`${GAME}#1`, head('w5549-x'), undefined)!, /armed .* before FF Factory checked/);
  assert.match(mergeTimeProblem(`${GAME}#1`, undefined, 'w5549-x')!, /could not read/);
});

test("w5549: branchCarriesRequest takes the id as a whole word; prHealthOf reads the head's repository and fork flag from gh", () => {
  assert.ok(branchCarriesRequest('w5549', 'w5549'));
  assert.ok(branchCarriesRequest('review/W5549-a', 'w5549'));
  assert.ok(!branchCarriesRequest('xw5549', 'w5549'));
  assert.ok(!branchCarriesRequest('w55491', 'w5549'));
  assert.ok(!branchCarriesRequest('anything', 'not-an-id'));
  const own = prHealthOf({ state: 'OPEN', headRefName: 'w5549-x', headRepository: { name: 'ff-factory' }, headRepositoryOwner: { login: 'Final-Factory' }, isCrossRepository: false });
  assert.equal(own.headRepo, 'Final-Factory/ff-factory');
  assert.equal(own.crossRepo, undefined);
  const fork = prHealthOf({ state: 'OPEN', headRefName: 'w5549-x', headRepository: null, headRepositoryOwner: { login: 'evil' }, isCrossRepository: true });
  assert.equal(fork.headRepo, undefined);
  assert.equal(fork.crossRepo, true);
});
