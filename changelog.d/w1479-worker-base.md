- **A worker's base context, audited part by part** (w1479, lothsahn: "can we analyze the base instructions to figure out why
  they're so long?"). `docs/worker-base.md` gives each part's tokens, measured from cache boundaries in beast's transcripts, with
  what it is for, whether a worker needs it on every call, and a ranked list of decisions worth about 17k tokens a call. The worker
  prompt now says four things once instead of twice: the free delete in $TMPDIR (Disk space), master only through a PR (Git),
  what green CI is (Your pull requests) and whose GitHub token a run uses. A save copied into the saves folder is named
  `ffa-<session>-…` in Attachments too, as Disk space says, and Waiting on CI names `gh run list`, since a vault token cannot
  run `gh pr checks`.
