- **A Live view stays up while its worker waits on you** (w1582, Ben: "The live views aren't working"). A worker whose
  Live view runs while it waits on a person keeps its process, its sandbox and its editor for 12 hours after its last
  activity, instead of being stopped 6 minutes after its turn and released 4 minutes later (w890). The daemon counts a
  running view as activity, so the editor's idle stop leaves it. When the hold ends or the sandbox is released any other
  way, the view stops with the release (it no longer shows the next worker's game) and the worker's next message asks it
  to stage the view again with the same knobs. Needs a portal deploy; the daemon half follows with the machine rollout.
  Docs: live-view.md ("While it waits on you"), machines.md ("Placing work"). Tests: placeAgain, orchestrators,
  liveDaemon.
