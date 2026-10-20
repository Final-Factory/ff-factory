- **A new machine joins in one step** (w1592, lothsahn: "I can connect to tailscale and then it should contact the portal to
  set itself up with an installer"). An owner asks for a join code (`add_machine` with `join_code`); at the PC, connected to
  Tailscale, `irm https://<the portal>/join/windows.ps1 | iex` (Mac or Linux: `bash -c "$(curl -fsSL https://<the
  portal>/join/unix.sh)"`) asks for the code, installs the missing tools, turns on OpenSSH Server with a tailnet-only
  firewall rule, enrols the PC, runs the worker installer and shows what the portal sees. The code works once, for an hour,
  only from the tailnet device it was made for; the credential goes into a private file on the PC, never through chat or
  onto the screen. Re-run on an installed PC, it updates it. Needs a portal deploy; the tailnet policy block for
  `tag:fff-worker` is a one-time admin step. Docs: worker-install.md "Adding a machine with a join code", ops-worker.md
  "A new machine". Tests: `server/machineJoin.test.ts`, `server/machineJoinHttp.test.ts`, `scripts/join.test.ts`.
