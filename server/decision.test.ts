import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionOf, utcStamp } from '../shared/decision.ts';
import { sourceTag } from './intakeRules.ts';
import type { WorkItem } from '../shared/types.ts';

/** w319: "needs a human" is a state only while an intake request waits; then it says who decided and when, or how it closed. */

const BEN = { userId: 'ben', displayName: 'Ben' };
const AT = '2026-10-03T20:51:12.000Z';
const item = (o: Partial<WorkItem>): WorkItem =>
  ({ id: 'w233', title: 'FFBox request', status: 'new', source: { kind: 'ffbox-request', untrusted: true }, triage: { class: 'needs-human', reason: 'needs a human: FFBox work that started from players’ reports or text' }, ...o }) as WorkItem;

test('untouched: it still says needs a human, in the tag and in the decision', () => {
  const w = item({ approval: { state: 'pending', why: 'x' } });
  assert.deepEqual(decisionOf(w), { state: 'waiting', text: 'needs a human' });
  assert.equal(sourceTag(w), 'FFBox request, untrusted, needs a human');
  assert.equal(decisionOf(item({ approval: { state: 'pending' }, triage: { class: 'obvious-bug', reason: 'x' } }))?.text, 'awaiting approval');
});

test('approved: the tag says who and when, and "needs a human" is gone; an auto-approval says so', () => {
  const w = item({ approval: { state: 'approved', by: BEN, at: AT } });
  assert.deepEqual(decisionOf(w), { state: 'approved', text: 'approved by Ben 2026-10-03 20:51 UTC' });
  assert.equal(sourceTag(w), 'FFBox request, untrusted, approved by Ben 2026-10-03 20:51 UTC');
  assert.ok(!sourceTag(w).includes('needs a human'));
  assert.equal(sourceTag(item({ approval: { state: 'approved', by: 'auto', at: AT }, triage: { class: 'obvious-bug', reason: 'x' } })), 'FFBox request, untrusted, obvious bug, auto-approved 2026-10-03 20:51 UTC');
  assert.equal(sourceTag(w, false), 'FFBox request, untrusted', 'without the decision, for a notice that states it itself');
});

test('declined reads declined by who and when', () => {
  const w = item({ status: 'rejected', approval: { state: 'declined', by: BEN, at: AT } });
  assert.deepEqual(decisionOf(w), { state: 'declined', text: 'declined by Ben 2026-10-03 20:51 UTC' });
  assert.equal(sourceTag(w), 'FFBox request, untrusted, declined by Ben 2026-10-03 20:51 UTC');
});

test('auto-closed (w298) reads closed: merged as #N, though its approval was never given', () => {
  const w = item({ status: 'done', approval: { state: 'pending', why: 'x' }, autoClosed: { at: AT, how: 'branch', pr: 946, sha: 'a'.repeat(40), mergedAt: AT, text: 'merged as #946 (aaaaaaaaaaaa) on 2026-10-03' } });
  assert.deepEqual(decisionOf(w), { state: 'closed', text: 'closed: merged as #946 (aaaaaaaaaaaa) on 2026-10-03' });
  assert.equal(sourceTag(w), 'FFBox request, untrusted, closed: merged as #946 (aaaaaaaaaaaa) on 2026-10-03');
  assert.ok(!sourceTag(w).includes('needs a human'));
});

test('closed some other way without approval says nothing about needing a human; a person’s own request has no decision', () => {
  assert.equal(decisionOf(item({ status: 'done', approval: { state: 'pending' } })), undefined);
  assert.ok(!sourceTag(item({ status: 'done', approval: { state: 'pending' } })).includes('needs a human'));
  assert.equal(decisionOf({ status: 'new' } as WorkItem), undefined);
  assert.equal(utcStamp(undefined), '');
});
