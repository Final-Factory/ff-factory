# Backlog

Planned work that is agreed but not started, in the order it should happen.

## 1. BEAST as a portal plus a machine daemon (done, 2026-10-06, w510)

Split BEAST into portal/orchestrator + a local machine daemon that owns BEAST's sandboxes, editors and workers (like
the M5 and LothDesktop), so portal updates and crashes don't stop workers.

Built and deployed: [beast-machine.md](beast-machine.md) (`add_machine local`, protocol 6). BEAST's five sandboxes
moved to its daemon in place on 2026-10-05 (w424, w440). Done 2026-10-06 (w510, Lothsahn: "Let's just delete that and
all the code around running portal processes directly (except those necessary for the orchestrator and dispatcher)"):
the portal's own sandbox pool and everything that ran workers, editors and standing agents in the portal process are
deleted (`SandboxManager`, host worker sessions, the host Unity watch, the "this host" place and host limits,
`migrate_host_sandboxes` and its rollback, the host sandbox page). The portal runs only the orchestrators and the
dispatcher; BEAST cannot go back to host sandboxes, and that is accepted.

## 2. Portal restarts that leave daemon agents running (done, 2026-10-05)

After the BEAST daemon split is fully working: a portal update or restart no longer drains or stops daemon-hosted
agents, on BEAST or on machines. The portal restarts, the daemons keep their agents running, and they reconnect and
replay missed events. A daemon update needs no drain either: since w605 it stops only the daemon, and the agents in their own agent hosts are adopted by the new one ([worker-install.md](worker-install.md), "An update does not stop running work").

Behind config `machines.keepAgentsOnRestart`, on on BEAST since 2026-10-05 (w424; [beast-machine.md](beast-machine.md#backlog-step-2-on)):
no drain and no stop for daemon agents, and a same-protocol daemon from another commit keeps taking agents until it is
idle and redeployed. Proven on BEAST before it went on. Agents mid-turn on BEAST's daemon and on LothDesktop ran through
an 84-second portal restart, with their events replayed ([restart.md](restart.md), "Agents on machines").

## 3. The portal in its own VM on the FFBox host (designed, scripts written, not deployed)

After steps 1 and 2: the portal leaves BEAST for a KVM/QEMU VM on the FFBox host, so BEAST only runs workers.
Designed in [portal-on-ffbox-host.md](portal-on-ffbox-host.md): w439 designed it as a container, and w441 made it a VM
at Lothsahn's request. The host and guest install scripts are in `deploy/vm/`, tested end to end in CI. Section 6 lists
the code changes still needed before the cut-over, section 8 Lothsahn's decisions, and section 9 the sizing
measured on BEAST. The install steps are in `deploy/vm/RUNBOOK.md`.
