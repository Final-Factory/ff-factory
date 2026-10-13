- **A "Waiting on input" tab on the Dispatcher page clears everything that waits on a person** (w1228, Ben: "theres 7 things
  waiting on input in the dispatcher ... its not clear in the UI how to go through and clear out the intake"). The
  count in the sidebar and on the Requests tab was not a link, and the Intake tab left out the dispatcher's questions.
  The new tab lists what waits on you first and what waits on someone else after it, oldest first, with how long each has
  waited, what is asked, FF Factory's recommendation where its triage gives one, the evidence, and the buttons: Approve,
  Decline with a reason, Answer (sent to your own orchestrator, which records it on the request), Open. The sidebar's
  Dispatcher row, its "Needs you" list, the phone's bell and a "Go through them" link on the Requests tab lead to it. No
  new endpoint. Docs: intake.md ("Approval, caps and auto-approve"). Tests: `waiting.test.ts`, `intake.spec.ts`.
