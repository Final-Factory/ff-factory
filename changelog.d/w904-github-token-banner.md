- **A banner when a GitHub token lacks a required repository or permission** (w904, lothsahn: "build checks that if the
  necessary repos and permissions aren't present, a banner appears at the top asking for the github token to be updated").
  The requirements are one list, `shared/githubRequirements.ts` (lothsahn's nine repositories, config `vault.githubRepos`,
  and his permissions: Actions, Commit statuses, Contents, Discussions, Issues, Pull requests and Workflows read and write,
  Artifact metadata and Metadata read, the organization's Self-hosted runners read), kept equal to docs/vault.md 13.2 by a
  test. Every vault GitHub token and the portal's own gh login (D7, through `gh api -i`) are probed against them; one that
  lacks anything, or nears or passes its expiry, gets a dashboard banner for its person and the owners naming what is
  missing and the fix, a `system_status` WARNING and a `[host]` notice once when it turns bad and once when it recovers.
  "Re-check now" on the banner and the vault page probes at once. Needs a portal deploy.
