- **A worker can stop a timed run** (w2442): `timed_place` with `cancel: "tr_..."` (and `what`: the reason) stops a run of
  its own request or of a request it names. A sent or running run's daemon ends its leg's player and gives its bench ticket
  back (the w2218 `timed_run_cancel`), and the run's worker gets a FAILED result with the reason. lothsahn, 2026-10-28:
  "Stop w2434's timing run on LothLaptop now"; w2434's worker had found no way to cancel one.
