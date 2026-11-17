// w4634 (lothsahn: "the dispatcher can never close a request as done with placeholder or empty text, or when no worker ever
// reported on it"). On 2026-11-17 at 22:21Z the dispatcher wanted only to clear w4592's timed flag (the urgent 1.0.0.50
// release, unblocked a minute before); decide_work took timed only beside an action, so it called
// {"id":"w4592","action":"done","timed":false,"note":"placeholder"} and closed the release no worker had run on. It had
// done the same to set the report flag on w4611, w4229, w3733 and w2621. doneNoteProblem is the check decide() runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneNoteProblem } from './work.ts';

test('w4634: an empty or placeholder note never closes a request as done, worked on or not', () => {
  for (const note of ['placeholder', 'Placeholder.', 'TODO', 'x', '...', 'ok', 'done', 'merged', 'n/a', 'see above', 'placeholder note for the flag']) {
    for (const reported of [true, false]) assert.match(doneNoteProblem('w4592', note, reported) ?? '', /refused \(w4634\)/, `${JSON.stringify(note)} reported=${reported}`);
  }
  // The refusal says how to change only a flag.
  assert.match(doneNoteProblem('w4592', 'placeholder', false)!, /no action/);
});

test('w4634: a worked request closes on a plain sentence; an unworked one only with a reason', () => {
  assert.equal(doneNoteProblem('w2', 'its PR merged on green CI', true), undefined);
  // Unworked: no reason given.
  assert.match(doneNoteProblem('w4592', 'the release is finished now', false) ?? '', /no worker ever reported on w4592/);
  // Its own id is no reason.
  assert.match(doneNoteProblem('w4592', 'w4592 is finished now, closing it', false) ?? '', /no worker ever reported on w4592/);
  // A repeat names what it repeats; a PR that did it; nothing needed and why.
  assert.equal(doneNoteProblem('w2051', 'repeats w1936, which passed', false), undefined);
  assert.equal(doneNoteProblem('w9', 'already done by PR #3850 on master', false), undefined);
  assert.equal(doneNoteProblem('w9', 'no work is needed: Ben withdrew the ask in chat', false), undefined);
  assert.match(doneNoteProblem('w9', 'not needed anymore', false) ?? '', /no worker ever reported/, 'a reason in under 6 words is no reason');
});
