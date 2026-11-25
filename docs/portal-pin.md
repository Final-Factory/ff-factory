# Pinned portal hosts (w5576, w5715)

A taken-over portal must not move a worker machine to an address it chose. Each daemon follows only the portal hosts
it was built with. Code: `machine/portalPin.ts`. Requests: w5576 (warn mode) and w5715 (enforce mode), both for
lothsahn; they come from finding 1 of the w5450 network audit.

## What is pinned, and why by name

- **The list.** `PINNED_PORTAL_HOSTS` in `machine/portalPin.ts` holds `fff.tailedfcad.ts.net` (the portal VM) and
  `beast.tailedfcad.ts.net` (the rollback host in [portal-on-ffbox-host.md](portal-on-ffbox-host.md)). Loopback is
  always allowed, because it is the machine itself.
- **Why the list is trusted.** It ships in the daemon's own code, so it changes only through an update. An update
  installs only a commit published on GitHub's ff-factory `main`; `checkPublished` in `machine/selfUpdate.ts` checks
  that on the machine itself (w5516). No signing key is involved. Signed updates were put off by lothsahn on
  2026-11-25 ("Drop build signing for now, remind me in 1 week").
- **One machine's extra hosts.** daemon.json's `pinnedPortalHosts` (a list of names) adds hosts on one machine; an
  entry written as a URL or `host:port` counts as its host, and a trailing dot is ignored (`pinnedHostOf`). A
  person or the ops worker edits it by hand over ssh: no installer flag writes it; an installer update (`-Update`/`--update`, a reinstall or a migration) keeps it; a full install rerun drops it. Nothing sent over the link can: `patchDaemonConfig` takes only `portalUrl`,
  `previousPortalUrl` and `relocatedAt`, and a link update's `LinkUpdateFlags` carry no portal field.
- **Why a host name, not an IP or a certificate pin.** The tailnet name is what every daemon.json already holds. Node
  checks its HTTPS certificate as it does for any site. A Tailscale certificate is a Let's Encrypt one that renews
  about every 90 days, so a certificate or key pin would stop every machine at the first renewal: an expiry with no
  alarm, which w5576 rules out. A tailnet IP changes when a node is registered again. A name has no expiry.

## What is checked

`PORTAL_PIN_MODE` in `machine/portalPin.ts` is `'enforce'` since w5715. Setting it back to `'warn'` and merging is the
whole rollback; the rollout takes it to every machine like any other merge.

| Where | What | Warn mode (w5576) | Enforce mode (now, w5715) |
|---|---|---|---|
| Daemon start | `portalUrl` and `previousPortalUrl` in daemon.json | logged, kept, reported; dialled | the same: **a dial is never refused** (see "Recovery") |
| `relocate` (w466) | the new URL's host | logged, kept, reported; followed | refused: `relocate_result` is `ok:false` and says why; daemon.json, the link and the portal it dials stay as they were |
| A fetch from the portal: attachments, review uploads | each redirect hop, checked before it is followed (`portalFetch`, `redirect:'manual'`) | logged, kept, reported; followed | refused before the hop: nothing is sent to that host, and the fetch fails at once, never retried; a hop to a pinned host, or within the host already dialled, is followed |
| A fetch from the portal: the update bundle | each redirect hop | logged, kept, reported; followed | **never refused**: logged, kept, reported and followed, since the size, SHA-256 and published-commit check decide what installs, and a pin must never stop a machine's updates (w5726) |
| The `/machine` WebSocket | a redirect answer | not followed (`ws` follows none), as before; now also reported | the same |

- **Where warnings go.** Each warning is a log line. Warn mode wrote
  `portal pin (w5576, warn): would refuse, allowed in warn mode: …`; enforce mode writes
  `portal pin (w5576, enforce): REFUSED: …` for a relocate or a refused redirect,
  `portal pin (w5576, enforce): followed, an update download is never refused: …` for an update's redirect, and
  `portal pin (w5576, enforce): dialled anyway, a dial is never refused: …` for an unpinned `portalUrl`. Each is also
  kept in `portal-pin.json` beside daemon.json (the last 20, kept across restarts) and sent in the hello as `portalPin`.
- **What list_machines shows.** One line per online machine: `portal pin (w5576): enforce mode; dials <host> (pinned);
  no warnings`, or the count and the three newest warnings. A daemon from before w5576 shows "not reported".
