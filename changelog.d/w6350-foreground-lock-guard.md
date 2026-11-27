- **The tray keeps Windows from leaking a kernel token per process start** (w6350, lothsahn: find what leaks the `Toke`
  objects on BEAST and LothDesktop, about 4 million each after 12 days, and fix it). Windows 11 25H2's win32k leaks the
  creator's token for every process start while the foreground lock is armed, and Windows arms it for 24.9 days after any
  input from each logon. The tray app now keeps the live `ForegroundLockTimeout` at 0, re-applying it after logon, unlock
  and Remote Desktop changes, so the leak stops while nobody is typing. The cost is that any program may bring its window
  to the front. `daemon.json` `"foregroundLockGuard": false` turns it off. The tokens already leaked go only with a reboot.
  Applies on each Windows PC when its daemon updates. Docs: machines.md ("The foreground lock guard"). Tests:
  `machineDeployWin.test.ts` (the real tray on Windows puts 0 back after the value is set to Windows' 2147483647).
