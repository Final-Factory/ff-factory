- **The daemon warns about a virtual disk in a folder workers write** (w5948, warn-only): at start, `lowSetup()` logs a
  `WARNING worker integrity:` line for each `.vhd`/`.vhdx` in a Low-labelled `<root>/tools` child (`lowDiskImages`,
  machine/lowIntegrity.ts). BEAST's `tools\wsl-ffu-sniper\ext4.vhdx` (the `ffu-sniper` WSL distro, made by hand for w2895)
  is one: a Low worker can rewrite it while the distro is stopped, and the next `wsl -d ffu-sniper` by a Medium process runs
  what it planted. The line names the fix (`wsl --manage <distro> --move <root>\wsl\<distro>`, distro stopped, then
  `icacls <moved ext4.vhdx> /setintegritylevel M`, since a move on one volume is a rename that keeps the Low label); nothing is
  moved or relabelled. Needs a daemon update.
