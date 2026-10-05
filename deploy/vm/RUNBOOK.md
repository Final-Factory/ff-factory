# Installing the portal VM on the FFBox host: the runbook

Tonight's install, in order: Ben's two steps in Tailscale, then Lothsahn on the FFBox host (Ubuntu 24.04), then in the
VM. The design and the reasons are in [docs/portal-on-ffbox-host.md](../../docs/portal-on-ffbox-host.md). Every script
here is idempotent, so a step that stops can be run again after its cause is fixed.

**What tonight does not do:** move the portal. BEAST keeps running the real one. The VM gets an empty portal that
nobody can sign in to, because logins exist only once someone runs `node server/user.ts` inside the VM. Nothing
points at the VM yet: no daemon, no FFBox connector, no browser. The data moves later, after the code changes in the
design's section 6 (changes 1-4, 6, 7, 18, 19), with its dry run, cut-over and rollback (section 7).

**Do not install Tailscale on the FFBox host.** Tailscale runs inside the VM only. A tailnet on the host would put BEAST
and the Macs within reach of FFBox's `ffdev` containers (design 1.4, rule 1).

## 1. Ben, in the Tailscale admin console

1. **The policy** (Access controls). Add the tag, the portal's grants, and Funnel for the tag only. Machine names
   below are placeholders for the tailnet IPs of BEAST, LothDesktop, M3 and M5 (Machines page):

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

   **Done (Ben, 2026-10-05):** the tailnet now runs these explicit rules in place of the default allow-all. Ben
   checked them: BEAST's ssh to the machines, the daemons to the portal on 443, Funnel and pings all pass. The policy
   before the change is kept as [`tailnet-policy-before-2026-10-05.hujson`](tailnet-policy-before-2026-10-05.hujson),
   to paste back if something breaks. It is Tailscale's default allow-all, whose sample emails and IP are
   placeholders.
   Rollback: [tailnet-policy-before-2026-10-05.hujson](tailnet-policy-before-2026-10-05.hujson) is the policy as it
   was before this change (copied out by Ben); paste this file back into the JSON editor and Save.
2. **An auth key** (Settings, Keys, Generate auth key): **not** reusable, **not** ephemeral, **pre-approved**, tag
   `tag:fff-portal`, expiry 1 day. The key only has to work once; a tagged node's own key does not expire. Ben makes it
   when Lothsahn reaches section 3 and sends it to him privately, not in a chat the agents read.

## 2. Lothsahn, on the FFBox host (as root)

```bash
# 2.1 What the host has (read it; nothing here changes anything)
lsb_release -ds; nproc; free -g; zpool list; sudo nft list tables; ip -4 route
grep -Ec 'vmx|svm' /proc/cpuinfo        # above 0, or turn on VT-x/AMD-V in the firmware

# 2.2 The scripts
sudo apt-get install -y git
git clone https://github.com/Final-Factory/ff-factory.git ~/ff-factory
cd ~/ff-factory

# 2.3 Settings: copy the defaults, then set the two lines below
sudo install -d -m 0755 /etc/fff-vm
sudo cp deploy/vm/host/fff-vm.conf.example /etc/fff-vm/fff-vm.conf
sudoedit /etc/fff-vm/fff-vm.conf
#   VM_ZVOL_PARENT=<pool>/fff-vm        a new dataset on a pool from `zpool list` with 130 GB free (D13)
#   VM_TIMEZONE=America/Denver          BEAST's zone (Ben confirmed), so the portal's cron schedules keep their times

# 2.4 Your ssh key for the VM's admin account, and the alerts' ntfy URL
cat ~/.ssh/id_ed25519.pub | sudo tee /etc/fff-vm/admin_authorized_keys
echo 'https://ntfy.sh/<topic>' | sudo tee /etc/fff-vm/ntfy-url >/dev/null && sudo chmod 600 /etc/fff-vm/ntfy-url
#   <topic>: FF Factory's outside-watch topic; ask your orchestrator (system_status names it)

# 2.5 Dry run: read every WARNING and REFUSED line, then install
sudo deploy/vm/host/install.sh --dry-run
sudo deploy/vm/host/install.sh --wait     # a few minutes: libvirt, the image, the VM's first boot

# 2.6 Check
sudo fff-vm status                        # running, agent answers, firewall table loaded, timers set
sudo fff-vm notify-test                   # a test alert arrives on the phone
```

