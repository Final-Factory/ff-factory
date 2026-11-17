- **A stop says where the worker will resume, and a seated agent no longer holds a sandbox** (w4608, lothsahn). An agent on
  an agent seat (work that is not the game's, in its own clone) no longer keeps a stopped game worker's sandbox from its
  release, and `switch_branch` no longer waits up to 30 minutes on its turn (portal and daemon). `stop_agent` says whether
  the sandbox is released or what keeps it; `message_agent` to a worker between turns says where it resumes, and never
  reports a move before the worker is recorded in the new sandbox. Docs: machines.md (the release pass). Tests:
  `w4608Placement.test.ts`, `machineSandboxes.test.ts`.
