- **Worker root inventory: Backtrace's crash database moved, the editor's Analytics file is an exception** (w5348,
  lothsahn: "under no circumstances should workers write outside of ffw"). docs/worker-root.md 2.7: the game now puts its
  crash database under `FF_GAME_DATA_DIR` (game PR #4260), and the Unity editor's `Editor/Analytics/values` stays under
  `persistentDataPath`, which no launch option or environment variable moves on Windows or macOS.
