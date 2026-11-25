- **A clean-up pass that a restart cuts off now names the step it was in and the steps it had done** (w5795). This change
  is report-only. On LothDesktop the first pass with pass timing started at 19:54 UTC on 2026-11-25. An update cut it off
  61 minutes later, with no record of which step took the hour. The pass marker (`cleanup-pass.json`) now records each
  step as it begins, and the next start logs it: `..., was cut off 61 min later, in its stale step (57 min in it), ...;
  steps done before: regular 4 min`.

  Needs a daemon update on each machine.
