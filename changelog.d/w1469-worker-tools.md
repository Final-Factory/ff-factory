- **Workers no longer carry three tools they never use** (w1469, lothsahn: "trim the base"). Workflow (0 calls by workers in a week
  on beast: it runs only on a person's own opt-in), ScheduleWakeup (2: /loop pacing; workers come back with wake_me) and
  AskUserQuestion (1: nobody watches a worker's terminal) are left out of a worker's tool definitions (`disallowedTools`, which
  the SDK removes from the model's context), which every model call reads again. PowerShell, ListAgents and ReportFindings stay.
