// w2444: a release's patch notes post once the build is live on any Steam branch, and a Steam branch is never a question.
// lothsahn, 2026-10-28, on w2440 (1.0 Build 22): "It's a dev build but you still upload the patch notes. Why did you suddenly
// decide not to update patch notes for development builds. We've done that for ages"; on w2431 (0.50 Build 113): "Add the
// patch notes now. I'll update it later. Close the workitem". Both workers had held the notes behind a branch card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseBranchAskIn, releaseBranchAskProblem } from '../shared/releaseBranchAsk.ts';
import { RELEASE_RULES } from './releaseLanes.ts';

// The two cards that reached lothsahn and Ben on 2026-10-28, as the ledger logged them.
const W2440 = 'Choose a Steam branch for 1.0 Build 22, which is live on development (BuildID 26260109), and move it there on the partner site if you want it on pre-release or default';
const W2431 = 'Set Build 113 (0.50.0.113, the newest upload on the Steam partner site) on pre-release, test it, then set it live on default';

test('w2444: the two branch cards that held the notes are refused, quoting lothsahn', () => {
  for (const what of [W2440, W2431]) {
    const p = releaseBranchAskProblem(what, []);
    assert.ok(p, what);
    assert.match(p, /post them now with post_as_max/);
    assert.match(p, /We've done that for ages/);
    assert.match(p, /Add the patch notes now/);
  }
  // A card whose question asks it, behind a harmless wait line.
  assert.ok(releaseBranchAskProblem('lothsahn to decide', ['Which Steam branch should Build 22 go to?']));
  assert.ok(releaseBranchAskIn('Leave 1.0 Build 22 on development (BuildID 26260109), or move it to pre-release?'));
  assert.ok(releaseBranchAskIn('I post the notes once the build is on default (Steam).'));
});

test('w2444: other questions, git branches and the cards a release may ask still go through', () => {
  for (const t of [
    'Which branch should this fix go to, master or pre-1.0?',
    'Set the new option on by default?',
    'Build now from the last fully green commit abc1234 (B: skips the 3 merges since it) or bump on master\'s tip (A)?',
    'May 1.0.0.0 go live on development now, or wait for your Steam event? (the go-live moment for major new content)',
    'Approve spending $40 on the art pass?',
    'Log in to lothdesktop so the Steam upload can finish',
  ])
    assert.equal(releaseBranchAskIn(t), false, t);
  assert.equal(releaseBranchAskProblem('Ben to approve the trailer', ['Which cut should we publish?']), undefined);
});

test('w2444: read_rules release says live means landed on any branch, the notes post then, and never asks about a branch', () => {
  const r = RELEASE_RULES;
  assert.match(r, /LIVE MEANS LANDED, AND THE NOTES POST THEN \(w2444/);
  assert.match(r, /development included/);
  assert.match(r, /never "once live on default"/);
  assert.match(r, /counts from the landing time/);
  assert.match(r, /never a step of a release, a precondition for its notes, or a question/);
  assert.match(r, /We've done that for ages/);
});
