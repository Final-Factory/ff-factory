- **Machine exclusions are checked against live holds and rules, warn-only for now** (w6687, lothsahn: "machine
  exclusions must cite a live hold and expire with it"). Each minute the blocker watch judges every pair run's `avoid`
  (before its legs start), every machine pin and every Queued request's `needs`: each machine kept out must be named by a
  live crash hold, a machine hold, pause, drain or offline state, a config `placement.avoid`/`placement.hold` key, a
  capability (a Mac for a run with a client, no players, no timed runs, Medium integrity) or a person's words (a
  `pin_words` pin, the request's constraints or a person's note). One that is not gets a `w6687 warn-only, nothing
  dropped: enforcing would drop ...` line on its request (once per change, also in the portal journal as
  `[w6687 exclusions]`), including one whose crash hold has cleared. Nothing is dropped or re-queued yet: enforcing is a
  separate later change. request_pair takes `avoid_why` (kept beside the avoid for the log, never trusted), and the
  capacity block (`list_sandboxes`, `system_status`) carries a `Crash holds now` line read from the live list. Tests:
  `w6687ExclusionAudit.test.ts`.
