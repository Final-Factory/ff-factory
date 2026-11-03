// w2969: follow-up requests a worker wrote but could not file (w2194's five dragon stages) are read from its report,
// counted, and hold its DONE until they are filed or its person closes it (shared/workState.ts unfiledFollowUpsIn, handUpsPending;
// server/ledgerRules.ts handUpProblem).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handUpsPending, unfiledFollowUpsIn } from '../shared/workState.ts';
import { doneProblem, handUpProblem } from './ledgerRules.ts';
import { handUpText } from './orchestrators.ts';
import type { WorkHandedUp } from '../shared/types.ts';

// c68864ef's report on w2194, 20:27 UTC 2026-10-29 (the ledger keeps it clipped; this is its sentence).
const DRAGON = "PR #2774 merged: the design and the five build briefs are in specs/w2194-ancient-dragon/build-requests.md. I couldn't file the five build requests myself, because none of my tools can create a request. Each brief is written to file as it stands.\n\nDONE: w2194";

test('w2969: the w2194 report is read as five follow-ups left to file, with its sentence', () => {
  const f = unfiledFollowUpsIn(DRAGON);
  assert.ok(f);
  assert.equal(f.count, 5);
  assert.equal(f.line, "I couldn't file the five build requests myself, because none of my tools can create a request.");
});

test('w2969: other ways of saying it, and how many', () => {
  const cases: [string, number][] = [
    ['None of my tools can create a request, so the stages are listed above.', 1],
    ['The 3 stage requests still need to be filed.', 3],
    ["Ben's orchestrator needs to file two follow-up requests: stage 4 and stage 5.", 2],
    ['I have no tool to file new requests; the four briefs are in the spec.', 4],
    ['Someone must file the request for the save fix.', 1],
  ];
  for (const [text, n] of cases) assert.equal(unfiledFollowUpsIn(text)?.count, n, text);
});

test('w2969: reports that file nothing are not read as follow-ups', () => {
  for (const text of [
    'PR #811 merged and deployed. DONE: w2959',
    "I couldn't open the pull request until CI was green, so I waited.",
    'Filed the bug as w2970 with request_pair.',
    'The requests file is at server/requests.ts.',
    "w2194: still open: blocked on CI on PR #2774",
  ]) assert.equal(unfiledFollowUpsIn(text), undefined, text);
});

test('w2969: a hand-up holds its DONE until each follow-up is filed', () => {
  const h: WorkHandedUp = { worker: 'c68864ef', at: '2026-10-29T20:27:00.000Z', count: 5, items: [], to: ['ben'], filed: [] };
  const w = { handedUp: h, prs: [], requesters: [] };
  assert.equal(handUpsPending(w), 5);
  assert.match(handUpProblem(w) ?? '', /^5 of the 5 follow-up requests handed up for it are not filed yet/);
  assert.match(doneProblem(w as never, 'DONE: w2194') ?? '', /follow-up requests handed up/);
  h.filed.push('w2962', 'w2963', 'w2964', 'w2965');
  assert.match(handUpProblem(w) ?? '', /^1 of the 5 follow-up requests handed up for it is not filed yet/);
  h.filed.push('w2966');
  assert.equal(handUpProblem(w), undefined);
  assert.equal(handUpsPending({}), 0);
});

test('w2969: the [follow-ups to file] message carries the line, the report and the person’s newest note, and says how to file', () => {
  const text = handUpText(
    { id: 'w2194', title: 'Ancient Dragon design', notes: [{ at: '2026-10-28T09:50:00.000Z', by: 'Ben', text: 'Build it in the five stages as designed, numbers tuned in stage 5' }] },
    'c68864ef', 'Ben', { count: 5, items: [], line: "I couldn't file the five build requests myself" }, DRAGON,
  );
  assert.match(text, /^\[follow-ups to file\] w2194 "Ancient Dragon design"\nIts worker c68864ef wrote 5 follow-up requests to file/);
  assert.match(text, /Ben's newest note on w2194 \(2026-10-28 09:50 UTC\): "Build it in the five stages as designed/);
  assert.match(text, /request_work, related_ids \["w2194"\]/);
  assert.match(text, /If they are not wanted, close w2194 with update_work/);
});
