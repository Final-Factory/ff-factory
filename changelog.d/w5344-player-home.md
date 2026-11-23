- **Workers' players keep Unity's own PlayerPrefs in the install folder on Linux and macOS** (w5344, after w5343; lothsahn:
  "under no circumstances should workers write outside of ffw"). The daemon sets `FF_PLAYER_HOME=<root>/gamedata-home`, and
  a player of a build that reads `FF_GAME_DATA_DIR` gets a home of its own under it: `XDG_CONFIG_HOME=<it>/config` on Linux,
  `CFFIXED_USER_HOME=<it>` on macOS (the real Steam folder linked in), never `HOME`. Timed runs do it here
  (`machine/gameData.ts` `playerHomeEnv`); slot launches, the lab and pair legs through the game's
  `player_slots.player_home_env`. Windows has no variable that moves HKCU, so a worker player still writes
  `HKCU\Software\Never Games\finalfactory` there; editors are unchanged on every OS (docs/worker-root.md 2.7).
