- **No ssh plan for a PC that joined without OpenSSH** (w4674; for lothsahn: "refuse ssh plans up front for Windows PCs
  that joined without OpenSSH"). LothLaptop joined through the worker join (w1596) with `-NoSsh`, so its port 22 times out
  by design, yet the ops worker's hourly timer for w4517 (the ReFS dedup rollout) kept running `ssh lothlaptop` and
  failing, and `machine_update` fell through to an ssh job whenever the laptop's daemon was offline. Now the daemon's hello
  says whether its install set up the portal's ssh (`ssh`, from root.json's `authorized-key` entry, machine/installSsh.ts;
  no protocol bump: an older side drops or never sends it), and the machine record carries `noSsh`. For such a machine
  `machine_update` and the rollout send no ssh (MachineManager `sshProblem`), the ops worker's guard refuses ssh, scp and
  sftp to it in a command or a scratch script it runs (`sshTargetProblem`, `noSshTargetProblem`), the w1742 firewall rerun
  skips it, and `list_machines` shows "no ssh". Each refusal names the route that applies: an update over the daemon's link,
  or a local worker in one of that machine's sandboxes. Tests: `server/w4674NoSsh.test.ts`, the w4674 case in
  `server/machineLink.test.ts` (a real daemon's hello) and the w1742 case in `server/machineRollout.test.ts`.
