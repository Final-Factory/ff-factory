- **A card answered in typed words no longer stays clickable** (w1955, lothsahn: "Why was I being shown old cards that were
  decided?"). Typed words carry no mark of which card they answer, so FF Factory never closes one on a guess. Instead, when
  your orchestrator files or updates work in a turn you started, the tool result lists its open questions asked before your
  message ("open question N (...) may be answered by this"), once per turn, and its brief now says to call `close_question`
  for a card you answered in words, in the same turn. Docs: orchestrators.md, "Every orchestrator question is a card". Test:
  `orchestrators.test.ts` ("w1955").
