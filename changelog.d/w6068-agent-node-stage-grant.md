- **BEAST gets its agent node again** (w6068, w5839 follow-up). Setting the Medium label on the unpacked node failed with
  "Access is denied" on every rollout, because BEAST's `F:\ffw` gives the unelevated daemon only a group's Modify, which
  lacks WRITE_OWNER. The cause was measured on BEAST: the ACL, not ReFS, the owner or the caller's integrity. The daemon now
  gives its own account Full on the stage before it unpacks, so every entry of the node holds it inherited, and
  `tools\node` still passes the label check. A grant that fails leaves the node there, warn-only. Applies at each machine's
  next daemon update. Tests: `agentNode.test.ts`.
