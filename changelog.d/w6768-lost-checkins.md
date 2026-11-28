- **A worker's check-in that nothing can deliver is said, and its request reads Stalled with the reason** (w6768, warn-only
  step): when a check-in comes due and its worker is gone, or its computer has been away past the grace and the wake is
  refused, the request shows Stalled "its check-in at HH:MMZ is due, and worker X is gone / is on beast (offline N min):
  nothing resumes it", not Sleeping or "Merged, follow-up pending". Its log says what the automatic move would do, and the
  dispatcher is told once to start or move it with the check-in's note, unless another worker on it is at work or comes back
  by itself (its own check-in, a job). A later turn by its worker, or a new worker, ends it for good.
  Nothing moves by itself yet; that is a separate step. Before, the Waker dropped such a check-in silently (w6370 sat 14 h;
  w6484 never moved off an offline BEAST).
- **`delete_sandbox` no longer removes the workers that released the sandbox before** (w6768): a worker that saved and
  released it while stopped until a check-in, or moved elsewhere since, is kept. Before, deleting lothdesktop/slot5 removed
  w6370's worker e41a69e8 and its pending check-in with it.
