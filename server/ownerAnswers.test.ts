// w4238 (lothsahn: "Alter ff portal so that I can click answers for Ben's questions"): which waiting questions an owner may
// answer for the other owner on the Waiting on input tab (shared/waiting.ts ownerAnswersFor, mirroring the server's w3606
// gate in Orchestrators.ownerActsForOwner), and the message a click sends (shared/questionCard.ts ownerAnswerMessage).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkItem } from '../shared/types.ts';
import { ownerAnswersFor } from '../shared/waiting.ts';
import { answerMessage, answersText, ownerAnswerMessage } from '../shared/questionCard.ts';

const BEN = { userId: 'ben', displayName: 'Ben' };
const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };
const ANNA = { userId: 'anna', displayName: 'Anna' };
const OWNERS = [BEN, LOTH];
const ME = { userId: 'lothsahn', role: 'owner' };
const AT = '2026-11-14T20:00:00.000Z';
const asks = [
  { question: 'Which Station card layout?', options: [{ label: 'Compact', description: 'One line.', recommended: true }, { label: 'Wide', description: 'Two lines.' }] },
  { question: 'Show the power bar?', options: [{ label: 'Yes', description: 'Shown.', recommended: true }, { label: 'No', description: 'Hidden.' }] },
];
const needsYou = { key: 'declared:abc', kind: 'declared' as const, question: 'Pick', who: ['Ben'], to: ['ben'], at: AT, previews: [], prs: [], worker: 'abcd1234', asks };
function item(o: Partial<WorkItem> = {}): WorkItem {
  return { id: 'w4196', title: 'Station card', brief: 'b', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: AT, updatedAt: AT, sessionIds: [], overlaps: [], asks: 0, log: [], needsYou, ...o };
}

test("w4238: an owner may answer the other owner's waiting question, named for whom", () => {
  assert.deepEqual(ownerAnswersFor(item(), { waitsOn: ['Ben'] }, ME, OWNERS), ['Ben']);
  // A design flag for Ben, and the dispatcher's question handed to Ben, too.
  assert.deepEqual(ownerAnswersFor(item({ needsYou: undefined, flag: { kind: 'design', text: 'Per output?', at: AT, for: [BEN] } }), { waitsOn: ['Ben'] }, ME, OWNERS), ['Ben']);
});

test('w4238: never for a member, a non-owner, an approval, a question on oneself, an answered wait, or a wait on a non-owner', () => {
  const no = (w: WorkItem, waitsOn: string[] = ['Ben'], me = ME, owners = OWNERS) => assert.equal(ownerAnswersFor(w, { waitsOn }, me, owners), undefined);
  no(item(), ['Ben'], { userId: 'lothsahn', role: 'member' });
  no(item(), ['Ben'], { userId: 'anna', role: 'owner' }, OWNERS);
  no(item(), ['Ben'], ME, []);
  no(item({ approval: { state: 'pending', why: 'auto-approve is off' } }));
  no(item({ requesters: [BEN, ANNA] }));
  no(item({ requestedBy: ANNA, requesters: [ANNA] }), ['Anna']);
  no(item({ needsYou: { ...needsYou, who: ['Lothsahn'], to: ['lothsahn'] } }), ['Lothsahn']);
  no(item(), ['Ben', 'the reporter']);
  no(item(), ['Lothsahn']);
  no(item({ needsYou: { ...needsYou, answered: { by: 'Ben', at: AT } } }));
  no(item({ status: 'done' }));
});

test("w4238: the message carries the answer, for whom, and which questions stay with that owner", () => {
  const w = item();
  const all = ownerAnswerMessage(w, answersText(asks, ['Compact', 'Yes']), ['Ben']);
  assert.match(all, /^Answer on w4196 \(Station card\)\. It asked: “Which Station card layout\? \/ Show the power bar\?”/);
  assert.match(all, /1\. Which Station card layout\?\n   Compact\n2\. Show the power bar\?\n   Yes/);
  assert.match(all, /This is Ben's question; I answer it for Ben as an owner \(w3606\), from the Waiting on input tab\. Please put this on w4196 as my answer \(update_work note\)\.$/);
  assert.equal((all.match(/Please put this on/g) ?? []).length, 1);
  // Answered in part: only the answered questions are listed, the rest are left to Ben.
  const part = ownerAnswerMessage(w, answersText(asks, ['Compact']), ['Ben'], [2]);
  assert.match(part, /1\. Which Station card layout\?\n   Compact\n\n/);
  assert.doesNotMatch(part, /Show the power bar\?\n/);
  assert.match(part, /I leave question 2 to Ben: quote my answers as written, so those stay open for Ben\./);
  // The owner's own answer is unchanged.
  assert.match(answerMessage(w, 'Compact'), /\n\nCompact\n\nPlease put this on w4196 as my answer \(update_work note\)\.$/);
});
