- **safeGit stops a repository's own proxy and TLS settings from steering the daemon's https calls** (w6100, from w6091's
  review of #1367): a checkout's `http.proxy`, `http.<url>.proxy`, `remote.<name>.proxy`, `http.curloptResolve`,
  `http.sslVerify` and `http.schannelUseSSLCAInfo` now fall back to no proxy, no forced address and a checked certificate
  (the user's or system's value when one is set). A repository-set CA file or path, TLS backend or git-lfs URL is logged for
  now (`safeGit (w6100, warn-only): would refuse ...`); refusing it is a later PR. Needs a portal deploy.
