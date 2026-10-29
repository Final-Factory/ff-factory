- **A timed leg that must run on one computer runs there or waits there** (w2521, lothsahn: "It never falls back to an
  idle or big computer, and it says plainly that it is waiting on that machine"). `timed_place` takes `machine` ("this
  leg runs on this computer only"); the asking request's pin, or "must run on X"/"needs X's ..." in what, brief or
  same_machine, pins it too. A pin answers here only on that computer, else files the leg Queued for it alone, saying it
  is busy, free or offline; the leg never widens, the room move and the timed relocation keep it there, and start_agent
  and the queue action refuse any other computer. Requests whose constraints say "must run on X" are pinned the same way.
  Fixes three LothLaptop-only (G-SYNC) legs placed on BEAST, m3 and biscuit on 2026-10-28/29. Docs: machines.md,
  scheduling.md. Tests: `w2521MachinePin.test.ts`, `orchestrators.test.ts`.
