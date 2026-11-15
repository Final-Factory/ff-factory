- **Owners answer each other's questions with one click** (w4238, lothsahn: "Alter ff portal so that I can click answers
  for Ben's questions"). The Waiting tab shows an owner the other owners' open questions ("Waiting on Ben"), with the same
  buttons, stills, clips and Chat more, and the Work list row links to that card. A click goes to the clicking owner's
  orchestrator and is recorded through w3606's owner path: the worker resumes, the asked owner hears who answered and what,
  and the card leaves the Waiting tab for both owners at once (the answer carries who it answers for). Several questions can
  be answered in part, leaving the rest with the owner asked. Intake approvals, ask_person cards, waits on a non-owner,
  release-branch asks and waits with no open question are not offered.
  A resume held behind a computer's hold after its sandbox was released (w4125 waited 5 h behind BEAST's crash hold) now
  moves to any computer with a seat, or shows Queued with its reason. Tests: `ownerAnswers.test.ts`, `w4238:` in
  `workState.test.ts`, `resumeMove.test.ts`, `orchestrators.test.ts`, `e2e/waitingCards.spec.ts`.
