- **`work_timing`: where the wall time of the last finished requests went** (w4531, lothsahn: "Do two parts to the
  analysis: time spent queued or blocked (scheduling issues) and time spent working after being scheduled"). A worker
  whose open request has both the ledger-read and the transcript-read grant measures the last N done requests (default
  50): part 1, filing to the first worker turn, split by what the ledger log said it waited for; part 2, the first turn
  to the last DONE, split by what its workers' transcripts were doing (compiles, editor, tests, builds, bench, pair runs,
  CI, merges, critics, failed calls, waits, thinking) and what each turn ended on. Totals, median, p90 and each cause's
  share with the requests behind it; `until` measures an earlier window to compare. Docs: orchestrators.md ("Where a
  request's wall time went"). Tests: `workTiming.test.ts`.
