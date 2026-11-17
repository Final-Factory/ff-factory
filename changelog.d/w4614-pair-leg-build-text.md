- **A pair leg builds into the shared player cache and leaves the player there** (w4614; lothsahn, about w4596: "file any
  subsequent findings as high priority fixes and just get them going"). The standard leg text (`PLAYERS_IN_SANDBOX`, and the
  clone guard's `BUILD_IN_SANDBOX`, server/cloneGuard.ts) said to move each player out of the tree into `$TMPDIR`, but the
  game repo's `scripts/nightly/build_player.sh` writes it to `<worker root>/player-cache/<sha>-<os>`, which w4601 places later
  legs by. It now names `unity-slot run -- scripts/nightly/build_player.sh <your sandbox> <sha> <os>` and says to leave the
  player in the cache, and to run ffnightly.py from the sandbox's checkout (master's copy over it after the build, put back
  after the run), never from a copy in `$TMPDIR`, which finds the repo two folders above itself (w4609's leg on biscuit).
