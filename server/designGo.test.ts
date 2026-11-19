// w4739 (r290 fix 5): a design's open questions are read from its report, and its close asks the go to build on a card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { designGoAsk, designGoQuestion, designName } from './designGo.ts';
import { openQuestionsOf } from './reports.ts';

// r87 revision 4 (2026-11-08 01:43), the multi-select design's last revision: its section as filed.
const R87_REV4 = `**TL;DR:** Every question is answered; the design is ready to build. Lothsahn's decisions:
- **Panel B:** the station window becomes a list of the selected stations.

## Edge cases
- **Mixed speeds (decided):** each station flies at its own speed in v1.

## Open questions
None. All six are answered by lothsahn. The calls I made inside his answers (the digit recall rule, nearest-to-drag-start past 50, no redo, groups not saved) are marked above and can be changed in the build's spec.
`;

// The shape of r87 revision 3 (Q4 and Q5 still open, and a new one on how far undo reaches).
const R87_REV3_SHAPE = `## Decisions
1. Panel (2026-11-04): "Panel B".

## Open questions
1. **Q4: Control groups:** in v1, or a later step?
2. **Q5: Selection cap:** cap the selection at about 50 stations, or none?
   - a sub-point that is not a question of its own
3. **Undo reach:** one step, or a list of the last 10 orders?

## Size
About 3 weeks.
`;

test('w4739: openQuestionsOf reads a design report\'s Open questions section', () => {
  assert.deepEqual(openQuestionsOf(R87_REV4), [], 'r87 revision 4: "None." leaves none open');
  assert.deepEqual(openQuestionsOf(R87_REV3_SHAPE), [
    'Q4: Control groups: in v1, or a later step?',
    'Q5: Selection cap: cap the selection at about 50 stations, or none?',
    'Undo reach: one step, or a list of the last 10 orders?',
  ]);
  assert.equal(openQuestionsOf('## Design\nNo section here.'), undefined, 'no section: unknown, not "none"');
  assert.deepEqual(openQuestionsOf('### Open questions\n\n- Which belt tier?\n#### Q2: the colour\nmore words\n### Next\n- not a question'), ['Which belt tier?', 'Q2: the colour']);
  assert.deepEqual(openQuestionsOf('**Open questions:** none left.\n'), [], 'a bold line, "none" on it');
  assert.deepEqual(openQuestionsOf('## Open questions\nNo open questions remain.'), []);
  assert.deepEqual(openQuestionsOf('## Open questions (for Ben)\nWhether the splitter picks round-robin or by fill.\n\nMore text.'), ['Whether the splitter picks round-robin or by fill.'], 'a paragraph with no list: the paragraph');
  assert.deepEqual(openQuestionsOf('## Open questions\r\n\r\n- One?\r\n'), ['One?'], 'CRLF');
});

test('w4739: the go card: "File the build of <design> now?", that answer recommended; open questions first when some are left', () => {
  const w = { id: 'w3031', title: 'Design: multi-select mobile stations and move them together', requesters: [{ userId: 'lothsahn', displayName: 'Lothsahn' }] };
  assert.equal(designName(w), 'multi-select mobile stations and move them together');
  assert.equal(designGoQuestion(w), 'File the build of multi-select mobile stations and move them together now?');
  const none = designGoAsk(w, [{ id: 'r87', title: 'Multi-selecting mobile stations to move them: options and recommendation', kind: 'design', openQuestions: [] }]);
  assert.match(none, /^\[design closed\] w3031 "Design: multi-select mobile stations and move them together" closed, and its result is a design \(r87 "Multi-selecting/);
  assert.match(none, /leaves no open questions\. Ask Lothsahn the go now: ask_person, request w3031: "File the build of multi-select mobile stations and move them together now\?", options "Yes, file the build now" \(recommended\)/);
  assert.match(none, /On yes, file the build with request_work \(related_ids \["w3031"\]/);
  assert.match(none, /Never offer the go in chat/);
  const open = designGoAsk(w, [{ id: 'r87', title: 'Multi-select', kind: 'design', openQuestions: ['Q4: Control groups in v1?', 'Q5: Cap at 50?'] }]);
  assert.match(open, /still lists 2 open questions:\n1\. Q4: Control groups in v1\?\n2\. Q5: Cap at 50\?\nAsk Lothsahn these now, before the go/);
  assert.match(open, /Once all are answered, ask the go the same way: ask_person, request w3031: "File the build of/);
  const unread = designGoAsk(w, [{ id: 'r87', title: 'Multi-select', kind: 'design' }]);
  assert.match(unread, /r87 has no "Open questions" section: read it \(read_report\)/);
  assert.ok(designGoQuestion(w).length <= 300, 'fits a card question');
});
