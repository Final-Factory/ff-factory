- **The daemon frees stale ffu slots by itself, warn-only first** (w6484, lothsahn: "fix why auto-release still misses
  them"). A slot `ffu-slot list` calls stale (its holder finished, stopped past 30 min or idle past 2 h) was freed only by
  the next `take` or a hand-run sweep. Now each slot report the daemon reads (every 2 min) acts on it by
  `machines.cleanup.staleOutput.ffuSlotSweep`: `warn` (default) logs `ffu slots: auto sweep (warn-only ...): would free ...` in
  daemon.log; `on` runs `ffu-slot sweep` (unpushed work saved on a rescue branch first, targets kept); `off` nothing.
  Only holders that no longer run are freed this way; a running holder's stale slot is left to the next take.
  `ffu-slot sweep` no longer needs FF_SESSION_ID. Docs: ffu-sandboxes.md. Tests: `ffuSlotAutoSweep.test.ts`, `ffuSlots.test.ts`.
