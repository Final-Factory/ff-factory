- **The portal's backups now hold the vault, check every upload, pin the target's host key and have a monthly restore
  drill** (w5529, w5566). `fff-backup` archives `data/vault.json` (never its key: it refuses to run if a vault key file is
  among what it packs), requires the target's host key pinned in `/etc/fff/backup_known_hosts`
  (`fffctl backup-config --host-key FILE`; `StrictHostKeyChecking=yes`), uploads as `.part`, compares the size and reads it
  back to compare its sha256 before renaming it into place, and writes `/var/lib/fff/backup.json`. `fffctl status` and the
  portal's `system_status` show the last backup and the drill (a failure as `PROBLEM:`, a stale one as `WARNING:`, the
  drill DUE after 31 days). The drill: `sudo fff-vm backup-drill --identity KEY` on the FFBox host, decrypting in a pipe;
  the VM unpacks it in a scratch folder and checks its JSON, its sessions and that every vault entry opens
  (`vaultCli verify`). The host side needs no copy of its own: its nightly VM snapshots go off-site with its whole disk.
  The backups' age keys: a recipe in deploy/vm/RUNBOOK.md; none are set up yet. Needs a portal deploy and, on the host,
  `age` (install.sh).
