- **Questions for a person go to their orchestrator chat as `[needs you]`** (w1378, Ben: "Those should just be surfaced to
  you the orchestrator and then I'll answer you and you send the response back"). A dispatcher question (`decide_work ask`, a
  dead gate's question), a worker's `waiting_on_person`, or a worker report whose "still open" line names a person now reaches
  that person's own orchestrator once, as `[needs you] wNNN "title"` with the question in full, the review files and pull
  requests it names, and the end of the worker's report. The orchestrator asks in chat; the person's answer, recorded with
  `update_work` (a note, in their own turn), resumes the waiting worker within a minute and clears the alert. One message per
  question (kept on the request as `needsYou`, so no turn, heartbeat or restart sends it again); a dispatcher question about a
  worker's unanswered wait is folded into it. Waits open when this ships go once, as one `[needs you] digest` per person,
  3 minutes after the portal starts. The dashboard's Waiting on input card shows the question whole with its files, pull
  requests and report, an "Answer in your chat" link, and an answer box for a worker's question too. Docs: orchestrators.md
  ("Questions for a person"). Tests: `needsYou.test.ts`, `orchestrators.test.ts` (w1378), `notices.test.ts`.
