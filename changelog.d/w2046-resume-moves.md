- **A resuming worker whose computer is full moves to one with room** (w2046, lothsahn: "We should not have idle slots if
  there is queued work"). A message that waits 20 s only for room on its worker's computer (no sandbox free there, its agent
  cap, its sandbox's seats) now moves the work: FF Factory picks a computer as for new work (placement.prefer, avoid, hold,
  minPriority, Live view/build lists, timed work only where timed runs go; a pair leg never on another leg's computer, a Mac
  only as a cross-OS host), stops the old worker, saves and pushes its sandbox and releases that sandbox at once, and starts
  a fresh session for the request in a free sandbox there on its branch, with its last report, its brief and the waiting
  message in the hand-off. It stays only when the work needs its own computer (unpushed commits, unsavable changes, a timed
  run holding the bench lock, a timed leg, a pin), and its Queued line says why; any other such wait beside room elsewhere
  is flagged WRONG on the ledger. Docs: machines.md ("A resume on a full computer moves to one with room"). Tests:
  `resumeMove.test.ts`, `agentSession.test.ts`, `workState.test.ts`, `orchestrators.test.ts` (w2046).
