- **Fenced sandbox agents on Macs get their Unity MCP server back** (w5693, found by w5691 on m5). `uvx` writes a temp file
  in uv's tool folder (`~/.local/share/uv/tools`) on every run, which the Seatbelt fence refuses, so the server exited at
  start (UnityMCP CONNECTION_CLOSED). Sandbox agents now use `<root>/cache/uv-tools` and the daemon and Medium agents
  `<root>/cache-medium/uv-tools` (read-only to workers); a Medium folder that cannot be made keeps uv's default, with a
  warning. Linux (Landlock) workers had the same gap. docs/worker-root.md 2.8.
