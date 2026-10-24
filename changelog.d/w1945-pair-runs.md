- **Pair runs are placed as one unit** (w1945, lothsahn: "Can we make the dispatcher smart enough so it queues work properly
  that requires running together across multiple machines and doesn't waste slots?"). A worker asks for a check on several
  computers at once with `request_pair`: it files one pair request (`WorkItem.pair`) and Blocks the worker's own request on
  its report, so the worker's sandbox is released as its turn ends and the host leg's result resumes it. The dispatcher
  starts every leg together with `start_agent` `pair_sandboxes` (one FREE sandbox per computer, leg 1 the host; all checked
  before any starts, and a leg that fails to start stops the others), and the legs talk with `message_pair`. A pair is room,
  in the Queued line, the WRONG flag, the capacity ping and `decide_work queue`, only where that many computers it fits have
  room at once; legs go on computers that are not Macs unless it is a cross-OS pair (then a Mac only hosts), and timed legs
  never on the m5. An older Queued pair holds each computer's last free sandbox it fits from newer work of no higher
  priority. Docs: machines.md ("Pair runs are placed as one unit"). Tests: `w1945PairRuns.test.ts`,
  `orchestrators.test.ts`.
