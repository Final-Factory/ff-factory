// w830: a person's decision that waits for a checked fact (shared/conditional.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionalLine, conditionalVerdict, conditionName, HELD_MARK, inPersonWords, parseCondition, type ConditionalPr } from '../shared/conditional.ts';
import type { ConditionalDecision, WorkItem } from '../shared/types.ts';

const NOW = Date.parse('2026-10-10T03:00:00Z');
const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };
const item = (id: string, status: WorkItem['status'], o: Partial<WorkItem> = {}) => ({ id, status, ...o }) as WorkItem;
const decision = (when: ConditionalDecision['when'], o: Partial<ConditionalDecision> = {}): ConditionalDecision => ({
  id: 'w811.c1',
  by: LOTH,
  at: '2026-10-10T02:31:00.000Z',
  words: 'Close w811 as a duplicate once 1314 is merged',
  action: 'decline',
  when,
  expires: '2026-10-24T02:31:00.000Z',
  ...o,
});
const facts = (pr?: ConditionalPr, work: WorkItem[] = [], now = NOW) => ({ now, pr: () => pr, work: (id: string) => work.find((w) => w.id === id) });

test('w830: a condition is one checked fact: a pull request merged or closed, or a request closed as done; nothing else', () => {
  assert.deepEqual(parseCondition({ pr_merged: 'Final-Factory/FinalFactory#1314' }, 'w811'), { kind: 'pr_merged', ref: 'Final-Factory/FinalFactory#1314' });
  assert.deepEqual(parseCondition({ pr_closed: 'https://github.com/Final-Factory/ff-factory/pull/262' }, 'w811'), { kind: 'pr_closed', ref: 'Final-Factory/ff-factory#262' });
  assert.deepEqual(parseCondition({ request_done: 'W810' }, 'w811'), { kind: 'request_done', ref: 'w810' });
  assert.throws(() => parseCondition({}, 'w811'), /exactly one of pr_merged, pr_closed or request_done/);
  assert.throws(() => parseCondition({ pr_merged: 'a/b#1', request_done: 'w1' }, 'w811'), /exactly one/);
  assert.throws(() => parseCondition({ pr_merged: '#1314' }, 'w811'), /"#1314" is not a pull request: .*a bare #1314 names no repo; the game is Final-Factory\/FinalFactory/);
  assert.throws(() => parseCondition({ request_done: 'when it is ready' }, 'w811'), /is not a request id/);
  assert.throws(() => parseCondition({ request_done: 'w811' }, 'w811'), /cannot wait on itself/);
  assert.equal(conditionName({ kind: 'pr_closed', ref: 'a/b#2' }), 'PR a/b#2 closes (merged or not)');
});

test('w830: carried out when the fact is met; dropped, never carried out, when it can no longer be met or it expires', () => {
  const merged = decision({ kind: 'pr_merged', ref: 'Final-Factory/FinalFactory#1314' });
  assert.deepEqual(conditionalVerdict(merged, facts({ state: 'open', text: 'open' })), { state: 'wait', why: 'PR Final-Factory/FinalFactory#1314 is still open' });
  assert.deepEqual(conditionalVerdict(merged, facts(undefined)), { state: 'wait', why: 'PR Final-Factory/FinalFactory#1314 not read yet' }, 'a read that failed waits');
  assert.deepEqual(conditionalVerdict(merged, facts({ state: 'merged', text: 'merged', sha: '3c1cdbfa256b0123456789' })), { state: 'run', why: 'PR Final-Factory/FinalFactory#1314 merged as 3c1cdbfa256b' });
  assert.deepEqual(conditionalVerdict(merged, facts({ state: 'closed', text: 'closed' })), { state: 'drop', why: 'PR Final-Factory/FinalFactory#1314 was closed without merging' });
  // "PR closed" means closed either way.
  const closed = decision({ kind: 'pr_closed', ref: 'a/b#2' });
  assert.equal(conditionalVerdict(closed, facts({ state: 'closed', text: '' })).state, 'run');
  assert.equal(conditionalVerdict(closed, facts({ state: 'merged', text: '' })).state, 'run');
  // A request: done runs (merges followed); declined or cancelled drops; open waits.
  const req = decision({ kind: 'request_done', ref: 'w810' }, { action: 'done' });
  assert.equal(conditionalVerdict(req, facts(undefined, [item('w810', 'active')])).state, 'wait');
  assert.deepEqual(conditionalVerdict(req, facts(undefined, [item('w810', 'merged', { mergedInto: 'w812' }), item('w812', 'done')])), { state: 'run', why: 'w810 (merged into w812) closed as done' });
  assert.deepEqual(conditionalVerdict(req, facts(undefined, [item('w810', 'cancelled')])), { state: 'drop', why: 'w810 was cancelled, not done' });
  assert.equal(conditionalVerdict(req, facts(undefined, [])).state, 'drop', 'gone from the ledger');
  // Expiry: unmet at its time, dropped and said so; a fact met at the same time still runs.
  const late = Date.parse(merged.expires) + 1;
  assert.deepEqual(conditionalVerdict(merged, facts({ state: 'open', text: '' }, [], late)), { state: 'drop', why: 'it expired at 10-24 02:31 UTC unmet (PR Final-Factory/FinalFactory#1314 is still open)' });
  assert.equal(conditionalVerdict(merged, facts({ state: 'merged', text: '' }, [], late)).state, 'run');
  assert.equal(conditionalLine({ id: 'w811' }, merged), 'w811.c1 on w811: decline when PR Final-Factory/FinalFactory#1314 merges (Lothsahn, 10-10 02:31 UTC: "Close w811 as a duplicate once 1314 is merged"; expires 10-24 02:31 UTC)');
});

test("w830: a decision's words must be its person's own, verbatim, and never FF Factory's note in their message", () => {
  const said = ['Please move all work requests I’ve created to beast', 'Close w811 as a duplicate once 1314 is merged.'];
  assert.equal(inPersonWords('close w811 as a duplicate once 1314 is merged', said), true, 'case and end punctuation aside');
  assert.equal(inPersonWords('"Close w811 as a duplicate once 1314 is merged"', said), true, 'outer quotes aside');
  assert.equal(inPersonWords("all work requests I've created", said), true, 'curly quotes match straight ones');
  assert.equal(inPersonWords('Close w811 once 1314 merges', said), false, 'a paraphrase is not their words');
  assert.equal(inPersonWords('w811', said), false, 'too short to be a decision');
  // The note FF Factory appends to a person's message (the calls a gate refused) is not theirs.
  const withNote = [`hi\n\n${HELD_MARK}\n- update_work {"id":"w811","decline":true,"words":"decline w811 when 1314 merges"}`];
  assert.equal(inPersonWords('decline w811 when 1314 merges', withNote), false);
});
