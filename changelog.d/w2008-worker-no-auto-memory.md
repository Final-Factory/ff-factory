- **Workers run without Claude Code's auto memory** (w2008, lothsahn: "see how we can save tokens"; docs/worker-base.md D3).
  Its "# Memory" prompt section (about 730 tokens, read again on every model call) told workers to write machine-local memory
  files, which the game repo's CLAUDE.md forbids. Orchestrators and the dispatcher keep theirs.
