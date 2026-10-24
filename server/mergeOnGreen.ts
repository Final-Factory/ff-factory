// The merge-on-green pilot (w2045; docs/orchestrators.md "Merge on green, a pilot"; docs/spend.md "Merging green PRs with no
// model turn, a pilot"). lothsahn chose it over a Sonnet CI helper: "Have FF Factory merge green PRs itself with no model; the
// worker reports before the wait". A share of requests, by a hash of the REQUEST id drawn apart from the other pilots'
// (autoCompact.ts inPilot; w2043's fresh-session pilot splits requests by `fresh:`, so the two read as a 2x2): when such a
// request's worker waits on CI with blocked_on, it is told it may leave its after-merge report (merge_on_green), and on green
// CI the blocker watch merges the pull request and files that report (blockerWatch.ts clearAll, Orchestrators.mergedOnGreen).
import type { Config } from './config.ts';
import { inPilot } from './autoCompact.ts';

/** The ledger's mark on a request in the arm, stamped when its worker is told; the comparison counts it. */
export const MERGE_ON_GREEN_MARK = 'merge-on-green pilot (w2045)';

/** The pilot's share of requests in force (config worker.mergeOnGreenPilotPercent, 0-100; default 0, off). */
export function mergeOnGreenPercent(cfg: Partial<Pick<Config, 'worker'>>): number {
  const v = cfg.worker?.mergeOnGreenPilotPercent;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(100, v) : 0;
}

/** Whether this request is in the arm: a stable share of request ids, apart from the other pilots'. */
export function inMergeOnGreenPilot(requestId: string, cfg: Partial<Pick<Config, 'worker'>>): boolean {
  return inPilot(`mergeongreen:${requestId.toLowerCase()}`, mergeOnGreenPercent(cfg));
}
