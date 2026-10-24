- **A play-only timing machine: builds made anywhere, timed there under its exclusive bench ticket** (w1946, lothsahn: "Can the
  portal do builds on one machine and then use this other with an exclusive lock for benchmarks?", then "File it: play-only timing
  machine, builds elsewhere, exclusive lock there"). `add_machine play_only "<why>"` (with `join_code`: the installer's smallest
  limits) makes a computer play-only: no pool, no sandbox, no worker and no standing agent (`poolSettingsOf` null, `agentCap` 0).
  A worker's new `timed_run` tool (builds, save, rounds) has its own daemon hash the builds into pieces (a big file in 64 MB
  pieces, small files grouped) and send over its own link only the pieces the portal lacks. The play-only computer's daemon is
  handed the run as data (`timed_run`: pieces by hash, a save, `-ff` switches, bounded numbers; no command, script or path). It
  fetches what it lacks, lays the players out in its player slots, holds its exclusive bench ticket in the queue's own format,
  and plays probe_ab_win.sh's interleaved legs with fixed arguments and a time bound each. The logs come back to the worker as
  one `.tar.gz` in that script's layout, with the table, in a message (`server/timedRuns.ts`, `machine/timedRunner.ts`,
  `machine/timedRunPack.ts`, `shared/timedRun.ts`; docs/machines.md "A play-only timing machine"). Protocol 9, no bump.
