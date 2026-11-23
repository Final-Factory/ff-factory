- **Workers' editors and players keep the game's data in the install folder** (w5306, part of w5297; lothsahn: "under no
  circumstances should workers write outside of ffw"). The daemon sets `FF_GAME_DATA_DIR=<root>/gamedata`, which the game
  reads since game PR #4237: a sandbox editor's or slot player's saves, settings, AgentControl, desync reports and playtest
  sessions go there. The live view finds a game's session file there first and in the old folder second (a branch from
  before #4237), and a timed run copies its save where each build loads it, reading the build's own `FFCore.dll` for the
  variable. `read_rules saves` now names `python scripts/game_data.py where` as the data root, and clean-up ages out
  `<root>/gamedata/PlaytestSessions`. Applies at each daemon's next update (editors at their next start). Exceptions:
  docs/worker-root.md 2.7.
