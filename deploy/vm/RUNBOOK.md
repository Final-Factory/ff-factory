# Installing the portal VM on the FFBox host: the runbook

One command on the FFBox host (Ubuntu 24.04), run by Lothsahn as root, installs the host side and then the portal
inside the VM, and sets the portal up: Tailscale and Funnel, the subscription token, GitHub and the base clone,
config.json and the backups. It asks for everything it needs first, before it changes anything, and stores the answers
in `/etc/fff-vm`, so running it again (or rebuilding the VM) asks nothing it already knows. The design and the reasons
are in [docs/portal-on-ffbox-host.md](../../docs/portal-on-ffbox-host.md). Every step is idempotent: a run that stops
can be run again after its cause is fixed, and it does only what is missing.

**What it does not do:** move the portal. BEAST keeps running the real one. The VM gets an empty portal that nobody can
sign in to, because logins exist only once someone runs `node server/user.ts` inside the VM. The data moves later, with
one command in the VM, `fffctl migrate`: first a dry run (section 4 below), then the cut-over (section 5).

**Do not install Tailscale on the FFBox host.** Tailscale runs inside the VM only. A tailnet on the host would put BEAST
and the Macs within reach of FFBox's `ffdev` containers (design 1.4, rule 1).

## 1. Ben, in the Tailscale admin console

1. **The policy** (Access controls): the tag, the portal's grants, and Funnel for the tag only.

   ```jsonc
   "tagOwners": { "tag:fff-portal": ["autogroup:admin"] },
   "hosts": { "beast": "100.x.x.x", "lothdesktop": "100.x.x.x", "m3": "100.x.x.x", "m5": "100.x.x.x" },
   "grants": [
     // people's devices and the machines reach the portal's HTTPS (Funnel serves the public side by itself)
     { "src": ["autogroup:member"], "dst": ["tag:fff-portal"], "ip": ["tcp:443"] },
     // the portal deploys and backs up to the four machines over ssh, and nothing else
     { "src": ["tag:fff-portal"], "dst": ["beast", "lothdesktop", "m3", "m5"], "ip": ["tcp:22"] }
   ],
   "nodeAttrs": [ { "target": ["tag:fff-portal"], "attr": ["funnel"] } ]
   ```

   **Done (Ben, 2026-10-05):** the tailnet runs these rules in place of the default allow-all, checked by Ben. The
   policy before the change is kept as [`tailnet-policy-before-2026-10-05.hujson`](tailnet-policy-before-2026-10-05.hujson):
   paste it back into the JSON editor and Save to roll back.
2. **An auth key** (Settings, Keys, Generate auth key): **not** reusable, **not** ephemeral, **pre-approved**, tag
   `tag:fff-portal`, expiry 1 day. It only has to work once: after the join the node keeps its own identity. Ben sends
   it to Lothsahn privately, not in a chat the agents read. A rebuilt VM needs a fresh one.

## 2. Lothsahn, on the FFBox host

What to have at hand (the installer asks for each, and stores it):

| It asks for | Default | Stored in |
|---|---|---|
| the VM's ZFS dataset (it lists the pools) and where it is mounted | `<first pool>/fff-vm`, `/<dataset>` | `/etc/fff-vm/fff-vm.conf` |
| the VM's time zone | America/Denver (BEAST's) | `fff-vm.conf` |
| your ssh public key for the VM's admin account | your `~/.ssh/id_ed25519.pub` | `/etc/fff-vm/admin_authorized_keys` |
| the alerts' ntfy URL | FF Factory's outside-watch topic | `/etc/fff-vm/ntfy-url` (0600) |
| the portal's owner name (config `ownerName`) | | `fff-vm.conf` |
| your Claude subscription token: `claude setup-token` on any machine with Claude Code, the `sk-ant-oat01-...` it prints | | `/etc/fff-vm/secrets/claude-token` |
| Ben's Tailscale auth key (`tskey-auth-...`) | | `/etc/fff-vm/secrets/tailscale-authkey`, deleted once the node has joined |
| the portal's GitHub token (D7, `github_pat_...`); skipping it needs an explicit yes | | `/etc/fff-vm/secrets/gh-token` |
| the backups: the sftp target (`fff-backup@beast`) and the age public keys; both may be left empty | | `fff-vm.conf`, `/etc/fff-vm/backup-recipients.txt` |

Secrets are typed without echo, checked for their format (and the Tailscale key for its age: older than a day, it has
expired), stored root-only (`/etc/fff-vm/secrets`, 0700, files 0600), and go into the VM only over ssh's stdin, into
the guest's `/run` (memory), handed to `fffctl` as a file and removed. Never on a command line, in a log or in the
cloud-init seed.

