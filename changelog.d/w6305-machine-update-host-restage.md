- **`machine_update host_restage`** (w6305): `ops_worker machine_update host_restage warn|on` sets daemon.json
  `hostRestage` (w6287) remotely, over the daemon link or the installer (`--host-restage`, `-HostRestage`), like
  `shared_lock`. `warn` stays the default and is the way back; nothing turns it on yet.
