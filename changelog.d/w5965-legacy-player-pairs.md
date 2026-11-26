- **A pair run of a pre-w5297 player goes only where the worker fence is off** (w5965, for lothsahn; found in w5944 on
  lothdesktop slot5). A 0.50 (pre-1.0) player never reads FF_GAME_DATA_DIR and writes the owner's own data folder (LocalLow
  on Windows, labelled Medium), which a Low-integrity worker cannot write, so ffnightly waited out "no host-ready within
  420s". request_pair takes `legacy_data` (why; "none" says no), and reads it from its words otherwise (pre-1.0, the 0.50
  line, 0.50.x); such a pair's legs go only on computers whose worker fence is off and never on Linux (pre-1.0 has no Linux
  multiplayer build): `unfitWhy` says why, from the machine's fence state now in `RoomFit`. The pair brief also says a
  pre-1.0 commit's build_player.sh needs the cache root as its 4th argument. The game repo's side (FinalFactory PR #4365)
  refuses such a run in seconds on a fenced worker. Tests: `orchestratorsPairs.test.ts` (w5965), `w4669PairBriefCommands.test.ts`.
