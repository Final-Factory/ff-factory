- **The daemon refuses a push or fetch to an origin that is not GitHub** (w6099, the enforce step after #1371's
  warn-only one): saveWork still commits and only skips the push (its note says why), switchBranch and the ffu-slot
  rescue change nothing, and the shared ffu clone is not fetched on `ffu-slot take`. A checkout with no remote named
  origin is refused too (git would take "origin" for a folder). Each message names the `git remote` command that fixes
  it, so a worker recovers by itself; `REMOTE_GUARD = 'warn'` in `server/remoteGuard.ts` (a portal deploy) turns it back
  to logging. The redacted URL in a message now also drops the scp form's user, a second `@` and any query or fragment.
  Needs a portal deploy (machines update themselves after).
