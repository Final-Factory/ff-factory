# Installing the portal VM on the FFBox host: the runbook

One command on the FFBox host (Ubuntu 24.04), run by Lothsahn as root, installs the host side and then the portal
inside the VM, and sets the portal up: Tailscale and Funnel, the subscription token, GitHub and the base clone,
config.json and the backups. It asks for everything it needs first, before it changes anything, and stores the answers
in `/etc/fff-vm`, so running it again (or rebuilding the VM) asks nothing it already knows. The design and the reasons
are in [docs/portal-on-ffbox-host.md](../../docs/portal-on-ffbox-host.md). Every step is idempotent: a run that stops
can be run again after its cause is fixed, and it does only what is missing.

**What it does not do:** move the portal. BEAST keeps running the real one. The VM gets an empty portal that nobody can
sign in to, because logins exist only once someone runs `node server/user.ts` inside the VM. The data moves later,
after the code changes in the design's section 6, with its dry run, cut-over and rollback (section 7).

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
short list of what it could not do itself, each with why. Typically:

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
