- **Worker prompt: start `unity-slot run` and builds in the background with `timeout` 7200000** (w3852): a pair run on biscuit waited 24 min
  for the single Unity slot and Claude Code's default 30-minute background limit killed it right after the grant, leaving a stale
  `Temp/UnityLockfile`. The rule is in the sandbox prompt (`server/agents.ts`) and `read_rules unity` (`server/workerRules.ts`).
