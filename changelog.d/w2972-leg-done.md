- **One leg of a fan-out can use merge on green** (w2972). The pilot took only a report with a `DONE: wNNN` line, so
  50e2b52d (w2895 row M2.17) declined it: "that would close the whole fan-out request, not just my row". A worker's
  `LEG DONE: wNNN <its leg>` now records its leg as done and never closes the request (only a `DONE` does, by the doneMarkers,
  workerEnded, recheckDone and cleanup paths); the pilot takes it, and its offer tells a leg worker to use it. With nobody
  else on the request the dispatcher is told to start its next leg. Docs: orchestrators.md "Merge on green, a pilot". Test:
  "w2972: one leg of a two-worker request" in `orchestrators.test.ts`.
