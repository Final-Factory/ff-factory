- **LothDesktop's ffu CI runners now run their jobs at Normal priority** (w6163, step 2). The daemon sets each runner's
  scheduled task from priority 7 to 4, once the runner is between jobs. It also raises the listener and the cmd and
  conhost it runs under to Normal in class, I/O and memory priority, so the jobs it starts from then on run at Normal.
  Step 1's warn lines there showed both tasks at 7 and both listeners at BelowNormal.
  - A "parent" that started after its child (a reused pid) is left alone.
  - A raise that fails is tried again after 30 minutes.
  - BEAST stays log-only in code, and `runner_priority enforce` is refused for it (Ben's hold on its system settings).
  - `ops_worker machine_update runner_priority off|warn|enforce` sets daemon.json `runnerPriority` remotely; warn is the
    recovery.
  - runnerRestartScript now accepts only a whitelisted runner folder path, as the step-1 review asked.
