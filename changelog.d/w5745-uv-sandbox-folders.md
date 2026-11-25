- **One rule for a sandbox's uv folders, its editor included** (w5745, from w5693's review): `sandboxUvEnv` alone sets a
  sandbox agent's uv tool folder (the Seatbelt fence's env no longer sets its own), keeps one daemon.json names only inside
  `<root>/cache`, and adds `UV_TOOL_BIN_DIR=<root>/cache/uv-bin`, so a fenced `uv tool install` works. Sandbox editors get
  the workers' uv cache and folders, not the daemon's Medium ones. uv's managed Pythons stay where they are (measured: the
  Unity MCP server installs none). Needs each machine's daemon update; editors take it from their next start.
