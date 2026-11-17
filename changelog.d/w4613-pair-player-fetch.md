- **A pair leg can fetch the requester's player instead of building it** (w4613, lothsahn's request). `publish_attachment`
  takes `player: <commit>`: the daemon packs that commit's ready entry from its shared player cache (player/ and
  build-manifest.json; a Windows player of 1963 MB packed to 748 MB in 27 s, measured) and publishes it as
  `player-<sha>-<os>.tar.gz`, with its own cap (3 GiB, machine uploads only) and 2 days' retention. `request_pair` takes
  `player: <att id>`; a leg on a computer of that OS which does not hold the commit is told to call `fetch_attachment` first,
  which unpacks it into that computer's cache as a ready `<sha>-<os>` entry (refusing another OS's player, a manifest not
  ok for that commit, or an entry not ready) so `build_player.sh` skips the build. Eviction stays `player_cache.py`'s.
