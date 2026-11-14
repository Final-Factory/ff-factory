# Every instance follows main (w14)

Final Factory's portal on its VM deploys every merge to `main` by itself (`server/autoDeploy.ts`, `deploy/vm/guest/fff-update`)
and then updates its machines' daemons (`server/machineRollout.ts`). The other portals on a computer, the *instances*
(a project's own portal on its own port, started by a logon task: docs/project.md), used to stay on whatever commit someone
last checked out: on 2026-11-14 BEAST's three were 6, 84 and 392 commits behind main (measured). This page is how they follow.

## How

One list per computer, `instances.json` (example: `scripts/instance/instances.example.json`), kept beside the updater's own
checkout, not in this repository (it names a person's folders). One scheduled task, `ff-instances-update`, runs every 5 minutes:

```
node scripts/instance/update-all.ts --list F:/ffw/instances/instances.json
```

1. **Target:** the commit the lead portal's `/api/health` reports (`leader.url`, Final Factory's), once it has reported it for
   `leader.stableMinutes` (5) and it is on `origin/main`. The VM's portal reports a new commit only after `fff-update` has
   verified it, and a rollback there shows the old commit again, so a deploy that fails on the VM never reaches an instance.
2. **The updater first:** its own checkout moves to the target and it runs again from there.
3. **Then one instance at a time,** in the list's order (put the one you lean on most last), each whose `/api/health` reports
   another commit:
   - **Drain:** `data/restart.request` with drain `auto`, as fff-update writes it on the VM: busy workers are asked to wrap up
     and the portal's own coordinators are waited for, for at most `drainMinutes` (30); after that it goes ahead and the
     sessions still busy are resumed after the restart (`resume.json`). Then a plain `restart.request`: stop now.
   - **Stop:** its task (and, with `daemonInApp`, its daemon's task) is disabled for the roll, since the tasks restart a
     failed task within a minute and a portal that came back during `npm ci` would run half-installed code; the portal exits
     by itself, and a daemon that runs from the portal's app folder is ended by its `daemon.json` path.
   - **Update:** `git checkout --detach <target>`, `npm ci`, the web's `npm ci` and build, `data/update.result.json`.
   - **Start and verify:** tasks enabled and started; `/api/health` must report the target within `healthMinutes` (6).
   - **Verified:** `data/update.verified.json`, the same marker fff-update leaves on the VM: that portal's machine rollout
     updates its own machines' daemons over their links (self_update; docs/worker-install.md), one machine at a time.
   - **Not verified,** or the build failed: the previous commit goes back (checkout, npm ci, build, start, verify), the
     commit is recorded as failed on this computer and the batch stops, so the instances after it keep code that works. A
     failed commit is not tried again; the next one the lead verifies is.
4. **Settings:** each instance's `config.json` is compared with its `expect` (settings a shared feature needs switched on per
   portal: `deviceApproval`, `trustProxy`, `machines.keepAgentsOnRestart`) and the differences are logged each time they
   change. The updater never edits a config.

State and log: `update-all.json` and `update-all.log` beside the list; a lock file there keeps two passes from overlapping.
`--dry-run` says what it would roll and changes nothing; `--only a,b` rolls just those instances (a roll by hand).

## What it does not change

Final Factory's own deploy. Nothing on the VM reads the list or knows the instances: the updater only reads the VM portal's
public `/api/health`. The VM's machines' daemons are updated by the VM's portal as before.

## Workers in the middle of a turn

- **The portal's restart:** the drain above. With `machines.keepAgentsOnRestart` set in the instance's config (FFF's VM sets
  it), workers on machines carry on through the restart untouched instead of being asked to wrap up.
- **The daemon's update:** a daemon installed by the worker installer runs its workers in agent hosts that outlive it
  (w605), so self_update does not cut a turn. A hand-made daemon that runs from the portal's app folder (`daemonInApp`) is
  stopped for the roll and its workers stop with it; install it properly (docs/worker-install.md) to end that.

## Adding an instance

Add it to the list. Its folder holds `config.json`; `app` (its checkout, a full clone: the machine rollout bundles from it)
is `<dir>/app` unless `app` says otherwise; `portalTask` is its logon task. Portals are on Windows only so far. The updater
must run as the same user as the instances' tasks, not elevated.
