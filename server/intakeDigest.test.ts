import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveAction, approveQuestion, declineAction, digestFromFfbox, digestMissing, digestFromPlayer, digestOfConversation, digestRows, digestText, testsIn } from '../shared/intakeDigest.ts';
import { approveAsk } from '../shared/waitSummary.ts';
import type { ProviderConversationView, WorkItem, WorkSource } from '../shared/types.ts';
import { readWork } from './workRead.ts';
import { diagnosisSource } from './diagnosisRules.ts';

/**
 * w3602 (lothsahn, 2026-11-08, on w3596's card: "I don't know what this means, what I'm approving, or anything... What am
 * I approving?"): an intake request carries a plain summary of FFBox's own write-up, and its Approve and Decline say what
 * each sets in motion for it.
 */

// FFBox's turn summary for w3596 (conversation 1325), cut to the parts the digest reads; its headings and bold leads as FFBox wrote them.
const W3596_SUMMARY = [
  '# hang 20261025T073811Z-hang-25862e0e5a',
  '',
  'root cause: the game rebuilt the swapchain for nothing at launch. On this Linux machine (Vulkan on RADV, Steam overlay loaded), the next frame\'s present then blocked forever inside the Steam overlay\'s present hook, so the game froze on its first frames.',
  'hang signature: libc.so.6!syscall / UnityPlayer.so!GfxDeviceClient::WaitForPendingPresent',
  '',
  '**What the report shows**',
  '',
  '- **Main thread:** blocked (cpu 0 ms, in futex) in `GfxDeviceClient::WaitForPendingPresent`.',
  '',
  '**What I can\'t prove here.** This container has no Steam overlay, so I couldn\'t reproduce the freeze. The evidence is that presents worked on the first swapchain and hung on the first present after the second, in both sessions. The game\'s other action that frame, `vSyncCount = 3`, I left alone.',
  '',
  '**What I changed** (two commits):',
  '- **Fix:** `Apply` now skips `Screen.SetResolution` when the window already is what it would ask for: same width, height and mode. A new pure function, `DisplaySettingsController.ScreenAlreadyMatches`, makes that decision.',
  '  - On LinuxPlayer, a requested ExclusiveFullScreen counts as matching a reported FullScreenWindow.',
  '- **Tests:** `Tests.UI.DisplayLaunchApplyTests`.',
  '',
  '**Verification:**',
  '- `ffverify --filter \'\\.DisplayLaunchApplyTests\\.\'`: 10/10 passed.',
  '- Full EditMode suite (`ffverify`): compiled, 16351/16361 passed, 0 failed.',
].join('\n');

const BRANCH = 'ffbox/linux-launch-skip-redundant-setresolution-d1325t1-0c4a9e21';
const AT = '2026-11-08T12:00:00.000Z';

