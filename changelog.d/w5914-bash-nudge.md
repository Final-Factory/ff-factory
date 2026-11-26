- **A worker's shell approval asks for another route first** (w5914, lothsahn: "Every time a worker needs approval for a
  bash command, can we send it back a message asking if there's a non bash way to do it rather than blocking on bash
  approval?"). Every non-orchestrator session's first Bash or PowerShell question is denied with a nudge toward a dedicated
  tool, an MCP tool or an allowed command, and no card goes up. A card goes up only when the worker answers "No other route:
  <reason>", with that reason beside the command (once per command per agent per turn). That answer files one route
  request per need (deduped by program): low risk goes ahead; credentials, network, machine-wide changes, paths outside ffw
  or the fences wait for lothsahn with options. Once the route request is done and deployed, waiting workers are denied
  with the new route. A shell card also clears at once when a person's or orchestrator's message reaches the worker or its
  turn ends (the w5869 card that stayed). Workers, the ops worker and standing agents are told the rule up front. Nothing
  is ever allowed by it; every fence and deny rule stays. Docs: bash-nudge.md, orchestrators.md. Tests:
  `bashNudge.test.ts`, `agentSession.test.ts`, `routeRequests.test.ts`.
