- **A slow or cut update bundle logs the Tailscale path to that machine** (w5897, from w5643). When the portal logs "the
  update bundle was cut", a bundle of 5 s or 1 MB or more goes out below 200 KB/s, or a bundle is still going after 60 s
  below that rate, the portal VM runs `tailscale status --json` and `tailscale ping -c 5 <the machine's tailnet IP>`
  (read-only, at most once per machine in 2 minutes) and writes one journal line: the peer's short key, direct or DERP,
  CurAddr, Relay, LastHandshake, RxBytes, TxBytes and each pong. Read it with `portal_logs` source `journal`, grep
  `tailscale path`. Docs: portal-logs.md ("The Tailscale path of a slow update bundle"), with the key prefixes of
  2026-11-25 and the Windows engine's second SYSTEM process. Tests: `tailscalePath.test.ts`.
