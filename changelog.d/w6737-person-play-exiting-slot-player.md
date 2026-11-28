- **The person-play look no longer takes an agent's exiting game for a person's** (w6737). On LothDesktop on 2026-11-28 it
  held the machine twice for 10+ min: Windows lists an exiting game with no command line, so its slot folder and lease were
  not seen. Now a game listed with no command line that a local lease names by its own pid, or that an earlier look knew as a
  worker's, is never a person's (a game whose path reads is still judged by its path, so a stale lease cannot hide a
  person's game), and a
  game counts only after two looks in a row (three with no command line), so the first look after a daemon start holds
  nothing. A real person's game is found a minute later than before. Needs a daemon update.
