- **Timed runs fall back to BEAST or LothDesktop when no small computer can take them** (w2048, lothsahn: "sometimes
  machines go offline. We should still allow timed runs on larger machines if there are no other machines available to take
  them"). Before, a timed leg waited for small computers that were offline. Now it waits only while a small computer can
  take it (online, even if busy, or only briefly offline). Once none can (each offline past the wait, held, or without a
  game sandbox), the leg may run on a big computer, never m5. Its log and the asking request's say "BIG-COMPUTER FALLBACK"
  and name the small computers that were unavailable and why.
  - The wait for an offline computer grows with the fleet's load (lothsahn: "If the fleet is idle it should wait far less
    than if the fleet is busy"): 5 minutes at 50% load or less, 60 minutes at 100% or more, and a straight line between.
    Settings `timing.unavailableIdleMinutes` and `timing.unavailableBusyMinutes` set the two ends. Daemon drops in the
    journal lasted 1 to 30 s, and real outages lasted hours.
  - Numbers never cross computers (lothsahn: "Timings can't be compared across machines at all"). A fall-back worker runs
    every side on its own computer and re-measures any baseline there. A second `timed_run` goes to its first run's
    computer. A run whose computer stays offline past the wait moves to another computer and plays every build there again,
    the baseline included (lothsahn: "rerun the baseline if a machine is offline or unavailable too long"). Every result
    names its computer.