If the dry run says **REFUSED**, something of the same name exists and is not this installer's: it names the thing
and changes nothing. The usual one is another libvirt network on 10.213.41.0/24. Pick other `NET_HOST_IP` and
`NET_VM_IP` values in `/etc/fff-vm/fff-vm.conf` and run it again.

## 3. Lothsahn, in the VM

```bash
sudo fff-vm ssh                           # from the host: a shell in the VM as fffadmin

git clone https://github.com/Final-Factory/ff-factory.git && cd ff-factory
sudo deploy/vm/guest/install.sh --dry-run
sudo deploy/vm/guest/install.sh           # under a minute; ends with the portal answering /api/health

# Tailscale, with Ben's auth key (pasted into a file, never on a command line)
umask 077; cat > ~/ts.key                 # paste the key, Enter, Ctrl-D
sudo fffctl tailscale-join --authkey-file ~/ts.key; shred -u ~/ts.key
#   prints the Funnel URL https://fff.<tailnet>.ts.net

# Your subscription token for the orchestrators and the dispatcher (D4). On any machine where you use Claude Code:
#   claude setup-token        -> copy the sk-ant-oat01-... it prints
umask 077; cat > ~/claude.token           # paste it, Enter, Ctrl-D
sudo fffctl claude-token --file ~/claude.token; shred -u ~/claude.token

sudo fffctl status                        # portal active, release, tailscale joined, funnel URL
exit
```

The token is stored now and used once code change 18 is in. Until then nothing in the VM uses it.

Check from your own device: `https://fff.<tailnet>.ts.net/api/health` answers `{"ok":true,...}`.

## 4. Later, not tonight

- **GitHub token (D7, Ben):** a fine-grained token on a machine user. In the VM: `sudo fffctl gh-login --token-file F`,
  then `sudo fffctl base-clone`.
- **Backups (D17):**
  1. Ben makes the backup account on BEAST.
  2. Put the age public keys in `/etc/fff/backup-recipients.txt` and `BACKUP_SSH_TARGET` in `/etc/fff/fff.conf`.
  3. Authorize `/etc/fff/backup_ed25519.pub` on BEAST.
  4. Run `sudo fffctl backup`.
- **The move itself:** the design's section 7, after the code changes.

## If it must come off again

```bash
sudo ~/ff-factory/deploy/vm/host/uninstall.sh --dry-run
sudo ~/ff-factory/deploy/vm/host/uninstall.sh --delete-disk    # the VM, its disk, network, firewall table and units
```

Without `--delete-disk` the disk and its snapshots stay. Packages stay unless `--purge-packages`, which removes only
what the install added.

## Choices made for this install, and why

| Choice | Value | Reason |
|---|---|---|
| Node name | `fff` | D3: neutral, will not need to change; the Funnel URL is `https://fff.<tailnet>.ts.net` |
| VM time zone | America/Denver, BEAST's own (Ben confirmed, 2026-10-05) | Cron triggers and daily budgets are read in the portal's local time, so the move keeps their times. The guest's update, backup and nightly restart times are set in UTC either way |
| Private network | 10.213.41.0/24 (host .1, VM .10) | Unlikely to collide with a home LAN or Docker's ranges; the installer refuses if it does |
| Guest resolvers | 1.1.1.1, 9.9.9.9 | The VM uses no DNS service on the host (design 1.3) |
| Funnel on the first join | on | Logins exist only once `node server/user.ts` runs in the VM, so an empty portal behind Funnel cannot be signed in to |

## Questions for Ben: answered (2026-10-05, relayed by the orchestrator)

1. **The tailnet policy:** the default allow-all is replaced by the explicit rules in section 1, checked by Ben; the
   old policy is kept as the rollback file.
2. **The auth key:** Ben makes it when Lothsahn reaches section 3 and sends it privately.
3. **BEAST's time zone:** America/Denver, confirmed, so `VM_TIMEZONE=America/Denver`.
