- **Every "Waiting on input" card says what you need to answer** (w1868, lothsahn: "The existing cards are impossible to know
  what I need to answer"; w1871 merged in). Each card on the portal's Waiting on input tab, each waiting request in
  `list_work` and each `[needs you]` message has six parts: what it is in one plain line, who must act and for how long, the
  question whole (never cut off), the answers with the recommended one and what each does and costs (or the one step), its
  stills and clips in the card (a clip plays there), and what happens after the answer. A card overtaken by events says "May be
  out of date". Intake cards say what the item is and what Approve and Decline do. `waiting_on_person` takes `about` and
  `after`, and refuses a still on the worker's own machine with no published copy. Every open `ask_person` question of your
  orchestrator is a card of its own (a click answers it as the chat's does; `close_question` withdraws one). Two questions on
  one request keep their own answered state: answering the first no longer blocks or hides the second (w1821). Docs:
  orchestrators.md, "What a waiting card says". Tests: `waitSummary.test.ts`, `orchestrators.test.ts`, `e2e/waitingCards.spec.ts`.

- After the deploy, the live list showed three slips, now fixed: a reporter's wait was cut mid-word (it now shows the worker's whole line), a brief that opens on a person's quote gave a half quote as "what it is" (the title is used instead), and "still open" counted as a visual question.
