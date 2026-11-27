- **A pair run whose words name a build without a number keeps its pre-w5297 mark** (w6458, for lothsahn; w6454's review
  of PR #1484). "The host runs the Steam pre-1.0 build" named no sha or 0.50.x.y build, so the commit's file cleared the
  mark. Now an installed, published or Steam build counts as another player, failing closed (`legacy_data` "none" is the
  way out). newPair builds its text from `PAIR_FILED_BY`, so `pairAskWords` always finds the cut; a test checks it on a
  run filed through request_pair. Docs: `docs/worker-fence.md`.
