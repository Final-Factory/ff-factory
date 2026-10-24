- **A new question an earlier decision settles is held** (w2085, Ben: "i already answered this. you keep asking me
  questions i already answered"). Every `[needs you]` now carries the asked person's notes on the request and its related
  requests, and flags `POSSIBLY DECIDED` a note that names its pull request, thread or feature. `waiting_on_person` refuses
  a look or merge OK for a pull request whose added text a note of theirs quotes, answering with that note
  (`decided_override` says what the note leaves open). The fresh session after a merge (w2043) is told its people's notes
  are decisions, with theirs on its related requests. Docs: orchestrators.md ("Questions for a person"). Tests:
  `priorDecisions.test.ts`, `orchestrators.test.ts`, `freshAfterMerge.test.ts` ("w2085"), with w1958's 16:32 replay.
