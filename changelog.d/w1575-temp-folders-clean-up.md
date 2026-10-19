- **Stopped workers' temp folders no longer pile up** (w1575, lothsahn: "make a change so that they get cleaned up in the
  future"). The daemon's clean-up takes stopped sessions' `ffa-*` folders every pass instead of once a day; a folder that
  cannot go whole (a clone with unpushed work, something changed lately, too many entries to judge) is taken entry by entry,
  so only that clone stays, listed; test fixture repos (`ffsb-e2e-*`, the game repo's `build-player-restore-*` and the like)
  no longer count as work. Old player builds in any worker's temp folder, live ones too, go beyond its newest 2 once idle
  6 h. On Windows the leftover reaper now ends Git Bash programs (`tail -f`) that name a stopped worker's folder once their
  shell is gone, and Unity import workers whose editor is gone.
