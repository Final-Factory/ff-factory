- **A timed run queued behind another on its daemon says so** (w3405, ben: "File it: show when a timed run is queued behind
  another"). The run keeps the state `sent`, but now records which run it waits behind and since when. The `timed_run` answer
  names the runs already on that daemon, and the Capacity block reads `tr_B queued behind tr_A`. `timed_place` with
  `status: "tr_..."` says what the run ahead waits for and since when. Once that wait passes one exclusive turn, the answer
  names a free computer to move to (docs/machines.md, "Queued behind another run").