```bash
# 2.1 What the host has (nothing here changes anything)
lsb_release -ds; nproc; free -g; zpool list; sudo nft list tables; ip -4 route
grep -Ec 'vmx|svm' /proc/cpuinfo        # above 0, or turn on VT-x/AMD-V in the firmware

# 2.2 The scripts (already cloned: drop any local edit first, then pull)
sudo apt-get install -y git
git clone https://github.com/Final-Factory/ff-factory.git ~/ff-factory    # or: git -C ~/ff-factory checkout -- . && git -C ~/ff-factory pull
cd ~/ff-factory

# 2.3 Optional: what it would do, changing nothing (it says which answers a real run would still need)
sudo deploy/vm/host/install.sh --dry-run

# 2.4 The install: questions first, then the host, the VM's first boot, the portal inside it and its settings
sudo deploy/vm/host/install.sh
```

It ends with `fffctl status` from inside the VM (the portal active, its release, Tailscale and the Funnel URL), and a
short list of what it could not do itself, each with why. The portal's `publicUrl` is set from the VM's tailnet address
(`https://<node>.<tailnet>.ts.net`) by the guest install, `fffctl tailscale-join` and every `fffctl update`, whenever
it is empty or a different ts.net address; a URL off ts.net is left alone. Typically:

- **the portal's deploy key**, to add on each machine it deploys to (BEAST, LothDesktop, M3, M5): the installer prints
  the whole `from="<the VM's tailnet IP>",no-agent-forwarding,... ssh-ed25519 ...` line (design 4.3). Add it to
  `~/.ssh/authorized_keys`, or on a Windows admin account `C:\ProgramData\ssh\administrators_authorized_keys`.
- **the backup key**, when the first backup could not reach the target yet: it prints the `restrict ssh-ed25519 ...`
  line for the backup account's `~/.ssh/authorized_keys`. Then `sudo fff-vm ssh`, `sudo fffctl backup`.

Then check:

```bash
sudo fff-vm status                        # running, agent answers, firewall table loaded, timers set
sudo fff-vm notify-test                   # a test alert arrives on the phone
```

From your own device: `https://fff.<tailnet>.ts.net/api/health` answers `{"ok":true,...}`.

If it says **REFUSED**, something of the same name exists and is not this installer's: it names the thing and changes
nothing. The usual one is another libvirt network on 10.213.41.0/24. Pick other `NET_HOST_IP` and `NET_VM_IP` values in
`/etc/fff-vm/fff-vm.conf` and run it again.

### On a host where the VM already runs

Run the same command. It recognises what is there: the host steps find everything in place and change nothing (the VM
keeps running), it asks only for the answers not stored yet (on tonight's host, set up by the earlier runbook: the
mountpoint, the owner name and the tokens), and inside the VM it does only what `fffctl state` says is missing.

### Without questions

`--yes` (or no terminal) takes the stored answers and stops, before any change, with the list of what is missing and
where to put it: exit code 2. `GUEST_TAILSCALE=skip` and `GUEST_GITHUB=skip` in `fff-vm.conf` leave those out on
purpose (CI does). Parts on their own: `--host-only`, `--guest-only`.

## 3. Rebuilding the VM

```bash
sudo deploy/vm/host/install.sh --rebuild-vm
```

It deletes the VM and its disk, **with all the portal's data in it and its snapshots** (it asks you to type the VM's
name), and makes it again from the stored answers. Only a fresh Tailscale auth key is asked for: the stored one was
used at the first join and deleted then. Back up first (`sudo fff-vm ssh`, `sudo fffctl backup`) if the data matters.

## 4. Dry run: BEAST's portal copied into the VM, defused

One command inside the VM pulls BEAST's portal (its `config.json`, `data\` and the conversations the orchestrators,
the dispatcher and BEAST's standing agents resume) straight from BEAST over ssh. It rewrites the copy for Linux, starts
it as a **dry run** and checks it. On BEAST it only reads: it lists files and runs `tar` there, nothing else. BEAST's
portal keeps running for everyone. The design is section 7.2 of
[docs/portal-on-ffbox-host.md](../../docs/portal-on-ffbox-host.md); the code is `scripts/fff-migrate.ts`.

**Before:**

- The VM is installed (section 2). The subscription token is stored and the base clone is there; `fffctl status`
  shows both.
