- **A second instance's daemon installs like any other and takes its portal's updates** (w14): `install --instance <name>`
  (`install.ps1 -Instance`, `install.sh --instance`) gives a daemon for another portal on the same computer its own
  service (`FFFactoryDaemon-<name>`, `com.fffactory.daemon.<name>`), firewall groups, Unity slots mailbox and Claude Code
  folder (daemon.json `env`, which the daemon sets on itself at start), cleans nothing outside its root and sets up no ssh.
  Before, such daemons were started by hand from their portal's checkout and stayed on that commit
  (docs/worker-install.md, "A second instance's daemon"). Without `--instance` nothing changes.
