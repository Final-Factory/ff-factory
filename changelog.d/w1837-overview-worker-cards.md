- **The Overview can show one card per worker** (w1837, Ben: "a mode where it shows an individual card for every worker
  ... concise, compact, show the status ... a title that briefly describes what it's doing ... what machine it's on"). A
  Machines / Workers switch in the Overview's header; the machine view is as it was. Each card says its status in the
  dashboard's colours and for how long, what it does in a few words (the worker's title without its request id), what it is
  on now (the tool mid-turn, the job or check-in, what a person must do, what blocks it), its request, whose it is, its
  machine and sandbox, its pull request, a Live badge and its cost; a click opens the worker. Cards are grouped needs a person,
  working, queued or blocked, idle or stopped, the longest in a state first, with filters by group, person and machine. The
  mode and the filters are kept in the browser. Built from the fleet the page already has: no new polling. Code:
  `shared/workerCards.ts`, `web/src/components/WorkerCards.tsx`. Tests: `workerCards.test.ts`, `e2e/fleet.spec.ts`.
