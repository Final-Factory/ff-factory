- **A local test run keeps its request when its record comes late** (w4922): the daemon announces a run as it starts and
  the portal tags it with the sandbox's workers then, so an editor run whose worker had stopped or moved before the record
  came is no longer untagged.
