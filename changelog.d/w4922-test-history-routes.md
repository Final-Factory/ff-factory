- **Every local test run reaches the test history, tagged with its request** (w4922, lothsahn: "the actual test executions
  should be ingested deterministically with every work order"). The daemon also reads the machine's spool,
  `$FF_WORKER_ROOT/test-history/`, so a run in a temp worktree is collected; a run is tagged by the worker session in its
  record, else by its sandbox's workers, else marked untagged (`runs.tagged`, `{query: "local_runs"}`); a run cut short is
  recorded as incomplete from its running file after 2 hours. Workers and orchestrators label a failure with
  `{query: "set_label"}`, recorded as theirs, and the labeller never overwrites it. Needs a portal deploy and a daemon update
  on each machine.
