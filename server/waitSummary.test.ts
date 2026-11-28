import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitMedia } from '../shared/ask.ts';
import { askingLine } from '../shared/workState.ts';
import { orchestratorAsks, waitingItemOf } from '../shared/waiting.ts';
import { APPROVE_LABEL, DECLINE_LABEL, asksAnsweredBy, briefSentence, intakeWhat, mediaCount, staleOf, summaryText, waitSummary, type WaitFacts } from '../shared/waitSummary.ts';
import { cardQuestions } from '../shared/questionCard.ts';
import { asksWithCopies, needsYouRecord, needsYouText } from './needsYou.ts';
import { publishedCopy } from './reviewMedia.ts';
import { FRAME_ASK, LOTH, STRIP_ASK, orchestratorQuestions, waitingCases } from './fixtures/waitingCards.ts';
import type { OpenAsk, SessionInfo, WorkItem } from '../shared/types.ts';

/**
 * w1868 (lothsahn, 2026-10-23: "The existing cards are impossible to know what I need to answer"; then "I meant the 'waiting
 * for input' tab on the portal"): every waiting card says what it is, who acts and since when, the question whole, its
 * answers with the recommended one (or the one step), its stills and clips, and what follows the answer.
 */

const NOW = Date.parse('2026-10-23T15:45:00.000Z');

function facts(cases: ReturnType<typeof waitingCases>): WaitFacts {
  return { session: (id) => cases.find((c) => c.session?.id === id)?.session as SessionInfo | undefined, reviewers: 'Ben or Lothsahn' };
}

test('w1868: every card of today’s real cases renders the six parts', () => {
  const cases = waitingCases(NOW);
  for (const c of cases) {
    const s = waitSummary(waitingItemOf(c.w, c.live), facts(cases));
    const id = `${c.w.id} (${c.was})`;
    // 1. What it is: a plain line, not the title, no bare worker id.
    assert.ok(s.what.length > 20, `${id}: what it is`);
    assert.notEqual(s.what, c.w.title, `${id}: not the title`);
    assert.doesNotMatch(s.what, /\b[0-9a-f]{8}\b/, `${id}: no worker ids`);
    // 2. Who acts, and since when.
    assert.ok(s.who && !Number.isNaN(Date.parse(s.since)), `${id}: who and since`);
    // 3. The question, never cut off.
    const words = s.asks.length ? s.asks.map((a) => splitMedia(a.question).text).join(' ') : s.question;
    assert.ok(words.length > 10, `${id}: the question`);
    assert.doesNotMatch(words, /…$/, `${id}: the question is whole`);
    // 4. The answers with one recommended, or the one step for an input.
    const picks = s.asks.length > 0 && s.asks.every((a) => a.options.length >= 2);
    assert.ok(picks || !!s.step, `${id}: answers or a step`);
    if (picks) assert.ok(s.asks.every((a) => a.options.filter((o) => o.recommended).length <= 1), `${id}: one recommended at most`);
    // 5. Media: a visual question carries its stills and clips, or is flagged.
    // A question about a look (not "still open", nor "what it saves per frame": w1820).
    const visual = /\bclips?\b|\bstills\b|\bthe still\b|\bframe look\b|\blooks? right\b/i.test(words);
    if (visual) assert.ok(mediaCount(s.asks, s.previews) > 0 || s.noMedia, `${id}: media shown, or flagged`);
    // 6. What happens after the answer.
    assert.ok(s.after.length > 20, `${id}: what follows`);
    // And the text list_work and the [needs you] message carry, every part on its line.
    const text = summaryText(s, NOW);
    for (const part of ['What it is:', 'Who acts:', 'Question', 'After the answer:']) assert.ok(text.includes(part), `${id}: ${part} in the text`);
  }
});

