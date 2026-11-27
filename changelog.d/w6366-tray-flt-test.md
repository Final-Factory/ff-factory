- **The real tray app test no longer fails on a runner Windows already armed** (w6366, lothsahn: "the real tray app test
  fails on a CI runner that cannot set ForegroundLockTimeout (error 87)"). SystemParametersInfo refuses
  SPI_SETFOREGROUNDLOCKTIMEOUT unless the caller may change the foreground window, and a background process may only once
  the lock timeout has expired. So the test sets 2147483647 itself only from 0, and starts the guard leg from a value
  Windows already set. It also waits for the guard's repair, not its first attempt, which waits for 3 s without input.
  The guard is unchanged. Tests: `machineDeployWin.test.ts`.
