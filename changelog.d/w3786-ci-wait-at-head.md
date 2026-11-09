- **A CI wait counts only the commit it waits on** (w3786, ben: "a wait with a head counts only runs whose head_sha
  equals it"). w3681's wait on ffu#500 at fa33b83 was cleared three times in 90 s (2026-11-09 03:05:50Z, 03:05:55Z,
  03:07:15Z) with "3 of 4 workflow runs failed", the runs of the old head 3514881, while every run at fa33b83 was queued:
  the gate kept no head, and the watch's CI reading was cached per pull request and taken at the head of its cached
  health read. Now a `ci:` gate keeps `blocked_on`'s `head`; the watch reads and caches CI per pull request and commit,
  asks GitHub only for that commit's runs (and drops any run whose `head_sha` is another), and a reading of another
  commit holds the gate until CI at the head is read. The 10-minute "no CI run" clear counts from the wait while the
  pull request still reads an older head. Tests: `blockers.test.ts` (w3786, fixtures from ffu#500's runs).