- The portal's key is authorized on BEAST. Print the line with:

  ```bash
  sudo fff-vm ssh
  sudo fffctl migrate --key       # the line, and whether BEAST answers yet
  ```

  Someone with administrator rights on BEAST (Ben) adds that line to `C:\ProgramData\ssh\administrators_authorized_keys`.
  `rydin`, the account the migration logs in as, is an administrator. Edit the existing file without changing its
  permissions. The line's `from="<the VM's tailnet IP>"` lets only the VM use the key. `--key` reports `BEAST answers:
  BEAST|<time>` once it works.

**Run it** (inside the VM: `sudo fff-vm ssh` first):

```bash
sudo fffctl migrate --dry-run-copy
```

Before it reads anything it takes **one point-in-time snapshot on BEAST**, and every file comes from it (the listing,
every stream, every retry), so the copy is one consistent view of the live portal, and the live files are never held
open (reading them in place made the portal's own saves fail, and Windows tar stop at any file that grew):

- a **VSS shadow copy** of C: (the portal's data and the conversations are both on it), reached through a link in
  BEAST's temp folder. It needs the ssh session's administrator rights, which `rydin` has;
- otherwise a **staged copy** in BEAST's temp folder (robocopy, after checking the disk has room for it), with any
  file it could not copy listed.

It says which, and BEAST's free space. The snapshot is removed when the copy ends, when it fails, and on Ctrl+C; one a
run could not remove (a crash) is removed by the next. `--snapshot copy` takes the staged copy without trying VSS.

While it copies it says what it does:

- "listing BEAST's files under C:/ff-sandboxes..." and then how many files and how much there is, and how much of it
  is to copy;
- which compression it uses: zstd level 3 through BEAST's own tar, else gzip, else bzip2, else none (it never stops
  over compression, and says why it took a lesser one). On real JSONL transcripts zstd 3 sent about a third of the
  bytes (3.3x) and cost BEAST about 2 s of CPU for 700 MB; gzip only 1.8x and about 13 s;
- a progress line every 5 seconds: files and megabytes done out of the total, the rate, and about how long is left. In a
  terminal (PuTTY too) it is one line rewritten in place; in a log, a line every 30 seconds;
- the time each part took (BEAST's config.json and data, then the conversations), and how many bytes of files came in
  how many bytes over the wire.

The copy goes in streams of at most 2,000 files and 256 MB. Each stream is checked, and tried again up to 3 times if it
breaks off. If BEAST's tar stops at a file (it prints `tar: (null)` for one it could not read to the end), that file is
taken out of its stream and sent on its own, and the stream goes on. A file it cannot read or that is gone is named at
the end and left out; the next run tries it again. If a stream keeps breaking, it stops and says so with BEAST's own message. Running the same
command again goes on from where it stopped. On BEAST it keeps its file lists in its temp folder
(`%TEMP%\fff-migrate-*`, removed at the end) and changes nothing else.

It prints and keeps in `/srv/fff/migrate/report-dry-run-*.txt`:

- the copy's size and time;
- every rewrite it made: BEAST from the portal's own host to a machine over ssh; every machine's portal URL; the paths;
  the portal-only mode; the orchestrators and the dispatcher on the subscription token; `machines.useHostClaudeEnv` for
  BEAST, so its workers keep their account;
- then four checks, each **PASS** or **FAIL**:
  - it starts as a dry run (`/api/health` says `dryRun`);
  - no data was restored on load;
  - the session, work-item, machine and transcript counts equal BEAST's;
  - the dispatcher's conversation resumes here on the token file (one short message, through `claude --resume
    --fork-session`, so the copied conversation itself is not changed).

While it is in place:

- **FFSB_DRY_RUN=1** (a systemd drop-in) keeps everything that acts outside off: no wakes, timers, standing runs, intake,
  push, FFBox link, Discord, daemon links, deploys or workers. Every page shows a red DRY RUN bar.
- **The Funnel is off.** The portal answers only on the tailnet, at `https://fff.<tailnet>.ts.net` (`tailscale serve`).
  The logins are BEAST's.
- **The VM's backups are paused.**

Do the checks that need a person (design 7.2, checks 2 and 4 to 13): sign in from a phone and a desktop, open
transcripts, download an attachment, and the rest. Running the same command again copies only what changed on BEAST
since, and checks again.

**End it:**

```bash
sudo fffctl migrate --rollback-dry-run
```

It puts the VM's own config and data back from the snapshot the first run took (`/srv/fff/migrate/before`). It removes
the copied conversations and FFSB_DRY_RUN, turns the Funnel and backups back on, and wipes the pulled copy with its
secrets. `--keep-stage` keeps the pulled copy (root-only, `/srv/fff/migrate/stage`), so the cut-over's first copy only
fetches what changed.

## 5. Cut-over

