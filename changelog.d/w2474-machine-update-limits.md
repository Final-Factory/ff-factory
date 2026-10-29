- **`ops_worker machine_update` with `max_unity` or `max_agents_per_sandbox` now takes effect** (w2474). A root install's
  daemon runs by the portal record's limits, which its welcome carries, so the installer's flag alone changed `daemon.json`
  and nothing the daemon used: biscuit kept 2 editors after `machine_update max_unity 1`. The update now sets them on the
  record too, and the daemon has them at once; list_machines shows them.
