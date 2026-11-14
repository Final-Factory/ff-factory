# Every instance follows main (w14)

Final Factory's portal on its VM deploys every merge to `main` by itself (`server/autoDeploy.ts`, `deploy/vm/guest/fff-update`)
and then updates its machines' daemons (`server/machineRollout.ts`). The other portals on a computer, the *instances*
(a project's own portal on its own port, started by a logon task: docs/project.md), used to stay on whatever commit someone
last checked out: on 2026-11-14 BEAST's three were 6, 84 and 392 commits behind main (measured). This page is how they follow.

## How

One list per computer, `instances.json` (example: `scripts/instance/instances.example.json`), kept beside the updater's own
checkout, not in this repository (it names a person's folders). One scheduled task, `ff-instances-update`, runs every 5 minutes
(`powershell -NoProfile -File scripts/instance/register-updater.ps1 -List <list> -Node <node.exe>` registers it, as you and not
elevated):

```
node scripts/instance/update-all.ts --list F:/ffw/instances/instances.json
```

1. **Target:** the commit the lead portal's `/api/health` reports (`leader.url`, Final Factory's), once it has reported it for
   `leader.stableMinutes` (5) and it is on `origin/main`. The VM's portal reports a new commit only after `fff-update` has
   verified it, and a rollback there shows the old commit again, so a deploy that fails on the VM never reaches an instance.
2. **The updater first:** its own checkout moves to the target and it runs again from there. Forward only: a lead still on
   an older commit (one from before the updater existed, or a rollback) leaves the updater where it is, so a pass never takes
   away the script the next pass runs.
3. **Then one instance at a time,** in the list's order (put the one you lean on most last), each whose `/api/health` reports
   another commit. Forward only here too: an instance someone updated ahead of the lead by hand (its commit is not in the
   lead's history) is left on its newer commit, said once in the log, and followed again once the lead passes it. Control
   first (w4218): this user must be able to disable and enable its task(s), so the pass disables and enables each again at
   once. One it cannot control (a task registered from an elevated shell: Administrators own it) is not drained, said once
   in the log, and rolled once the task is registered again from a normal shell.
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

## Tasks the updater can change

The stop disables the instance's tasks for the roll, so the updater's account must be able to change them. A task
registered from an administrator shell belongs to the Administrators group and that account may only read it ("Access is
denied"). Before it drains an instance the updater checks it can disable and enable its task (w4218), and when it cannot it
leaves the instance running and says so once in its log; it rolls it once the task is fixed. (Draining first had stopped
the Lens portal on BEAST from 22:34 to about 22:46 UTC on 2026-11-14.)

The fix is one administrator step: give the task to its user, as `register-tasks.ps1` and `scripts/instance/new.ts` make
them (owner the user, the user full control). From an administrator PowerShell:

```
$s = New-Object -ComObject Schedule.Service; $s.Connect()
$t = $s.GetFolder('').GetTask('<task>'); $u = (New-Object Security.Principal.NTAccount $env:USERNAME).Translate([Security.Principal.SecurityIdentifier]).Value
$t.SetSecurityDescriptor("O:$($u)G:$($u)D:(A;;0x1f019f;;;BA)(A;;0x1f019f;;;SY)(A;;FA;;;$u)", 0)
```

The running task is not touched.

## A new instance

`node scripts/instance/new.ts` makes one, adds it to the list and prints what is left for the owner (docs/project.md,
"A new instance is one command"). Try it with `--dry-run` first.
