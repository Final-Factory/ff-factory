- **A worker's shell output over 10,000 characters goes to a file** (w2002, lothsahn: "File the compaction pilot plus the
  base-context trim and noise fixes"). Workers start with Claude Code's `bashOutputMaxChars` at 10,000 instead of 30,000: past it
  the whole output is saved to a file and the worker gets a 2,200-character preview and the path. Shell results are 24% of what a
  worker's later calls re-read; the cap cuts up to 3.7% of all context tokens (beast, 2026-10-17..24, measured, before any
  read-back). Docs: spend.md ("Shell output over 10,000 characters goes to a file"). Tests: `machineUnityMcp.test.ts`.
