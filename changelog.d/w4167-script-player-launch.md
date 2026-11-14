- **Guard: a script handed a built player outside a player slot is refused (w4167).** checkPlayerLaunch (w513) only saw a
  player named as a command's own program, so a tour script run with a player in `$TMPDIR/builds/<sha>-win/player/` among
  its arguments could start it from the temp folder unseen, and Windows Firewall prompts for every new exe path
  (lothsahn, LothDesktop, 2026-11-14). checkScriptPlayerLaunch refuses a bash, sh, python or PowerShell script run with a
  player exe or a build cache entry outside a slot among its arguments, unless the script, or a script it imports or
  names, starts players through the slot pool (player_slots.py, FF_LAUNCH, slot_path, lab.py, or says "player slots"); a
  script it cannot read passes. The refusal names `player_slots.py launch`.
