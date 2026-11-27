- **The per-commit pre-w5297 check closes the gaps its review found** (w6235, for lothsahn; w6192's review of PR #1402).
  `legacy_data` that names another player than the pair's `commit` (another sha, or a `0.50.x.y` build such as Steam's)
  keeps the mark, at `request_pair` and `start_agent`, since only `commit` is read. A queued pair run still marked from
  before w6189 is re-checked each minute before the queue is read, so it is placed without waiting for `start_agent`.
  New tests fail when the same-commit guard (request_pair and start_agent), the environment-read half of the source test,
  the other-player guard or the queue re-check is removed. Docs: `docs/worker-fence.md`.
