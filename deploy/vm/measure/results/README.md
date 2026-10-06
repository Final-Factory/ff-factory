# BEAST portal footprint (w442)

Measured on BEAST (32 logical CPUs, 63.8 GB RAM) with `measure-portal.ps1 -AppRoot '' -PortalPort 8790
-IntervalSeconds 30`, as a one-off scheduled task, from 2026-10-05 14:27:47 for 24 h. Read-only. The final run lands in
`final-*/` when it ends; `partial-20261005/` is a snapshot of the first 2.4 h (280 samples, 14:27:48 to 16:51:27),
summarised with `summarize-samples.ps1` into `summary-partial.txt`.

## Headline so far (measured, first 2.4 h)

| | typical (median) | p95 | peak (max) |
|---|---|---|---|
| node server, working set | 150 MB | 206 MB | 459 MB |
| node server, private bytes | 213 MB | | 434 MB |
| node server, CPU (% of one core) | 4.8 (mean) | 10.0 | 43.3 |
| dispatcher claude (1 process + its tools), working set | 139 MB | 225 MB | 417 MB |
| orchestrator claudes (2 processes: ben, lothsahn), working set together | 244 MB | 456 MB | 556 MB |
| everything under the portal, working set | 522 MB | 855 MB | 1,066 MB |
| everything under the portal, private bytes | 1,674 MB | | 1,977 MB |
| everything under the portal, CPU (% of one core) | 5.8 (mean) | 13.3 | 50.0 |

- Claude processes under the portal at once: 3 (median and max): the dispatcher and two orchestrators. No standing
  agent and no worker ran under the portal in this window. One claude.exe's own working set: median 115 MB, max 342 MB.
- Restarts: the server restarted at 16:36 (pid 42608 -> 50812) and 16:45 (-> 49668). All three claude processes ended
  with the old server and were respawned under the new one (same sessions resumed); none outlived a restart.
- Network: the per-process counters are all I/O, file I/O included (node shows 314 GB/day, almost all file I/O), so
  they do not isolate network. The host's adapters (everything on BEAST: the game, sandbox workers, git) moved
  2.3 GB/day in and 10.7 GB/day out, an upper bound far above the portal's own traffic.
- The script's own cost: 0.27% of one core, 71 MB, about 0.22 s per sample.

## Not measured: data/ and the base clone

The w442 sandbox's harness refuses any shell command naming `C:\ff-sandboxes` or `C:\ffsb\_base` (reads included), so
the disk section (data/ size, growth per day, base clone size) did not run. Someone with access can run it once (a few
minutes, read-only): `powershell -NoProfile -ExecutionPolicy Bypass -File measure-portal.ps1 -AppRoot C:\ff-sandboxes -Minutes 0`.
