- **A daemon that crashed no longer makes the next one send a finished turn's end again** (w6548, for lothsahn). A daemon
  saves how far it read each agent host's output after each poll, off its loop (w6486), so a kill between forwarding a
  turn end and that save left the saved offset short of it, and the next daemon forwarded the turn end a second time:
  the portal ran its turn-end handling twice for one turn. Each daemon now keeps how far the signals it forwarded go
  (`daemon.signalled` in the host folder, written as each is sent) and the next one skips signals up to there; a turn
  that ended while no daemon ran still reaches the portal (w605). This was the cause of the flaky agentHost.test.ts
  w2625 test on Linux CI (run 46073307022). Tests: `agentHost.test.ts` (w6548).
