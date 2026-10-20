- **A question about visual work carries its previews in the card** (w1602, Ben: "when you ask me about visual things you have to
  include the previews", after a Warden question whose clips sat in the message above the `ask_person` card). The tool now
  refuses a call that names a request (wNNN) whose review folder holds stills or clips while neither the question nor an option
  carries any `![..](<path>)`, and answers with the newest files as lines to paste, so the orchestrator picks the ones that
  belong to each option; the same call sent again goes through (the question may not be about that media). Refused rather than
  attached for the card: a review folder holds every iteration, and only the orchestrator knows which still belongs to which
  option. A refused call no longer draws as a card with live buttons (the page drew every `ask_person` call, whatever its
  result), and a click on one is refused. The orchestrator's brief carries the rule in one line. Docs: orchestrators.md
  ("Questions with buttons"). Tests: `ask.test.ts` (w1602), `e2e/images.spec.ts` (w1602).
