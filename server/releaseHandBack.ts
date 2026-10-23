/**
 * A release build hands its sandbox back on its own branch (w1856). Ben's request, from worker c28c5061's report: "the
 * urgent release build w1836 (Build 1.0.0.12, on BEAST) left sandbox beast/slot1 checked out on the release branch
 * `urgent/1.0.0.12` with stale build caches. The next worker given that sandbox committed onto the release branch by
 * mistake".
 *
 * How a sandbox gets there: the urgent lane builds the checkout it runs from, so its builder puts its sandbox on the bump
 * commit (`git branch urgent/<v> <sha>`, then switch_branch; the ci-release skill's urgent-release.md, step 3.1) and runs
 * the game repo's scripts/release/urgent_release.py. Nothing switched it back: build_plan done lifted the hold and told
 * the workers paused for the build to carry on "in this same conversation and sandbox", whose branch was now the
 * release's; prepareForNewWork switches only a sandbox a released worker left on its branch.
 *
 * Three guards, each enough on its own for the w1836 slip:
 *  1. switch_branch to a release branch records the branch the sandbox left (SessionInfo.releaseSwitch), and build_plan
 *     done switches every sandbox still on that release branch back to it (Agents.handBackRelease), before the paused
 *     workers are told to carry on. When that branch is gone or checked out elsewhere, a fresh hand-over branch from
 *     origin/master (handOverBranch).
 *  2. New work is never started on a release branch: prepareForNewWork switches such a sandbox to a fresh branch first,
 *     and every new worker's handover warns when its sandbox is on one (work.ts handoverNote).
 *  3. The shell guard refuses a commit, merge, cherry-pick, revert, am or pull in a sandbox on urgent/* (guard.ts
 *     checkReleaseBranchCommit): urgent/<v> only ever points at the commit the lane builds; nobody commits on it.
 *     release/<v> is a bump branch, which its release worker may legitimately commit on, so it gets 1 and 2 only.
 * The build caches are the game repo's (urgent_release.py hand_back, w1856): the tree as committed, Library/Bee,
 * ScriptAssemblies and ScriptMapper cleared, the project opened again on its own build target.
 */
import fs from 'node:fs';
import path from 'node:path';
import { handOverBranch } from './placeAgain.ts';

/** urgent/<v>: the urgent lane's pointer at the commit it builds. Never committed on. */
export const URGENT_BRANCH = /^urgent\//;
/** urgent/<v> and release/<v> (a bump branch, trigger-ci-release.sh): no sandbox is handed to new work on one. */
export const RELEASE_BRANCH = /^(urgent\/|release\/\d)/;

export const isUrgentBranch = (b: string | undefined): boolean => !!b && URGENT_BRANCH.test(b);
export const isReleaseBranch = (b: string | undefined): boolean => !!b && RELEASE_BRANCH.test(b);

/** What a worker's switch_branch records when it puts a sandbox on a release branch (w1856). */
export interface ReleaseSwitch {
  machine: string;
  sandbox: string;
  /** The branch the sandbox left: where build_plan done puts it back. */
  from: string;
  /** The release branch it went to. */
  to: string;
  at: string;
}

/**
 * The record after a switch from `from` to `to` in `machine/sandbox` (`had`: the caller's record before it). Going onto a
 * release branch from another branch records it; one release branch to the next (urgent/1.0.0.10 to urgent/1.0.0.12)
 * keeps the first record, so the sandbox still goes back to where it was before the first; leaving release branches
 * clears it.
 */
export function nextReleaseSwitch(had: ReleaseSwitch | undefined, machine: string, sandbox: string, from: string, to: string, at: string): ReleaseSwitch | undefined {
  if (!isReleaseBranch(to)) return had && (had.machine !== machine || had.sandbox !== sandbox) ? had : undefined;
  if (isReleaseBranch(from) && had && had.machine === machine && had.sandbox === sandbox) return { ...had, to };
  if (isReleaseBranch(from)) return had;
  return { machine, sandbox, from, to, at };
}

/**
 * The branch a sandbox on a release branch goes back to: the one it left (`left`), unless that is a release branch too,
 * unknown, or checked out in another sandbox now (git allows one branch in one worktree); else a fresh hand-over branch,
 * which the daemon creates from origin/master.
 */
export function handBackBranch(sandbox: string, tag: string, left: string | undefined, checkedOutElsewhere: (branch: string) => boolean): string {
  if (left && !isReleaseBranch(left) && left !== 'detached HEAD' && left !== '?' && !checkedOutElsewhere(left)) return left;
  return handOverBranch(sandbox, `after-${tag.replace(/[^A-Za-z0-9._-]+/g, '-')}`);
}

/**
 * The branch checked out in a worktree, read from its files (no git process: the guard asks on every matching command),
 * or undefined when it cannot tell (detached, not a git folder).
 */
export function headBranch(worktree: string): string | undefined {
  try {
    const dotGit = path.join(worktree, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return undefined;
      gitDir = path.resolve(worktree, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The branch a sandbox is on now, as the portal knows it: its daemon's sandbox list, sent on every switch (SandboxPool
 * changed), else the git status read every 2 minutes.
 */
export function branchNow(sb: { branch?: string; git?: { branch?: string } }): string | undefined {
  return sb.branch && sb.branch !== '?' ? sb.branch : sb.git?.branch;
}

/** The handover's warning for a worker whose sandbox is on a release branch (work.ts handoverNote). */
export function releaseBranchWarning(branch: string): string {
  return `WARNING (w1856): this sandbox is on the release branch ${branch}, which a release build left it on. Never commit on it${isUrgentBranch(branch) ? ' (the shell guard refuses commits on urgent/*)' : ''}: switch_branch to your own branch first (create_from origin/master for new work), and if a player build here fails in EntitiesILPostProcessors on Unity.Jobs.dll, stop the editor and run \`python scripts/release/urgent_release.py handback\` (it clears the stale Library folders; it refuses tracked changes until you commit yours).`;
}
