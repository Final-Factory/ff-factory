- **Stopped workers' temp folders no longer pile up, and none is emptied while its worker may come back** (w1575,
  lothsahn: "clean up at end if the worker is done ... Then have the daemon do a nightly cleanup for anything the worker
  missed"). A worker whose request closed keeps its folder for the 7 days the request can be reopened (before: 10 minutes
  after the close); a turn end or a wait never empties it. The daily clean-up pass now runs at night. In it, a folder that
  cannot go whole (a clone with unpushed work, something changed lately, too many entries to judge) is taken entry by
  entry, so only that clone stays, listed; test fixture repos (`ffsb-e2e-*`, the game repo's `build-player-restore-*` and
  the like) no longer count as work; old player builds in any worker's temp folder, live ones too, go beyond its newest 2
  once idle 6 h. On Windows the leftover reaper now ends Git Bash programs (`tail -f`) that name a stopped worker's folder
  once their shell is gone, and Unity import workers whose editor is gone.
