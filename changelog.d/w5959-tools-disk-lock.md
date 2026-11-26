- **The daemon can keep a virtual disk's tools folder Medium** (w5959, the enforce step after w5948's warning; Windows):
  daemon.json `toolsDiskLock` `"on"` keeps each Low `<root>\tools` child that holds a `.vhd`/`.vhdx` (a WSL distro's
  `ext4.vhdx`) Medium at start, so a Low worker cannot rewrite the disk that a Medium `wsl -d` would then run. Workers can no
  longer write anything in that child. Default `"warn"`: w5948's warning only, now naming the switch. Set and set back with
  `ops_worker` `machine_update` `tools_disk_lock` (installer `--tools-disk-lock`, `-ToolsDiskLock`); `warn` labels the child
  Low again at the next start. Ships off on every machine. Needs a daemon update.
