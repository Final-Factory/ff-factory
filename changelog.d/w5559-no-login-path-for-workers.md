- **No agent gets a path to the machine's own Claude login** (w5559, lothsahn: "workers can't read BEAST's old Claude login
  folder"). `FF_CLAUDE_LEGACY_DIR` (the person's `~/.claude`, which holds `.credentials.json` on Windows and Linux) stays in
  the daemon's environment for its own readers (transcripts, the usage probe) and is dropped from every agent's
  (`server/claudeHome.ts` `withoutLoginPaths`, applied in `server/launch.ts` `buildOptions`). Every worker runs on a vault
  token (`server/secrets.ts` `machineRunEnv`), never on that login. `claudeLoginFiles` names the login files the read fences
  deny next (w5546's mechanism). Tests: `claudeHome.test.ts`, `accounts.test.ts`.
