// The "Waiting on input" queue (w1228, shared/waiting.ts): whose move each waiting request is, the order, the age, the
// recommendation, and the cheap count the sidebar and the phone's bell use.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkItem } from '../shared/types.ts';
import { decisionsOn, decisionsOnMe, groupByPerson, intakeRecommendation, waitAge, waitingItems, waitOnLabel } from '../shared/waiting.ts';
import type { WorkLive } from '../shared/workState.ts';

const BEN = { userId: 'ben', displayName: 'Ben' };
const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };
const NOW = Date.parse('2026-10-13T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function item(id: string, o: Partial<WorkItem> = {}): WorkItem {
  return { id, title: id, brief: 'b', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'new', createdAt: ago(1), updatedAt: ago(0), sessionIds: [], overlaps: [], asks: 0, log: [], ...o };
}
const pending = (id: string, days: number, o: Partial<WorkItem> = {}) => item(id, { createdAt: ago(days), approval: { state: 'pending', why: 'auto-approve is off' }, triage: { class: 'needs-human', reason: 'no clear defect' }, ...o });
const waiting = (why = 'x', waitsOn?: string[]): WorkLive => ({ state: 'waiting', why, ...(waitsOn ? { waitsOn } : {}) });

test('a reviewer\'s approvals and their own question are theirs, oldest first; another person\'s design question is not', () => {
  const work = [
    pending('w2', 2),
    pending('w1', 10),
    item('w3', { status: 'question', question: { text: 'Which?', at: ago(1) } }),
    item('w4', { status: 'question', requestedBy: LOTH, requesters: [LOTH], flag: { kind: 'design', text: 'Per output?', at: ago(3), for: [LOTH] } }),
  ];
  const live = new Map(work.map((w) => [w.id, waiting()]));
  const items = waitingItems(work, live, { ...BEN, reviewer: true });
  assert.deepEqual(items.map((i) => [i.w.id, i.mine, i.ask]), [['w1', true, 'approve'], ['w2', true, 'approve'], ['w3', true, 'answer'], ['w4', false, 'answer']]);
  // A non-reviewer waits on the reviewers for an approval.
  assert.deepEqual(waitingItems([pending('w1', 1)], new Map([['w1', waiting()]]), { ...BEN, reviewer: false }).map((i) => i.mine), [false]);
});

test('only requests whose live state is waiting are listed; a declared wait names who', () => {
  const w = item('w5');
  assert.deepEqual(waitingItems([w], new Map([['w5', { state: 'working', why: 'x' }]]), { ...BEN, reviewer: false }), []);
  const [mineItem] = waitingItems([w], new Map([['w5', waiting('w5 waits on Ben: log in', ['Ben'])]]), { ...BEN, reviewer: false });
  assert.deepEqual([mineItem.mine, mineItem.ask, mineItem.on], [true, 'check', ['Ben']]);
  const [other] = waitingItems([w], new Map([['w5', waiting('waits on Lothsahn', ['Lothsahn'])]]), { ...BEN, reviewer: false });
  assert.equal(other.mine, false);
});

test('a recommendation only where triage gives one: a possible repeat first, else the class; a needs-human is the person\'s call', () => {
  assert.equal(intakeRecommendation(pending('w1', 1)), undefined);
  assert.match(intakeRecommendation(pending('w1', 1, { triage: { class: 'obvious-bug', reason: 'a crash on 0.50.0.46' } }))!, /^Approve \(an obvious bug\): a crash on 0\.50\.0\.46$/);
  assert.match(intakeRecommendation(pending('w1', 1, { overlaps: [{ ref: 'w9', title: 'Same', why: 'same title' }] as WorkItem['overlaps'] }))!, /^Check first: it may repeat w9/);
});

