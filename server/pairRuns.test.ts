import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitsIn, normPr, pairCommitsOf, pairPrOf, pairRanCommit, pairWaitLine, prIn, resultFor, sameCommit } from './pairRuns.ts';

test('w2057: a pair run’s pull request, from request_pair or its title and brief', () => {
  assert.equal(prIn('MP-lowore-pin-pair on PR #2340'), 'Final-Factory/FinalFactory#2340');
  assert.equal(prIn('see https://github.com/Final-Factory/ff-factory/pull/667 for it'), 'Final-Factory/ff-factory#667');
  assert.equal(prIn('Final-Factory/FinalFactory#2364 sync run'), 'Final-Factory/FinalFactory#2364');
  assert.equal(prIn('Sync run for #2340'), 'Final-Factory/FinalFactory#2340');
  assert.equal(prIn('400 heartbeats, 2 legs'), undefined);
  assert.equal(normPr('#2340'), 'Final-Factory/FinalFactory#2340');
  assert.equal(normPr('2340'), 'Final-Factory/FinalFactory#2340');
  assert.equal(normPr('Final-Factory/FinalFactory#2340'), 'Final-Factory/FinalFactory#2340');
  assert.equal(normPr('the fix'), undefined);
  const hand = { title: 'Sync run: MP-lowore-pin-pair for PR #2340 on two non-Mac machines', brief: 'branch w665-lowore', pair: { legs: 2 } };
  assert.equal(pairPrOf(hand), 'Final-Factory/FinalFactory#2340');
  assert.equal(pairPrOf({ ...hand, pair: { legs: 2, pr: 'Final-Factory/FinalFactory#9' } }), 'Final-Factory/FinalFactory#9', 'the recorded one wins');
});

test('w2057: the commits a finished pair run ran, and whether it ran one', () => {
  assert.deepEqual(commitsIn('at 1a2b3c4d, not deadbeef nor 1234567 (no letter); ABCDEF12'), ['1a2b3c4d', 'abcdef12']);
  assert.ok(sameCommit('1a2b3c4d', '1a2b3c4d5e6f'));
  assert.ok(!sameCommit('1a2b3c', '1a2b3c4d'), 'shorter than 7 is no commit');
  const done = { title: 'Pair run for w665', brief: 'run it', outcome: 'For w665: PASS at c7891d5: 0 diverged', done: { s1: { at: 'x', report: 'For w665: PASS', text: 'For w665: PASS on c7891d5e2' } } };
  assert.deepEqual(pairCommitsOf(done), ['c7891d5', 'c7891d5e2']);
  assert.ok(pairRanCommit(done, 'c7891d5e2ff'));
  assert.ok(!pairRanCommit(done, '0f1e2d3c'));
  assert.ok(!pairRanCommit(done, undefined));
  assert.deepEqual(pairCommitsOf({ ...done, pair: { legs: 2, commit: 'AB12CD3' } }), ['ab12cd3'], 'the recorded one only');
});

test('w2057: the result for the waiter starts at its "For wNNN:" line', () => {
  assert.equal(resultFor('Ran it.\n\nFor w665: PASS, 400 heartbeats\nDONE: w1936', 'w665'), 'For w665: PASS, 400 heartbeats\nDONE: w1936');
  assert.equal(resultFor('**For w665:** PASS', 'w665'), '**For w665:** PASS');
  assert.equal(resultFor('PASS on both legs', 'w665'), 'PASS on both legs');
  assert.equal(resultFor('x'.repeat(50), 'w1', 10), `${'x'.repeat(9)}…`);
  assert.equal(resultFor(undefined, 'w1'), '');
});

test('w2057: a still-open line that waits on a pair run, as d558ba14 wrote it; not a repair or a pair of anything else', () => {
  assert.ok(pairWaitLine('w665: still open: waiting on a Windows or Linux pair worker to run `MP-lowore-pin-pair` for PR #2340 (CI is green, the merge is held for that run)'));
  assert.ok(pairWaitLine('waiting on the pair run of PR #2364'));
  assert.ok(pairWaitLine('the merge is held for MP-W1904-connector-pair'));
  assert.ok(pairWaitLine('waiting for a two-machine check on two non-Mac computers'));
  assert.ok(!pairWaitLine('waiting on the repair of the belt saves'));
  assert.ok(!pairWaitLine('waiting on Ben to pick a pair of colours'));
  assert.ok(!pairWaitLine('ran MP-lowore-pin-pair: passed'), 'no wait');
});
