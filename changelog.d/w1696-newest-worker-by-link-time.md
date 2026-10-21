- **A request's newest worker is the one it was last given, not the last in its worker list** (w1696, ben: "Fix it so a
  request stays with its own worker unless the dispatcher or a person actually moves it"). Sending a request again to a
  worker already on it kept that worker's first place in `sessionIds`, so a worker given a side job earlier stayed
  "newest": the release pass stopped w665's worker d558ba14 at 15:47 and 16:13 UTC on 2026-10-21 as "its request is with
  another worker now (w665: dc19eb45)" and its temp folder was swept. `latestWorker` and `newestFirst`
  (`shared/blockers.ts`) order a request's workers by their `links` time; `isWith`, `workOver`, `resumeOrder`, a gate's
  resume, the shown report and branch and the fleet's holder all read them, and a merge carries the merged request's
  link times along. Docs: orchestrators.md ("A request is with the worker it was last given"). Tests:
  `blockers.test.ts`, `orchestrators.test.ts` (w1696).
