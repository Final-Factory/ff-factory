import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { alreadySent, needsYouDigestText, needsYouRecord, needsYouText, previewLine, previewsIn, prsIn, reportTail, whoOf, NEEDS_YOU_REPORT_CHARS } from './needsYou.ts';
import type { UserInfo, WorkItem } from '../shared/types.ts';

/** The pure parts of w1378's [needs you] routing: what a question carries, whom it goes to, and that it goes once. */

const PEOPLE: UserInfo[] = [
  { userId: 'ben', displayName: 'Ben', role: 'owner' },
  { userId: 'lothsahn', displayName: 'Lothsahn', role: 'owner' },
];
const w = { id: 'w1360', title: 'Circuits: pills → circuit icon button / back arrow', prs: [{ repo: 'Final-Factory/FinalFactory', number: 1799, state: 'open' as const, turns: 0 }] } as unknown as WorkItem;

// The worker's words as the portal's journal had them on 2026-10-15 (place again: released lothdesktop/slot2 of 14fac04c).
const W1360 = "OK the w1360 circuit button look (white circuit icon on Main, back arrow on the Circuit view; new stills after w1349's status-line fix in /srv/fff/review/w1360-circuit-icon-button/w1360b-*.png) so PR #1799 can merge on green CI";

// Where the review root is not on this computer (a dev machine): what is named is kept as written, files first. The
// portal's own case (folders expanded, files checked on disk) is in reviewMedia.test.ts.
const NOWHERE = path.join(os.tmpdir(), 'no-such-review-root-w1384');

test('previews where the review root is not here: files and folders kept as written, each once', () => {
  assert.deepEqual(previewsIn([W1360], NOWHERE), ['/srv/fff/review/w1360-circuit-icon-button/w1360b-*.png']);
  const report = 'Clips: /srv/fff/review/w1332-comet-catch-tail/before.mp4 and /srv/fff/review/w1332-comet-catch-tail/after.mp4.\nSheet: C:\\work\\w1331\\sheet-1920.png; again /srv/fff/review/w1332-comet-catch-tail/after.mp4';
  assert.deepEqual(previewsIn([report], NOWHERE), [
    '/srv/fff/review/w1332-comet-catch-tail/before.mp4',
    '/srv/fff/review/w1332-comet-catch-tail/after.mp4',
    'C:\\work\\w1331\\sheet-1920.png',
  ]);
  assert.deepEqual(previewsIn(['Watch /srv/fff/review/w1332-comet-catch-tail/ and OK the look'], NOWHERE), ['/srv/fff/review/w1332-comet-catch-tail/']);
  assert.deepEqual(previewsIn([undefined, 'nothing to look at'], NOWHERE), []);
});

test('previews show inline in Markdown when they are one file, as code otherwise', () => {
  assert.equal(previewLine('/srv/fff/review/w1/a.png'), '- ![a.png](</srv/fff/review/w1/a.png>)');
  assert.equal(previewLine('/srv/fff/review/w1/clip.mp4'), '- ![clip.mp4](</srv/fff/review/w1/clip.mp4>)');
  assert.equal(previewLine('/srv/fff/review/w1/w1b-*.png'), '- `/srv/fff/review/w1/w1b-*.png`');
  assert.equal(previewLine('/srv/fff/review/w1/'), '- `/srv/fff/review/w1/`');
});

test('pull requests: owner/repo#n, links, PR #n with the request’s repo, and its open ones', () => {
  assert.deepEqual(prsIn([W1360], w), ['Final-Factory/FinalFactory#1799']);
  assert.deepEqual(prsIn(['See https://github.com/Final-Factory/ff-factory/pull/401 and Final-Factory/FinalFactory#1735; also #1744'], { prs: [] }), [
    'Final-Factory/ff-factory#401',
    'Final-Factory/FinalFactory#1735',
    '#1744',
  ]);
  // Not a PR: an issue-like small number or a colour.
  assert.deepEqual(prsIn(['step #2 and colour #ffb020'], { prs: [] }), []);
  // The request's own open PR is listed even when the text names none; a merged one is not.
  assert.deepEqual(prsIn(['OK the look'], { prs: [...w.prs!, { repo: 'Final-Factory/FinalFactory', number: 1700, state: 'merged', turns: 0 } as never] }), ['Final-Factory/FinalFactory#1799']);
});

test('who: the people a wait names among those FF Factory knows, else the fallback', () => {
  const fallback = [{ userId: 'ben', displayName: 'Ben' }];
  assert.deepEqual(whoOf(['Ben'], PEOPLE, []), [{ userId: 'ben', displayName: 'Ben' }]);
  assert.deepEqual(whoOf(['Ben (or his orchestrator)'], PEOPLE, []), [{ userId: 'ben', displayName: 'Ben' }]);
  assert.deepEqual(whoOf(['Ben, Lothsahn'], PEOPLE, []).map((r) => r.userId), ['ben', 'lothsahn']);
  assert.deepEqual(whoOf(['a person'], PEOPLE, fallback), fallback);
  // A name inside another word is not that person.
  assert.deepEqual(whoOf(['Benjamin'], PEOPLE, []), []);
});

