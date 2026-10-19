- **Secrets stay out of transcripts, logs and the ledger** (w1584, lothsahn: "Can we fix the issue that caused the token to
  leak?"). `npm test` drops every credential variable before any test runs (`scripts/testEnv.ts`), so a failing assertion can
  no longer print a worker's `GH_TOKEN`. Session records, work items (log, DONE reports, `[needs you]`), page events, push
  notifications, the daemon log and text attachments are masked like transcripts already were, and a GitHub token after a
  line break or a colour code is no longer missed. The portal scrubs its data folder once at its next start;
  `sudo fffctl scrub-secrets [--dry-run]` does it by hand and ends with `remaining: 0` when nothing is left (the ops worker may
  run the dry run). Takes effect with a portal deploy and the daemons' update. Docs: vault.md section 14. Tests:
  `scripts/testEnv.test.ts`, `server/scrubSecrets.test.ts`.
