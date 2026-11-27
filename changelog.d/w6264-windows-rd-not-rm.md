- **Windows workers delete folders with `rd`, not `rm -r`** (w6264, lothsahn: "Windows workers: rm -rf follows a mklink /J
  junction; clean temp folders with rd /s /q"). Git Bash's `rm -rf` on a folder holding a junction made by `cmd /c mklink /J`
  deleted the folder the junction points at, then failed on the junction (measured on BEAST and LothDesktop). A Windows
  worker's Disk space section now says to delete a folder with `cmd //c "rd /s /q <windows path>"` or PowerShell's
  `Remove-Item -Recurse -Force`. The daemon's own sweeps already delete with `rd /s /q` (removeTree) or Node's `fs.rm`, and
  never run Git Bash's `rm` on Windows; `junctionDelete.test.ts` (Windows runner) shows each of those routes, and the
  prompt's, removes the junction and keeps its target. Applies to workers started after a portal deploy.
