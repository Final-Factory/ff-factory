- **A worker's base context is about 3.9k tokens smaller per model call** (w1482, lothsahn: "Do 4. Do 10. Do what you think is best
  for 7-9."; measured on beast, 54,439 → 50,711 on a one-turn session). Rules few tasks need (a clean-up request, saves and the
  game's settings in a test, Unity batch runs) moved to a worker `read_rules` tool with a pointer line each; ReportFindings and the
  built-in Explore, Plan, claude and statusline-setup roles are left out of worker sessions; the evidence, merge, Discord and trunk
  rules are said once, in the game repo's CLAUDE.md, which a game-repo test now pins. A brief leaves out the request as filed when
  it already quotes it, and its DONE rule points at CLAUDE.md. Worker prompts and briefs speak of now, not of how their rules came
  to be (lothsahn: "They should only describe what the worker should do now and why, not the history of how the instructions have
  changed."), and the dispatcher and orchestrators write briefs that way.
