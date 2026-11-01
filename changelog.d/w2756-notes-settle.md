- **A question the person's own notes may settle is refused once** (w2756, Ben: "didnt i already talk to you about this
  above?"). `waiting_on_person` and `ask_person` now compare each question and its recommended answer with every sentence
  of the asked person's notes on the request; a sentence sharing three content words refuses it, naming the question and
  the sentence. `decided_override` (waiting_on_person) or `notes_leave_open` (ask_person) says what the notes leave open
  and lets it through, logged on the request. Before, only earlier questions (w1812) and a look OK whose quoted note was
  in the diff (w2085) were checked. Docs: orchestrators.md ("Questions for a person"). Tests: `priorDecisions.test.ts`,
  `orchestrators.test.ts` ("w2756"), with w2651's 04:57 replay.
