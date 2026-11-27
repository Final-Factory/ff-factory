- **A Windows worker is warned before an `rm -r` over a folder holding a junction** (w6266, lothsahn: "warn-only guard for
  rm -r over a tree holding a junction on Windows"). Before a Bash `rm -r`/`rm -rf` runs on a Windows worker, the guard walks
  each folder it names (at most 20,000 entries and 200 ms) for a link, by folder entry, since lstat calls a worker's
  `\??\Global\` junction a plain folder. On a find it tells the agent to delete with `cmd //c "rd /s /q <path>"`, and one
  `junction rm warn (w6266, warn)` line goes, as a new `junctionRm` signal, to the machine's daemon.log and to the portal's
  log (not to the agent host's host.log, which goes with the host's folder). `lstatLink=true` marks a likely false positive;
  `unfinished` a walk that ran out of budget. The command still runs: refusing or rewriting it is a later step, after a week
  of these lines. The Disk space brief and the temp-size note no longer give `rm -rf` as the Windows delete. Applies to
  workers started after a portal deploy and the machine's daemon update.
