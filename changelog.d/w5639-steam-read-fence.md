- **Workers can no longer read `<root>/steam`** (w5639): steamcmd's cached Steam login, the upload config, the daemon's
  ffbox clone and `uploads.json` join the read fence's closed paths on every OS (macOS Seatbelt, Linux Landlock, Windows
  No-Read-Up). It follows the read fence's own mode (`off` by default; `read-fence-off` takes it off live). The daemon runs
  the Steam uploads itself, outside the fence, so they keep working. docs/worker-fence.md "Reads".
