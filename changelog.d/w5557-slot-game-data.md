- **Each sandbox's games keep their data in a folder of their own, and the owner's game folder can be locked from workers**
  (w5557, lothsahn: "If workers use their own per slot save folder could they accidentally destroy my steam cloud?"). A
  sandbox's editor and agent now get `FF_GAME_DATA_DIR=<root>/gamedata/sandboxes/<sandbox>` (`machine/gameData.ts`
  `sandboxGameDataEnv`), so its editor, and the players and batch runs its agent starts, write saves, settings, logs and
  AgentControl there; timed and nightly runs keep `<root>/gamedata`. The live view, the clean-up and the save-copy delete
  rule know the new folders. New `daemon.json` key `workerIntegrityLockGameData` (Windows fence only, opt-in: it changes a
  label on C:) keeps the owner's `AppData\LocalLow\Never Games\finalfactory` Medium, so a Low worker's write there is
  refused, and logs the read-back. `read_rules saves` says each sandbox has its own folder and that Steam Cloud is never a
  worker's. Needs a daemon update; a sandbox's editor gets its folder at its next start.
