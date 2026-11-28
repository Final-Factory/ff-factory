- **Every open question card shows, once, and an answer anywhere closes its copies** (w6813, lothsahn: "I've answered all
  the cards but many were duplicates", then "I don't have cards for those six. Please investigate and figure out why those
  cards were missing in the dispatch window"). Four fixes:
  - The Waiting tab shows every open `ask_person` card, whatever its request's state. A card about a stalled or closed
    request says so ("stalled since; the question still waits"). A card whose request's own card asks the same thing hides
    only while that card is on the tab. Before, six cards that were open in the store (#150503, #150648, #151065, #151470,
    #152079, #152123) were on no tab: their requests were stalled, done or blocked (`shared/waiting.ts orchestratorAsks`).
  - A `[needs you]` that lists its answers is already a card with them as buttons. The orchestrator no longer asks it again
    with `ask_person`: the `[needs you]` message and the brief say so, and `cardCopyRefusal` refuses a copy once while the
    request is not blocked. Its reworded copies were second cards of the same question (w6778's #152099, w6792's #152081).
  - An answer to a `[needs you]` closes every open card that asks what it asked, whatever request the card names
    (`closeAsksAnsweredBy`). #151470, filed under w6786, was a copy of w6781's question.
  - A reply to a card that only asks back (it ends in a question mark and quotes none of the card's answers) leaves the card
    open. lothsahn's "What do you mean? …" closed #152055, and "Can check run on any other machines?" closed #150635; neither
    was asked again.

  Docs: orchestrators.md (ask_person, "With the rest"). Tests: `waitSummary.test.ts`, `orchestratorsWaits.test.ts`,
  `ask.test.ts`.
