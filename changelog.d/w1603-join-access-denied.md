- **The Windows join installer works where it said only "Access is denied."** (w1603, desktop-coosego). The downloaded
  `ff-factory-join.cmd` no longer starts `powershell -Command "irm ... | iex"`, a command line Microsoft Defender blocks; it
  downloads the bootstrap to a file and runs it with `-File`. It runs from an administrator window too, installing for the
  person signed in. On a failure it names the step and the error, keeps a log with no secrets at
  `%LOCALAPPDATA%\FFFactory\join\join.log`, and shows the Tailscale hint only when the portal cannot be reached. A machine
  waiting for its join no longer shows as a Mac; it shows its system from the join on.
