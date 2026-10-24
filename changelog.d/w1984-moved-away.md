- **A worker moved to another computer leaves no bench ticket in its old machine's way** (w1984, with w1983). `stop_agent
  move_to` (`Agents.moveWorker`) now records `movedAway` on the old session, and `benchPriorities` marks it away in its
  old machine's `priorities.json` for 6 hours, even though it serves no request there any more: bench_queue.py parks its
  waiting tickets there (FinalFactory#2382). Test in `server/orchestrators.test.ts`.
