- **The dispatcher no longer waits on sandbox switches or a clean-up pass** (w5278, lothsahn). In a measured dispatcher
  hour (2026-11-23 06:30-07:30 UTC) its tools took 352 s of 1230 s, 75% of that in three: `machine_cleanup` (one call,
  153 s), `switch_branch` (6 calls, median 15 s, worst 36 s) and `start_agent` (39 calls, median 0.2 s, worst 43 s while
  it handed a released sandbox over). Now:
  - `start_agent` checks everything at once (placement, duplicates, gates, the sandbox being spoken for), and for the
    dispatcher a hand-over (the editor stopped, the branch switched) runs in the background, the request and the sandbox
    held meanwhile; the worker starts with its brief once the switch is done, and a start that fails sends a
    `[start failed]` message.
  - `start_agent` takes `branch`: a MOVED or HANDED BACK request starts on its pushed branch in one
    call, `switch_branch`'s refusals checked before it answers, instead of a `switch_branch` the dispatcher waited on
    first. Those notices now say so.
  - The dispatcher's `machine_cleanup` answers at once; the pass's result (or its error) comes as a `[clean-up]` message.
  Other callers (orchestrators over /mcp, the dashboard) keep the waiting behaviour. Needs a portal deploy.
