- **A Claude token can have its own weekly cap** (w2785): `vault.pool.weeklyCapPercent`, a map of vault entry name to percent
  set with `set_app_config` (`"vault-ben-3=90"`). At its cap the token is retired for all work, the orchestrators' and ops
  worker's use-it-up included, its agents move at their next turn, and it comes back after its weekly reset; system_status
  shows `weekly 91% (cap 90%): retired until …` (docs/vault.md section 4).
