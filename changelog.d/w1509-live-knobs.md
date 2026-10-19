- **Live view knobs keep working through a restart, and say when they cannot move the picture** (w1509, asked by Ben):
  - A machine rollout restarts the daemon. Its live views used to end there while the page kept showing them as live:
    the stream froze and every knob was refused ("this live view is not running on the machine"). Now the daemon's
    hello lists its views (`liveViews`), the portal starts the missing ones again with the same id, and after a portal
    restart it takes back the views a daemon still runs.
  - A knob the game reports as set by something else (`driven`: a value written back, a MaterialPropertyBlock, Entities
    Graphics per entity) is folded away under "N more the game sets itself", with the game's reason instead of a dead
    control.
  - The panel reads the knobs again 1.5 s after the last answer.
  - Protocol: optional fields only, recorded as a fingerprint with no bump.
