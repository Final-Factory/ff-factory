- **uv's cache and the game's determinism audits move inside the worker install folder** (w5281, lothsahn: m5 was down to
  18 GB free). The daemon sets `UV_CACHE_DIR=<root>/cache/uv` and `FF_DETERMINISM_AUDIT_DIR=<root>/cache/determinism-audit`
  in every agent, editor, player and batch run it starts, and runs `uv cache prune` on the uv cache once a day (hourly below
  the soft threshold; never `--force`, so it waits for a running `uv run`). ff-leftovers keeps `<root>/cache` and says why.
  The old `~/.cache/uv` (36.9 GB on m5) and the game data folder's audits are left where they are. Needs a daemon update;
  the game reads `FF_DETERMINISM_AUDIT_DIR` from its PR into master.
