- **Runners waiting in a bench queue show Blocked on the lock, and the holder says it holds it** (w1968; lothsahn: "Why
  does Beast show an exclusive lock but a bunch of working runners? Shouldn't some of them be blocked?"). list_sandboxes,
  the machine view, the worker cards and the sidebar read the same queue waits as list_work's Blocked: a
  worker whose own bench ticket (or Unity slot) waits reads "Blocked: waiting for the exclusive bench lock on beast (held
  by w1891 / t00001009 since 02:10 UTC, next in queue)", and the holder "Working: holds the exclusive bench lock on beast
  (t00001009 for w1891, since 02:10 UTC)". Docs: orchestrators.md ("Ledger"). Tests: `w1968AgentQueue.test.ts`.
