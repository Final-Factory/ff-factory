- **ffu-server can take peers from other PCs in every ffu slot** (w5442, lothsahn: "These should be added for all the ffu
  sandboxes so that it can start servers always"). The Windows worker install and every tools rollout keep a firewall
  group "Final Factory ffu-server": an inbound TCP allow rule from Tailscale only for `ffu-server.exe` in each ffu slot's
  `target\debug`, `target\release` and `bin` (slots 1..4, made before the slot exists). By program, not port: its ports
  come from flags. Reaches a machine with the tools rollout after a verified deploy (the elevated rerun over ssh makes the
  rules). Docs: ffu-sandboxes.md, worker-install.md. Tests: `ffuSlots.test.ts`.
