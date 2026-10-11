- **The Dev Drive move stops only the daemon** (w900): it used the stop that also ends agent hosts. It now uses the update's stop, so an
  idle agent's host carries on. docs/worker-install.md also says to restart a Windows daemon with `machine_daemon restart`, not `schtasks /end` + `/run`, which can leave a second daemon.
