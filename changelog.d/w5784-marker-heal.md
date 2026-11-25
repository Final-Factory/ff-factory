- **A publish-skills marker that names no checkout heals on the next agent tools publish** (w5784). The publish put back
  whatever `~/.claude/final-factory-agents-checkout` held before `registerAgents.sh` ran, even a path that no longer
  existed, so once BEAST's marker named a removed `F:/ffw/tools/ff-agents-run-jadTAl/final-factory-agents` run clone
  (2026-11-25, from 13:33Z on), every publish kept it there and workers' publish-skills stopped at its checks. Now a
  marker that is empty or names a folder without `.claude-plugin/marketplace.json` names FF Factory's lasting checkout
  (`<root>/tools-medium/final-factory-agents`) instead; a person's real checkout is still kept as it is.
