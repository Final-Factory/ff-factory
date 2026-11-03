// w2956: w2895 (Ben's FFU fan-out, standing ask "keep 8 to 10 rows running at once") stalled twice: on 2026-11-02 (Ben's
// 05:10 note found every worker stopped) and on 2026-11-03, when planning worker 2d1ac9f7 ended its turn at 05:14 UTC with
// ten startable rows and "the dispatcher starts the ten rows above", and nothing started until lothsahn's review note at
// 11:57. Its [worker update] went to Ben's orchestrator only, and the capacity ping names queued requests only, so the
// dispatcher had no turn for it. These pin the two readers; the message flow is in orchestrators.test.ts ("w2956: …").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatcherAskIn, orchestratorAskIn, otherWorkWait, standingTargetOf } from '../shared/workState.ts';

const W2895_LINE =
  "w2895: still open: the dispatcher starts the ten rows above, M2.13 (thin bots, PR #107) is rebased, its timed hour runs, and Ben answers M1.7's rate-mode decision";

test('w2956: the w2895 line hands the dispatcher legs, and no earlier reader took it', () => {
  assert.equal(dispatcherAskIn(W2895_LINE), true);
  // Why nothing fired before: it is neither a wait on the orchestrator (w2870) nor a wait on another worker (w1944).
  assert.equal(orchestratorAskIn(W2895_LINE), false);
  assert.equal(otherWorkWait(W2895_LINE, 'w2895'), undefined);
  for (const line of [
    'w12: still open: waiting on the dispatcher to start rows M2.3 and M2.6',
    'w12: still open: the dispatcher should start one leg per row in the table above',
    'w12: still open: the next three rows, to be started by the dispatcher',
    'w12: still open: the dispatcher to open a leg for M1.3 once M1.2 merges',
  ]) assert.equal(dispatcherAskIn(line), true, line);
  for (const line of [
    'w12: still open: CI on PR #44',
    'w12: still open: waiting on the dispatcher to answer whether m5 may time',
    'w12: still open: the dispatcher started the rows; I am on M2.6',
    undefined,
  ]) assert.equal(dispatcherAskIn(line), false, String(line));
});

test("w2956: a request's standing target is its people's newest \"keep N running\"", () => {
  const brief = 'One worker per row. Aim for 6–8 rows at once.';
  assert.equal(standingTargetOf({ brief }), undefined, 'an aim in the brief is no standing ask');
  const notes = [
    { at: '2026-11-02T20:11:00Z', by: 'ben', text: 'Start wave 1 now with one worker per row.' },
    { at: '2026-11-02T23:26:00Z', by: 'ben', text: 'Keep at least 8 to 10 rows running at once, and start the next row as soon as one merges.' },
    { at: '2026-11-03T00:42:00Z', by: 'ben', text: 'Each worker: check at ffu main that your row is unmarked.' },
  ];
  assert.deepEqual(standingTargetOf({ brief, notes }), { min: 8, max: 10, words: 'Keep at least 8 to 10 rows running' });
  assert.equal(standingTargetOf({ brief, notes: [...notes, { at: '2026-11-03T05:10:00Z', by: 'ben', text: 'keep 4 workers going' }] })?.min, 4, 'the newest wins');
  assert.equal(standingTargetOf({ brief: 'keep 6 legs running' })?.min, 6);
  assert.equal(standingTargetOf({ brief: 'keep the 2 tests green and keep it running' }), undefined);
});
