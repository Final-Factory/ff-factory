import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerMessage, answersText, cardMedia, cardQuestions, checkAsks, legacySteps, MAX_ASKS, namesForPaths, plainQuestion } from '../shared/questionCard.ts';
import type { WorkItem, WorkNeedsYou } from '../shared/types.ts';

// w1597, Ben: "just ask the question clearly, give me the option selections and thats it".

const two = [{ label: 'Put it in', description: '', recommended: true }, { label: 'Leave it out', description: '' }];

test('checkAsks: one plain question per decision with 2 to 4 answers, the recommended one first', () => {
  const ok = checkAsks([{ question: 'Should the vision speed-up go in?', options: [{ label: 'Leave it out' }, { label: 'Put it in', description: 'Already live on development.', recommended: true }] }]);
  assert.ok('asks' in ok);
  assert.deepEqual(ok.asks[0].options.map((o) => o.label), ['Put it in', 'Leave it out']);
  assert.equal(ok.asks[0].options[1].description, '', 'a missing description is empty');
  assert.match((checkAsks([]) as { problem: string }).problem, /at least one question/);
  assert.match((checkAsks(undefined) as { problem: string }).problem, /at least one question/);
  assert.match((checkAsks(Array.from({ length: MAX_ASKS + 1 }, () => ({ question: 'Go?', options: two }))) as { problem: string }).problem, /at most 6/);
  assert.match((checkAsks([{ question: 'Go?', options: [{ label: 'Yes' }] }]) as { problem: string }).problem, /options: 2 to 4/);
  assert.match((checkAsks([{ question: 'x'.repeat(301), options: two }]) as { problem: string }).problem, /at most 300 characters/);
  assert.match((checkAsks([{ question: 'Go?', options: two }, { question: 'And?', options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }]) as { problem: string }).problem, /^question 2: mark ONE option recommended/);
});

test('checkAsks: no file paths, pull request lists or worker ids in a question or an answer; a still goes in as media', () => {
  const problem = (question: string, options: unknown[] = two) => (checkAsks([{ question, options }]) as { problem?: string }).problem;
  assert.match(problem('Decide from /srv/fff/review/w1588/REPORT.md: go-live?')!, /no file paths/);
  assert.match(problem('Include the knn chain (#1873, #1880, #1909)?')!, /no lists of pull requests/);
  assert.match(problem('Did worker dafd0fe0 get it right?')!, /no worker or session ids/);
  assert.match(problem('Go live?', [{ label: 'Yes, with #1873 and #1909' }, { label: 'No' }])!, /question, answer 1: no lists of pull requests/);
  assert.equal(problem('Merge #1924 now?'), undefined, 'one pull request named is fine');
  assert.equal(problem('Which shield look? ![look A](</srv/fff/review/w1475/a.png>)'), undefined, 'a still as media is fine');
});

