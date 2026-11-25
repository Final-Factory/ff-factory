- **The daemon link (/machine) checks that it comes from the tailnet, warn-only for now** (w5575, finding 3 of the w5450
  network audit; lothsahn: "File it: the daemon link accepts only tailnet connections"). Every `/machine` request and
  upgrade is judged by `tailnetOnly`: not through Funnel, and a client address (w5535's `clientAddress`) on loopback,
  100.64.0.0/10 or fd7a:115c:a1e0::/48. The new owner setting `machineLinkTailnet` is `warn` while unset: it lets
  everything in and logs `machine link: WOULD REFUSE ...`; `enforce` refuses with 403; `off` skips the check (the
  recovery switch). Each daemon link logs `machine <id>: link from <address>`. Docs: machines.md ("The daemon link is
  tailnet-only"). Tests: `machineLinkGate.test.ts`.
