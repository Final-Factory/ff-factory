- **A worker whose agent host dies mid-turn is resumed by itself, once, in its own sandbox** (w2884; lothsahn: biscuit's
  workers 0b897db6 and 3215a6aa stopped with "its agent host stopped unexpectedly" and nothing resumed them). When a
  connected daemon reports a worker's host gone, gave no heartbeat or stopped unexpectedly while its turn was open (a
  worker, not stopped on purpose, active within 6 h), the portal keeps its sandbox and, 3 s later, sends it a message
  that says what died and what to check (git status, a build or player it started, its Unity pin), and notes its
  request's log. A second death within the hour is only noted and reported, not resumed again.
- **Linux agent hosts and editors no longer die with an OOM-killed child** (w2884): the `systemd-run --user --scope`
  each one runs in (w2474) now carries `-p OOMPolicy=continue` where systemd takes it (253+, probed and cached; older
  systemd keeps the old command). A scope's default `OOMPolicy=stop` ended the whole scope, agent host and claude
  included, when the kernel OOM killer took a batch Unity build inside it. A host that still dies names the scope's
  last OOM line from `journalctl --user -u <scope>` in its stop reason. Needs a portal deploy and the daemons' update
  (FF Factory updates them); hosts and editors started after the update get it.
