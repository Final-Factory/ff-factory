- **Workers fetch a release's symbols and a report's diagnosis files from FFBox** (w1542): `list_ffbox_files` lists FFBox's
  symbol store (every version, a release's pdbs, `.sym` files and binaries), the players' reports and a report's diagnosis
  files; `fetch_ffbox_symbols` puts one symbol file (e.g. 1.0.0.0's `lib_burst_generated.pdb`) in the worker's `Inbox/`,
  in 64 MiB parts appended into one attachment, each part and the whole SHA-256 checked; `fetch_ffbox_report` takes
  `diagnosis` for a file the report's diagnosis kept. Read-only, an allowlist of names and folders on FFBox. Needs a portal
  and daemon deploy, and ffbox master from 2f3181c. [docs/ffbox.md](../docs/ffbox.md)
