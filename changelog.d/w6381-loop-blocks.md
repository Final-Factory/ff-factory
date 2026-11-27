- **Fewer portal event-loop blocks** (w6381, lothsahn; after w6336). The stall profiles after the 0966c33 deploy
  (2026-11-27 10:42Z on) still showed 1-3 s blocks about every 10 s and one of 5.8 s. These paths now do their work once
  where they did it many times, or let the loop run between pieces:
  - The machine event's and the 5 s loop's FREE of each sandbox computes a machine's claims once
    (`Agents.sandboxesFree`, one claims memo for the 5 s loop). `PlaceAgain` memoizes its facts per claims memo.
  - `describeAllSandboxes` and the minute's `pushBenchPriorities` run in one placement pass and one claims memo
    (`Agents.placementRead`, `MachineManager.benchPass`). The bench priorities are read first and sent after.
  - state.json and work.json background saves serialize in slices (`stringifyPrettyPieces`) and write the text in pieces
    of about 1M characters. The bytes are the same as `JSON.stringify(v, null, 2)`, and `flushSync` is unchanged.
  - The board check's concept cache is filled in slices 5 s after start-up (`warmBoardTexts`), so the first
    `board_check` no longer works out every request at once.

  Bench (`scripts/bench-loop-blocks.ts`, a synthetic portal of 977 sessions and 6400 requests; measured on a workstation):
  - Machine event: 67-92 ms before, 14-17 ms after.
  - 5 s resend: 71-76 ms before, 17 ms after.
  - `describeAllSandboxes`: 20-25 ms before, 8-9 ms after.
  - Longest hold of a work.json save: 105-140 ms before, about 55 ms after.
  - First board check: 1.2-1.9 s before, 0.3-0.6 s after.

  Tests: `loopBlocks.test.ts`.
