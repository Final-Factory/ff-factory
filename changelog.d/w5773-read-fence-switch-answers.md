- **A read fence switch answers once the mode is written, and Linux's owner-socket probe is cut at 15 s** (w5773, from
  w5756's review of #1247/#1249): `setReadFence` ran the file probe (up to 60 s) and then the owner-socket probe (up to 60 s)
  before answering, so a hung probe child could keep `read-fence-warn` or `-on` past the portal's 60 s `daemon_control` wait
  and the switch looked failed though it had applied. The switch now writes the mode (and on Windows sets the labels), then
  answers; the probe runs after in the background, and runs start without read rules until it passes, as at start. A probe
  that hangs or fails still counts the owner sockets as reachable, so Linux `on` stays unenforced, and when two probes
  overlap only the newer one's verdict counts.
