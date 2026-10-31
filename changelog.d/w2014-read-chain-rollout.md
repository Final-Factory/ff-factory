- **Every worker gets the read-chain nudge** (w2014, lothsahn: "nudge workers to hand long read/search chains to Explore"). After 7
  days with half the workers in the pilot (beast, 132 control and 152 pilot Opus 5.5 sessions, measured): the nudge fired 333 times,
  98% on a real chain of five reads; after such a chain a worker handed off to a subagent 10% of the time against 3%, and read a
  third less past the fifth; cost per merged PR was the same within noise ($6.98 against $7.07, ±20%), and no pilot request was
  reopened (1 in control). `worker.readChainPilotPercent` now defaults to 100; under 100 brings a control arm back. Docs: spend.md
  ("Read chains handed to a subagent, a pilot", its result); the comparison: `scripts/read-chain-compare/`.
