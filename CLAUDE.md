# CLAUDE.md

Rules for agents working in this repository (Claude Code reads this file; Codex reads it through the `AGENTS.md`
symlink). The rest of the conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

- **Run `npm run prepush` before every push, and push only when it passes** (lothsahn, 2026-10-10, w924: "yes, have
  the workers do #1"). It runs the typecheck, shellcheck on the VM scripts, gitleaks on your commits and the noreply
  identity check against `origin/main`, the rules that failed CI 77 times in two weeks (w922, [docs/ci.md](docs/ci.md)).
  A `SKIPPED` line means a tool is missing on this machine: say so in your report; CI still runs that check.
- **Run `npm run perf` locally before you push a change to the web UI's hot paths** (what renders per key or per live
  event, the state store, anything that adds DOM to a page of thousands of agents), on a quiet machine, and put the result
  in the pull request. CI runs no performance, load or timing tests (lothsahn, 2026-10-12, w1173: "We don't want load or
  performance tests in the ff factory CI pipeline"); [CONTRIBUTING.md](CONTRIBUTING.md), "Performance".
- Commit with a GitHub noreply address; the history is public.
- Changelog notes go in `changelog.d/<request>-<topic>.md`, never in CHANGELOG.md itself (w907).
