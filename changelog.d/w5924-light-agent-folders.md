- **Agent-only work gets a light agent folder of its own instead of a game sandbox** (w5924; lothsahn). A request that
  needs only an agent slot (another repo, FFU, a review) starts in a new empty folder, `<sandbox_root>/agent-work/agentN`,
  counted against the computer's agent cap only: a computer whose game sandboxes are all full takes it while an agent slot
  is free. It keeps the fence, write scope, transcript lock, caps, the urgent keep-between-turns rule and holds; it has no
  game checkout and no Unity editor (`unity` and `switch_branch` refuse there). An FFU or other agent-only worker already
  in a game sandbox moves to one when it next resumes (its temp folder stays; files left in the game sandbox go to the
  orphan save). Empty folders whose work is over are deleted by the release pass; one whose clone holds unpushed work is
  kept and said once. `list_sandboxes`, system_status, the Capacity block and the page show them apart from game
  sandboxes. The folders sit inside the sandbox root, so the worker fence is unchanged. Needs a portal deploy and each
  machine's daemon update; a computer on an older daemon places as before. docs/machines.md, "Light agent folders (w5924)".
