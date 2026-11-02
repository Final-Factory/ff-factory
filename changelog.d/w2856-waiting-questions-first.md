- **Every Waiting on input card leads with its question** (w2856, lothsahn: "Can we have it have the question at the top so
  it's easy to answer?"). The card opens with the question in plain text (a wait with no ask_person card leads with what is
  needed in one line: the step to take, else what it is); its stills and clips, then its answers with the recommended one
  first and each one's line, sit right under it. The request id, title, who acts and how long it has waited move to a footer
  below the answers; the log stays behind Details. The tab's order: within each section the cards whose answer lets a running
  worker go on come first (a pending permission, a declared wait, or an unanswered [needs you] from a live worker), marked
  "A worker waits on this" with an amber edge, then the rest; oldest first within each group. What counts as Waiting on
  input is unchanged. Docs: orchestrators.md ("What a waiting card says"). Tests: `waitOrder.test.ts`,
  `e2e/waitingCards.spec.ts` ("w2856").
