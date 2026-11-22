import { gatesOf, isWith } from '../shared/blockers.ts';
import { WORK_OPEN, type SessionInfo, type WorkItem } from '../shared/types.ts';

/**
 * Why a save of a sandbox's uncommitted work must not push `branch` on `machineId` now (w5067), or undefined: a worker
 * on that branch there (in the sandbox, or released from it on that branch) is the latest worker on an open request
 * that waits on a CI gate (blocked_on prs "ci:owner/repo#n"; the gate clears when the checks finish,
 * server/blockerWatch.ts). A push to the branch then cancels the run in progress (the game repo's workflows cancel a
 * pull request's earlier run on a new push, Documentation/CI-Runs.md). On 2026-11-22 the release save of de2893f4
 * (blocked on CI for w5052's PR #4137, and waiting on Ben for w5053) pushed 6d6488f046 to sandbox/slot1-w5052 at
 * 04:11Z and cancelled the run; its worker reverted it in 3fca63219c, a CI run lost. Any of its gates counts, not
 * only when every request waits on CI (Agents.ciWait): de2893f4's other request waited on a person.
 */
export function ciPushHold(
  machineId: string,
  branch: string,
  sessions: Iterable<SessionInfo>,
  workOf: (sessionId: string) => Iterable<WorkItem>,
  branchOf: (s: SessionInfo) => string | undefined,
): string | undefined {
  const refs = new Set<string>();
  for (const s of sessions) {
    if (s.kind !== 'worker' || s.machineId !== machineId) continue;
    if ((s.placeReleased ? s.placeReleased.branch : branchOf(s)) !== branch) continue;
    for (const w of workOf(s.id)) {
      if (!WORK_OPEN.includes(w.status) || !isWith(w, s.id)) continue;
      for (const g of gatesOf(w)) if (g.kind === 'ci') refs.add(g.ref ?? 'its pull request');
    }
  }
  return refs.size ? `CI runs on ${[...refs].sort().join(', ')}` : undefined;
}
