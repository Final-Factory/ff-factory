- **A pre-w5297 pair run skips a Windows computer whose fence nobody reported, and its brief says how to check the level**
  (w5988, for lothsahn; w5966 was placed on beast/slot5 at Low). On Windows the worker fence is the integrity level, so an
  unreported fence is an unknown level, not Medium: `unfitWhy` refuses it there and says so (a Mac's still fits). The pair
  leg's brief now says to check with `MSYS2_ARG_CONV_EXCL='*' "$SYSTEMROOT/System32/whoami.exe" /groups`: Git Bash's own
  `whoami` is coreutils, and Git Bash turns a bare `/groups` into a path (measured on lothdesktop 2026-11-26). When no
  computer fits, the request shows Stalled with each computer's reason (w4468 `pairNoPlacement`), as before.
