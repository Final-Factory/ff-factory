- **The person-play look no longer takes an agent's exiting game for a person's** (w6737). On LothDesktop on 2026-11-28 it
  held the machine twice for 10+ min: Windows lists an exiting game with no command line, so its slot folder and lease were
  not seen. Now a game named by a local lease's own pid, or known as a worker's on an earlier look, is never a person's, and a
  game counts only after two looks in a row (three with no command line), so the first look after a daemon start holds
  nothing. A real person's game is found a minute later than before. Needs a daemon update.
