- **Machines take updates again** (w5593). Since the 07:04Z deploy on 2026-11-25, every daemon's rollout failed with
  `git bundle failed (128): error: unable to open loose object ...: Permission denied`. At 06:03Z, `fff-update activate`
  found no root record and built `origin/main` itself. It runs as root inside `fff-portal.service`, which keeps that
  unit's `UMask=0077`, so its fetch wrote objects into root's `repo.git` that the `fff` user could not read, and the
  portal (`fff`) could no longer bundle its commit for the machines. `fff-update` now sets `umask 022`. Its `ensure_repo`
  also makes the clone readable (`chmod -R go-w,a+rX`) on every `prepare` and `init`, so the next update's system setup
  repairs the objects already written. A root test runs `activate` under umask 077 and bundles the result as `fff`.
