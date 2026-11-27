- **Linux takes the read fence's `on` mode** (w6434, lothsahn: "Build Linux 'on' as its own request, then run the same
  checks on biscuit"). The daemon's code on Linux now lives in `<daemon>/code/` (`app`, `app.old`, `app.new`,
  `app.failed`) and `<daemon>/app` is a link to `code/app` that updates never touch; `code` is given back to workers as a
  folder, so a run already going keeps git push, gh, ff-pr and unity-slot across a daemon update under Landlock (B4 of
  #1193, which refused `on` on Linux until now). The installer moves an old `app` folder over at the next update, the
  rollback swaps inside `code/`, and the stop script's agent-host match takes both layouts. `on` is held at warn, with a
  logged reason, until the link is there (`readFenceOnHeld`). Below Landlock ABI 9 (Linux 7.1) `on` still enforces
  nothing (w5748): `systemd-run --user` would start a job outside every rule (w6443's review), and the owner-socket
  probe now counts systemd's sockets too. Off by default;
  `read-fence-off` still takes the rules off the next run with nobody at the machine. Docs: worker-fence.md. Tests:
  `scripts/worker/linuxCode.test.ts` (with a live Landlock leg across both swaps), workerFence, machineLink. The daemon's entry points (daemon, agent host, gh helper, ff-pr,
  unity-slot, leftovers, ffu slots) tell they are the script node started by real path (`machine/isMain.ts`), so they still
  run through the link.
