- **A machine's update waits for a timed run there** (w1861, after m5's daemon update and agent-tools job ran inside a timed
  A/B leg of w1780 on 2026-10-23). After a verified portal deploy, the machine rollout holds a machine's daemon update and its
  agent tools publish while its daemon reports a timed run holding its bench queue exclusively, until the bench has been free
  for 90 s (a timed script lets go between its legs for seconds) and for 45 minutes at the most. The report names the run it
  waits for, and a follow-up says when the machine was updated. Docs: ops-worker.md ("After a verified deploy"). Tests:
  `machineRollout.test.ts`.
