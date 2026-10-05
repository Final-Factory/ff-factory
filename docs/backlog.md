# Backlog

Planned work that is agreed but not started, in the order it should happen.

## 1. BEAST as a portal plus a machine daemon (built, deploy pending)

Split BEAST into portal/orchestrator + a local machine daemon that owns BEAST's sandboxes, editors and workers (like
the M5 and LothDesktop), so portal updates and crashes don't stop workers.

Built: [beast-machine.md](beast-machine.md) (`add_machine local`, `migrate_host_sandboxes`, protocol 6). Left: the
deploy and the in-place migration at a quiet moment Ben picks (tell Ben and Loth first), then an hour of watching.
Once it has run for a while, delete the host's own sandbox code (`server/sandboxes.ts` and the host-only branches),
which the rollback needs until then.

The orchestrators are ready for it: the dispatcher addresses a sandbox the same way on every computer
(`"<machine>/<name>"` for one a daemon owns), and the ledger, the overlap check and the routing of worker updates go by
session and place, not by which process runs the worker. BEAST's sandboxes become `beast/<name>`, and bare names keep
working.

## 2. Portal restarts that leave daemon agents running (prepared, off)

After the BEAST daemon split is fully working: a portal update or restart no longer drains or stops daemon-hosted
agents, on BEAST or on machines. The portal restarts, the daemons keep their agents running, and they reconnect and
replay missed events. Only a daemon update itself would need a drain.

Prepared behind config `machines.keepAgentsOnRestart` (default off; [beast-machine.md](beast-machine.md#backlog-step-2-prepared-off)):
no drain and no stop for daemon agents, and a same-protocol daemon from another commit keeps taking agents until it is
idle and redeployed. Left: prove on BEAST that a restart leaves the daemon's agents running and replays their events,
then turn it on.

## 3. The portal in its own VM on the FFBox host (designed, scripts written, not deployed)

After steps 1 and 2: the portal leaves BEAST for a KVM/QEMU VM on the FFBox host, so BEAST only runs workers.
Designed in [portal-on-ffbox-host.md](portal-on-ffbox-host.md): w439 designed it as a container, and w441 made it a VM
at Lothsahn's request. The host and guest install scripts are in `deploy/vm/`, tested end to end in CI. Section 6 lists
the code changes still needed before the cut-over, section 8 the decisions for Lothsahn and Ben, and section 9 the
measurement of BEAST's portal still to run.
