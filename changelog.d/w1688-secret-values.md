- **Every vault secret is masked by value, whatever its name, in Claude Code's own transcripts too** (w1688; lothsahn: "Fix
  4"). A worker printed its environment through a filter of its own that hid only names with TOKEN, and the vault's
  `FFSTEAM_PASSWORD` value reached the Claude Code transcript on beast. Launch specs now list the vault's variables
  (`secretEnv`), so the daemons mask those values whatever they are called; one precompiled matcher masks each value raw,
  URL-encoded, base64/base64url and JSON-escaped (values under 8 characters are skipped and named); the daemons and the
  portal overwrite known values in Claude Code's own transcripts in place, as they are written, and look back through every
  file for a value they learn (`server/cliScrub.ts`); agent_transcript, search snippets and post_as_max text are masked
  again on the way out; the portal rescans its data folder once (`SCRUB_VERSION` 2). Docs: vault.md. Tests:
  `secretValues.test.ts`, `agentHost.test.ts` (w1688).
