- **Each machine's ffu build slots show on the portal** (w5912, lothsahn: "Does FFU have its own set of slots the same
  way? Can we show those on the portal?"). The machine's page has an "ffu slots" set under its sandboxes, and
  `list_sandboxes` and `list_machines` list them too. Each slot shows its holder and request, whether the holder runs,
  stopped or is gone, its branch and commit, how long it has been held and when it was last used, and its target's size
  from the clean-up pass. A hold that `ffu-slot list` would let another worker take shows as **stale** (w5885's notion).
  The daemon reads `ffu-slot list --json` every 2 minutes in a child process and sends it in its stats. Nothing is added
  to do from the page. This applies once the portal and each machine's daemon are deployed. Docs: ffu-sandboxes.md ("On
  the portal"). Tests: `ffuSlotsReport.test.ts`, and `fleet.spec.ts` (w5912).