- **A refused relocate at a cut-over (w499).** The portal's `relocateAll` takes the refusal like any other: the
  machine's entry in `relocate.result.json` says `ok:false` with the daemon's reason, and the drain-and-hold goes on to
  `drain.done` and the hold as with an accepted one (`server/relocate.test.ts`, "a refused relocate still releases the
  drain-and-hold"). The refused machine stays on the old portal.
- **Redirects.** `portalFetch` (machine/portalPin.ts) follows at most 5 redirects itself. The token goes only to the
  host it was meant for, never across a hop to another host; a 303, or a 301/302 of a POST, becomes a GET with no body.
  An update bundle is checked against the size and SHA-256 the portal sent on the link, and the commit against GitHub's
  `main` (w5516), wherever it came from.
- **Failures in the check itself.** A pin check never throws. A warning file that cannot be read or written is logged
  and skipped.

## Before enforcing (the gate w5715 passed)

Enforcement was its own PR, reviewed on its own. It merged only once every machine passed this check, in `list_machines`
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
3. Only then move the portal: `relocate_machines`, as in [machines.md](machines.md), "Moving the portal". The BEAST
   cut-over (`fffctl migrate --cut-over`) refuses an unpinned target before it copies, drains or stops anything (exit
   4); `--pinned-host <host>` names a host every machine's daemon.json already pins by hand. If a daemon still refuses
   the relocate, the cut-over gives up and BEAST's portal keeps running (`scripts/fff-migrate-cutover.test.ts`).
4. Once every machine dials the new host, drop the old one in a later merge.

Never in the other order: in enforce mode, a relocate to a host the daemon does not yet follow is refused. The machine
then stays on the old portal while that portal still runs.

## Renaming the tailnet

Every pinned name ends in the tailnet's name (`tailedfcad.ts.net`). Renaming the tailnet changes every portal host's
name at once, so in enforce mode no machine would follow a relocate to the new names. Before any rename:

1. Add the new names (`fff.<new tailnet>`, `beast.<new tailnet>`) to `PINNED_PORTAL_HOSTS` and merge.
2. Let the rollout put that on every machine, and check each machine's pin line in `list_machines`.
3. Rename the tailnet, then relocate the machines (`relocate_machines`), as in "Moving the portal to a new host".
4. Drop the old names in a later merge.

A rename done first does not lock a machine out by itself: each daemon still dials the `portalUrl` in its daemon.json.
But that old name stops resolving, so the machine is offline until route 2 in "Recovery" below.

## Recovery

- **Warn mode can strand nothing.** It only logs.
- **Enforce mode gates only changes of address** (relocates, and review and attachment redirects to another host). A daemon always dials the `portalUrl` in its daemon.json, and the
  `previousPortalUrl` fallback while a relocation is unsettled. A machine therefore loses its portal through pinning
  only if the portal moved to an unpinned host and the old host is gone. If that happens, take the first route that
  reaches the machine:
  1. **The old host still runs.** Merge the new host into `PINNED_PORTAL_HOSTS`, update the machine over its link from
     the old portal, then relocate it.
  2. **An ssh machine.** The ops worker, over ssh, takes the first of these that fits:
     - **(a) Edit daemon.json, then update.** Set `portalUrl` to the new URL, and add the new host to
       `pinnedPortalHosts` if it is not built in. Then run the installer's update form (`-Update` on Windows,
       `--update` on macOS and Linux), as in [ops-worker.md](ops-worker.md#updating-and-re-running-a-machines-installer-w855).
       The update reads `portalUrl` from daemon.json (it has no `--portal-url` flag), keeps both fields and the
       machine's other carried settings, and restarts the daemon. An update alone, without the edit, keeps the old
       `portalUrl`, and the daemon goes on dialling the dead host.
     - **(b) A full install rerun** with `--portal-url <new URL>` (it needs the machine's credential,
       `-CredentialFile`). It rewrites daemon.json and drops `pinnedPortalHosts` and the other settings only an update
       carries. The daemon dials the new URL anyway: the start-up check of the configured URL never stops a dial, in
       either mode (`PortalPin.check` never refuses `kind: 'dial'`; tested live in `server/relocate.test.ts`, "a daemon
       whose own portalUrl is not pinned still dials it"). If the new host is not built in, add it
       back to `pinnedPortalHosts` by hand afterwards and run (a)'s update.
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
