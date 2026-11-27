- **Windows writes the shims to `<root>\tools-medium\shims`** (w6101, item 3 of w6085), the name macOS and Linux use,
  first on new agents' PATH. `tools-medium` and its `shims` are kept Medium (a rollout before w5539 labelled
  `tools-medium` Low). `<root>\tools\shims` is still written for agents started before the move; the start line says how
  many still have it on PATH. A file in the new folder the daemon does not write is a WARNING, left in place (warn first).
  A failed write there falls back to `tools\shims` (Medium). Applies at the daemon's next start. Docs: worker-root.md.
  Tests: `w6101WinShims.test.ts`.
