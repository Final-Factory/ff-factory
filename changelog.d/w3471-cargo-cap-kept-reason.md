- **A cargo target kept over its size cap is reported with the reason on every clean-up pass** (w3471): the hourly log listed
  only what went, so an idle target over `cargoTargetCapGB` that stayed could not be told from a rule that never looked at it.
  The pass now returns it as kept (a running build, a recent write, a git work tree), as a low pass already did.
