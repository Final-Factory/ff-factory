- **Read chains handed to a subagent, a pilot** (w2014, lothsahn: "nudge workers to hand long read/search chains to Explore").
  Half of worker sessions (`worker.readChainPilotPercent`, default 50, drawn apart from the other pilots) get a PostToolUse hook:
  after five Read, Grep, Glob or read-only Bash calls in a row, one line pointing at ff-agents:Explore or scout, once per chain.
  Runs of five or more reads hold 20-30% of worker calls (measured, w2008). Docs: spend.md ("Read chains handed to a subagent, a
  pilot"). Tests: `readChain.test.ts`.
