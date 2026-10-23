- **m5 takes no timed runs, and timed or exclusive-lock work goes to the smallest computer by default** (w1861, w1872;
  lothsahn: "The m5 should not be used for timing runs because Ben runs stuff on it personally"; "favors placing jobs that
  need an exclusive lock or timing runs on machines that have a smaller number of editors or slots"). A machine setting,
  `noTimedRuns` (add_machine `no_timed_runs`, m5 by default), keeps timed work off a computer. Placement never sends it
  there, a start pinned there is refused back to the caller with the computers that take it, and its daemon tells the
  game repo's bench queue to refuse every exclusive ticket there. "Next timed work" now ranks the computers that take
  timed runs: fewest agent slots, then the editor limit, then the fewest live workers, then queued legs, then
  placement.prefer, BEAST last. The ranking is the default, unless a machine is named. Docs: orchestrators.md
  ("Timed and exclusive-lock work"), machines.md ("Placing work"). Tests: `w1861NoTimedRuns.test.ts`,
  `w1872TimedRank.test.ts`.
