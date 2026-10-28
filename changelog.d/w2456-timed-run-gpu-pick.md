- **A timed run can pick the GPU** (w2456, lothsahn: "Timed runs accept a GPU-pick option (-force-device-index) so w2320 can
  measure on LothLaptop's integrated GPU"): a `timed_run` build's `args` take Unity's `-force-device-index N` (a number of
  one or two digits) beside the game's own `-ff` switches, so one build can be timed on a laptop's integrated GPU and its
  discrete one. The allow-list stays: no other Unity switch, and the run's own switches (the save, the log, the quit) are
  still refused. The leg's Player.log `Direct3D:` Renderer line names the GPU it ran on.