test("plainQuestion: a free-text question cleaned for the card: no paths, no PR brackets, no worker ids (w1588's real words)", () => {
  const w1588 =
    "Decide from /srv/fff/review/w1588/REPORT.md: the go-live moment for 0.50.0.111 on default (Steam event?), the knn vision speed-up chain (#1873–#1909, #1997 optional), the transform chain, #1917's upgrade step version, the Ancient Portal burst regression, and #1919 / #1969+#1996.";
  const q = plainQuestion(w1588);
  assert.doesNotMatch(q, /\/srv|REPORT\.md|#1873|#1997/);
  assert.match(q, /^Decide the go-live moment for 0\.50\.0\.111 on default \(Steam event\?\), the knn vision speed-up chain, the transform chain/);
  assert.equal(plainQuestion('Ask worker dafd0fe0 about ![a](</srv/x/a.png>) it'), 'Ask its worker about it');
});

test('namesForPaths: paths in Details are file names; a Markdown still keeps its target', () => {
  assert.equal(namesForPaths('See /srv/fff/review/w1588/REPORT.md: the list'), 'See `REPORT.md`: the list');
  assert.equal(namesForPaths('![main](</srv/fff/review/w1/main.png>) and `C:\\work\\b.png`.'), '![main](</srv/fff/review/w1/main.png>) and `b.png`.');
  // A folder is its last name, a <placeholder> in it is not one (w1588's brief: "a short report in /srv/fff/review/<request id>/").
  assert.equal(namesForPaths('a short report in /srv/fff/review/<request id>/ and in your message'), 'a short report in `review/` and in your message');
});

test('cardQuestions: the questions given, else the worker’s own words cleaned (the dispatcher’s restatement is Details)', () => {
  const asks = [{ question: 'Go live now?', options: two }];
  const r = (extra: Partial<WorkNeedsYou> = {}): WorkNeedsYou => ({ key: 'k', kind: 'declared', question: 'Decide from /srv/x/REPORT.md: A, B and C', who: ['Ben'], to: ['ben'], at: '', worker: 'abcd1234', previews: [], prs: [], ...extra });
  assert.deepEqual(cardQuestions({ needsYou: r({ asks }) }).asks, asks);
  assert.deepEqual(cardQuestions({ needsYou: r(), question: { text: 'Waiting on Ben: his 6 decisions', at: '' } }), { asks: [], text: 'Decide A, B and C', worker: 'abcd1234' });
  assert.deepEqual(cardQuestions({ question: { text: 'Keep it?', at: '', asks } }).asks, asks, "the dispatcher's own questions");
  assert.equal(cardQuestions({ flag: { kind: 'design', text: 'Per output or per splitter?', at: '', for: [] } }).text, 'Per output or per splitter?');
  assert.equal(cardQuestions({ needsYou: r({ asks, answered: { by: 'Ben', at: '' } }), question: { text: 'Next one?', at: '' } }).text, 'Next one?', 'an answered wait asks nothing');
});

test('a click and typed words send the same message to the orchestrator (the update_work note path)', () => {
  const w = { id: 'w9', title: 'Pre-1.0 picks', needsYou: undefined, question: { text: 'Keep the old order?', at: '' }, flag: undefined } as Pick<WorkItem, 'id' | 'title' | 'question' | 'flag' | 'needsYou'>;
  const asks = [{ question: 'Keep the old order?', options: [{ label: 'Keep the old order', description: '' }, { label: 'Newest save first', description: '' }] }];
  // One question: the label clicked is the answer's words, as if typed.
  assert.equal(answerMessage(w, answersText(asks, ['Keep the old order'])), answerMessage(w, 'Keep the old order'));
  assert.equal(answerMessage(w, 'Keep it'), 'Answer on w9 (Pre-1.0 picks). It asked: “Keep the old order?”\n\nKeep it\n\nPlease put this on w9 as my answer (update_work note).');
  // Several: each question with its answer, numbered, in one message.
  const six = [asks[0], { question: 'Go live now? ![s](</srv/a.png>)', options: asks[0].options }];
  assert.equal(answersText(six, ['Keep the old order', 'Not yet']), '1. Keep the old order?\n   Keep the old order\n2. Go live now?\n   Not yet');
});

test('cardMedia: the question’s own stills first, then the review files a wait names; images and clips only', () => {
  const ask = { question: 'Which? ![look A](</srv/r/a.png>)', options: [] };
  assert.deepEqual(cardMedia(ask, ['/srv/r/b.mp4', '/srv/r/REPORT.md', '/srv/r/*.png', '/srv/r/a.png']), [
    { url: '/srv/r/a.png', alt: 'look A' },
    { url: '/srv/r/b.mp4', alt: 'b.mp4' },
  ]);
});

test('legacySteps: a free-text list of decisions is asked one decision at a time, each answered in words', () => {
  const steps = legacySteps(plainQuestion("Decide from /srv/fff/review/w1588/REPORT.md: the go-live moment for 0.50.0.111 on default (Steam event?), the knn vision speed-up chain (#1873–#1909, #1997 optional), the transform chain, #1917's upgrade step version, the Ancient Portal burst regression, and #1919 / #1969+#1996."));
  assert.deepEqual(steps?.map((a) => a.question), [
    'Decide: the go-live moment for 0.50.0.111 on default (Steam event?)',
    'Decide: the knn vision speed-up chain',
    'Decide: the transform chain',
    "Decide: #1917's upgrade step version",
    'Decide: the Ancient Portal burst regression',
    'Decide: #1919 / #1969+#1996',
  ]);
  assert.ok(steps!.every((a) => a.options.length === 0));
  assert.equal(legacySteps('Should the save menu keep its old order, or show the newest first?'), undefined, 'a question that is no list stays one');
});
