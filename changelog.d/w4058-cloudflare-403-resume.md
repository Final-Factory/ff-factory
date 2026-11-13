- **A worker's turn that ends on "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare" is an errored
  turn, not its report** (w4058). Claude Code does not retry a 403 for an OAuth token, so on 2026-11-13 BEAST's and the
  m5's workers (4e1a6788, effbf59b, 9fe5979d, c58c7636) stopped on that line and the ledger kept it as each one's report:
  nothing resumed them. `ledgerRules.ts` `API_ERROR_RESULT` now reads Claude Code's error line behind "Failed to
  authenticate." too, so the cleanup resumes such a worker after `ERROR_SETTLE_MS` (10 minutes, past Cloudflare's short
  challenge window) and escalates when the same error comes back. A refused credential (401 `authentication_error`) still
  escalates at once as needing a login. Tests: `ledgerErrors.test.ts`.
