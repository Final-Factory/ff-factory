# Pinned portal hosts (w5576)

A taken-over portal must not move a worker machine to an address it chose. Each daemon follows only the portal hosts
it was built with. Code: `machine/portalPin.ts`. Request: w5576, for lothsahn; it comes from finding 1 of the w5450
network audit.

## What is pinned, and why by name

- **The list.** `PINNED_PORTAL_HOSTS` in `machine/portalPin.ts` holds `fff.tailedfcad.ts.net` (the portal VM) and
  `beast.tailedfcad.ts.net` (the rollback host in [portal-on-ffbox-host.md](portal-on-ffbox-host.md)). Loopback is
  always allowed, because it is the machine itself.
- **Why the list is trusted.** It ships in the daemon's own code, so it changes only through an update. An update
  installs only a commit published on GitHub's ff-factory `main`; `checkPublished` in `machine/selfUpdate.ts` checks
  that on the machine itself (w5516). No signing key is involved. Signed updates were put off by lothsahn on
  2026-11-25 ("Drop build signing for now, remind me in 1 week").
- **One machine's extra hosts.** daemon.json's `pinnedPortalHosts` (a list of names) adds hosts on one machine. A
  person or the ops worker edits it by hand over ssh: no installer flag writes it, and an installer rerun keeps it. Nothing sent over the link can: `patchDaemonConfig` takes only `portalUrl`,
  `previousPortalUrl` and `relocatedAt`, and a link update's `LinkUpdateFlags` carry no portal field.
- **Why a host name, not an IP or a certificate pin.** The tailnet name is what every daemon.json already holds. Node
  checks its HTTPS certificate as it does for any site. A Tailscale certificate is a Let's Encrypt one that renews
  about every 90 days, so a certificate or key pin would stop every machine at the first renewal: an expiry with no
  alarm, which w5576 rules out. A tailnet IP changes when a node is registered again. A name has no expiry.

## What is checked

| Where | What | Warn mode (now) | Enforce mode (a later PR) |
|---|---|---|---|
| Daemon start | `portalUrl` and `previousPortalUrl` in daemon.json | logged, kept, reported; dialled | dialled (see "Recovery") |
| `relocate` (w466) | the new URL's host | logged, kept, reported; followed | refused: `relocate_result` says why |
| A fetch from the portal (attachments, review uploads, the update bundle) | a response that came through a redirect to an unpinned host | logged, kept, reported; used | the fetch fails |
| The `/machine` WebSocket | a redirect answer | not followed (`ws` follows none), as before; now also reported | the same |

- **Where warnings go.** Each warning is a log line, `portal pin (w5576, warn): would refuse, allowed in warn mode: …`.
  It is also kept in `portal-pin.json` beside daemon.json (the last 20, kept across restarts) and sent in the hello as
  `portalPin`.
- **What list_machines shows.** One line per online machine: `portal pin (w5576): warn mode; dials <host> (pinned);
  no warnings`, or the count and the three newest warnings. A daemon from before this change shows "not reported".
- **Failures in the check itself.** A pin check never throws. A warning file that cannot be read or written is logged
  and skipped.

## Before enforcing

Enforcement is its own PR, reviewed on its own. It ships only once every machine passes this check, in `list_machines`
and in its daemon log:

- **Machines.** BEAST, LothDesktop, biscuit, m3, m5 and FFBox; LothLaptop too once it is back.
- **What each must show.** `portal pin (w5576): warn mode; dials fff.tailedfcad.ts.net (pinned); follows …`, with no warning
  newer than the rollout of this change.
- **A warning newer than the rollout.** Find where it came from before going on. It is either a host to add to the
  list, or a portal that did something it should not.

## Moving the portal to a new host

1. Add the new host to `PINNED_PORTAL_HOSTS` and merge.
2. Let the rollout put that on every machine. Check with `list_machines`: each machine's pin line says which hosts it
   follows.
3. Only then move the portal: `relocate_machines`, as in [machines.md](machines.md), "Moving the portal".
4. Once every machine dials the new host, drop the old one in a later merge.

Never in the other order: in enforce mode, a relocate to a host the daemon does not yet follow is refused. The machine
then stays on the old portal while that portal still runs.

## Recovery

- **Warn mode can strand nothing.** It only logs.
- **Enforce mode gates only changes of address.** A daemon always dials the `portalUrl` in its daemon.json, and the
  `previousPortalUrl` fallback while a relocation is unsettled. A machine therefore loses its portal through pinning
  only if the portal moved to an unpinned host and the old host is gone. If that happens, take the first route that
  reaches the machine:
  1. **The old host still runs.** Merge the new host into `PINNED_PORTAL_HOSTS`, update the machine over its link from
     the old portal, then relocate it.
  2. **An ssh machine.** The ops worker reruns the installer over ssh with `--portal-url <new URL>` (or adds
     `pinnedPortalHosts` to daemon.json by hand, then reruns the installer, which keeps it and restarts the daemon), as in [ops-worker.md](ops-worker.md), "Updating and re-running a machine's installer". The
     installer writes daemon.json directly, and the daemon dials the `portalUrl` it finds there.
  3. **A `-NoSsh` machine.** Route 2 does not exist for it, so route 1 must stay open: keep the old portal running until
     every machine has moved.
- **A lost key, a CI secret or a certificate.** None of them is involved: the list lives in the code, and the hosts'
  certificates are checked as for any HTTPS site.

## What pinning does not stop

Pinning keeps a machine on a portal host we chose. It does not stop a taken-over portal on that host from running code
on the workers. That portal can still:

- start agents with Claude Code settings, hooks and prompts (`send`, `LaunchSpec` in `server/launch.ts`);
- merge to ff-factory `main` with the GitHub tokens in its vault, after which the rollout installs that code;
- ssh into the machines its records can reach.

Those three routes need a design of their own. The w5576 report for lothsahn (2026-11-25) lays them out.
