- **A pair run's what and brief that name another player keep its pre-w5297 mark** (w6451, for lothsahn; w6442's review
  of PR #1477). A run with no `legacy_data` is marked from its words, and those words ("the host runs the Steam 0.50.0.47
  build", another sha) were not checked, so its commit's file cleared the mark at `request_pair`, `start_agent` and the
  queue re-check. Now all three read them, and the reason is kept in the mark. The re-check also forgets runs that are no
  longer queued and marked. New tests fail with each guard removed. Docs: `docs/worker-fence.md`.
