- **A daemon update refused for a full disk is retried by itself** (w4421). The machine rollout re-sends an update a
  machine refused with ENOSPC once that machine is online with its disk back over its warning line + 5 GB, up to 3 times
  per rollout, instead of waiting for the next deploy (`server/machineRollout.ts` `retryDiskFull`; docs/ops-worker.md).