At a quiet moment Ben and Lothsahn pick (design 7.3). Workers on the machines keep running. Nobody should be
mid-conversation with an orchestrator.

**Before:**

- The dry run has been rolled back.
- BEAST's portal runs a release with the cut-over's relocate (w499, 2/3). Check its version on its page.
- The Funnel is on in the VM (`fffctl status`).
- The key line from section 4 is on BEAST.

```bash
sudo fff-vm ssh
sudo fffctl migrate --cut-over
```

1. **A first copy while BEAST still runs**, rewritten once to check it. Nothing on BEAST changes yet.
2. **It asks you to type `CUT OVER`.** Anything else stops there, with nothing touched.
3. **The VM's own portal stops**, so a daemon sent to it meets a closed door and retries rather than being refused.
4. **BEAST's portal drains**, up to `--drain-minutes` (5 by default). It sends every connected daemon to the VM's
   public URL (relocate), writes the outcome, and holds. Each machine is listed as relocated or not.
5. **BEAST's portal is stopped**, by its own `scripts\stop-server.ps1`, and its `ffsb-server` task is disabled, so
   nothing starts it again. Its folder and data stay as they are.
6. **The rest of the copy** (what changed since step 1), the rewrite, and the VM's portal starts for real.
7. **The checks:** the portal answers within 3 minutes, and each relocated daemon says hello within 3 minutes.

**If the portal in the VM does not come up**, the command rolls back by itself:

- the VM's own data back;
- BEAST's task enabled and started again, on BEAST's data as it was;
- the relocated daemons return to BEAST by themselves within about 10 minutes (their fallback).

**A machine that was not relocated** (an old daemon) or does not say hello is named. Redeploy it from the new portal
(`machine_daemon redeploy`).

**By hand afterwards**, as the command's last lines say:

1. **FFBox's link**: Lothsahn, on the FFBox host as FFBox's owner account. The connector's address is `fff.url` in
   FFBox's config, rendered into its unit by root, so the migration cannot move it; until this is done FFBox shows
   offline and its board checks, dev requests and intake hand-offs wait (2026-10-06: missed, BEAST's old URL answered
   502). The cut-over prints these with both URLs filled in:

   ```bash
   sed -i 's|"url": "<BEAST URL>"|"url": "<new URL>"|' ~/.config/ffbox/config.json
   grep -n '"url"' ~/.config/ffbox/config.json                  # "url": "<new URL>"
   cd "$(cat ~/.config/ffbox/checkout)" && sh scripts/06-services.sh --check
                                                                # units differ ...: fffconnector.service, and no other
   sudo sh scripts/06-services.sh --install                     # restarted fffconnector.service
   journalctl -u fffconnector -n 5 --no-pager                   # connected
   ```

   `--install` restarts only the units whose file changed and that were running, so `--check` must name
   `fffconnector.service` alone: another unit there (drift from an earlier template change) would be restarted too,
   which can cut a build or run in flight; wait for a quiet moment then. The token stays as it is. Max's escalations
   post to the same `fff.url`.
2. Everyone opens the new URL, signs in, adds the phone app again, turns notifications on, and points `/mcp` at it.

Then the checks of design 7.4. A rollback after real use is design 7.5. BEAST's old portal is left exactly as it was
for two weeks (its task disabled, not removed).

## 6. Updating the portal

```bash
sudo fff-vm ssh
sudo fffctl update
```

It waits, and shows each stage on one line rewritten in place: building the new release beside the running one (or
"already up to date"), the drain with how many agents are still finishing and the time left, the restart, the new code
answering, and fff-health's verification. It exits 0 once the new release is verified (or nothing needed doing), 1 when
the build failed or the update was rolled back (with the reason), 2 when it timed out (`--timeout-minutes`, 60 by
default), and prints the `journalctl` command for the details. Ctrl+C stops the waiting, not the update. `--no-wait`
only asks for it, as `request_app_update` does. `fffctl restart` and `fffctl rollback` wait the same way until the portal
answers again.

Each update also installs `fffctl` and every helper script in `/usr/local/lib/fff` from the release it switches to (and
from the older release on a rollback), so they stay as new as the portal; "already up to date" brings them up to the
running release too. A changed systemd unit is not installed this way: the update's log says so, and the guest
`install.sh` from a clone at that commit installs it.

## 7. Changing the VM's size

The size is `VM_VCPUS` and `VM_MEMORY_MB` in `/etc/fff-vm/fff-vm.conf` (4096 since 2026-10-06). Edit it; the nightly
cold restart (`NIGHTLY_TIME`, 12:00 UTC) applies it, or now:

