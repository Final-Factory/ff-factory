- **A weekly full ReFS dedup pass on a Dev Drive with dedup on** (w4502, lothsahn: "check and fix V:'s dedup"). The daily
  scheduled job is incremental (Microsoft: "only new or changed files will be processed"); on LothDesktop it reported success
  every night while 54 GB of byte-identical files that predated its last run stayed unshared (measured 2026-11-16). The
  privileged helper gains a `dedup` action (`Start-ReFSDedupJob -FullRun`, 5 h cap, 50% CPU, files changed in the last hour
  skipped) that reports the free space before and after; `install-privileged-helpers.ps1 -Actions dedup` registers
  `ffsb-helper-dedup` to run every Sunday at 04:00 with a 6 h task limit, and the app's user may start it on demand. Only for a
  drive with dedup enabled (LothDesktop's V:); worker installs do not register it. Docs: sandbox-disk.md. Tests:
  `devdrive.test.ts` (dedup).
