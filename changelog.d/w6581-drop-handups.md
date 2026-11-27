- **An orchestrator can drop a handed-up follow-up, and a hand-up waiting on the orchestrator reads Working** (w6581, for
  lothsahn: w6534's `--waive-tests` hand-up, already decided "Keep it as it is for master/development", sat unfiled and
  read Waiting on input on lothsahn; w5599 and w5562 the same day). `file_follow_ups` takes `drop: true` with a `reason`
  (the person's words, quoted, or the fact that made them outdated; refused without one) and drops all of them or the
  numbered items; the request's log quotes the reason, its card goes, and it closes on its kept DONE. Until the 12 h card,
  a pending hand-up is Working on "<Name>'s orchestrator", off every person's Waiting on input tab; from the card on it is
  Waiting on input on the person, as before. Tests: "w6581: ..." in `orchestratorsAsks.test.ts` and `w2969HandUp.test.ts`.
