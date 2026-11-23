- **A merge on green survives a close and a reopen** (w5316). A close dropped every gate, so a request closed and reopened
  while its worker's ci: merge-on-green gate waited came back New with nothing to wait on, and a dispatcher's re-block on
  the pull request merging replaced the gate with one nobody would merge. A close now keeps its gates, a reopen gives them
  back (the request is Blocked on them again), and a dispatcher block on the same pull request merging keeps the
  merge-on-green gate. w5234's ffu#998 sat green and unmerged for 2.5 h so on 2026-11-23. Docs: orchestrators.md
  ("Merge on green, a pilot"). Test: orchestrators.test.ts "w5316".
