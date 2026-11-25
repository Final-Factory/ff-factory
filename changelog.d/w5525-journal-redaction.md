- **The portal's journal holds no secret, and `fffctl logs` redacts with the full redactor** (w5525 and w5526, security audit
  w5452 findings 16 and 17; lothsahn: "redact all console output and make fffctl logs use the full redactor", "move the
  missing secret patterns into the shared redactor"). Every console call and direct stdout or stderr write of the portal goes
  through the log redactor before systemd keeps it (`server/journalRedact.ts`, turned on by `server/index.ts`'s first
  import). `fffctl logs` pipes the journal through `server/redactLogsCli.ts` (the vault's values, every token shape, the log
  forms; a private key's lines withheld) in place of a `sed`, so older entries come out masked too; a release without the
  CLI prints nothing. JWTs, AWS access keys, Slack tokens, Bearer credentials and passwords or tokens in URLs move from
  portal_logs into the shared set (`shared/secretShapes.ts`), so transcripts, reports and the data-folder scrub mask them
  too; commits, ordinary URLs and base64 game data stay. The start-up scrub runs again once (scrub version 3). Cost: 2.2 to
  2.9 µs a line (measured). Docs: portal-logs.md. Tests: `secretShapes.test.ts`, `journalRedact.test.ts`,
  `deploy/vm/test/fff-ops.test.sh`.