test('w3602: FFBox’s write-up cut to what the player hit, the cause, the fix, the tests and what nobody checked', () => {
  const d = digestFromFfbox(W3596_SUMMARY, AT, { hit: 'a freeze (hang) on LinuxPlayer, game 1.0.0.16' })!;
  assert.equal(d.by, 'FFBox');
  assert.match(d.cause!, /^the game rebuilt the swapchain for nothing at launch\. On this Linux machine, .* so the game froze on its first frames\.$/);
  assert.match(d.fix!, /^Apply now skips Screen\.SetResolution when the window already is what it would ask for/);
  assert.doesNotMatch(d.fix!, /\*\*|`/, 'markdown out');
  assert.match(d.unverified!, /^This container has no Steam overlay, so I couldn't reproduce the freeze\./);
  // The whole suite's run, not the 10 targeted tests.
  assert.deepEqual(d.tests, { passed: 16351, run: 16361, failed: 0, compiled: true });
  assert.equal(d.text, undefined, 'no fallback when the parts were found');
  assert.deepEqual(digestRows(d).map((r) => r.label), ['The player hit', 'Cause', 'The fix', 'Tests', 'Not checked', 'Risk']);
  // The top of the card in plainer words: the bracketed aside and the sentence that only names code are out.
  assert.doesNotMatch(d.cause!, /RADV|\(/);
  assert.doesNotMatch(d.fix!, /ScreenAlreadyMatches/);
  assert.equal(digestRows(d).at(-1)!.text, 'FFBox named none. From the facts: whether the fix ends what the player hit is unchecked (above).');
  assert.match(digestText(d), /^FFBox’s summary \(a model’s words: check them against the code\):\n- The player hit: a freeze \(hang\) on LinuxPlayer, game 1\.0\.0\.16\n- Cause: /);
});

test('w3602: the run’s own verification wins over the numbers in the words', () => {
  const d = digestFromFfbox(W3596_SUMMARY, AT, { verification: { ran: true, compiled: true, testsRun: 16361, testsPassed: 16349, testsFailed: 2 } })!;
  assert.deepEqual(d.tests, { passed: 16349, run: 16361, failed: 2, compiled: true });
  assert.equal(digestRows(d).find((r) => r.label === 'Tests')!.text, 'compiled; 16349 of 16361 tests passed, 2 failed, 10 skipped');
  assert.equal(digestRows(d).find((r) => r.label === 'Risk')!.text, 'FFBox named none. From the facts: 2 tests fail on its branch; whether the fix ends what the player hit is unchecked (above).');
  // FFBox's own risk words win.
  assert.equal(digestFromFfbox(`${W3596_SUMMARY}

**Risk:** a resolution change the player asked for could be skipped.`, AT)!.risk, 'a resolution change the player asked for could be skipped.');
});

test('w3602: tests in words', () => {
  assert.deepEqual(testsIn('10/10 passed. Then the suite: 1,200 of 1,210 tests passed, 3 failed'), { passed: 1200, run: 1210, failed: 3 });
  assert.deepEqual(testsIn('8/10 passed'), { passed: 8, run: 10, failed: 2 });
  assert.equal(testsIn('no tests ran'), undefined);
  assert.equal(testsIn('it did not compile, 5/6 passed')!.compiled, undefined);
});

test('w3602: a write-up with no cause or fix falls back to its first sentences; an empty one has no digest', () => {
  const d = digestFromFfbox('I looked at the save. It loads fine here. More later.', AT)!;
  assert.equal(d.text, 'I looked at the save. It loads fine here. More later.');
  assert.equal(digestFromFfbox('  \n ', AT), undefined);
  assert.match(digestFromPlayer('Ship stops dead', '**Disable Transit** stops it at once.\nIt should slow down.', AT)!.text!, /^Ship stops dead\. Disable Transit stops it at once\. It should slow down\.$/);
});

const review = (extra: Partial<WorkSource> = {}): Pick<WorkItem, 'source'> => ({
  source: { kind: 'ffbox-diagnosis', untrusted: true, branch: BRANCH, reports: ['20261025T073811Z-hang-25862e0e5a'], ...extra },
});

test('w3602: Approve and Decline say what each sets in motion for an FFBox fix branch', () => {
  const failing = review({ digest: { by: 'FFBox', at: AT, tests: { run: 16361, passed: 16349, failed: 2 } } });
  assert.equal(approveQuestion(failing), 'Should a worker review FFBox’s fix “linux launch skip redundant setresolution” and merge it?');
  // With what the player hit known, the question names it, not the branch.
  assert.equal(approveQuestion(review({ digest: { by: 'FFBox', at: AT, hit: 'a freeze (hang) on LinuxPlayer, game 1.0.0.16' } })), 'Should a worker review FFBox’s fix for a freeze (hang) on LinuxPlayer and merge it?');
  assert.equal(approveAction(failing), 'A worker reviews FFBox’s fix “linux launch skip redundant setresolution” against the code, checks the 2 failing tests and fixes any the fix broke, opens a pull request and merges it on green: one worker session of Claude usage.');
  assert.equal(approveAction(review({ pr: 3401 })), 'A worker reviews FFBox’s fix “linux launch skip redundant setresolution” against the code, reviews its pull request #3401 and merges it on green: one worker session of Claude usage.');
  assert.equal(declineAction(failing), 'It closes as declined: nobody reviews FFBox’s branch and it is never merged. FFBox marks the player’s report obsolete and posts nothing. Your reason goes with it if you type one; nothing is spent.');
  // The card's own ask carries them.
  const ask = approveAsk(failing, undefined);
  assert.equal(ask.question, approveQuestion(failing));
  assert.deepEqual(ask.options.map((o) => o.description), [approveAction(failing), declineAction(failing)]);
});

test('w3602: the other intake kinds say theirs', () => {
  const diag = { source: { kind: 'ffbox-diagnosis', untrusted: true, rootCause: 'not_found' } } as Pick<WorkItem, 'source'>;
  assert.equal(approveQuestion(diag), 'Should a worker take on FFBox’s diagnosis of this player’s report and fix it?');
  assert.match(approveAction(diag), /^A worker checks FFBox’s diagnosis against the code, looks for the cause FFBox did not find, writes a fix/);
  assert.match(declineAction(diag), /^It closes as declined: nobody works on the player’s report\. Your reason/);
  const bug = { source: { kind: 'discord-bug', untrusted: true } } as Pick<WorkItem, 'source'>;
  assert.equal(approveQuestion(bug), 'Should FF Factory work on this player’s bug report?');
  assert.match(approveAction(bug), /^A worker reproduces the player’s report/);
  assert.match(declineAction(bug), /FF Factory posts nothing in their thread/);
  assert.match(approveAction({ source: { kind: 'ffbox-request', untrusted: true } } as Pick<WorkItem, 'source'>), /^A worker checks Max’s diagnosis against the code/);
  assert.match(approveAction({}), /a worker starts at the next free sandbox/);
});

test('w3602: the digest of a conversation: its newest summary, the run that pushed the branch, the lead report’s kind', () => {
  const view = {
    conversation: { kind: 'hang', reportIds: ['20261025T073811Z-hang-25862e0e5a'] },
    turns: [
      { summary: '', runs: [], messages: [], replies: [] },
      {
        summary: W3596_SUMMARY,
        endedAt: AT,
        runs: [
          { branch: 'ffbox/something-else', verification: { ran: true, testsRun: 5, testsPassed: 5 } },
          { branch: BRANCH, verification: { ran: true, compiled: true, testsRun: 16361, testsPassed: 16349, testsFailed: 2 } },
        ],
        messages: [],
        replies: [],
      },
    ],
  } as Pick<ProviderConversationView, 'turns' | 'conversation' | 'summary' | 'at'>;
  const d = digestOfConversation(view, { branch: BRANCH, version: '1.0.0.16', platform: 'LinuxPlayer' })!;
  assert.equal(d.at, AT);
  assert.equal(d.hit, 'a freeze (hang) on LinuxPlayer, game 1.0.0.16');
  assert.deepEqual(d.tests, { passed: 16349, run: 16361, failed: 2, compiled: true });
  assert.equal(digestOfConversation({ turns: [] } as never, {}), undefined);
});

test('w3602: a diagnosis is filed with its digest, and read_work shows it fenced as the untrusted text it is', () => {
  const s = diagnosisSource(
    { report: { id: '20261025T073811Z-hang-25862e0e5a', kind: 'hang', platform: 'LinuxPlayer', gameVersion: '1.0.0.16' }, findings: W3596_SUMMARY } as never,
    AT,
  );
  assert.equal(s.digest?.hit, 'a freeze (hang) on LinuxPlayer, game 1.0.0.16');
  assert.match(s.digest!.cause!, /^the game rebuilt the swapchain/);
  const w = { id: 'w3596', title: 'Review and merge', brief: 'Review it.', status: 'new', priority: 'normal', keys: [], requestedBy: { userId: 'lothsahn', displayName: 'Lothsahn' }, requesters: [], humanAsked: false, createdAt: AT, updatedAt: AT, sessionIds: ['sess-me'], overlaps: [], asks: 0, log: [], source: s } as unknown as WorkItem;
  const out = readWork([w], 'sess-me', { id: 'w3596' }, new Map());
  const at = out.indexOf('Summary on its card:');
  assert.ok(at > 0 && at < out.indexOf('Brief:'), 'the summary comes before the brief');
  assert.match(out.slice(at), /FFBox’s summary \(a model’s words: check them against the code\):\n- The player hit: a freeze \(hang\) on LinuxPlayer/);
});

test('w3602: an FFBox card with no summary says so and where the write-up is; other kinds and cards with one say nothing', () => {
  assert.equal(digestMissing(review()), 'Its full write-up is under Details, at the foot of this card.');
  assert.equal(digestMissing(review({ digest: { by: 'FFBox', at: AT, text: 'x' } })), undefined);
  assert.equal(digestMissing({ source: { kind: 'discord-bug', untrusted: true } } as Pick<WorkItem, 'source'>), undefined);
  assert.equal(digestMissing({}), undefined);
});

test('w3622: FFBox’s reviewer lines (ffbox diagnose.md) become the card’s plain Cause, Fix and FFBox’s own Risk', async () => {
  const { FFBOX_REVIEWER_SUMMARY } = await import('./fixtures/ffboxReviewerSummary.ts');
  const d = digestFromFfbox(FFBOX_REVIEWER_SUMMARY, AT, { hit: 'a freeze (hang) on LinuxPlayer, game 1.0.0.16' })!;
  assert.equal(d.cause, 'the game set the same screen size a second time at launch, and on Linux with the Steam overlay that second setup froze the game on its first frame.');
  assert.equal(d.fix, 'the game no longer re-applies the screen size at launch when the window already has it, so a Linux player with the Steam overlay gets past the first frame.');
  // The Risk line alone: not the evidence heading or bullets after it.
  assert.equal(d.risk, 'Low for other players: it only skips a call when nothing would change, and the 2 tests that fail on this branch fail on master too. Whether it ends this player’s freeze is unproven, since the freeze could not be made to happen here.');
  assert.match(d.unverified!, /^I could not make the freeze happen here, because this machine has no Steam overlay\./);
  assert.doesNotMatch(d.unverified!, /swapchain|present|container/);
  assert.equal(digestRows(d).find((r) => r.label === 'Risk')!.text, d.risk);
});
