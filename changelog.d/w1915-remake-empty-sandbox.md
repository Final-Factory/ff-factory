- **A sandbox folder that came back empty after a drive reset is made again too** (w1915: LothLaptop's slot1 was an empty
  folder, a worker's own directory, so w1918's remake skipped it and slot1 stayed git "unknown"). The pool's remake now
  counts a missing or empty folder as gone and makes the worktree in it. Tests: `machineSandboxes.test.ts`.
