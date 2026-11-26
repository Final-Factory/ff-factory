- **Per-slot tool caches and the players broker, stage 2 of per-slot isolation, warn only** (w5615, design w5544): a new
  daemon.json setting `sharedLock` (`ops_worker machine_update shared_lock`: `off` / `warn` / `on`, off when unset). With
  `warn` each sandbox gets its own block-cloned copies of the uv, pip, npm, nuget, upm, dotnet and Playwright caches under
  `cache/slots/<sandbox>` (made while it is idle, merged back into the seed and refreshed daily), its own determinism-audit
  folder and procs mailbox, and the `players/*` RPC calls that let the daemon install and start a sandbox's player in
  `players/<sandbox>-<peer>`. Worker writes to the shared caches, players, seed and tools are logged, not refused; `on`
  (refusing them) ships separately. Way back: `shared_lock off` (docs/worker-root.md 4.4).
