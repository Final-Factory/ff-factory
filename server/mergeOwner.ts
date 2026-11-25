// w5549 (the rogue-worker audit w5451, item 17): merge on green merges only the calling worker's own pull request.
// lothsahn: "File it: merge_on_green only merges the worker's own PR". FF Factory merges with the person's GitHub token, so
// before this a worker could arm merge_on_green on any pull request that token reaches (another worker's, a fork's) and
// FF Factory merged it on green. The check reads the pull request's head from GitHub (PrHealth: headRef, headRepo,
// crossRepo, server/blockerWatch.ts ghPrHealth), never the worker's word, when the worker arms it (Agents.declareBlocked,
// Orchestrators.mergeOnGreenAsk) and again at the merge (BlockerWatch.ownedAtMerge).
import type { PrHealth } from '../shared/blockers.ts';

/** Branches no request owns: the trunks and release lines every worker merges into. */
const SHARED_BRANCH = /^(develop|master|main|release\/.*)$/i;

/** What FF Factory knows, from its own records, about whose work a pull request may be. */
export interface MergeOwner {
  /** The request the worker arms it for (`w5549`). */
  request: string;
  /** The worker's sandbox branches (Agents.branchNow, the sandbox's record): its own in the game repo. */
  sandboxBranches: readonly (string | undefined)[];
  /** The game repository (owner/name), the repo a sandbox worktree is a checkout of. Unset: no sandbox branch counts. */
  gameRepo?: string;
  /** The request's own branch (an intake request's `ffbox/...`, WorkItem.source.branch). */
  sourceBranch?: string;
}

/** Whether a branch is named for the request: the id as a whole word (`w5549-merge-owner`, `design/w5549`, not `w55490`). */
export function branchCarriesRequest(branch: string, request: string): boolean {
  const id = request.trim().toLowerCase();
  if (!/^w\d+$/.test(id)) return false;
  return new RegExp(`(^|[^a-z0-9])${id}(?![0-9])`, 'i').test(branch);
}

/**
 * Why merge on green must not merge `ref` for this worker, or undefined when it is the worker's own: its head is a branch of
 * the pull request's own repository (no fork), and that branch is the worker's sandbox branch (in the game repo), the
 * request's own branch, or a branch named for the request. Unreadable heads are refused: the check never takes a guess.
 */
export function mergeOwnerProblem(ref: string, h: PrHealth | undefined, o: MergeOwner): string | undefined {
  const repo = ref.split('#')[0];
  if (!h?.headRef) return `FF Factory could not read ${ref}'s head branch from GitHub, so it cannot tell that it is yours`;
  if (h.crossRepo || !h.headRepo || h.headRepo.toLowerCase() !== repo.toLowerCase())
    return `its head is ${h.headRepo ?? 'a repository GitHub did not name'}:${h.headRef}, a branch of another repository (a fork), not of ${repo}`;
  const head = h.headRef;
  if (SHARED_BRANCH.test(head)) return `its head is ${head}, a shared branch no request owns`;
  const game = !!o.gameRepo && o.gameRepo.toLowerCase() === repo.toLowerCase();
  const sandbox = [...new Set(o.sandboxBranches.filter((b): b is string => !!b && !SHARED_BRANCH.test(b)))];
  if (game && sandbox.includes(head)) return undefined;
  if (o.sourceBranch && !SHARED_BRANCH.test(o.sourceBranch) && o.sourceBranch === head) return undefined;
  if (branchCarriesRequest(head, o.request)) return undefined;
  const yours = [game && sandbox.length ? `your sandbox's branch (${sandbox.join(', ')})` : undefined, `a branch named for ${o.request} (${o.request}-<what>)`].filter(Boolean).join(' or ');
  return `its head branch is ${head}, which is not ${yours}: it is not your request's pull request`;
}

/** The refusal blocked_on answers when merge_on_green names a pull request that is not the worker's own. */
export function mergeOwnerRefusal(ref: string, why: string): string {
  return (
    `merge_on_green refused: FF Factory merges on green only your own pull request (w5549), and ${ref} is not yours: ${why}. ` +
    `Push your work to your own branch (your sandbox's, or one named for your request in a clone) and wait on that pull request; ` +
    `a pull request of another request is that request's worker's to merge. Nothing was recorded.`
  );
}

/**
 * Why FF Factory must not merge `ref` now, at the merge (BlockerWatch): its head, read from GitHub again, is not the branch
 * of the pull request's own repository that the check passed when the worker armed it (`armed`, the gate's headRef). A
 * gate armed before this check (no headRef) is not merged either: its worker merges it by hand.
 */
export function mergeTimeProblem(ref: string, h: PrHealth | undefined, armed: string | undefined): string | undefined {
  const repo = ref.split('#')[0];
  if (!armed) return `merge on green was armed on ${ref} before FF Factory checked that it is the worker's own pull request (w5549)`;
  if (!h?.headRef) return `FF Factory could not read ${ref}'s head branch from GitHub to check that it is still the worker's own (w5549)`;
  if (h.crossRepo || !h.headRepo || h.headRepo.toLowerCase() !== repo.toLowerCase() || h.headRef !== armed)
    return `${ref}'s head is ${h.headRepo ?? 'an unnamed repository'}:${h.headRef}, not ${repo}:${armed}, the worker's own branch it was armed on (w5549)`;
  return undefined;
}
