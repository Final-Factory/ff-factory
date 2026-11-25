- **Standing agents' git ignores programs a repository's own config names** (w5514, follow-up of w5504 and the w5452
  audit): their processes carry command-scope git config (`safe.bareRepository=explicit`, `core.fsmonitor=false`,
  `core.hooksPath=/dev/null`, `core.pager=cat`, `protocol.ext.allow=never`, no system config except on Windows), and
  Write/Edit refuse any path into `.git` in any spelling, judged on the real path, so a symlink in a cloned repository
  cannot carry a write into git's metadata or out of the agent's folder.