test('the record: question in full, the report’s end, files and PRs; equal keys are one question', () => {
  const report = `${'x'.repeat(5000)}\nw1360: still open: waiting on Ben to OK the look`;
  const r = needsYouRecord(w, { kind: 'declared', key: 'declared:14fac04c:2026-10-15T16:14:15Z', question: W1360, names: ['Ben'], worker: '14fac04c', report }, [{ userId: 'ben', displayName: 'Ben' }], '2026-10-15T16:14:20Z');
  assert.equal(r.question, W1360);
  assert.equal(r.report!.length, NEEDS_YOU_REPORT_CHARS);
  assert.match(r.report!, /still open: waiting on Ben to OK the look$/);
  assert.deepEqual(r.previews, ['/srv/fff/review/w1360-circuit-icon-button/w1360b-*.png']);
  assert.deepEqual(r.prs, ['Final-Factory/FinalFactory#1799']);
  assert.deepEqual({ who: r.who, to: r.to, worker: r.worker }, { who: ['Ben'], to: ['ben'], worker: '14fac04c' });
  assert.equal(alreadySent({ needsYou: r }, r.key), true);
  assert.equal(alreadySent({ needsYou: r }, 'declared:14fac04c:2026-10-15T17:00:00Z'), false);
  assert.equal(alreadySent({}, r.key), false);
  assert.equal(reportTail('short'), 'short');
});

test('the message: tagged, the question in full with files and PRs, and how to answer', () => {
  const r = needsYouRecord(w, { kind: 'declared', key: 'k', question: W1360, names: ['Ben'], worker: '14fac04c', report: 'Stills published.\nw1360: still open: waiting on Ben to OK the look' }, [{ userId: 'ben', displayName: 'Ben' }], '2026-10-15T16:14:20Z');
  const text = needsYouText(w, r, 'Ben');
  assert.match(text, /^\[needs you\] w1360 "Circuits: pills → circuit icon button \/ back arrow"\n/);
  assert.ok(text.includes(W1360), 'the question in full');
  assert.match(text, /Question \(its worker 14fac04c stopped and waits on Ben\):/);
  assert.match(text, /Look at:\n\n- `\/srv\/fff\/review\/w1360-circuit-icon-button\/w1360b-\*\.png`/);
  assert.match(text, /Pull requests: Final-Factory\/FinalFactory#1799/);
  assert.match(text, /The end of its last report:\n\nStills published\./);
  assert.match(text, /record it with update_work on w1360, their answer as the note: FF Factory resumes worker 14fac04c with their words/);
  assert.match(text, /Never answer it for them/);
  // A dispatcher question with no worker: the dispatcher carries on.
  const q = needsYouRecord(w, { kind: 'question', key: 'q', question: 'Single-player or co-op?', names: ['Ben'] }, [{ userId: 'ben', displayName: 'Ben' }], '2026-10-15T16:14:20Z');
  assert.match(needsYouText(w, q, 'Ben'), /Question \(the dispatcher asks Ben\):\n\nSingle-player or co-op\?[\s\S]*the question clears and the dispatcher carries on/);
});

test('the digest: one message with every question, each with its files and PRs', () => {
  const a = needsYouRecord(w, { kind: 'declared', key: 'a', question: W1360, names: ['Ben'], worker: '14fac04c' }, [{ userId: 'ben', displayName: 'Ben' }], 't', { digest: true });
  const w2 = { id: 'w1346', title: 'Comet-hit explosion plays the instant the hit lands', prs: [] } as unknown as WorkItem;
  const b = needsYouRecord(w2, { kind: 'declared', key: 'b', question: 'Say which delay you saw when a comet hits: (1) your own ship vanishes, (2) explosions come a beat after, or (3) they look small at first.', names: ['Ben'], worker: '0855daf2' }, [{ userId: 'ben', displayName: 'Ben' }], 't', { digest: true });
  const text = needsYouDigestText([{ w, r: a }, { w: w2, r: b }], 'Ben');
  assert.match(text, /^\[needs you\] digest: 2 requests wait on Ben's input, sent once/);
  assert.match(text, /w1360 "Circuits[\s\S]*Final-Factory\/FinalFactory#1799[\s\S]*\(worker 14fac04c resumes with the answer\)/);
  assert.match(text, /w1346 "Comet-hit[\s\S]*\(1\) your own ship vanishes[\s\S]*\(worker 0855daf2 resumes with the answer\)/);
  assert.match(text, /record it with update_work on that request, their answer as the note/);
});
