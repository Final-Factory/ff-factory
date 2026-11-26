- **ffu slots on Windows run a native git `reference-transaction` hook** (w6062, ben: "Build a native Windows version of
  the commit hook."). Git runs that hook 7 times per commit, and each Git Bash start cost about 30 ms on LothDesktop, so the
  shell slot guard (w6038) added about 210 ms per commit there. `ffu-slot take` on Windows now builds
  `machine/ffuSlotHooks/native/reference_transaction.rs` (the same check, std-only Rust) with `rustc` once per version of the
  hooks into `ffu-sandboxes/hooks/<hash>/` and points the shared clone's `core.hooksPath` there; with no rustc it keeps the
  shell hooks. Refusals are unchanged and tested on both (`server/ffuSlotGuard.test.ts`). macOS and Linux are unchanged.
  Docs: ffu-sandboxes.md.
