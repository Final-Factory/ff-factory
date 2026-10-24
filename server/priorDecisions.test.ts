import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, asksLookOk, contentWords, decidedRefusal, personNotes, possiblyDecided, questionRefs, quoteCovered, quotedPhrases, relatedRequests, type PriorNote } from './priorDecisions.ts';
import type { WorkItem } from '../shared/types.ts';
import { PR2395_DIFF, W1958_0459, W1958_1550, W1958_1632 } from './priorDecisions.fixtures.ts';

const note = (at: string, text: string, on = 'w1958', by = 'ben'): PriorNote => ({ on, at, by, text });

test('w2085: Ben\'s 04:59 note quotes what PR #2395 adds; the 15:50 note (another PR) does not', () => {
  const added = addedLines(PR2395_DIFF);
  assert.ok(!added.includes('+++'), 'file headers are not added text');
  assert.equal(quoteCovered(W1958_0459, added), 'Right-click dismisses for a while; shift+right-click silences for good.');
  assert.equal(quoteCovered(W1958_1550, added), undefined);
  // The PR's docs line words it its own way ("Shift + right click silences that asteroid for good"): words, not the string.
  const docsOnly = added.split('\n').filter((l) => !/Ben:|Ben, Discord/.test(l)).join('\n');
  assert.ok(quoteCovered(W1958_0459, docsOnly), 'covered without the lines that quote Ben');
});

test('w2085: quotes of fewer than four content words decide nothing; stop words are not content', () => {
  assert.deepEqual(quotedPhrases('Ben: "looks great". And "Use L, and a long press of D-pad up on a pad".'), ['Use L, and a long press of D-pad up on a pad']);
  assert.deepEqual(contentWords('Can it merge as it looks?'), []);
  assert.equal(quoteCovered('"looks great"', 'it looks great'), undefined);
});

test('w2085: the 16:32 question is possibly decided by the 04:59 note ("low-ore"), not by the 15:50 one', () => {
  const refs = questionRefs([W1958_1632], ['Final-Factory/FinalFactory#2395']);
  const d = possiblyDecided([note('2026-10-24T04:59:00Z', W1958_0459), note('2026-10-24T15:50:00Z', W1958_1550)], refs);
  assert.equal(d.length, 1);
  assert.equal(d[0].at, '2026-10-24T04:59:00Z');
  assert.ok(d[0].why.includes('"low-ore"'), d[0].why.join());
  // A PR or a thread the question names counts too.
  assert.deepEqual(possiblyDecided([note('2026-10-24T05:00:00Z', 'Merge PR #2395 when green')], refs)[0].why, ['PR #2395']);
  assert.deepEqual(possiblyDecided([note('2026-10-24T05:00:00Z', 'thread 1251 is a design call')], questionRefs(['the thread 1251 tooltip'], []))[0].why, ['thread 1251']);
});

test('w2085: a look or merge OK is told from a design choice', () => {
  assert.ok(asksLookOk([W1958_1632]));
  assert.ok(asksLookOk(['OK the low-ore tooltip look so #2395 can merge']));
  assert.ok(!asksLookOk(['Pick a direction for marking circuit structures in normal view']));
});

test('w2085: the person\'s notes on the request, the ones it names, the ones that name it and its worker\'s others, newest kept', () => {
  const w = (id: string, extra: Partial<WorkItem> = {}) => ({ id, notes: [], relatedIds: [], ...extra }) as unknown as WorkItem;
  const items = [
    w('w1', { relatedIds: ['w2'], notes: [{ at: '2026-10-24T01:00:00Z', by: 'ben', text: 'one' }, { at: '2026-10-24T02:00:00Z', by: 'lothsahn', text: 'not his' }] }),
    w('w2', { notes: [{ at: '2026-10-24T03:00:00Z', by: 'Ben', text: 'two' }] }),
    w('w3', { relatedIds: ['w1'], notes: [{ at: '2026-10-24T00:30:00Z', by: 'ben', text: 'zero' }] }),
    w('w4', { notes: [{ at: '2026-10-24T04:00:00Z', by: 'ben', text: 'unrelated' }] }),
    w('w5', { notes: [{ at: '2026-10-24T05:00:00Z', by: 'ben', text: 'same worker' }] }),
  ];
  const rel = relatedRequests(items[0], items, [items[4]]);
  assert.deepEqual(rel.map((x) => x.id), ['w1', 'w2', 'w3', 'w5']);
  assert.deepEqual(personNotes(rel, ['Ben']).map((n) => `${n.on}:${n.text}`), ['w3:zero', 'w1:one', 'w2:two', 'w5:same worker']);
});

test('w2085: the refusal shows the note, the quote and the way past it', () => {
  const t = decidedRefusal(note('2026-10-24T04:59:00Z', W1958_0459), 'Right-click dismisses for a while; shift+right-click silences for good.', 'Final-Factory/FinalFactory#2395', 'w1958');
  assert.match(t, /^Not recorded: ben already decided what Final-Factory\/FinalFactory#2395 adds\. Their note at 2026-10-24 04:59 UTC:/);
  assert.match(t, /Low-ore right-click \(thread 1251\)/);
  assert.match(t, /merge it on green/);
  assert.match(t, /decided_override/);
});
