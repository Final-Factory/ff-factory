- **`ff-leftovers end` no longer kills the worker that runs it** (w1222). On 2026-10-13 four workers on Windows (w1203,
  w1215, w1216, w1219) ran it before DONE, as their brief asks, and their own Claude process died at once with exit code 1.
  Git Bash's fork+exec leaves the shim's `sh.exe` a Windows parent that has already exited, so the parent chain the
  command walked to spare its caller stopped at the shim, and claude.exe, its shells and its Unity MCP server, all carrying
  the session id, were taken for leftovers (measured on beast: `list` in a live worker named its own claude.exe, conhost,
  uvx and bash). The agent process is now also found from the environment, as the session's root (its parent, the agent
  host, carries no session; a parent pid Windows reused for a newer process does not count), and its MCP servers with it;
  the `sh` shim hands node the Windows pids of its MSYS parents (`FF_LEFTOVERS_CALLERS`), so the calling shell is spared
  too. A Mac and Linux keep an intact chain and were not affected. The daemon's own reaper never touched a live worker and
  is unchanged. Needs a portal deploy; the daemons update after it and rewrite the shim at start. Tests:
  `leftovers.test.ts` (beast's measured tree; the real shim under a stand-in agent, which the old code killed with exit 1).
