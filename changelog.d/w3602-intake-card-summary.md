- **An intake approval card says what you are approving** (w3602, lothsahn on w3596's card: "I don't know what this
  means, what I'm approving, or anything... What am I approving?"). An intake request now carries a plain summary of FFBox's
  own write-up, or the player's words, on its source (`WorkSource.digest`): what the player hit, the cause, the fix, the
  tests (the run's own numbers before the text's), what nobody could check, and the risk (FFBox's own, else what the facts say). An FFBox card without a summary says so. It is labelled as FFBox's (a model's words)
  or the player's (untrusted) and leads the Waiting on input card, above the question; read_work shows it before the brief.
  Diagnoses, Discord bugs and Max's escalations get it when filed; an FFBox fix branch's request gets it from its
  conversation's newest turn summary right after filing, and open ones without it are filled 30 s after the portal starts.
  The question and the Approve and Decline answers now name the request's own work ("A worker reviews FFBox's fix “…”
  against the code, fixes the 2 failing tests, opens a pull request and merges it on green"; Decline: nobody reviews the
  branch, FFBox marks the report obsolete). Tests: `intakeDigest.test.ts`, `waitSummary.test.ts`, `e2e/waitingCards.spec.ts`.
