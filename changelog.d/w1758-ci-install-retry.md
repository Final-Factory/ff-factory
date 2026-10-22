- **CI's browser install gives up on a slow or hung Ubuntu mirror after 4 minutes and tries again elsewhere** (w1758): w922
  had a limit and a retry, and w1194's move back to GitHub's runners dropped both, so 3 WebKit jobs on 2026-10-22 sat in
  `apt-get` until the job's 20-minute timeout. A try cut off has its `apt-get` ended (it held dpkg's lock, which failed the
  retry at once) and the second try skips Azure's mirror for Ubuntu's own archive. Healthy installs take 22 to 37 s median,
  55 s at most (60 jobs, measured). `scripts/e2e-legs.test.ts` fails a ci.yml without the limit, the cleanup or the retry.
