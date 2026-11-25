- **Workers' cargo registry moves inside the install folder** (w5501): the daemon gives every agent
  `CARGO_HOME=<root>/cache/cargo`, and `ffu-slot take` exports it, so a worker under the Windows Low-integrity fence can
  `cargo fetch` a crate not yet downloaded (BEAST's `~/.cargo` on C: refused it: "Access is denied (os error 5)"). A
  `CARGO_HOME` already inside the root stays (LothDesktop's `V:/ffw/tools/cargo`). At daemon start the new home is seeded
  once in the background from the old one (registry index and crates, git dependencies, config; not `bin`, `registry/src`
  or credentials), which is only read. Writable under every fence: `cache` is labelled Low on Windows, and Landlock and
  Seatbelt open it. Applies at each machine's next daemon update. Docs: ffu-sandboxes.md, worker-root.md. Tests:
  `cargoHome.test.ts`.
