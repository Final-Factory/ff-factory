- **A worker that makes no progress mid-turn is ended and resumed; an interrupt says what became of it** (w3673,
  lothsahn: "Figure out and get 3510 working urgently"; worker 316ded29 sat "running, live" for 12 h on lothdesktop).
  - Hang watch (machine/agentHost.ts `HANG_WATCH`): mid-turn with no transcript line, tool call or MCP call from its agent
    for 30 min, the daemon reads its tools' CPU and again 5 min later. 30 s of CPU or more keeps it (a build, a timed run),
    flagged in its status detail; less ends its host's tree with "its agent host made no progress ...", and the portal
    resumes it once (w2884's `HOST_DIED`). The clock goes on across daemon restarts (`daemon.progress` in its host folder);
    a message held mid-turn does not reset it.
  - `interrupt_agent` waits up to 30 s for the daemon's answer and says it: interrupted, delivered but its turn not stopped
    (the agent may be hung), not delivered (machine offline, no such agent), or no answer. The daemon logs every interrupt.
  - The leftovers reaper ends a live worker's `until`/`while ... sleep` wait loop that started before its current agent
    host (the claude it reported to is gone); builds and the current agent's loops are kept.
  Applies after a portal deploy (the interrupt answer) and each machine's daemon update. Tests: `hostWatch.test.ts`,
  `machines.test.ts`, `leftovers.test.ts` (w3673).
