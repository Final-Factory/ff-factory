# Backlog

Planned work that is agreed but not started, in the order it should happen.

## 1. BEAST as a portal plus a machine daemon

Split BEAST into portal/orchestrator + a local machine daemon that owns BEAST's sandboxes, editors and workers (like
the M5 and LothDesktop), so portal updates and crashes don't stop workers. **Not before 2026-09-30.**

- Prerequisites: machine sandboxes (PR #16) proven on LothDesktop, and per-user orchestrators landed
  ([orchestrators.md](orchestrators.md)).
- Migrate the existing sandboxes in place.
- Tell Ben and Loth before deploying.

The orchestrators are ready for it: the dispatcher addresses a sandbox the same way on every computer
(`"<machine>/<name>"` for one a daemon owns), and the ledger, the overlap check and the routing of worker updates go by
session and place, not by which process runs the worker. BEAST's sandboxes become `beast/<name>`.

## 2. Portal restarts that leave daemon agents running

After the BEAST daemon split is fully working: a portal update or restart no longer drains or stops daemon-hosted
agents, on BEAST or on machines. The portal restarts, the daemons keep their agents running, and they reconnect and
replay missed events. Only a daemon update itself would need a drain.
