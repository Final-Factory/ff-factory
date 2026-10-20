- **Add a machine from the dashboard, with an installer to download** (w1592, lothsahn: "Can it be an installer I download
  from the website instead of opening a ssh tunnel?"). Computers > Add a machine (owners) makes the join code and offers
  the Windows installer with the code in it (`ff-factory-join.cmd`): on the new PC, connected to Tailscale, double-click it.
  A PC without one opens `https://<the portal>/join` (the installer that asks for the code, and the commands). The
  bootstrap now asks one question before it changes anything, then installs the tools and sets up OpenSSH Server without
  another. Windows warns about the downloaded file (More info, Run anyway); with Smart App Control on it blocks it, and the
  PowerShell line shown beside the download is the way. Why it is a `.cmd` and not a signed `.exe`, and why the portal
  still uses ssh: worker-install.md "The download and Windows' warnings" and "Why the portal still reaches a machine over
  ssh". Tests: `server/machineJoinHttp.test.ts`, `server/machines.test.ts` (createJoin), `scripts/join.test.ts` (on
  Windows: the installer under cmd.exe), `e2e/machineJoin.spec.ts`.
