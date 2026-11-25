- **The agent node's firewall rule lets in the tailnet only** (w5581, lothsahn: "narrow BEAST's agent-node firewall rule
  to the tailnet"). "Final Factory agent node" allowed `<root>\tools\node\node.exe` in from every address; on BEAST that
  node serves the instance portals (Light Tree on 8891, Lens on 8892) to the whole LAN. `firewall.ps1 -AgentNode` now
  makes it from `100.64.0.0/10` and `fd7a:115c:a1e0::/48` only (any protocol and port: a new instance takes a new one),
  and drops inbound allow rules for that path outside the install's groups. The tools run's check reports a rule that
  lets the node in from any address (`wide`), so the rollout's elevated rerun over ssh narrows it on every machine.
  Revert: docs/worker-install.md, "The agent node's firewall rule". Tests: `agentNode.test.ts`, `ffuSlots.test.ts`.
