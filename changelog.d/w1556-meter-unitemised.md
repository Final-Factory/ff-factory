- **Spend: "unitemised" is itemised** (w1556, lothsahn: "Why is over half the cost on w1510 unitemized?"). w1510's worker read
  37% of its cost as unitemised: its conversation resumed with no saved tally (it began before w1484), so its base was 0, a
  compaction dropped the carried history, and every later call read the real base as unitemised; a carried resume on a cold cache
  also left the history it wrote again unitemised. Now the rewritten history is `carried`, a carried base is measured by the next
  compaction, a process with no tally rebuilds it from Claude Code's own transcript, and the meter reads that transcript before each
  call for what the stream never shows: reminders (`reminder`), hook output (`hook`), the CLAUDE.md and lists a resumed process sends
  again (`base`), the CLI's own task notifications (`brief`) and what a compaction carries over (`compact-carry`). Replayed on
  beast's 121 worker transcripts: unitemised 6.6% to 2.9% with the tally kept, 18.8% to 3.0% with a carried resume. Categories
  only: dollars and attribution do not move. Applies after a portal deploy and the machines' daemon updates. Docs: spend.md
  ("What unitemised was (w1556)"). Tests: `meterUnitemised.test.ts`.
