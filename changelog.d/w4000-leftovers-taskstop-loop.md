- **`ff-leftovers` finds a background Git Bash loop stopped with TaskStop on Windows** (w4000). On lothdesktop (w3998,
  w3980) `ff-leftovers end` said "None is left" while a worker's `bash $TMPDIR/checks.sh` loop and its `cargo run` kept
  running. Reproduced on lothdesktop, 2026-11-12: after TaskStop of a background `bash $TMPDIR/x.sh` sleep loop, `list` said
  "Nothing your session started is still running" while the script's bash and its `sleep` ran on. Git Bash programs show
  Windows no environment, and once the task's shells are gone their Windows parents have exited, so neither the session id
  nor the parent chain reached them. On Windows a process whose command line names this session's temp folder
  (`<root>/ffa-<session>`, from TEMP/TMP, and no other session's) is now the session's, and so is what runs under any of
  the session's processes, by Windows parent or by MSYS parent (the shim now also hands node every MSYS program's parent
  by Windows pid, `FF_LEFTOVERS_MSYS`), unless it carries another session. `end` scans again after it ends them (up to
  three rounds) and says "None is left" only when that scan finds nothing. Measured with the new shim on the same
  machine: `list` named the loop's bash and its sleep, `end` ended both, the next `list` found nothing, and another worker's
  identical loop and the calling shells stayed. Mac and Linux read every process's environment and are unchanged. Needs a
  portal deploy; the daemons rewrite the shim at start. Tests: `leftovers.test.ts` (the measured tree).
