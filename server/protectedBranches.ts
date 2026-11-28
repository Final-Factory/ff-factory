/**
 * w6815: the remote branches no worker may delete, on any repo. It is the one list the sandbox guard reads
 * (server/guard.ts) for both delete routes: `git push --delete` / `git push <remote> :<branch>` and the GitHub API's
 * `DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`. Every other branch name is a feature branch a worker may delete.
 *
 * lothsahn, 2026-11-28: "It should block deleting master or a release branch, but not feature branches."
 *
 * This is a PROTECTED list, not an allow list of feature names: a name it matches is refused, and so is a name that is
 * not clearly a branch (judgeBranchDelete: a tag or other ref, HEAD, a name the shell would expand). When a name is
 * unclear, it goes on this list. Where each entry comes from (read 2026-11-28 from the repos' branch lists, their CI
 * workflows and the release docs):
 *   - default branches: the game repo, FFBox and the ff-agents plugin use master; ffu, FF Factory and most others main.
 *   - the game repo's release lanes: its CI builds and uploads on pushes to master and pre-1.0 (.github/workflows/main.yml
 *     `branches: [master, pre-1.0]`); FFBox's scripts/release_lane.py SETLIVE sets master's main app live on the Steam
 *     branch `development` and pre-1.0's on `pre-release`; the urgent lane (ci-release skill, urgent-release.md) pushes
 *     `release/<v>` and points `urgent/<v>` at the bump; pre-1.0 fixes go through `hotfix/*` PRs. 98 `release/<v>` branches,
 *     `release-0.50.0.42`, `release-next`, and the old version lines `0.15` and `0.16.1` are on the game repo today.
 *   - FFBox's release lane: its regenerated-files PR of each release, `ffbox/release-<version>-regenerated`, which FFBox
 *     closes and deletes itself (release_lane.py).
 *   - Steam branch names and old Steam lanes kept as git branches (`demo`, `steamdeck-beta`, `mp`, `ci/mp-beta-lane`,
 *     `ci/release-*`): unclear, so protected.
 *   - safety copies of someone's work (`backup/`, `ff-backup/`, `ff-saved/`, `rescue/`): a delete would lose the copy.
 *
 * To change it: edit this list, add the name to the cases in server/guard.test.ts ("w6815"), and say where the name
 * comes from. Matching ignores case and a leading `refs/heads/`.
 */
export interface ProtectedBranch {
  pattern: RegExp;
  why: string;
}

export const PROTECTED_BRANCHES: readonly ProtectedBranch[] = [
  { pattern: /^(?:master|main|trunk|default|gh-pages)$/i, why: "a repo's default or published branch" },
  { pattern: /^develop$/i, why: "the game repo's retired trunk (w1137), kept for its history" },
  { pattern: /^pre-1\.0$/i, why: "the game repo's pre-1.0 hotfix line: CI uploads it and sets it live on Steam's pre-release" },
  { pattern: /^(?:development|pre-release|prerelease|public|beta|demo|steamdeck-beta|mp|mp-beta|staging|production|prod|stable)$/i, why: 'a Steam branch name or a release lane' },
  { pattern: /^releases?(?:[/_-]|$)/i, why: 'a release branch (release/<version>, release-<version>, release-next)' },
  { pattern: /^(?:urgent|hotfix|hotfixes|lane|steam)\//i, why: "a release lane's branch (urgent/<version> marks an urgent release's bump; hotfix/ carries pre-1.0 fixes)" },
  { pattern: /^ffbox\/release-/i, why: "FFBox's release lane (its regenerated-files PR of a release, which FFBox closes and deletes itself)" },
  { pattern: /^ci\//i, why: 'a CI lane branch (ci/mp-beta-lane, ci/release-*)' },
  { pattern: /^v?\d+(?:\.\d+)+/i, why: 'a version line (0.15, 0.16.1), or a release tag of the same name' },
  { pattern: /^(?:backup|backups|ff-backup|ff-saved|rescue)\//i, why: "a safety copy of someone's work" },
];

/** The matching entry of PROTECTED_BRANCHES for a branch name, or undefined (refs/heads/ and case ignored). */
export function protectedBranch(name: string): ProtectedBranch | undefined {
  const b = name.replace(/^refs\/heads\//i, '');
  return PROTECTED_BRANCHES.find((p) => p.pattern.test(b));
}

/**
 * Why deleting this remote branch is refused, or undefined for a feature branch. A name that is not clearly a branch is
 * refused: empty, HEAD or @ (the guard does not resolve it), a ref outside refs/heads/ (a tag, a pull ref), or one with
 * characters the shell or git would expand or that no branch name carries.
 */
export function judgeBranchDelete(name: string): string | undefined {
  const fix = 'Feature branches may be deleted; this one stays (server/protectedBranches.ts, w6815). If it truly must go, hand that up to your orchestrator.';
  if (!name || /^(?:head|@)$/i.test(name)) return `Deleting the remote branch "${name}" is refused: name the branch itself, not HEAD. ${fix}`;
  if (/^refs\//i.test(name) && !/^refs\/heads\/./i.test(name)) return `Deleting ${name} is refused: only branches (refs/heads/...) may be deleted, never a tag or another ref. ${fix}`;
  if (/[$`*?[\]{}~^\\<>|;&'"\s]|\.\.|^-|\/$|\.lock$|@\{/.test(name)) return `Deleting the remote branch "${name}" is refused: the name is not clear (a variable, a glob or a character no branch name has). Write the branch name out. ${fix}`;
  const p = protectedBranch(name);
  return p ? `Deleting the remote branch ${name.replace(/^refs\/heads\//i, '')} is refused: ${p.why}. Master, main and release branches are never deleted from a sandbox. ${fix}` : undefined;
}
