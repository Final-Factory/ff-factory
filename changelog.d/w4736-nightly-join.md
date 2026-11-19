- **A build no longer waits behind the nightly** (w4736, r290's fix 2; game repo #3919, `bench_queue.py` `RULES_VERSION` 8).
  A shared bench ticket (a build, an editor) is not held back by a waiting exclusive ticket of its own or lower priority
  that the running nightly holds back. On LothDesktop on 2026-11-17 w4536's `build_player` waited 5954 s and w4535's build
  5976 s that way (measured); under the rule both start at once (the replay in `test_bench_nightly_join.py`). Strict
  priority stays. A player-slot lease now records its holder's process start, so a reused pid frees the slot. Applies once
  the game repo change is on master; no daemon change. Docs: unity-lifecycle.md ("A build joins the running nightly").
