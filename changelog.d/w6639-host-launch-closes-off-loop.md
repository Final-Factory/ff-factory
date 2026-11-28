- **An agent host's start, the transcript tail's idle close, the clean-up facts' close and the Unity MCP status read no longer
  hold the daemon's loop** (w6639, after w6614's hour of BEAST's daemon log on 2026-11-27/28). The host starts from the spawn
  thread (`launchDetached`, server/spawnThread.ts), detached with its log and its start on stdin as before; its pid comes back
  when the thread answers, and a start that fails is told the portal as before (24.7 s and 14.7 s on BEAST). The tail's
  keep-open timer and `writeInPlace` close their handles with an async close (56.6 s and 15.8 s), and `refreshMcpScopes`
  reads the editors' status files with fs.promises (10.8 s). With the thread off, everything starts as before. Tests:
  `w6639LoopBlocks.test.ts`.
