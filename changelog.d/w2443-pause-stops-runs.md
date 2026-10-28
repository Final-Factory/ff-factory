- **Pausing a machine stops everything FF Factory runs there within two minutes, and its work waits for it** (w2443, lothsahn:
  "Pausing a machine should stop existing runs on that machine. They should terminate in a minute or two. Please make this fix
  so that pausing the machine gets workers to stop, upload, and quit quickly", and "The worker harness should be authoritative
  and if the worker is nonresponsive, should kill the worker after a few minutes. There's no way it should keep running").
  Timed runs there are cancelled at once (player ended, bench ticket freed, worker told) and new ones refused while paused.
  Workers mid-turn are told to push a WIP commit to their sandbox branch and end their turn; one still running is interrupted
  at 60 s and stopped at 75 s. At 90 s the daemon itself, portal or not, ends every agent host left with its whole process tree
  (`taskkill /T /F`, or the process group and every descendant with SIGKILL), closes the sandboxes' editors and ends every
  process FF Factory started (players, batch Unity, builds), then sweeps again every 15 s while paused; a person's own games
  are never touched (`machine/pauseStop.ts`). The requests are no longer handed to other computers: they show Blocked on the
  machine's pause and resume by themselves in their own sandboxes on the unpause, as after an offline machine (w2433); a pair
  run's leg there re-queues the whole pair elsewhere. docs/machines.md "Pausing a machine".
