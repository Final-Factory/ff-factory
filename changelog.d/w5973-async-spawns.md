- **The daemon's timers and link messages no longer wait on a child process** (w5973, lothsahn, after w5938's BEAST
  daemon updates failed behind a blocked event loop: 4,837 "event loop: blocked" lines on 2026-11-25, 416 of them 20 s or
  more). What ran as `spawnSync` on the daemon's loop now runs as a child it does not wait on (`server/proc.ts` `run`),
  with the same errors handled: the trusted bench script's `gh api` fetch (two tries of up to 30 s; the daemon fetches it
  in the background, one fetch at a time, and a call with no copy yet is refused saying so), `gh auth token` for the
  machine's own gh (kept 30 min, read in the background), Windows' `taskkill` in the editor and leftover reapers and in
  a timed run's leg timeout and cancel, the Linux scope journal read when an agent host is found gone, and the Linux
  scope probes (warmed every minute, so an editor's or agent's launch finds their answers kept). LoopWatch's blocked
  line now names what held the loop: `; longest labelled run: timer keepLogs 12.1 s` (each `setInterval` of the
  daemon, each link message as `link <type>`, each local RPC as `rpc <name>`), else `; last ran: <label>`. Still on the
  loop, once each: the startup fence probes and the lazy fence re-probes (each once per event, not per timer). Tests:
  `loopWatch.test.ts`, `trustedBench.test.ts`, `ownerSecrets.test.ts`, `linuxScope.test.ts`.
