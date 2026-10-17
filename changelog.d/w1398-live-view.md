- **Live view: watch a sandbox's game beside its agent's chat, and drag the shader's own knobs** (w1398, the first slice of
  w1393's plan; Ben: "the game should just show a preview of that asset rendering in the engine ... change how much this
  glows"). Off unless the portal's config has `"live": { "enabled": true }`.
  - **The agent:** a worker's `live_view` tool streams its sandbox editor's running game. The game half is the game
    repo's `live.frames` and `look.material.*` commands (FinalFactory #1822).
  - **The machine:** the daemon gives the play session's agent channel the dev tier through the editor's MCP bridge,
    takes the JPEG frames on a loopback port, and keeps only the newest. It sends them to the portal on a socket of
    their own (`/machine/live/<liveId>`).
  - **The page:** `#/live/<sessionId>` shows the view beside the conversation (on a phone, above it) with sliders and
    colour swatches made from the shader's properties. Only the session's person and the owners can open it.
  - **A knob move:** it reaches the game through the daemon, appears as a line in the agent's conversation, opens the
    agent's next message, and counts as activity in that sandbox.
  - Protocol 9 unchanged: `liveView` in the hello, plus `live`, `live_result` and `live_state`.
  - Docs: live-view.md. Tests: `live.test.ts`, `liveMachine.test.ts`, `liveDaemon.test.ts`, `e2e/live.spec.ts`.
