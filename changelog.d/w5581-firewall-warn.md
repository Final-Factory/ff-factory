- **The agent node's firewall check now finds a rule open to any address, and only warns** (w5581, lothsahn: "narrow
  BEAST's agent-node firewall rule to the tailnet, check nothing breaks"). BEAST's "Final Factory agent node" rule allowed
  Any (the ops worker's elevated read, 2026-11-25) while every tools run since #1190 said "the agent node (tailnet only)".
  `firewallCheckScript` now counts a tailnet-only path's rule as narrow only when its RemoteAddress is read and holds
  the tailnet alone, reads a rule missing from the bulk read on its own, and prints what it read (`from`, `read`) and
  each connection to that program from outside loopback and the tailnet (`peer`). Warn stage: a wide rule gives
  "WARNING: tailnet-only rule (w5581, warn only)", without the words that make the rollout rerun the tools elevated, so
  nothing is narrowed by this change; a separate PR enforces once the peers are measured at zero. Tests: `agentNode.test.ts`
  runs the script in PowerShell against stand-ins that return BEAST's values.
