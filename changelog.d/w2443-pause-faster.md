- **A paused machine is clear in about 95 s instead of about 2 minutes, and a paused worker's work is saved even when its
  process is slow to go** (w2443, lothsahn after the LothLaptop live check: "I paused it and it took a while to close"). The
  check measured the worker gone at 69 s, the player and its crash handler at 117 s and the editor at 123 s: the 90 s sweep
  closed the editor (30 s grace) before it ended the leftovers. The daemon now asks every sandbox editor to quit at 60 s, and
  its 90 s sweep ends agent hosts, editors still up (forced) and leftovers all at once. The portal's save of a stopped
  worker's sandbox, refused while the daemon still saw its agent ("agent ... runs in sandbox ..."), was tried once and given
  up; it now tries again every 5 s for up to 2 minutes. docs/machines.md "Pausing a machine".
