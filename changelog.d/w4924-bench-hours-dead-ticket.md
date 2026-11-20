- **Bench hours no longer count a dead ticket to now** (w4924, r341). The machine's bench report used to treat an exclusive ticket
  with a grant and no end line as held until the report was made. A machine that went offline or slept mid-hold never wrote
  the "gone" line, so lothlaptop's w3881 ticket counted as 60 exclusive minutes an hour from 2026-11-10 to 11-20 (the "22.3 h"
  r341 saw). `readBenchHours` now passes `benchHours` the tickets whose helper still runs (`queueTickets`). An open ticket
  outside that set ends at the next exclusive grant, or else at the history's last event. Needs a daemon update on each
  machine.
- **Workers are told that a timed A/B gates done only for a performance goal** (lothsahn: "Timed tests gate only perf-goal
  requests; others merge and time after"). Any other change merges on green CI and hands up its after-merge timing as a
  follow-up that reverts the change if it regresses. They are also told that an A/B's legs share one bench ticket
  (`server/agents.ts`, docs/orchestrators.md). Needs a portal deploy.
