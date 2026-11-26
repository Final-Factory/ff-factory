- **Workers' shell writes into /tmp are refused** (w6050, after w6008's warn stage; lothsahn: "under no circumstances should
  workers write outside of ffw"). The Bash and PowerShell guard refuses a command that writes into /tmp, /var/tmp,
  /private/tmp, /var/folders, AppData\Local\Temp or C:\Windows\Temp outside the worker's own folders, and points it at its
  own `$TMPDIR`. The parser now also reads `cp -T`, `sed -i`, `find -delete`, zip and 7z, `pip --target`,
  `gh run download -D`, git's `-C`/`-c`/`worktree add -b`, `TMPDIR=/tmp`, Start-Transcript, Compress-Archive,
  `[IO.File]::Write...` and heredocs fed to `sudo bash`, `timeout … bash` or `| bash` (the w6040 re-review's 20 cases).
  Recovery switch: config `tmpWriteFence` `"warn"` (owner key; reaches each worker at its next turn). Docs: worker-fence.md.
