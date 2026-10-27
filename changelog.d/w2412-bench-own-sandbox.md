- **A worker's own exclusive bench ticket no longer closes its own sandbox editor after it moved sandboxes** (w2412,
  lothsahn: "during a worker's own exclusive bench ticket, FF Factory must leave that worker's own sandbox editor open").
  On biscuit, 2026-10-27, worker edc18110 (w2338, the Leech timed leg), placed again in slot2 after slot3, had its slot2
  editor closed at the grant of its tickets t00002451 and t00002458.
  - The bench turn's holder now owns, besides its ticket's sandbox, the sandbox its checkout (the ticket's cwd) is in and
    the sandbox its worker session is placed in now (machine/benchTurn.ts `holderSandboxes`, `holdsSandbox`;
    machine/daemon.ts `timedHolderHere`). Its editor, players and builds there are left; other workers' are still quieted.
  - A bench warning for an editor's own life ticket (`editor:<sandbox>`, w1962) is logged as that and sends nothing,
    instead of "no session editor:slot2 here" (server/benchWarnings.ts).
  Tests: `w2412BenchOwnSandbox.test.ts`.
