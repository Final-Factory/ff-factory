- **The nightly run, its pair runs and its timed legs run on the pool `vault.unattributed.nightly` names** (w4306, lothsahn:
  w4303, the 2026-11-15 nightly e2e run, was held on lothsahn's Claude pool at 99% weekly although config said `ben`). The
  schedule files the run for `intake.nightly.run.person` when that is set, and a request with a person was never counted as
  nobody's work, so the mapping was skipped: `unattributedKind` now counts sources `nightly-run` and `nightly-review` as nightly
  whoever they name (`person` still hears a missing night). And a pair run or timed leg filed from any request copied only its
  `requestedBy` (the system payer for nobody's work, in every kind: intake, FFBox, nightly); it now takes its parent's payer
  (`inheritedPayer`: a take-over's `runsFor`, else its kind in the new `WorkItem.unattributedAs`). Applies to requests already
  open from the next worker process start. Docs: vault.md section 10, intake.md. Tests: `orchestrators.test.ts` (w4306).