test('decisionsOnMe counts the approvals of a reviewer, their question and their design questions, with the oldest date', () => {
  const work = [pending('w1', 4), pending('w2', 1), item('w3', { status: 'question', question: { text: 'q', at: ago(2) } }), item('w4', { flag: { kind: 'design', text: 'd', at: ago(9), for: [LOTH] } })];
  assert.deepEqual(decisionsOnMe(work, { ...BEN, reviewer: true }), { count: 3, since: ago(4) });
  assert.deepEqual(decisionsOnMe(work, { ...BEN, reviewer: false }), { count: 1, since: ago(2) });
  assert.deepEqual(decisionsOnMe(work, { ...LOTH, reviewer: false }), { count: 1, since: ago(9) });
});

test('a wait is old after a day and stale after three', () => {
  assert.deepEqual([ago(0.5), ago(2), ago(4)].map((s) => waitAge(s, NOW)), ['fresh', 'old', 'stale']);
});

test('a decision the sidebar counts is in the tab even while a worker is mid-turn on its request (w1356)', () => {
  // workLive says Working first when a worker is mid-turn, so the old tab (waiting only) dropped these: the Needs you item
  // opened a page where its question was nowhere to be found.
  const work = [pending('w1', 3), item('w2', { status: 'question', question: { text: 'Which?', at: ago(2) } }), item('w3', { flag: { kind: 'design', text: 'd', at: ago(1), for: [BEN] } }), item('w4')];
  const live = new Map<string, WorkLive>(work.map((w) => [w.id, { state: 'working', why: 'w9 mid-turn' }]));
  const me = { ...BEN, reviewer: true };
  assert.deepEqual(waitingItems(work, live, me).map((i) => [i.w.id, i.mine, i.ask]), [['w1', true, 'approve'], ['w2', true, 'answer'], ['w3', true, 'answer']]);
  // Every decision the count finds is a card, and the list says what each asks.
  const ids = decisionsOn(work, me).map((d) => d.w.id);
  assert.deepEqual(ids, ['w1', 'w2', 'w3']);
  assert.deepEqual(waitingItems(work, live, me).map((i) => i.w.id), ids);
  assert.deepEqual(decisionsOn(work, me).map((d) => d.text), ['Approve or decline w1', 'Answer w2: Which?', 'Answer w3: d']);
  // A closed request has no live state and stays out.
  assert.deepEqual(waitingItems(work, new Map(), me), []);
});

test('a request filed by one person and waiting on another is listed under the person it waits on (w1559)', () => {
  // w1544: lothsahn's request, its worker called waiting_on_person with who "Ben".
  const w = item('w1544', { requestedBy: LOTH, requesters: [LOTH] });
  const other = item('w1600', { requestedBy: LOTH, requesters: [LOTH] });
  const live = new Map([
    ['w1544', waiting('a3b0bf2c waits on Ben: review PR #1969', ['Ben'])],
    ['w1600', waiting('a1 waits on Lothsahn: log in', ['Lothsahn'])],
  ]);
  const asLoth = waitingItems([w, other], live, { ...LOTH, reviewer: false });
  const [forBen] = asLoth.filter((i) => i.w.id === 'w1544');
  assert.deepEqual([forBen.mine, forBen.on, forBen.requesters], [false, ['Ben'], ['Lothsahn']]);
  assert.equal(waitOnLabel(forBen), 'Ben');
  // The panel's groups carry the waited-on person, not the requester.
  assert.deepEqual(groupByPerson(asLoth.filter((i) => !i.mine)).map((g) => [g.who, g.items.map((i) => i.w.id)]), [['Ben', ['w1544']]]);
  // Ben sees it as his own move, with lothsahn kept as the requester.
  const [asBen] = waitingItems([w], live, { ...BEN, reviewer: false });
  assert.deepEqual([asBen.mine, asBen.requesters], [true, ['Lothsahn']]);
  // Several people, and none named: grouped in order of first appearance.
  const many = [
    { ...forBen, w: { ...forBen.w, id: 'a' }, on: ['Ben'] },
    { ...forBen, w: { ...forBen.w, id: 'b' }, on: [] },
    { ...forBen, w: { ...forBen.w, id: 'c' }, on: ['ben'] },
  ];
  assert.deepEqual(groupByPerson(many).map((g) => [g.who, g.items.map((i) => i.w.id)]), [['Ben', ['a', 'c']], ['someone else', ['b']]]);
});
