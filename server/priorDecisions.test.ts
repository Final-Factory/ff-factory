import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, asksLookOk, contentWords, decidedRefusal, noteSentences, notesSettle, personNotes, possiblyDecided, questionRefs, quoteCovered, quotedPhrases, relatedRequests, settledRefusal, stem, type PriorNote } from './priorDecisions.ts';
import type { WorkItem } from '../shared/types.ts';
import { PR2395_DIFF, W1958_0459, W1958_1550, W1958_1632, W2651_0457, W2651_2051 } from './priorDecisions.fixtures.ts';

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

// ---------------------------------------------------------------- w2756: the person's own notes settle a new question

test('w2756: the replay of w2651 at 04:57: Ben\'s 20:51 note settles the merge-behind-the-toggle and the Crafting questions', () => {
  const s = notesSettle(W2651_0457, [note('2026-10-31T20:51:00Z', W2651_2051, 'w2651')]);
  assert.deepEqual(s.map((x) => x.ask), [0, 2], 'questions 1 and 3');
  assert.match(s[0].sentence, /^move the hover card to the left of the rail/);
  assert.deepEqual(s[0].shared, ['hover', 'card', 'rail']);
  assert.deepEqual(s[1].shared, ['craft', 'stop', 'station', 'info']);
  // Question 2 (the Deck rail's width): the note says nothing of width; Ben's goal of the whole inventory in view is in the
  // brief, not in his note. Left to the asker, who now reads the note beside the other two.
  assert.ok(!s.some((x) => x.ask === 1));
  const t = settledRefusal(s, 'waiting_on_person', 'w2651');
  assert.match(t, /^Not recorded: ben's own notes on w2651 may already settle 2 of these questions \(w2756/);
  assert.match(t, /- Question 3 \("At 1280x800 at UI scale 0\.9 Crafting stops above Station Info.*"\): ben's note at 2026-10-31 20:51 UTC says "move the hover card .* make Crafting stop above Station Info instead of hiding it\."/);
  assert.ok(!/pair-1-craft/.test(t), 'stills left out of the quoted question');
  assert.match(t, /decided_override/);
  assert.match(settledRefusal(s, 'ask_person', 'w2651'), /^Not asked: .*notes_leave_open/s);
});

test('w2756: a new question on the same request, another person\'s note or another request\'s decisions settle nothing', () => {
  const ben = [note('2026-10-31T20:51:00Z', W2651_2051, 'w2651')];
  const fresh = [
    { question: 'The rail covers the minimap at 1280x800: move the minimap above the rail, or shrink the rail?', options: [{ label: 'Move the minimap above the rail', recommended: true }] },
    { question: "Which colour should the rail's frame use: the HUD blue or the panel grey?", options: [{ label: 'The HUD blue', recommended: true }] },
  ];
  assert.deepEqual(notesSettle(fresh, ben), []);
  // w2085's own cases stay as they were: its diff check, not this one, holds the low-ore look OK.
  const w1958 = [note('2026-10-24T04:59:00Z', W1958_0459), note('2026-10-24T15:50:00Z', W1958_1550)];
  assert.deepEqual(notesSettle([{ question: 'Can the low-ore alert tooltip merge as it looks?', options: [{ label: 'Yes, merge it as it looks', recommended: true }] }], w1958), []);
  assert.deepEqual(notesSettle([{ question: 'Pick the arrow style for the low-ore alert pointer', options: [{ label: 'Go with A, the arrow', recommended: true }] }], w1958), []);
  assert.deepEqual(notesSettle(W2651_0457, []), []);
});

test('w2756: stems and sentences', () => {
  assert.deepEqual(['stops', 'stopping', 'stop', 'columns', 'crafting', 'scrolls', 'scrolling', 'boxes', 'glass'].map(stem), ['stop', 'stop', 'stop', 'column', 'craft', 'scroll', 'scroll', 'box', 'glass']);
  assert.deepEqual(noteSentences('Ben\'s answer, his words: "Build D, the right rail: a column on the right that never moves." Build D for real.'), [
    "Ben's answer, his words:",
    'Build D, the right rail:',
    'a column on the right that never moves.',
    'Build D for real.',
  ]);
});
