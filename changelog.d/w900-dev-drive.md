- **The Windows worker installer makes a Dev Drive in the install folder** (w900, lothsahn: "Please modify the installer so that
  it does this in the specified location when you request an install. The dev drive file would live there, and the dev drive
  would grab a new file letter starting with V: and moving back towards A until it finds an available drive letter."). A new
  install on Windows (`-NoDevDrive` opts out) makes `<root>\devdrive.vhdx`, a dynamically expanding ReFS Dev Drive mounted at
  the first drive letter from V: down to A: that is not in use, a mapped network drive or reserved by Windows, and puts the
  sandboxes and the Library seed on it, so each new sandbox's Library is a block clone of the seed. `ffsb-helper-mount` (SYSTEM,
  also at every boot) mounts it again at the same letter, or the next free one with `daemon.json`, the pool's record, the junctions
  and the worktrees repointed; the daemon's host guard remounts it if it goes. Running the installer again reuses the file and
  formats nothing. An update makes no drive unless `-DevDrive`; `-Update -MoveToDevDrive` (and `ops_worker machine_update`
  `move_to_dev_drive`) re-creates an existing install's sandboxes on it from the seed, saving each one's work first, and refuses
  while an agent or an editor is in one. Tested on a real Windows runner (`.github/workflows/dev-drive.yml`) and with the disks
  faked under PowerShell 7. docs/worker-install.md "The Dev Drive". Needs a portal deploy and, for LothDesktop, the move.
