- **A worker that only waits on other work frees its sandbox at once** (w1944, lothsahn: "Why is m3 not taking work when
  there's stuff to do?"). A worker whose still-open line waits on another request, the orchestrator, or a worker only the
  dispatcher starts ("waiting on a Windows or Linux pair worker to run …"), with no `blocked_on`, now releases its clean,
  pushed sandbox at once, as a declared block does (w890), not after 30 minutes idle; a message places it again. On
  2026-10-23 such a worker held m3's only sandbox 29 minutes while 18 requests were queued. Docs: machines.md ("Placing
  work"). Tests: `w1944ReleaseWaits.test.ts`, `orchestrators.test.ts`.
