- **A conflict on a pull request wakes only the request that owns it** (w3572, ben: "Requests that only wait for another
  request's PR to merge should stay blocked until it merges or closes, not wake on its conflict"). A `pr:` wait clears on
  the PR's conflict only when the waiting request owns it (the ledger links it, its description names the request with
  `Request:` or `Part of:`, or its head branch is the request's); every other waiter stays Blocked until it merges or
  closes. The requests that own it are told once per head commit (log line, and their worker messaged). ffu#397 (w3445's)
  had woken w3423, w3416, w3419, w3421, w3422 and w3424 each several times an hour with "merge main in, resolve, push".
  Docs: machines.md ("A PR that cannot get CI"). Tests: `blockers.test.ts`, `orchestrators.test.ts` (w3572).
