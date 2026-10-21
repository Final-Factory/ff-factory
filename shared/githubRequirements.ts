// What every GitHub token FF Factory uses must have (w904, docs/vault.md section 13.2): the one list in code. The probe
// (server/githubTokens.ts) checks it, the banner asks for the token to be updated when something is missing, and a test
// (server/githubRequirements.test.ts) fails when docs/vault.md's table disagrees with it.
//
// lothsahn, 2026-10-10: "We should have at least these repos: ..." and "Give it these repo permissions: Actions (RW),
// Artifact metadata (RO), Commit statuses (RW), Contents (RW), Discussions (RW), Issues (RW), Metadata (Required), Pull
// requests (RW), Workflows (RW). And these organizational permissions: Self-hosted runners (RO). As we find more permissions
// we need, please add them to the requirements". A worker refused by GitHub for a permission or repository not listed here
// adds it here, in a pull request (the evidence-gate lesson "github-403-adds-a-requirement").

/** The organization every required repository belongs to (a fine-grained token's resource owner). */
export const GITHUB_ORG = 'Final-Factory';

/** The repositories every token must reach: the default of config vault.githubRepos. */
export const GITHUB_REQUIRED_REPOS: readonly string[] = [
  'Final-Factory/Facepunch.Steamworks',
  'Final-Factory/FinalFactory',
  'Final-Factory/FinalFactoryModTemplate',
  'Final-Factory/final-factory-agents',
  'Final-Factory/ffbox',
  'Final-Factory/finalfactory-agent-kit',
  'Final-Factory/ff-factory',
  'Final-Factory/KNN',
  'Final-Factory/ff-marketing',
  'Final-Factory/ff-orchestrator-memory',
];

export type GithubPermissionId = 'actions' | 'artifact-metadata' | 'commit-statuses' | 'contents' | 'discussions' | 'issues' | 'metadata' | 'pull-requests' | 'workflows' | 'self-hosted-runners';

export interface GithubPermission {
  id: GithubPermissionId;
  /** GitHub's name for it on the token's page. */
  label: string;
  scope: 'repository' | 'organization';
  /** What to tick: "Read and write" or "Read-only". */
  access: 'write' | 'read';
  /**
   * How its read half is probed without writing anything, or undefined when it has none (Workflows: write only). The
   * write half of a "write" permission is never probed: that would mean writing.
   */
  probe?: string;
}

/** The permissions every token must have, in the order GitHub's token page lists them. */
export const GITHUB_REQUIRED_PERMISSIONS: readonly GithubPermission[] = [
  { id: 'actions', label: 'Actions', scope: 'repository', access: 'write', probe: 'GET /repos/{repo}/actions/runs' },
  { id: 'artifact-metadata', label: 'Artifact metadata', scope: 'repository', access: 'read', probe: 'GET /orgs/{org}/artifacts/{digest}/metadata/storage-records (an unknown digest: 404 allowed, 403 refused)' },
  { id: 'commit-statuses', label: 'Commit statuses', scope: 'repository', access: 'write', probe: 'GET /repos/{repo}/commits/HEAD/status' },
  { id: 'contents', label: 'Contents', scope: 'repository', access: 'write', probe: 'GET /repos/{repo}/commits' },
  { id: 'discussions', label: 'Discussions', scope: 'repository', access: 'write', probe: 'GraphQL repository.discussions' },
  { id: 'issues', label: 'Issues', scope: 'repository', access: 'write', probe: 'GET /repos/{repo}/issues' },
  { id: 'metadata', label: 'Metadata', scope: 'repository', access: 'read', probe: 'GET /repos/{repo}' },
  { id: 'pull-requests', label: 'Pull requests', scope: 'repository', access: 'write', probe: 'GET /repos/{repo}/pulls' },
  { id: 'workflows', label: 'Workflows', scope: 'repository', access: 'write' },
  { id: 'self-hosted-runners', label: 'Self-hosted runners', scope: 'organization', access: 'read', probe: 'GET /orgs/{org}/actions/runners' },
];

/** "Actions (read and write), …": what cannot be checked without writing, for the banner's detail. */
export const GITHUB_UNPROBED = GITHUB_REQUIRED_PERMISSIONS.filter((p) => p.access === 'write' || !p.probe)
  .map((p) => `${p.label} ${p.probe ? 'write' : '(write only)'}`)
  .join(', ');

// ---------------------------------------------------------------- GitHub Apps (w1519, docs/github-apps.md)

/** A permission a GitHub App's installation grants, by the REST API's name for it (an installation's `permissions`). */
export interface GithubAppPermission {
  /** The key in an installation's `permissions` object. */
  id: 'actions' | 'checks' | 'contents' | 'metadata' | 'pull_requests' | 'workflows';
  /** GitHub's name for it on the app's Permissions page (Repository permissions). */
  label: string;
  /** What to pick: "Read and write" or "Read-only". */
  access: 'write' | 'read';
  /** Not needed by every repository: shown when missing, never a problem (Workflows: only to change .github/workflows). */
  optional?: boolean;
  /** What a worker does with it. */
  why: string;
}

/**
 * What an app's installation must grant for a worker to clone, push a branch, open a pull request and read its CI there
 * (sourced: docs.github.com "Choosing permissions for a GitHub App": Git over HTTPS needs Contents, files in
 * .github/workflows need Workflows; Metadata is given to every app). The health check compares each installation's granted
 * permissions with this list, and docs/github-apps.md's table is checked against it (server/githubApps.test.ts).
 */
export const GITHUB_APP_PERMISSIONS: readonly GithubAppPermission[] = [
  { id: 'actions', label: 'Actions', access: 'read', why: 'read CI runs (gh run list, ff-pr merging on green)' },
  { id: 'checks', label: 'Checks', access: 'read', why: 'read check results (gh pr checks)' },
  { id: 'contents', label: 'Contents', access: 'write', why: 'clone, fetch and push branches; merge a pull request' },
  { id: 'metadata', label: 'Metadata', access: 'read', why: 'given to every app (mandatory)' },
  { id: 'pull_requests', label: 'Pull requests', access: 'write', why: 'open, comment on and merge pull requests' },
  { id: 'workflows', label: 'Workflows', access: 'write', optional: true, why: 'only to push changes to .github/workflows files' },
];

/** Whether a granted level ("read", "write", "admin", or nothing) covers what a permission needs. */
export const appAccessCovers = (granted: string | undefined, need: 'read' | 'write') =>
  granted === 'admin' || granted === 'write' || (need === 'read' && granted === 'read');
