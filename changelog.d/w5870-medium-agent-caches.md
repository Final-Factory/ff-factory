- **Medium agents' tool caches, the user PATH and ffu slots can move out of the workers' reach** (w5870, w5862's follow-up;
  lothsahn's rule: warn-only first). Medium agents ran .NET tools, Playwright browsers and npm, pip and NuGet packages from
  `<root>/cache`, searched a user PATH entry in it, and built ffu in the slots, all folders fenced workers write. The daemon
  now logs `WARNING medium agent caches: ...` at start, and `ffu-slot take` warns a Medium agent; daemon.json
  `"mediumAgentCaches": "on"` gives Medium agents `<root>/cache-medium/<tool>`, takes those entries off the user PATH and,
  with `"mediumAgentFolders": "on"` too, refuses a Medium agent an ffu slot (exit 5). A Medium agent's `ffu-slot take` no
  longer exports the workers' CARGO_HOME (w5947). Always on: a Medium agent's plugin fallback skips the old `<root>/tools`
  checkout, and the plugin refresh's git runs with safeGit's fence (a planted URL rewrite is removed and said). Docs: `docs/worker-root.md`. Tests:
  `server/mediumCaches.test.ts`.
