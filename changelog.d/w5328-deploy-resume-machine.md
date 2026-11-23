- **A worker that waits on another computer's update resumes on that computer** (w5328, lothsahn: "when a worker waits on
  deploys:[<machine id>] for a machine other than its own, resume it on that machine (a seat there)"). When a
  `blocked_on` deploy gate naming a known machine clears and the worker is on another computer (w5319 had been moved to
  lothdesktop by w2046 and waited for m5's daemon update to run a macOS check), the request records `resumeOn` and the send
  queue moves the resume there with the w2046 move: a fresh session in a free sandbox on that machine, on its branch for game
  work, or an agent seat for agent work. No new `blocked_on` argument: the deploy gate already names where the check runs.
  No room there, the machine held or offline: the resume waits Queued for it and never falls back to another computer. Work
  that exists only where the worker is (unpushed commits, a bench lock): it resumes in place and is told the check belongs
  on the named machine. Code: `server/deployResume.ts`, `Agents.deployMove`. Tests: `w5328DeployResume.test.ts`,
  `agentSession.test.ts`.
