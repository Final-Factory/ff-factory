- **The daemon and Medium agents use their own uv cache, `<root>/cache-medium/uv`, which workers cannot write** (w5565;
  lothsahn: "File it: separate uv cache for the daemon and Medium agents"). Before, they ran the Unity MCP server's uvx and
  `uv run --with ...` from `<root>/cache/uv`, which fenced workers write, so a worker could plant code that ran outside the
  fence. Sandbox agents keep `<root>/cache/uv`; the daemon fills both with the Unity MCP package and prunes each. Needs a
  portal deploy (machines' daemons update after it). docs/worker-root.md 2.8.
