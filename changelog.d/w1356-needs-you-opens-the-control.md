- **Each "Needs you" item opens the card with its buttons, and no decision is missing from the tab** (w1356, Ben: "i liked
  when the NEEDS YOU yellow box when you clicked on it it opened the thing that literally had the accept or decline button
  right there on the panel it opened"). w1228 folded every intake approval, question and design question into one item
  ("6 requests wait on you") that opened the top of the Waiting on input tab; and the tab left out any decision whose request
  had a worker mid-turn (its live state says Working), so a question the sidebar counted had no card to answer it (measured:
  10 counted, 8 cards). Now each decision is its own item, which opens the tab scrolled to its card (Approve, Decline… or the
  answer box in view), and the tab lists every decision on a person whatever its request is doing. Permissions and delegations
  stay before the ledger's decisions in the list. Docs: intake.md ("Approval, caps and auto-approve"). Tests:
  `waiting.test.ts`, `intake.spec.ts` (every kind, desktop and phone).
