- **Guard: a built player on a backslash-continued line is an argument, not a launch (w4286).** checkPlayerLaunch and
  checkScriptPlayerLaunch split a command on newlines, so a `run.sh` written with `ffnightly.py run ... \` and then
  `--player "$TMPDIR/.../finalfactory.app" \` on the next line read that line as a command of its own whose program was
  the player, and refused it (w4214's host leg on m5, 2026-11-15), although ffnightly copies the build into a leased slot
  itself. Continuations are now joined first; a player that is the program after one (`timeout 600 \` newline
  `<player>`) is still refused. request_pair's brief guidance names ffnightly's new `--scenarios-from <commit>` and the
  headless Linux relay lab.
