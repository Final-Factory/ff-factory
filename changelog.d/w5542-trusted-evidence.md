- **The guard runs only a pr_evidence.py workers cannot have written** (w5542, w5451 item 4): a raw `gh pr merge` of a gated
  repository's pull request ran the highest-versioned copy in `<root>/claude/plugins/cache` or `<root>/tools/final-factory-agents`,
  both worker-writable, with python found on a PATH whose first folder (`<root>/unity-slots/bin`) workers can write. The
  agent host now runs the script from its own checkout in the daemon's folder, `<appDir>/trusted/final-factory-agents`
  (cloned anonymously, refreshed after 10 minutes or on a stale-version refusal), with `python -s`, no `PYTHON*` settings
  and python and gh resolved outside the worker root. The same audit's other host-level runs: rerunGuard's gh and the
  guard's git reads now use trusted binaries (git with `core.fsmonitor` and signature checks off), and the daemon's uv
  cache warm no longer runs a uvx or a `--from` package inside the worker root and reads no uv config for Low agents.
  Needs a portal deploy (daemons update themselves after it).
