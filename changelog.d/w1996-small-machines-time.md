- **Big computers build, small computers time** (w1996, lothsahn: "We're wasting system resources like crazy locking beast
  down to a single timing job"). `timed_run` now goes to small Windows worker computers that take timed runs (LothLaptop), not
  only to play-only ones: the worker builds both players where it is under shared tickets, and the small computer's daemon
  times them under its own exclusive ticket, taken through its bench queue at the asking request's priority, in turns of at
  most 24 minutes, in a sandbox's player-slot pair no live lease holds. `timed_place` with no `via` on BEAST or LothDesktop
  sends a Windows player A/B there, and names `via: "leg"` for anything else timed. A one-slot computer that times another
  worker's run keeps the 30-minute turn. Design and measurements: docs/scheduling.md. Tests: `w1996SmallTiming.test.ts`.