```bash
sudo sed -i 's/^VM_MEMORY_MB=.*/VM_MEMORY_MB=4096/' /etc/fff-vm/fff-vm.conf
sudo fff-vm status            # definition: fff-vm.conf asks for memory 8192 -> 4096 MiB: the next nightly applies it
sudo fff-vm nightly --now     # optional, instead of waiting: drain, shut down, snapshot, apply, start, wait for the portal
sudo fff-vm status            # VM fff-portal: running (2 vCPUs, 4096 MiB, ...); definition: matches fff-vm.conf
sudo fff-vm ssh 'free -m'     # Mem: total about 3,910 MiB (CI's 4 GiB guest)
```

With the VM off, the nightly defines the new size (`journalctl -u fff-vm-nightly` shows what changed) and keeps libvirt's
previous definition in `/etc/fff-vm/domain.libvirt-prev.xml`. If libvirt refuses the new one, the VM does not start
with it, or the portal does not answer within 15 minutes of the start, it defines the previous one again, starts the VM,
and alerts; `fff-vm status` then says so, and that size is not tried again until `fff-vm.conf` changes. `--now` drains
the portal like the nightly: run it when no update or migration is under way (`sudo fff-vm ssh 'systemctl is-active
fff-update.service; pgrep -af "[f]ff-migrate" || echo "no migrate running"'` says `inactive` and `no migrate running`).
A change to the disk, seed, network or MAC address in `fff-vm.conf` is not the nightly's: stop the VM and run
`install.sh --host-only`, which defines whatever changed while the VM is off. `install.sh` never redefines a running VM;
it says what the nightly will apply.

A host installed before 2026-10-06 (w537) has the older `fff-vm`, which restarts the VM without applying anything:
update the host's scripts once, `git -C ~/ff-factory pull && sudo ~/ff-factory/deploy/vm/host/install.sh --host-only
--yes` (it leaves the running VM alone).

## 8. /tmp on the VM's disk (a VM installed before 2026-10-06)

Ubuntu 26.04 keeps `/tmp` in RAM, half of it: 1.9 GiB in the 4 GiB VM. The portal's clean-up counts that as its free
disk space and reports it as low. The guest install now masks `tmp.mount`; for a VM installed before (w537):

```bash
sudo fff-vm ssh 'df -h / /tmp; findmnt -n -o FSTYPE,OPTIONS /tmp'
                              # before: / about 118G; /tmp "tmpfs 1.9G"; "tmpfs rw,nosuid,nodev,size=...,usrquota"
sudo fff-vm ssh 'sudo systemctl mask tmp.mount'
                              # Created symlink '/etc/systemd/system/tmp.mount' -> '/dev/null'.
                              # nothing changes until the VM's next boot: the nightly, or sudo fff-vm nightly --now
sudo fff-vm ssh 'findmnt /tmp || echo "/tmp is on the root disk"; df -h /tmp'
                              # after that boot: "/tmp is on the root disk", and /dev/vda1 about 118G
```

## If it must come off again

```bash
sudo ~/ff-factory/deploy/vm/host/uninstall.sh --dry-run
sudo ~/ff-factory/deploy/vm/host/uninstall.sh --delete-disk    # the VM, its disk, network, firewall table and units
```

Without `--delete-disk` the disk and its snapshots stay. Packages stay unless `--purge-packages`, which removes only
what the install added. `/etc/fff-vm`, the answers and secrets included, is kept as a root-only tarball in
`/var/backups`, or left in place with `--keep-config`.

## Choices made for this install, and why

| Choice | Value | Reason |
|---|---|---|
| Node name | `fff` | D3: neutral, will not need to change; the Funnel URL is `https://fff.<tailnet>.ts.net` |
| VM time zone | America/Denver, BEAST's own (Ben confirmed, 2026-10-05) | Cron triggers and daily budgets are read in the portal's local time, so the move keeps their times. The guest's update, backup and nightly restart times are set in UTC either way |
| Private network | 10.213.41.0/24 (host .1, VM .10) | Unlikely to collide with a home LAN or Docker's ranges; the installer refuses if it does |
| Guest resolvers | 1.1.1.1, 9.9.9.9 | The VM uses no DNS service on the host (design 1.3) |
| Funnel on the first join | on | Logins exist only once `node server/user.ts` runs in the VM, so an empty portal behind Funnel cannot be signed in to |
| The orchestrators and the dispatcher | on the subscription token (`claudeAccounts` `tokenfile`) | D4, design 5.2; workers stay as they are |
| A copy of the secrets on the host | `/etc/fff-vm/secrets`, root-only | So a rebuilt VM needs no one to find them again. Root on this host can read the VM's memory and disk anyway (D2), so this moves no boundary |
