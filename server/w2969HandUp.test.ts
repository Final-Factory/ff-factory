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
    ['I could not create the 3 stage requests.', 3],
    ["I can't file two follow-up requests: stage 4 and stage 5.", 2],
    ['I have no tool to file new requests; the four briefs are in the spec.', 4],
    ['Stage 2 is merged. I was unable to open the request for the save fix.', 1],
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
    // w2977: a description, a third person, history and quotes are not the worker saying it.
    'Workers can\'t file requests: only a person\'s orchestrator has request_work.',
    'Someone must file the request for the save fix.',
    'The 3 stage requests still need to be filed.',
    'The worker\'s line, "I couldn\'t file the five build requests myself, because none of my tools can create a request", matched no route.',
    '> I couldn\'t file the five build requests myself.',
    'It wrote \u201cI cannot create new requests\u201d and closed.',
  ]) assert.equal(unfiledFollowUpsIn(text), undefined, text);
});

// w2977: w2969's own DONE report (2026-11-03), which describes the feature and quotes the dragon worker; it was read as
// one follow-up to file, sent Ben's orchestrator [follow-ups to file] and refused the DONE.
const W2969_REPORT = `**TL;DR:** The fix for the dragon work never starting is merged and live. A worker that can't file a follow-up request now hands it up to the requester's orchestrator with a new \`hand_up_requests\` tool, and its DONE waits until those requests are filed.

**Why the dragon work never started (from the code):**
1. **Workers can't file requests.** Only a person's orchestrator has \`request_work\` (\`server/toolManifest.ts\`).
2. **The worker's report reached nobody who could file.** \`onWorkerTurnEnd\` sends a \`[worker update]\` only for a turn the orchestrator started, and this turn came from Ben's note. The worker's line, "I couldn't file the five build requests myself, because none of my tools can create a request", also didn't match either of the two existing routes that pass a worker's ask up.
3. **The DONE closed it.** \`doneProblem\` had no check for follow-up requests that were never filed. So when the ledger cleanup asked "is it done?", the worker's DONE closed w2194 (the dragon design request).
4. **The dispatcher promised a step workers can't take.** It wrote that the worker (session c68864ef) would file the build. Its prompt never says workers can't file.

**One thing to fix:** the tool's description still says the request closes once the follow-ups are filed "or its person drops them". It's a one-line follow-up, and I haven't filed it.

Learned: final-factory-agents PR #542 (evidence-gate, \`lessons/research-the-route-before-you-say-cant.md\`, the w2969 section)

DONE: w2969`;

test('w2977: w2969\'s own report, describing the feature and quoting the dragon worker, hands up nothing', () => {
  assert.equal(unfiledFollowUpsIn(W2969_REPORT), undefined);
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
