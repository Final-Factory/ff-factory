- **A slow or hung agent tools publish no longer stalls a machine rollout** (w5967, lothsahn's brief: "a hanging publish step
  gets a timeout and a logged reason, does not hold the machine's update lock, and does not block other machines"). On
  2026-11-26 BEAST's tools job for portal 0dd1e39 ran about 20 minutes while biscuit, LothDesktop and m5 waited behind it,
  and `machine_update beast` was refused all that time. The rollout now runs each machine's tools publish beside the
  next machines' updates instead of inside the one-at-a-time tick (`machineRollout.ts`, `publishTools`), gives it a
  40-minute deadline that fails it with a named reason, and waits 35 minutes over the link (was the link's 25-minute
  default, shorter than BEAST's slow runs). On the machine, the update job (`scripts/worker/linkJob.ts`) gives a tools
  run 30 minutes, then reports it failed with the reason and exits, so job.json ends and the update lock is free again.
  Tests: `machineRollout.test.ts` and `linkJob.test.ts` (w5967 cases).
