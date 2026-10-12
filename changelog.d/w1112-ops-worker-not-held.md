- **The ops worker is never held by the token pool's caps** (w1112, lothsahn: "The ops worker should not hold based on tokens,
  just like the dispatcher"). On 2026-10-12 at 07:30Z `ops_worker deploy` was refused with "lothsahn's Claude token pool is
  held: every token is at a limit (vault-lothsahn-1: 5-hour 92% (>= 80) ...)". Now the 5-hour hold, one at a time and the
  retire cap still hold new worker and standing jobs, but the ops worker (send, deploy, restart, machine_update) runs on the
  person's token with the most room when none passes them, the dispatcher's reserved token last. Only a pool whose every token
  is used up stops it, and the error says so ("... is used up, so the orchestration worker cannot start until a token
  resets"). The orchestrators already used the pool up past the caps; follow-ups to workers (`message_agent`) stay held like
  any worker run. Applies after a portal deploy. Docs: vault.md section 4, ops-worker.md. Tests: `opsWorkerPool.test.ts`.
- **The sandbox guard's "PRs into master/main" refusal says when the repo was only unknown** (w1112): `cd $TMPDIR/ff-factory &&
  gh pr create --base main` was refused as the game repo's, because a `cd` to a path with a variable is not followed. The
  reason now says so and names the way: `gh pr create -R <owner>/<repo>`.
