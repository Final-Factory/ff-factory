- **A worker's Write tool no longer makes files outside its own folders** (w3257, ben: "Workers on m5 leave stray
  placeholder files outside their worker folder: find why, stop it, clean up"). Two m5 workers wrote a probe file at a
  guessed path before they had looked up `$TMPDIR` (`~/ffw-tmp-placeholder` through `sandboxes/slot1/../../..`, and
  `~/ffw/sandboxes/tmp-pr-body-w3249.md`), and no worker may delete either. The sandbox guard now refuses a Write that would
  create a new file outside the worker's sandbox and temp folder (`..` resolved first), and the refusal names the temp
  folder's path. Left open: the game's `Never Games` data folders, `~/.claude`, `~/.codex` and the ff-agents checkout the
  publish-skills marker names; overwriting an existing file is unchanged. The worker brief's Disk space says to
  `echo $TMPDIR` before the first Write there. Applies to workers started after the daemon update. Tests: `strayWrite.test.ts`.