test('w1868: the cases lothsahn named read as he asked', () => {
  const cases = waitingCases(NOW);
  const sum = (id: string) => {
    const c = cases.find((x) => x.w.id === id)!;
    return waitSummary(waitingItemOf(c.w, c.live), facts(cases));
  };
  // w1797: the whole question, the clip shown, the step to answer it in words.
  const w1797 = sum('w1797');
  assert.match(w1797.question, /the two-machine check passed, so PR #2250 merges on your OK\.$/);
  assert.match(w1797.what, /^A player's bug report from Discord by Reteoteigam: “Disable Transit should let ship slow down/);
  assert.equal(mediaCount(w1797.asks, w1797.previews), 1);
  assert.match(summaryText(w1797, NOW), /Media: 1 clip, shown on the card/);
  // w1829: the decision itself, and that it may be out of date (timed runs no longer go to m5).
  const w1829 = sum('w1829');
  assert.match(w1829.question, /Should I run it on BEAST instead, or keep waiting for m5\?/);
  assert.match(w1829.stale ?? '', /changed since it was asked: .*timed runs no longer go to m5/);
  assert.match(w1829.what, /^When a timed bench leg holds the exclusive ticket/i);
  // w1820: the report line whole, though the ledger's line kept 160 characters.
  assert.match(sum('w1820').question, /or after w1785’s LothDesktop timing shows what it saves per frame$/);
  // w1821: the frame look is answered; the Station strip question is still asked, on its own, with its still.
  const w1821 = sum('w1821');
  assert.deepEqual(w1821.asks.map((a) => a.question), [STRIP_ASK.question]);
  assert.match(w1821.what, /^Stacked game windows/);
  assert.match(w1821.after, /bring you their clips/);
});

test('w1868: intake cards say what the item is, and what Approve and Decline do', () => {
  const cases = waitingCases(NOW);
  for (const id of ['w1853', 'w1842']) {
    const c = cases.find((x) => x.w.id === id)!;
    const s = waitSummary(waitingItemOf(c.w, c.live), facts(cases));
    assert.equal(s.kind, 'approve');
    assert.equal(s.who, 'a reviewer (Ben or Lothsahn)');
    assert.deepEqual(s.asks[0].options.map((o) => o.label), [APPROVE_LABEL, DECLINE_LABEL]);
    // What Approve sets in motion for this request (w3602): a nightly's worker starts; an FFBox branch is reviewed and merged.
    assert.match(s.asks[0].options[0].description, id === 'w1842' ? /^A worker reviews FFBox’s fix “circular placement log once” against the code, opens a pull request and merges it on green/ : /a worker starts at the next free sandbox/);
    assert.match(s.asks[0].options[1].description, /closes as declined/);
    assert.match(s.after, /^Approve: .* Decline: /);
  }
  assert.match(intakeWhat(cases.find((x) => x.w.id === 'w1853')!.w)!, /^The nightly game tests of 2026-10-23: 6 scenarios failed on master \(commit ff44324f2\), already shipped in 1\.0\.0\.10\.$/);
  assert.match(intakeWhat(cases.find((x) => x.w.id === 'w1842')!.w)!, /^FFBox's diagnosis of a player's report \(version 1\.0\.0\.9, OSXPlayer\), root cause found, with a fix branch nobody has reviewed/);
  // A regression is recommended for approval; a needs-human FFBox branch is the reviewer's call.
  const rec = (id: string) => waitSummary(waitingItemOf(cases.find((x) => x.w.id === id)!.w, cases.find((x) => x.w.id === id)!.live)).asks[0].options[0].recommended;
  assert.equal(rec('w1853'), true);
  assert.equal(rec('w1842'), undefined);
});

test('w1868: the stale flag: a decision or someone’s note after the question, or the worker that asked gone', () => {
  const w = { log: ['10:00 [needs you] sent to ben’s orchestrator: pick one'], done: {} } as unknown as WorkItem;
  assert.equal(staleOf(w, undefined), undefined, 'nothing changed');
  w.log.push('10:05 pull request states updated (read live from GitHub): PR #1 merged', '10:06 lothsahn’s orchestrator followed up with ab12cd34');
  assert.equal(staleOf(w, undefined), undefined, 'bookkeeping is no change');
  w.log.push('10:09 dispatcher: queued for capacity on beast: timed runs no longer go to m5');
  assert.match(staleOf(w, undefined)!, /^changed since it was asked: 10:09 dispatcher: queued for capacity on beast/);
  assert.match(staleOf({ log: [], done: {} } as unknown as WorkItem, 'ab12cd34', { session: () => undefined })!, /the worker that asked is gone/);
  assert.match(staleOf({ log: [], done: {} } as unknown as WorkItem, 'ab12cd34', { session: () => ({ id: 'ab12cd34', status: 'error' }) })!, /failed since/);
  assert.equal(staleOf({ log: [], done: {} } as unknown as WorkItem, 'ab12cd34', { session: () => ({ id: 'ab12cd34', status: 'idle' }) }), undefined);
});

test('w1868: the structured block: about and after ride the record into the [needs you] message', () => {
  const r = needsYouRecord({ prs: [], id: 'w9' }, { kind: 'declared', key: 'declared:ab12cd34:t', question: 'Pick the look', names: ['Lothsahn'], worker: 'ab12cd34', asks: [FRAME_ASK], about: 'Window frames let the back text show through.', after: 'I build the picked look and bring you its clip.' }, [LOTH], '2026-10-23T15:00:00.000Z', { reviewRoot: path.join(os.tmpdir(), 'no-review-here') });
  assert.equal(r.about, 'Window frames let the back text show through.');
  assert.equal(r.after, 'I build the picked look and bring you its clip.');
  const text = needsYouText({ id: 'w9', title: 'Frames' }, r, 'Lothsahn');
  assert.ok(text.indexOf('What it is: Window frames') < text.indexOf('Question ('), 'what it is comes first');
  assert.match(text, /After the answer: I build the picked look and bring you its clip\./);
});

test('w1868: a still or clip on the worker’s machine becomes its published review copy; one with none stays as written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-review-'));
  try {
    fs.mkdirSync(path.join(root, 'w9-frames'));
    fs.writeFileSync(path.join(root, 'w9-frames', 'brake.mp4'), 'x');
    const o = { root, ids: ['w9'] };
    assert.equal(publishedCopy('F:/ffw/tmp/ffa-1/brake.mp4', o), path.join(root, 'w9-frames', 'brake.mp4'));
    assert.equal(publishedCopy('F:/ffw/tmp/ffa-1/other.mp4', o), undefined);
    assert.equal(publishedCopy('/srv/fff/review/w9-frames/brake.mp4', o), '/srv/fff/review/w9-frames/brake.mp4', 'a review path is itself');
    const [a] = asksWithCopies([{ question: 'Is it right? ![the brake](<F:/ffw/tmp/ffa-1/brake.mp4>)', options: [{ label: 'Yes it is', description: '![other](<F:/ffw/tmp/ffa-1/other.mp4>)' }, { label: 'No it is not', description: '' }] }], o);
    assert.equal(splitMedia(a.question).media[0].url, path.join(root, 'w9-frames', 'brake.mp4'));
    assert.equal(splitMedia(a.options[0].description).media[0].url, 'F:/ffw/tmp/ffa-1/other.mp4');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('w1868: a visual question with no viewable media is flagged', () => {
  const cases = waitingCases(NOW);
  const c = cases.find((x) => x.w.id === 'w1797')!;
  const bare = { ...c.w, needsYou: { ...c.w.needsYou!, question: 'Watch the new braking clip and say whether it is right.', previews: [] } };
  const s = waitSummary(waitingItemOf(bare, c.live), facts(cases));
  assert.equal(s.noMedia, true);
  assert.match(summaryText(s, NOW), /Media: none, although it asks about something visual/);
  assert.equal(waitSummary(waitingItemOf(c.w, c.live), facts(cases)).noMedia, undefined, 'with its clip it is not flagged');
});

test('w1868: which of several questions a note answers: the one whose answer it quotes', () => {
  assert.deepEqual(asksAnsweredBy([FRAME_ASK, STRIP_ASK], 'Frame look, lothsahn’s answer verbatim: "Keep frames see-through over space, solid only over a window".'), [0]);
  assert.deepEqual(asksAnsweredBy([FRAME_ASK, STRIP_ASK], 'Station strip: "1", meaning "The whole strip comes up over the window".'), [1]);
  assert.deepEqual(asksAnsweredBy([FRAME_ASK, STRIP_ASK], 'yes to both'), [], 'quotes none: taken as all, as before');
  // The card asks only what is left; the answer message names only that.
  const w = waitingCases(NOW).find((x) => x.w.id === 'w1821')!.w;
  assert.deepEqual(cardQuestions(w).asks.map((a) => a.question), [STRIP_ASK.question]);
});

test('w1868: "stopped asking for a decision" names the decision', () => {
  assert.equal(askingLine('The PRs merged.\n\nNo m5 sandbox has come free. Should I run it on BEAST instead, or keep waiting for m5?'), 'Should I run it on BEAST instead, or keep waiting for m5?');
  assert.equal(askingLine('All done, merged.'), undefined);
});

test('w1868: the orchestrator’s open questions are cards: three requests and two on one make five; one its request’s card asks is left out', () => {
  const cases = waitingCases(NOW);
  const work = cases.map((c) => c.w);
  const orch = { id: 'orch-l', kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: LOTH, openAsks: orchestratorQuestions(NOW) } as unknown as SessionInfo;
  const other = { id: 'orch-b', kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: { userId: 'ben', displayName: 'Ben' }, openAsks: orchestratorQuestions(NOW) } as unknown as SessionInfo;
  const items = orchestratorAsks([orch, other], work, { userId: 'lothsahn' });
  assert.equal(items.length, 5, 'only the viewer’s own orchestrator, every open question');
  assert.deepEqual(items.map((i) => i.a.seq), [101, 102, 103, 104, 105], 'oldest first');
  assert.deepEqual(items.filter((i) => i.w?.id === 'w1797').map((i) => i.a.seq), [104, 105], 'two on one request: two cards');
  // The question the w1821 card already asks (its Station strip question, relayed) is that card, not a second one.
  orch.openAsks = [...orch.openAsks!, { seq: 106, at: new Date(NOW).toISOString(), request: 'w1821', ask: STRIP_ASK }];
  assert.equal(orchestratorAsks([orch], work, { userId: 'lothsahn' }).length, 5);
  // w6813: a closed request's question still shows until it is answered or closed, marked so.
  const closed = work.map((w) => (w.id === 'w1829' ? { ...w, status: 'done' as const } : w));
  const shown = orchestratorAsks([orch], closed, { userId: 'lothsahn' });
  assert.equal(shown.length, 5);
  assert.deepEqual(shown.filter((i) => i.closedRequest).map((i) => i.a.seq), [101]);
});

/**
 * w6813 (lothsahn, 2026-11-28: "I don't have cards for those six. Please investigate and figure out why those cards were
 * missing in the dispatch window"): six questions the store held open had no card. Every open question shows, whatever
 * became of its request; one hides behind its request's card only when that card is on the tab.
 */
test('w6813: every open question the store holds is a card: stalled and closed requests, and a [needs you] whose card is not on the tab', () => {
  const cases = waitingCases(NOW);
  const base = cases.find((c) => c.w.id === 'w1821')!.w;
  const req = (id: string, status: WorkItem['status'], needsYou?: WorkItem['needsYou']) => ({ ...base, id, status, needsYou }) as WorkItem;
  const two = (question: string, a: string, b: string) => ({ question, options: [{ label: a, description: 'One way.', recommended: true }, { label: b, description: 'The other.' }] });
  const gpu = two('Adding ffu’s new GPU runner label needs an admin login on the ffu repo. How should it be added?', 'Let the ops worker use LothDesktop’s own GitHub login', 'Hold the label for now');
  const nyGpu = { ...base.needsYou!, answered: undefined, answeredAsks: undefined, question: 'Add the ffu-gpu label to ffu’s runners with an admin account.', asks: [gpu] };
  const work = [
    req('w5710', 'stalled'),
    req('w5691', 'stalled'),
    req('w6754', 'done'),
    req('w6781', 'blocked', nyGpu),
    req('w6780', 'done'),
    req('w6704', 'done'),
  ];
  const ask = (seq: number, request: string | undefined, a: ReturnType<typeof two>): OpenAsk => ({ seq, at: new Date(NOW - (200000 - seq) * 1000).toISOString(), ...(request ? { request } : {}), ask: a });
  const orch = {
    id: 'orch-l',
    kind: 'orchestrator',
    orchestratorRole: 'personal',
    requestedBy: LOTH,
    openAsks: [
      ask(150503, 'w5710', two('The ledger cleanup stalled w5710 as superseded. Close it, or keep the m5 rollout?', 'Close it as superseded', 'Keep it open')),
      ask(150648, 'w6754', two('Machine exclusions logged no false warnings for an hour. Should placement.exclusions switch from warn to enforce?', 'Keep it at warn until BEAST is back', 'Enforce now')),
      ask(151065, 'w5691', two('w5691 has stalled on m3 being offline. Close it with three machines checked, or wait?', 'Close it with three checked', 'Wait for m3')),
      ask(151470, 'w6781', gpu),
      ask(152079, 'w6780', two('Should I file w6780’s follow-up to move one big flying station’s buildings in parallel?', 'File it', 'Drop it')),
      ask(152123, 'w6704', two('w6704’s worker already merged FFU PR #1287 without check. Keep it or revert?', 'Keep it', 'Revert it')),
    ],
  } as unknown as SessionInfo;
  const me = { userId: 'lothsahn' };
  // The tab shows none of these requests' own cards (w6781 is blocked on a pull request, not Waiting on input).
  const items = orchestratorAsks([orch], work, me, new Set());
  assert.deepEqual(items.map((i) => i.a.seq), [150503, 150648, 151065, 151470, 152079, 152123], 'all six open questions are cards');
  assert.deepEqual(items.filter((i) => i.closedRequest).map((i) => i.w!.id), ['w5710', 'w6754', 'w5691', 'w6780', 'w6704'], 'marked: their request is stalled or closed');
  // When w6781's own card is on the tab, it asks the GPU question: one question, one card.
  assert.deepEqual(orchestratorAsks([orch], work, me, new Set(['w6781'])).map((i) => i.a.seq), [150503, 150648, 151065, 152079, 152123]);
  // Answered, its [needs you] no longer hides the card, on the tab or not.
  const answered = work.map((w) => (w.id === 'w6781' ? { ...w, needsYou: { ...nyGpu, answered: { by: 'lothsahn', at: new Date(NOW).toISOString() } } } : w)) as WorkItem[];
  assert.equal(orchestratorAsks([orch], answered, me, new Set(['w6781'])).length, 6);
});

test('w1868: the live cards after the deploy: a reporter’s wait shown whole, a quoted brief not cut mid-quote, "still open" not visual', () => {
  const cases = waitingCases(NOW);
  const base = cases.find((x) => x.w.id === 'w1797')!;
  // w1778 as list_work showed it live: the reporter's wait, its line cut at 160 characters ("FFBox pas").
  const line = 'w1778: still open: waiting on the reporter Reteoteigam to answer in the Discord thread (when the asteroid vanished, whether rejoining brings it back); FFBox passes the answer on.';
  const w1778 = { ...base.w, id: 'w1778', needsYou: undefined, brief: 'Goal: fix a multiplayer bug for the next patch. Ben asked for it.' } as WorkItem;
  const outside = { state: 'waiting' as const, why: `d373b21a waits on the reporter Reteoteigam to answer through FFBox and Discord: "${line.slice(0, 160)}"`, line, waitsOn: ['the reporter Reteoteigam'], worker: 'd373b21a', outside: true };
  const a = waitSummary(waitingItemOf(w1778, outside), facts(cases));
  assert.equal(a.question, 'Waiting on the reporter Reteoteigam to answer in the Discord thread (when the asteroid vanished, whether rejoining brings it back); FFBox passes the answer on.');
  // w1588: a brief that opens on Ben's quote, and a status line that says "still open".
  const report = 'w1588: still open: waiting on Ben to finish testing Build 111 on pre-release and set it live on default (then I post the patch notes)';
  const w1588 = {
    ...base.w,
    id: 'w1588',
    source: undefined,
    title: 'Research: is the pre-1.0 branch ready as the final pre-1.0 release on Steam default, and what from master to include',
    brief: 'Ben, in his own words: "i want to do one final release for the pre-1.0 build. whats on the pre 1.0 release branch right now"\n\nBackground: master is 1.0.',
    needsYou: { ...base.w.needsYou!, question: report, previews: [], asks: undefined, about: undefined, after: undefined },
  } as WorkItem;
  const b = waitSummary(waitingItemOf(w1588, base.live), facts(cases));
  assert.equal(b.what, 'The request “Research: is the pre-1.0 branch ready as the final pre-1.0 release on Steam default, and what from master to include”.');
  assert.equal(b.question, 'Waiting on Ben to finish testing Build 111 on pre-release and set it live on default (then I post the patch notes)');
  assert.equal(b.noMedia, undefined, '"still open" is not a still');
  assert.equal(briefSentence('Ben said, verbatim: ship it now.'), undefined);
});
