- **The portal no longer holds its event loop on transcript reads that grow with the data** (w2026, lothsahn: every machine
  dropped off the portal at 10:16-10:20Z on 2026-10-24, and fff-health restarted it every 9-21 minutes). The ledger sweep's
  "opened by its own worker" check, two minutes after each start and every five minutes after, read the last 2,000 or
  100,000 lines of every open and recently auto-closed request's worker transcripts whole and synchronously; it now reads
  only what was appended since its last pass, in pieces (`Store.prCreateResults`). The spend backfill and repairs after a
  start read transcripts off the main thread in slices, leave ones over 128 MB alone, and remember a session with no turn
  instead of reading it again on every start (`server/spendJobs.ts`). A tail read of a compressed transcript comes from a
  tail file beside it instead of unzipping it whole. A stall of 3 s or more now logs the functions that held the loop
  (`stall profile:` in the journal, `server/stallProfile.ts`; docs/portal-logs.md). Local bench:
  `node scripts/loop-lag-bench.ts`. Tests: `spendJobs.test.ts`, `transcriptReads.test.ts`, `stallProfile.test.ts`.
