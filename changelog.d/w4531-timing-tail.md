- **`work_timing` reads shell waits and a late close honestly** (w4531). A shell `until`/`sleep` loop counts as what it
  polls (build, pair, tests, CI, else a wait), and the gap after a request's last worker turn keeps its cause for two
  minutes only; the rest until the close is `tail`, so a DONE recorded two days after its PR merged no longer reads as
  CI time. Tests: `workTiming.test.ts`.
