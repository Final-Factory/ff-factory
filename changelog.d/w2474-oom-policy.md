- **On Linux, the daemon's unit keeps running when the kernel OOM-kills one of its processes** (w2474). systemd's default
  `OOMPolicy=stop` ended the whole unit, the daemon too, when the kernel killed a Unity editor in it: biscuit's daemon went
  down that way at 10:23 and 10:52 UTC on 2026-10-28. The unit now says `OOMPolicy=continue`; it is written again by the
  next daemon update. Editors and agent hosts already start in scopes of their own (PR #757); this covers what still runs
  in the unit.
