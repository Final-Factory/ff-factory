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
