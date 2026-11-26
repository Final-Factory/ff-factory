- **A pre-1.0 pair run is marked pre-w5297 per commit** (w6189, for lothsahn; found when w6187's pair check of game PR
  #4382 was refused). Game PR #4357 backported FF_GAME_DATA_DIR to pre-1.0, so `request_pair` and `start_agent` now read
  `GameDataPaths.cs` at the pair's commit through GitHub (`server/gameDataDir.ts`): a commit that reads the variable is not
  marked (`WorkPair.dataDirChecked` says why) and its legs may go on Low-integrity Windows sandboxes. An older commit, no
  commit given, or one that cannot be checked (unknown sha, a failed read) keeps the w6003 refusal, and its reason says
  which. Tests: `gameDataDir.test.ts`, `orchestratorsPairs.test.ts` (w6189). Docs: `docs/worker-fence.md`.
