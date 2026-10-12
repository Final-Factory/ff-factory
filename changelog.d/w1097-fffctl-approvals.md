- **`fffctl approvals`: the prompt count the orchestration worker may run** (w1097). `fffctl approvals [--since D]
  [--split D]` runs the current release's `scripts/cleanup-approvals.ts` over the portal's transcripts as the portal's
  account and prints counts only: per day, the clean-up prompts by kind, and every prompt by kind before and after the split
  day. The worker's guard barred running `node` and reading `/srv/fff`, so it could not run the count itself; `fff-ops-priv`
  now passes exactly this form (two date options), and a reason Claude Code gave is shown only as its leading plain words.
  Needs a portal deploy (the VM's fffctl and fff-ops-priv come with it). Docs: ops-worker.md. Tests:
  `cleanup-approvals.test.ts`, `configAccess.test.ts`, `fff-ops.test.sh`.
