- **Server dependencies cleared of known advisories, and CI fails on a new high one** (w5519, finding 13 of the w5452
  security audit). `npm audit fix` in the root takes `@modelcontextprotocol/sdk` 1.30.1 to 1.32.2, `zod` to 4.6.7,
  `body-parser` past 2.3.0, and `hono`, `ip-address`, `qs` and `fast-uri` to their fixed versions: `npm audit --omit=dev`
  goes from 8 issues (3 high) to 0. The web UI's issues all come through mermaid and dompurify, bumped by w5518. A new CI
  step, `scripts/audit-gate.ts`, fails a pull request or a push to main on any high or critical advisory in the server's or
  the web UI's production dependencies; one advisory with no fix yet can be allowed in `.github/npm-audit-allow.json`
  with a reason and an end date (docs/ci.md, "npm audit"). Needs a portal deploy.
