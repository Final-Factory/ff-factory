- **After a sharedLock switch, adopted agents are noticed** (w6287, found by w6213 on LothDesktop). A switch restarts the
  daemon, which adopts the running agent hosts, and a host keeps its environment, so those agents kept the old mode's cache
  paths and FF_PLAYER_BROKER until their next host start. Each host now records a hash of that environment (`lockenv.sha`);
  an idle agent on another one is logged (daemon.json `hostRestage` "warn", the default), or with "on" its agent is ended
  between turns, never mid-turn, so its next message starts a new host on the new mode in the same conversation.
  `machine_update shared_lock` says in its reply that running agents keep the old mode until then. Docs: worker-root.md
  4.4 "After a sharedLock switch". Tests: `hostRestage.test.ts`, `opsWorker.test.ts`.
