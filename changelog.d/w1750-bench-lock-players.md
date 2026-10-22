- **No game player or screen grab beside another worker's timed run** (w1750, lothsahn, 2026-10-22: "Why is the game player
  running if the worker has an exclusive lock on beast?"). While another worker's granted exclusive bench ticket holds a
  machine's lock, the shell guard refuses a command that starts a built player by its slot path or grabs the screen with
  ffmpeg (gdigrab, ddagrab, gfxcapture, x11grab, avfoundation), with "bench lock held by worker <session> (<requests>,
  <host>/<sandbox>, "<what>"), until HH:MMZ at the latest" (`server/guard.ts` `checkBenchBusyLaunch`,
  `machine/benchLock.ts` `foreignTimedHold`). The worker's own session passes; a dead holder, a revoked hold, one past its
  bound, a waiting ticket and shared tickets never block. The game repo's `player_slots.py` and ff-agents `record_clip`
  check the same lock themselves and can wait (`--bench-wait`); this covers launches straight from the shell. Rolls out
  with the machines' daemon update.
