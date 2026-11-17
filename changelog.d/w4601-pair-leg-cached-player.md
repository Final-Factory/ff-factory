- **A pair leg goes where a player of its commit is already built, and is told to use it** (w4601; lothsahn, about w4596:
  "file any subsequent findings as high priority fixes and just get them going"). In w4596's timelines of 12 pair runs each
  leg built its own player of the head commit (Mac 3 to 9 min, Linux on biscuit 4 to 21, Windows 7 to 23) while the host
  waited up to 15 min. Each daemon now sends the ready entries of its shared player cache (the game repo's
  `scripts/nightly/player_cache.py`, `<worker root>/player-cache/<sha>-<win|mac|linux>`, manifest `status: ok`) with its
  stats (`machine/playerCache.ts`); `pairRoom` puts a computer whose cache holds the pair's `commit` for its own OS ahead of
  the rest when it has room (a Mac still hosts first), and that leg's first message names the player's path and says to
  pass `--player <path>` and skip the sandbox build. It needs `request_pair`'s `commit`. Needs a portal deploy and the
  daemons' update.
